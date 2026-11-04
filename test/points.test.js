import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-points-'));
process.env.ADMIN_TOKEN = 'x';
process.env.MAX_RUNNING = '100';
process.env.MAX_RUNTIME_HOURS = '0';
process.env.KEEPALIVE_MINUTES = '0';

const { insertProject, updateProject, newId, upsertGithubUser, updateUser, getUser } = await import('../src/db.js');
const { assertRunQuota, stopReason, QuotaError } = await import('../src/manager.js');
const { config } = await import('../src/config.js');
const { encryptJson } = await import('../src/crypto.js');
const {
  settleAll, balanceOf, regenPerHour, burnPerHour, secondsUntilEmpty, pointsShortage, presentPoints,
} = await import('../src/points.js');

const HOUR = 3_600_000;
const mkUser = (gid) => {
  const u = upsertGithubUser({ githubId: gid, login: `pt${gid}`, avatarUrl: null });
  return updateUser(u.id, { status: 'approved', max_running: 10, memory_budget_mb: 8192 });
};
const mkRunning = (userId, memoryMb) => {
  const p = insertProject({
    id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000,
    envEnc: encryptJson({}), userId, memoryMb,
  });
  return updateProject(p.id, { status: 'running', started_at: new Date().toISOString() });
};
// 経過時間を指定して、ポイントを反映する(2回呼んで、その間の経過を作る)
const advance = (ms) => {
  const t0 = Date.now();
  settleAll(t0, Infinity);
  settleAll(t0 + ms, Infinity);
};

test('既定は 2 ポイント(満タン)。1時間に 2/24 ポイントずつ回復する', () => {
  const u = mkUser(1);
  assert.equal(config.points.cap, 2);
  assert.equal(balanceOf(u), 2);
  assert.ok(Math.abs(regenPerHour(u) - 2 / 24) < 1e-9);
  assert.deepEqual(
    { ...presentPoints(u), regenPerHour: undefined },
    { enabled: true, balance: 2, cap: 2, regenPerHour: undefined, burnPerHour: 0 }
  );
});

test('動かしている間は、メモリ(GB)×時間ぶん減る。1GB を1時間で、2 → 約 1.083', () => {
  const u = mkUser(2);
  mkRunning(u.id, 1024);
  assert.equal(burnPerHour(u.id), 1);
  advance(HOUR);
  assert.ok(Math.abs(getUser(u.id).points - (2 + (2 / 24 - 1))) < 1e-6, String(getUser(u.id).points));
});

test('メモリを大きくするほど、速く減る(512MB と 2GB を比べる)', () => {
  const a = mkUser(3);
  const b = mkUser(4);
  mkRunning(a.id, 512);
  mkRunning(b.id, 2048);
  advance(HOUR / 2);
  const lossA = 2 - getUser(a.id).points;
  const lossB = 2 - getUser(b.id).points;
  assert.ok(lossB > lossA * 3, `${lossA} / ${lossB}`);
});

test('動いていないときは回復する。上限(2)を超えては貯まらない', () => {
  const u = mkUser(5);
  updateUser(u.id, { points: 1 });
  advance(6 * HOUR);
  assert.ok(Math.abs(getUser(u.id).points - (1 + 6 * (2 / 24))) < 1e-6);
  advance(100 * HOUR);
  assert.equal(getUser(u.id).points, 2);
});

test('前回から長く空いていても、まとめては減らさない(1回の反映は最大 maxStepMs まで)', () => {
  const u = mkUser(6);
  mkRunning(u.id, 1024);
  const t0 = Date.now();
  settleAll(t0);
  settleAll(t0 + 10 * HOUR); // 既定の 60 秒までしか見ない
  assert.ok(getUser(u.id).points > 1.97, String(getUser(u.id).points));
});

test('0 になったら止める。残りがあるうちは止めない', () => {
  const u = mkUser(7);
  const p = mkRunning(u.id, 1024);
  assert.equal(stopReason(p), null);
  updateUser(u.id, { points: 0 });
  assert.match(stopReason(p), /ポイントがなくなったため停止します/);
  updateUser(u.id, { points: 0.5 });
  assert.equal(stopReason(p), null);
  // 動いていない(停止中・順番待ち)ものは、ここでは止めない
  updateUser(u.id, { points: 0 });
  assert.equal(stopReason({ ...p, status: 'stopped' }), null);
});

test('起動: 残りが足りないと QuotaError(回復までの目安つき)。足りていれば通る', () => {
  const u = mkUser(8);
  updateUser(u.id, { points: 0 });
  assert.throws(() => assertRunQuota(u.id, undefined, 1024), (e) => e instanceof QuotaError && /ポイントが足りません.*回復を待つか/.test(e.message));
  updateUser(u.id, { points: 2 });
  assert.doesNotThrow(() => assertRunQuota(u.id, undefined, 1024));
  // 大きいメモリほど、必要な残りが増える(2GB を5分 = 約 0.167pt)
  updateUser(u.id, { points: 0.1 });
  assert.equal(pointsShortage(getUser(u.id), 256), null); // 256MB の5分は 約 0.021pt
  assert.match(pointsShortage(getUser(u.id), 2048), /ポイントが足りません/);
});

test('尽きるまでの時間: メモリが大きいほど短い。回復が上回れば null', () => {
  const small = mkUser(9);
  const big = mkUser(10);
  mkRunning(small.id, 512);
  mkRunning(big.id, 1024);
  const a = secondsUntilEmpty(getUser(small.id));
  const b = secondsUntilEmpty(getUser(big.id));
  assert.ok(a > b * 2, `${a} / ${b}`);
  // 上限を 24 にすると、回復(毎時 1GB)が、512MB の消費(毎時 0.5GB)を上回るので、尽きない
  const rich = mkUser(11);
  updateUser(rich.id, { points_cap: 24 });
  mkRunning(rich.id, 512);
  assert.equal(secondsUntilEmpty(getUser(rich.id)), null);
});

test('人ごとの上限(points_cap)で、上限と回復の速さが変わる。null で既定に戻る', () => {
  const u = mkUser(12);
  const v = updateUser(u.id, { points_cap: 6 });
  assert.equal(presentPoints(v).cap, 6);
  assert.ok(Math.abs(regenPerHour(v) - 6 / 24) < 1e-9);
  assert.equal(presentPoints(updateUser(u.id, { points_cap: null })).cap, 2);
});

test('上限 0 は、ポイントの仕組み全体が無効', () => {
  const keep = config.points.cap;
  config.points.cap = 0;
  try {
    const u = mkUser(13);
    const p = mkRunning(u.id, 2048);
    updateUser(u.id, { points: 0 });
    settleAll(Date.now(), Infinity);
    assert.equal(stopReason(p), null);
    assert.equal(pointsShortage(getUser(u.id), 2048), null);
    assert.deepEqual(presentPoints(getUser(u.id)), { enabled: false });
  } finally {
    config.points.cap = keep;
  }
});

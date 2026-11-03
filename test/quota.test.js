import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-quota-'));
process.env.ADMIN_TOKEN = 'x';
process.env.MAX_RUNNING = '100';
process.env.MAX_RUNTIME_HOURS = '1';
process.env.IDLE_STOP_MINUTES = '10';

const { insertProject, updateProject, getProject, newId, upsertGithubUser, updateUser, limitsFor } =
  await import('../src/db.js');
const { startProject, assertRunQuota, userOccupied, QuotaError, stopReason } = await import('../src/manager.js');
const { encryptJson } = await import('../src/crypto.js');

const mkUser = (gid, status = 'approved') => {
  const u = upsertGithubUser({ githubId: gid, login: `u${gid}`, avatarUrl: null });
  return updateUser(u.id, { status });
};
const mkProject = (userId, status = 'created') => {
  const p = insertProject({
    id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000,
    envEnc: encryptJson({}), userId,
  });
  return status === 'created' ? p : updateProject(p.id, { status });
};

test('既定の上限は プロジェクト3件・同時起動1件。個別に変えられ、null で既定に戻る', () => {
  const u = mkUser(1);
  assert.deepEqual(limitsFor(u), { maxProjects: 3, maxRunning: 1 });
  const v = updateUser(u.id, { max_projects: 7, max_running: 2 });
  assert.deepEqual(limitsFor(v), { maxProjects: 7, maxRunning: 2 });
  const w = updateUser(u.id, { max_projects: null, max_running: null });
  assert.deepEqual(limitsFor(w), { maxProjects: 3, maxRunning: 1 });
  assert.throws(() => updateUser(u.id, { status: 'root' }));
  assert.throws(() => updateUser(u.id, { id: 99 }), /unknown column/);
});

test('同時起動: 1件動いていたら、2件目の起動は QuotaError。状態は変わらない', () => {
  const u = mkUser(2);
  mkProject(u.id, 'running');
  const second = mkProject(u.id);
  assert.throws(() => startProject(second.id), QuotaError);
  assert.equal(getProject(second.id).status, 'created');
});

test('ビルド中・順番待ちも「枠を使っている」に数える', () => {
  for (const [gid, st] of [[3, 'building'], [4, 'queued']]) {
    const u = mkUser(gid);
    mkProject(u.id, st);
    assert.equal(userOccupied(u.id), 1);
    assert.throws(() => assertRunQuota(u.id), QuotaError, st);
  }
});

test('止まっている・失敗したものは枠を使わない', () => {
  const u = mkUser(5);
  mkProject(u.id, 'stopped');
  mkProject(u.id, 'failed');
  assert.equal(userOccupied(u.id), 0);
  assert.doesNotThrow(() => assertRunQuota(u.id));
});

test('自分自身は数えない(動いているものの再ビルドは断られない)', () => {
  const u = mkUser(6);
  const p = mkProject(u.id, 'running');
  assert.doesNotThrow(() => assertRunQuota(u.id, p.id));
});

test('他の人の動いているものは、自分の枠に影響しない', () => {
  const a = mkUser(7);
  const b = mkUser(8);
  mkProject(a.id, 'running');
  assert.doesNotThrow(() => assertRunQuota(b.id));
});

test('個別に上限を増やすと、その分だけ起動できる', () => {
  const u = mkUser(9);
  updateUser(u.id, { max_running: 2 });
  mkProject(u.id, 'running');
  assert.doesNotThrow(() => assertRunQuota(u.id));
  mkProject(u.id, 'running');
  assert.throws(() => assertRunQuota(u.id), QuotaError);
});

test('持ち主のいないプロジェクトは、利用者の上限の対象外', () => {
  assert.doesNotThrow(() => assertRunQuota(null));
  assert.doesNotThrow(() => assertRunQuota(undefined));
});

test('stopReason: 承認済みでなくなった持ち主のものは止める / 最大稼働時間を超えたら止める', () => {
  const ok = mkUser(10);
  const bad = mkUser(11, 'suspended');
  const pending = mkUser(12, 'pending');
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();

  const fresh = updateProject(mkProject(ok.id, 'running').id, { started_at: recent });
  assert.equal(stopReason(fresh), null);

  const stale = updateProject(mkProject(ok.id, 'running').id, { started_at: old });
  assert.match(stopReason(stale), /最大稼働時間/);

  assert.match(stopReason(updateProject(mkProject(bad.id, 'running').id, { started_at: recent })), /アカウント/);
  assert.match(stopReason(updateProject(mkProject(pending.id, 'running').id, { started_at: recent })), /アカウント/);

  // 持ち主なしでも、稼働時間の上限は効く
  assert.match(stopReason(updateProject(mkProject(null, 'running').id, { started_at: old })), /最大稼働時間/);
  // 待機中は、稼働時間では止めない
  assert.equal(stopReason(mkProject(ok.id, 'queued')), null);
});

test('redact: 利用者に見せる文字列から、サーバー内部のフォルダの場所を伏せる', async () => {
  const { redact } = await import('../src/manager.js');
  const { config } = await import('../src/config.js');
  const msg = `Cloning into '${config.dataDir}/work/abc'... (${config.dataDir}/work/abc.home)`;
  const out = redact(msg);
  assert.ok(!out.includes(config.dataDir), out);
  assert.equal(out, "Cloning into '<data>/work/abc'... (<data>/work/abc.home)");
});

test('stopReason: 無操作が長く続いたら止める(最後の操作の時刻で数え、無ければ起動時刻から)', () => {
  const ok = mkUser(20);
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

  // 起動は30分前でも、5分前に操作があれば止めない
  const active = updateProject(mkProject(ok.id, 'running').id, { started_at: ago(30), last_active_at: ago(5) });
  assert.equal(stopReason(active), null);

  // 最後の操作が15分前なら止める
  const idle = updateProject(mkProject(ok.id, 'running').id, { started_at: ago(30), last_active_at: ago(15) });
  assert.match(stopReason(idle), /10分間操作がなかった/);

  // 操作の記録がなければ、起動時刻から数える
  const noRecord = updateProject(mkProject(ok.id, 'running').id, { started_at: ago(20) });
  assert.match(stopReason(noRecord), /操作がなかった/);
  assert.equal(stopReason(updateProject(mkProject(ok.id, 'running').id, { started_at: ago(3) })), null);

  // 待機中は対象外
  assert.equal(stopReason(updateProject(mkProject(ok.id, 'queued').id, { last_active_at: ago(60) })), null);
});

test('buildLimitOpts: ビルドにメモリ・CPU上限と、実行時と同じネットワークを使う', async () => {
  const { buildLimitOpts } = await import('../src/manager.js');
  const { config } = await import('../src/config.js');
  const o = buildLimitOpts();
  assert.equal(o.memory, config.limits.buildMemoryMb * 1024 * 1024);
  assert.equal(o.memswap, o.memory);
  assert.equal(o.cpuquota, config.limits.buildCpus * o.cpuperiod);
  assert.equal(o.networkmode, config.dockerNetwork);
});

test('counterDelta: 前回との差を返す。基準が無ければ0、数字が戻っていれば(再起動)今の値', async () => {
  const { counterDelta } = await import('../src/manager.js');
  assert.equal(counterDelta(undefined, 5_000_000), 0);
  assert.equal(counterDelta(1_000_000, 4_500_000), 3_500_000);
  assert.equal(counterDelta(9_000_000, 2_000_000), 2_000_000);
  assert.equal(counterDelta(3, 3), 0);
});

test('既定の実行時の上限: メモリ256MB・CPU 0.5・PID 128', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.limits.memoryMb, 256);
  assert.equal(config.limits.cpus, 0.5);
  assert.equal(config.limits.pids, 128);
});

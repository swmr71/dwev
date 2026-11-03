import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-persist-'));
process.env.ADMIN_TOKEN = 'x';
process.env.MAX_RUNNING = '100';
process.env.DATA_LIMIT_MB = '100';
process.env.STOPPED_KEEP_DAYS = '7';

const { DatabaseSync } = await import('node:sqlite');
const { insertProject, updateProject, getProject, newId } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const {
  setDockerForTest, stopProject, startProject, canResume, storageVerdict, sweepStorage, reconcile,
} = await import('../src/manager.js');
const { encryptJson } = await import('../src/crypto.js');

const err = (statusCode) => Object.assign(new Error(`docker ${statusCode}`), { statusCode });

// Docker の代わり。呼ばれた操作を calls に残す
function fakeDocker({ startError, stopError, list = [] } = {}) {
  const calls = [];
  return {
    calls,
    getContainer: (name) => ({
      start: async () => { calls.push(['start', name]); if (startError) throw startError; },
      stop: async () => { calls.push(['stop', name]); if (stopError) throw stopError; },
      remove: async () => { calls.push(['remove', name]); },
      inspect: async () => ({ Id: `id-of-${name}` }),
    }),
    getNetwork: () => ({ inspect: async () => ({}) }),
    listContainers: async () => list,
    getImage: () => ({ remove: async () => {} }),
  };
}

const mk = (fields = {}) =>
  updateProject(
    insertProject({
      id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000,
      envEnc: encryptJson({}), userId: null,
    }).id,
    fields
  );
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
// updated_at は updateProject が現在時刻にするので、古い印は別の接続から直接書き換える
const rawDb = new DatabaseSync(path.join(process.env.DATA_DIR, 'devbox.db'));
const setUpdatedAt = (id, iso) => rawDb.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(iso, id);

test('停止はコンテナを消さずに止める。container_id も残す(コンテナが無ければ空にする)', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  const p = mk({ status: 'running', container_id: 'cid1' });
  await stopProject(p.id);
  assert.deepEqual(d.calls.map((c) => c[0]), ['stop']); // remove は呼ばれない
  assert.equal(getProject(p.id).status, 'stopped');
  assert.equal(getProject(p.id).container_id, 'cid1');

  // すでに止まっている(304)でも失敗にしない / コンテナが無い(404)なら container_id は空に
  setDockerForTest(fakeDocker({ stopError: err(304) }));
  const q = mk({ status: 'running', container_id: 'cid2' });
  await stopProject(q.id);
  assert.equal(getProject(q.id).container_id, 'cid2');
  setDockerForTest(fakeDocker({ stopError: err(404) }));
  const r = mk({ status: 'running', container_id: 'cid3' });
  await stopProject(r.id);
  assert.equal(getProject(r.id).container_id, null);
});

test('canResume: 止まっていて、コンテナが残り、設定を変えていないときだけ', () => {
  assert.equal(canResume(mk({ status: 'stopped', container_id: 'c' })), true);
  assert.equal(canResume(mk({ status: 'stopped', container_id: 'c', dirty: 1 })), false);
  assert.equal(canResume(mk({ status: 'stopped', container_id: null })), false);
  assert.equal(canResume(mk({ status: 'running', container_id: 'c' })), false);
});

test('起動: 残っているコンテナは、ビルドせずに start で再開する', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  const p = mk({ status: 'stopped', container_id: 'old', keepalive_at: null });
  startProject(p.id);
  assert.ok(await waitFor(() => getProject(p.id).status === 'running'), '再開されない');
  assert.deepEqual(d.calls.map((c) => c[0]), ['start']); // 作り直し(remove)も、ビルドもしない
  const after = getProject(p.id);
  assert.equal(after.container_id, `id-of-devbox-${p.id}`);
  assert.ok(after.keepalive_at, '再開から数えて、確認の時刻が入る');
});

test('再開に失敗したら、コンテナは消さずに停止に戻し、エラーを残す', async () => {
  const d = fakeDocker({ startError: new Error('port is already allocated') });
  setDockerForTest(d);
  const p = mk({ status: 'stopped', container_id: 'old' });
  startProject(p.id);
  assert.ok(await waitFor(() => getProject(p.id).status === 'stopped' && getProject(p.id).error));
  assert.match(getProject(p.id).error, /port is already allocated/);
  assert.equal(getProject(p.id).container_id, 'old');
  assert.ok(!d.calls.some((c) => c[0] === 'remove'));
});

test('再ビルドの依頼・実行中への依頼は、次をビルドからにする(dirty)。順番待ちでも印は残る', () => {
  const keep = config.maxRunning;
  config.maxRunning = 0; // すぐ順番待ちにして、ビルドを走らせない
  try {
    const a = mk({ status: 'stopped', container_id: 'c' });
    startProject(a.id, { rebuild: true });
    assert.equal(getProject(a.id).dirty, 1);
    assert.equal(getProject(a.id).status, 'queued');
    assert.equal(canResume(getProject(a.id)), false);

    const b = mk({ status: 'running', container_id: 'c' });
    startProject(b.id); // 実行中のものへの依頼は、再ビルド
    assert.equal(getProject(b.id).dirty, 1);

    const c = mk({ status: 'stopped', container_id: 'c' });
    startProject(c.id); // ふつうの起動は、印を付けない
    assert.equal(getProject(c.id).dirty, 0);
  } finally {
    config.maxRunning = keep;
  }
});

test('storageVerdict: 書き込みが上限を超えたもの・停止から日数がたったものを消す', () => {
  const MB = 1024 * 1024;
  const stoppedNew = { status: 'stopped', updated_at: daysAgo(1) };
  assert.equal(storageVerdict(stoppedNew, 50 * MB), null);
  assert.match(storageVerdict(stoppedNew, 150 * MB), /上限\(100MB\)/);
  assert.match(storageVerdict({ status: 'stopped', updated_at: daysAgo(8) }, 1 * MB), /7日/);
  // 動いているものは、日数では消さない(上限は見る)
  assert.equal(storageVerdict({ status: 'running', updated_at: daysAgo(30) }, 1 * MB), null);
  assert.match(storageVerdict({ status: 'running', updated_at: daysAgo(0) }, 150 * MB), /上限/);
});

test('sweepStorage: 超えたものは(動いていれば止めてから)削除し、container_id を空にして理由を残す', async () => {
  const MB = 1024 * 1024;
  const big = mk({ status: 'running', container_id: 'c1' });
  const old = mk({ status: 'stopped', container_id: 'c2' });
  setUpdatedAt(old.id, daysAgo(8));
  const fine = mk({ status: 'stopped', container_id: 'c3' });
  const d = fakeDocker({
    list: [
      { Labels: { 'devbox.id': big.id }, SizeRw: 200 * MB },
      { Labels: { 'devbox.id': old.id }, SizeRw: 1 * MB },
      { Labels: { 'devbox.id': fine.id }, SizeRw: 1 * MB },
    ],
  });
  setDockerForTest(d);
  await sweepStorage();
  const names = (op) => d.calls.filter((c) => c[0] === op).map((c) => c[1]);
  assert.deepEqual(names('stop'), [`devbox-${big.id}`]);
  assert.ok(names('remove').includes(`devbox-${big.id}`));
  assert.equal(getProject(big.id).container_id, null);
  assert.match(getProject(big.id).error, /上限/);
  assert.equal(getProject(big.id).status, 'stopped');
  assert.ok(names('remove').includes(`devbox-${old.id}`)); // 停止から8日
  assert.equal(getProject(old.id).container_id, null);
  assert.match(getProject(old.id).error, /7日/);
  assert.ok(!names('remove').includes(`devbox-${fine.id}`));
  assert.equal(getProject(fine.id).container_id, 'c3');
});

test('reconcile: 実行中のはずが止まっていても、コンテナが残っていれば container_id を持ち続ける', async () => {
  const kept = mk({ status: 'running', container_id: 'k' });
  const gone = mk({ status: 'running', container_id: 'g' });
  const stale = mk({ status: 'stopped', container_id: 'z' });
  setDockerForTest({
    ...fakeDocker(),
    listContainers: async () => [{ Labels: { 'devbox.id': kept.id }, State: 'exited' }],
  });
  await reconcile();
  assert.equal(getProject(kept.id).status, 'stopped');
  assert.equal(getProject(kept.id).container_id, 'k');
  assert.equal(getProject(gone.id).container_id, null);
  assert.equal(getProject(stale.id).container_id, null); // 外で消されたコンテナは、再開できない
});

test('enforceStops: 最大稼働時間を超えたものを止める(コンテナは残す)。超えていないものは止めない', async () => {
  const { enforceStops } = await import('../src/manager.js');
  const d = fakeDocker();
  setDockerForTest(d);
  const keep = config.maxRuntimeHours;
  config.maxRuntimeHours = 1;
  try {
    const over = mk({ status: 'running', container_id: 'c-over', started_at: new Date(Date.now() - 61 * 60_000).toISOString() });
    const fine = mk({ status: 'running', container_id: 'c-fine', started_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    await enforceStops();
    assert.equal(getProject(over.id).status, 'stopped');
    assert.equal(getProject(over.id).container_id, 'c-over');
    assert.equal(getProject(fine.id).status, 'running');
    assert.deepEqual(d.calls.filter((c) => c[0] === 'stop').map((c) => c[1]), [`devbox-${over.id}`]);
    assert.ok(!d.calls.some((c) => c[0] === 'remove'));
  } finally {
    config.maxRuntimeHours = keep;
  }
});

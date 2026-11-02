import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-queue-'));
process.env.ADMIN_TOKEN = 'x';
process.env.MAX_RUNNING = '2';

const { insertProject, updateProject, getProject, newId } = await import('../src/db.js');
const { startProject, stopProject, activeCount, queuePosition, queueOrder, isBusy } = await import('../src/manager.js');
const { encryptJson } = await import('../src/crypto.js');

const make = (name) =>
  insertProject({ id: newId(), name, repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000, envEnc: encryptJson({}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('上限に達していると、起動の依頼は「待機中」になり、順番がつく', async () => {
  const a = make('a');
  const b = make('b');
  updateProject(a.id, { status: 'running' });
  updateProject(b.id, { status: 'building' });
  assert.equal(activeCount(), 2);

  const c = make('c');
  const d = make('d');
  startProject(c.id);
  await sleep(5);
  startProject(d.id);

  assert.equal(getProject(c.id).status, 'queued');
  assert.equal(getProject(d.id).status, 'queued');
  assert.ok(!isBusy(c.id) && !isBusy(d.id), '待機中はビルドを始めない');
  assert.equal(queuePosition(c.id), 1);
  assert.equal(queuePosition(d.id), 2);
  assert.deepEqual(queueOrder().map((p) => p.id), [c.id, d.id]);
  assert.equal(activeCount(), 2, '待機中は稼働数に数えない');
});

test('すでに待機中のものを再度依頼しても、順番は変わらない', async () => {
  const p = make('e');
  const q1 = make('f');
  updateProject(make('g').id, { status: 'running' });
  updateProject(make('h').id, { status: 'running' });
  startProject(q1.id);
  const before = getProject(q1.id).queued_at;
  await sleep(5);
  startProject(q1.id);
  assert.equal(getProject(q1.id).queued_at, before);
  assert.ok(p);
});

test('待機中の取り消し: 停止になり、順番から外れる', async () => {
  const w = make('w');
  startProject(w.id);
  assert.equal(getProject(w.id).status, 'queued');
  await stopProject(w.id);
  assert.equal(getProject(w.id).status, 'stopped');
  assert.equal(getProject(w.id).queued_at, null);
  assert.equal(queuePosition(w.id), null);
});

test('自分自身は上限の数に含めない(稼働中の再ビルドは待たされない)', () => {
  const r = make('r');
  updateProject(r.id, { status: 'running' });
  const others = [make('o1'), make('o2')];
  for (const o of others) updateProject(o.id, { status: 'running' });
  assert.equal(activeCount(r.id), activeCount() - 1);
});

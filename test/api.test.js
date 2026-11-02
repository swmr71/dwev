import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_TOKEN = 'test-token';
process.env.PREVIEW_HOST_TEMPLATE = '{id}-dev.example.com';
process.env.PREVIEW_SCHEME = 'https';

const { app } = await import('../src/server.js');
const { dockerPing } = await import('../src/manager.js');
const { decryptJson, encryptJson } = await import('../src/crypto.js');
const { getProject } = await import('../src/db.js');

let server;
let base;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };
const call = (method, p, body, headers = H) =>
  fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const valid = {
  name: 'demo',
  repoUrl: 'https://github.com/octocat/Hello-World',
  branch: 'main',
  port: 3000,
  env: { API_KEY: 'super-secret-value' },
  autoStart: false,
};

test('crypto: round trip & tamper detection', () => {
  const enc = encryptJson({ A: '1' });
  assert.deepEqual(decryptJson(enc), { A: '1' });
  const parts = enc.split('.');
  parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptJson(parts.join('.')));
});

test('info endpoint reports limits and DNS automation off by default', async () => {
  const r = await call('GET', '/api/info');
  assert.equal(r.status, 200);
  const i = await r.json();
  assert.equal(i.maxRunning, 30);
  assert.equal(i.dnsAutomation, false);
  assert.equal(typeof i.active, 'number');
});

test('healthz is public', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('API requires the admin token', async () => {
  assert.equal((await call('GET', '/api/projects', null, {})).status, 401);
  assert.equal((await call('GET', '/api/projects', null, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call('GET', '/api/projects')).status, 200);
});

test('input validation rejects dangerous values', async () => {
  const bad = [
    { repoUrl: 'http://github.com/a/b' }, // http
    { repoUrl: 'https://evil.example.com/a/b' }, // 許可外ホスト
    { repoUrl: 'https://user:pw@github.com/a/b' }, // 認証情報つき
    { repoUrl: 'https://github.com/a/b;rm -rf /' },
    { repoUrl: 'file:///etc/passwd' },
    { repoUrl: 'https://169.254.169.254/a/b' },
    { branch: '--upload-pack=evil' }, // オプション注入
    { branch: '../../etc' },
    { branch: 'a b' },
    { port: 0 },
    { port: 70000 },
    { port: 'abc' },
    { env: { 'bad key': 'x' } },
    { env: { PORT: '1' } }, // 予約済み
    { env: { A: { nested: 1 } } },
    { env: ['A=1'] },
    { name: '' },
    { name: 'x'.repeat(41) },
  ];
  for (const patch of bad) {
    const r = await call('POST', '/api/projects', { ...valid, ...patch });
    assert.equal(r.status, 400, `should reject ${JSON.stringify(patch)} (got ${r.status})`);
  }
});

let createdId;
test('create: env values are never returned and are encrypted at rest', async () => {
  const r = await call('POST', '/api/projects', valid);
  assert.equal(r.status, 201);
  const body = await r.json();
  createdId = body.id;
  assert.match(body.id, /^[0-9a-f]{10}$/);
  assert.equal(body.repoUrl, 'https://github.com/octocat/Hello-World.git');
  assert.deepEqual(body.envKeys, ['API_KEY']);
  assert.equal(body.previewUrl, `https://${body.id}-dev.example.com`);
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));

  const row = getProject(body.id);
  assert.ok(!row.env_enc.includes('super-secret-value'));
  assert.deepEqual(decryptJson(row.env_enc), { API_KEY: 'super-secret-value' });

  const list = await (await call('GET', '/api/projects')).json();
  assert.ok(!JSON.stringify(list).includes('super-secret-value'));
});

test('patch updates fields and re-encrypts env', async () => {
  const r = await call('PATCH', `/api/projects/${createdId}`, { branch: 'dev', env: { A: '1', B: '2' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.branch, 'dev');
  assert.deepEqual(body.envKeys, ['A', 'B']);
  const bad = await call('PATCH', `/api/projects/${createdId}`, { branch: '-x' });
  assert.equal(bad.status, 400);
});

test('unknown / malformed ids return 404', async () => {
  assert.equal((await call('GET', '/api/projects/0000000000')).status, 404);
  assert.equal((await call('GET', '/api/projects/..%2F..%2Fetc')).status, 404);
  assert.equal((await call('GET', '/api/projects/x')).status, 404);
});

test('build-log endpoint returns empty log for a never-started project', async () => {
  const r = await call('GET', `/api/projects/${createdId}/build-log?offset=0`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: '', offset: 0 });
});

test('malformed JSON and oversized bodies are handled', async () => {
  const r = await fetch(base + '/api/projects', { method: 'POST', headers: H, body: '{bad' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/projects', {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'x'.repeat(100_000) }),
  });
  assert.equal(big.status, 413);
});

test('project limit is enforced', async () => {
  // 既定の上限は10。残りを埋めて 429 になることを確認
  let last;
  for (let i = 0; i < 12; i++) {
    last = await call('POST', '/api/projects', { ...valid, name: `p${i}` });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
});

test('delete removes the project (requires a Docker daemon)', { skip: !(await dockerPing()) && 'Docker daemon not available' }, async () => {
  const r = await call('DELETE', `/api/projects/${createdId}`);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `/api/projects/${createdId}`)).status, 404);
});

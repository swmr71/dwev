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
delete process.env.PUBLIC_URL; // Cookie 名を素の名前にする(HTTPSでない)

const { app } = await import('../src/server.js');
const { dockerPing } = await import('../src/manager.js');
const { decryptJson, encryptJson } = await import('../src/crypto.js');
const { getProject, upsertGithubUser, updateUser, createSession, getUser, updateProject } = await import('../src/db.js');
const { SESSION_COOKIE } = await import('../src/auth.js');

let server;
let base;
const json = { 'Content-Type': 'application/json' };
const ADMIN = { ...json, Authorization: 'Bearer test-token' };

// 利用者を作って、ログイン済みの状態(Cookie)にする
function makeUser(githubId, login, status = 'approved') {
  const u = upsertGithubUser({ githubId, login, avatarUrl: null });
  if (status !== 'pending') updateUser(u.id, { status });
  const { token } = createSession(u.id);
  return { id: u.id, headers: { ...json, Cookie: `${SESSION_COOKIE}=${token}` } };
}

const call = (method, p, body, headers) =>
  fetch(base + p, { method, headers: headers || {}, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch {} // Windows では SQLite のファイルが開いたままで消せない
});

const valid = {
  name: 'demo',
  repoUrl: 'https://github.com/octocat/Hello-World',
  branch: 'main',
  port: 3000,
  env: { API_KEY: 'super-secret-value' },
  autoStart: false,
};

const alice = makeUser(1001, 'alice');
const bob = makeUser(1002, 'bob');
const pending = makeUser(1003, 'carol', 'pending');
const banned = makeUser(1004, 'dave', 'suspended');

test('crypto: round trip & tamper detection', () => {
  const enc = encryptJson({ A: '1' });
  assert.deepEqual(decryptJson(enc), { A: '1' });
  const parts = enc.split('.');
  parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptJson(parts.join('.')));
});

test('healthz is public', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('ログインしていないと、利用者向けAPIは 401 (code=login)', async () => {
  for (const p of ['/api/me', '/api/info', '/api/projects']) {
    const r = await call('GET', p);
    assert.equal(r.status, 401, p);
    assert.equal((await r.json()).code, 'login');
  }
  // 壊れた Cookie でも 401
  assert.equal((await call('GET', '/api/me', null, { Cookie: `${SESSION_COOKIE}=nope` })).status, 401);
});

test('承認待ち・凍結のアカウントは、自分の状態は見えるが、プロジェクトは操作できない', async () => {
  const me = await call('GET', '/api/me', null, pending.headers);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).status, 'pending');

  assert.equal((await call('GET', '/api/projects', null, pending.headers)).status, 403);
  const post = await call('POST', '/api/projects', valid, pending.headers);
  assert.equal(post.status, 403);
  assert.equal((await post.json()).code, 'pending');

  const b = await call('POST', '/api/projects', valid, banned.headers);
  assert.equal(b.status, 403);
  assert.equal((await b.json()).code, 'suspended');
});

test('管理者用APIは、管理トークンが必要(利用者のログインでは入れない)', async () => {
  assert.equal((await call('GET', '/api/admin/users')).status, 401);
  assert.equal((await call('GET', '/api/admin/users', null, alice.headers)).status, 401);
  assert.equal((await call('GET', '/api/admin/users', null, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call('GET', '/api/admin/users', null, ADMIN)).status, 200);
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
    const r = await call('POST', '/api/projects', { ...valid, ...patch }, alice.headers);
    assert.equal(r.status, 400, `should reject ${JSON.stringify(patch)} (got ${r.status})`);
  }
});

let aliceProject;
test('create: env values are never returned and are encrypted at rest', async () => {
  const r = await call('POST', '/api/projects', valid, alice.headers);
  assert.equal(r.status, 201);
  const body = await r.json();
  aliceProject = body.id;
  assert.match(body.id, /^[0-9a-f]{10}$/);
  assert.equal(body.repoUrl, 'https://github.com/octocat/Hello-World.git');
  assert.deepEqual(body.envKeys, ['API_KEY']);
  assert.equal(body.previewUrl, `https://${body.id}-dev.example.com`);
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));

  const row = getProject(body.id);
  assert.equal(row.user_id, alice.id, '持ち主が記録される');
  assert.ok(!row.env_enc.includes('super-secret-value'));
  assert.deepEqual(decryptJson(row.env_enc), { API_KEY: 'super-secret-value' });

  const list = await (await call('GET', '/api/projects', null, alice.headers)).json();
  assert.ok(!JSON.stringify(list).includes('super-secret-value'));
});

test('patch updates fields and re-encrypts env', async () => {
  const r = await call('PATCH', `/api/projects/${aliceProject}`, { branch: 'dev', env: { A: '1', B: '2' } }, alice.headers);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.branch, 'dev');
  assert.deepEqual(body.envKeys, ['A', 'B']);
  const bad = await call('PATCH', `/api/projects/${aliceProject}`, { branch: '-x' }, alice.headers);
  assert.equal(bad.status, 400);
});

test('他人のプロジェクトは、一覧に出ず、見ることも操作することもできない(404)', async () => {
  const mine = await (await call('GET', '/api/projects', null, bob.headers)).json();
  assert.deepEqual(mine, [], 'bob の一覧に alice のものは出ない');

  const id = aliceProject;
  const cases = [
    ['GET', `/api/projects/${id}`],
    ['PATCH', `/api/projects/${id}`, { name: 'hijack' }],
    ['POST', `/api/projects/${id}/start`],
    ['POST', `/api/projects/${id}/stop`],
    ['DELETE', `/api/projects/${id}`],
    ['GET', `/api/projects/${id}/build-log?offset=0`],
    ['GET', `/api/projects/${id}/runtime-log`],
  ];
  for (const [m, p, b] of cases) {
    const r = await call(m, p, b, bob.headers);
    assert.equal(r.status, 404, `${m} ${p} → ${r.status}`);
  }
  assert.equal(getProject(id).name, 'demo', '書き換えられていない');
  assert.ok(getProject(id), '消されていない');
});

test('管理者は、全員のプロジェクトを持ち主つきで見られる', async () => {
  const all = await (await call('GET', '/api/admin/projects', null, ADMIN)).json();
  const p = all.find((x) => x.id === aliceProject);
  assert.equal(p.owner, 'alice');
});

test('unknown / malformed ids return 404', async () => {
  assert.equal((await call('GET', '/api/projects/0000000000', null, alice.headers)).status, 404);
  assert.equal((await call('GET', '/api/projects/..%2F..%2Fetc', null, alice.headers)).status, 404);
  assert.equal((await call('GET', '/api/projects/x', null, alice.headers)).status, 404);
});

test('build-log endpoint returns empty log for a never-started project', async () => {
  const r = await call('GET', `/api/projects/${aliceProject}/build-log?offset=0`, null, alice.headers);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: '', offset: 0 });
});

test('malformed JSON and oversized bodies are handled', async () => {
  const r = await fetch(base + '/api/projects', { method: 'POST', headers: alice.headers, body: '{bad' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/projects', {
    method: 'POST', headers: alice.headers, body: JSON.stringify({ name: 'x'.repeat(100_000) }),
  });
  assert.equal(big.status, 413);
});

test('プロジェクト数の上限は利用者ごと(既定3件)。他の人の枠は減らない。管理者が人ごとに変えられる', async () => {
  // alice は demo で1件。あと2件作れて、4件目は 429
  assert.equal((await call('POST', '/api/projects', { ...valid, name: 'p2' }, alice.headers)).status, 201);
  assert.equal((await call('POST', '/api/projects', { ...valid, name: 'p3' }, alice.headers)).status, 201);
  const over = await call('POST', '/api/projects', { ...valid, name: 'p4' }, alice.headers);
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /3 件/);

  // bob は影響を受けない
  assert.equal((await call('POST', '/api/projects', { ...valid, name: 'b1' }, bob.headers)).status, 201);

  // 管理者が alice の上限を5件にすると作れる
  const up = await call('PATCH', `/api/admin/users/${alice.id}`, { maxProjects: 5 }, ADMIN);
  assert.equal(up.status, 200);
  assert.equal((await up.json()).limits.maxProjects, 5);
  assert.equal((await call('POST', '/api/projects', { ...valid, name: 'p4' }, alice.headers)).status, 201);

  // 空にすると既定値(3件)に戻る
  const back = await call('PATCH', `/api/admin/users/${alice.id}`, { maxProjects: null }, ADMIN);
  assert.equal((await back.json()).limits.maxProjects, 3);
});

test('同時起動の上限(既定1件): 上限に達していると、作成して起動も、起動も、409で断られる', async () => {
  const carol = makeUser(1010, 'erin');
  const first = await (await call('POST', '/api/projects', { ...valid, name: 'e1' }, carol.headers)).json();
  const second = await (await call('POST', '/api/projects', { ...valid, name: 'e2' }, carol.headers)).json();
  updateProject(first.id, { status: 'running' }); // 1件、動いている状態にする(Docker は使わない)

  const start = await call('POST', `/api/projects/${second.id}/start`, null, carol.headers);
  assert.equal(start.status, 409);
  assert.match((await start.json()).error, /同時に起動できるのは 1 件/);
  assert.equal(getProject(second.id).status, 'created', '起動は始まっていない');

  // 作成と同時に起動(autoStart 既定)も、先に断られて、プロジェクトは作られない
  const before = (await (await call('GET', '/api/projects', null, carol.headers)).json()).length;
  const auto = await call('POST', '/api/projects', { ...valid, name: 'e3', autoStart: undefined }, carol.headers);
  assert.equal(auto.status, 409);
  const after = (await (await call('GET', '/api/projects', null, carol.headers)).json()).length;
  assert.equal(after, before, '断られたら作られない');
});

test('管理者API: 入力の検証', async () => {
  const id = alice.id;
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { status: 'root' }, ADMIN)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { maxProjects: -1 }, ADMIN)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { maxProjects: 101 }, ADMIN)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { maxRunning: 'abc' }, ADMIN)).status, 400);
  assert.equal((await call('PATCH', '/api/admin/users/999999', { status: 'approved' }, ADMIN)).status, 404);
  assert.equal((await call('PATCH', '/api/admin/users/abc', { status: 'approved' }, ADMIN)).status, 404);
});

test('承認: 承認待ちの人を承認すると、使えるようになる', async () => {
  assert.equal((await call('GET', '/api/projects', null, pending.headers)).status, 403);
  const r = await call('PATCH', `/api/admin/users/${pending.id}`, { status: 'approved' }, ADMIN);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/projects', null, pending.headers)).status, 200);
});

test('凍結すると、ログインが無効になる(セッションが消える)', async () => {
  const victim = makeUser(1020, 'frank');
  assert.equal((await call('GET', '/api/me', null, victim.headers)).status, 200);
  const r = await call('PATCH', `/api/admin/users/${victim.id}`, { status: 'suspended' }, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(getUser(victim.id).status, 'suspended');
  assert.equal((await call('GET', '/api/me', null, victim.headers)).status, 401, 'セッションは無効');
});

test('CSRF対策: 別のサイト・同じドメインの別ホスト(プレビュー)からの変更系リクエストは断る', async () => {
  const host = new URL(base).host;
  const withHdr = (extra) => ({ ...alice.headers, ...extra });
  const body = { name: 'renamed' };
  const url = `/api/projects/${aliceProject}`;

  // 別のホストからのリクエスト (プレビュー {id}-dev.example.com を想定)
  assert.equal((await call('PATCH', url, body, withHdr({ Origin: 'https://x-dev.example.com' }))).status, 403);
  assert.equal((await call('PATCH', url, body, withHdr({ 'Sec-Fetch-Site': 'same-site' }))).status, 403);
  assert.equal((await call('PATCH', url, body, withHdr({ 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  assert.equal(getProject(aliceProject).name, 'demo');

  // 同じ出どころなら通る
  assert.equal(
    (await call('PATCH', url, body, withHdr({ Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' }))).status,
    200
  );
  assert.equal(getProject(aliceProject).name, 'renamed');

  // 読み取り(GET)は、別ホストからでも判定はしない(ただし CORS ヘッダーを返さないので、中身は読めない)
  const g = await call('GET', url, null, withHdr({ Origin: 'https://x-dev.example.com' }));
  assert.equal(g.headers.get('access-control-allow-origin'), null);
});

test('API の応答はキャッシュさせない', async () => {
  const r = await call('GET', '/api/me', null, alice.headers);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('delete removes the project (requires a Docker daemon)', { skip: !(await dockerPing()) && 'Docker daemon not available' }, async () => {
  const r = await call('DELETE', `/api/projects/${aliceProject}`, null, alice.headers);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `/api/projects/${aliceProject}`, null, alice.headers)).status, 404);
});

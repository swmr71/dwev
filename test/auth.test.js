import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-auth-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_TOKEN = 'test-token';
process.env.PUBLIC_URL = 'https://devbox.example.com';
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';

const { app } = await import('../src/server.js');
const { getUser, updateUser, getSessionUser } = await import('../src/db.js');
const { SESSION_COOKIE, STATE_COOKIE } = await import('../src/auth.js');

// GitHub への通信だけ差し替える(それ以外は本物の fetch)
const realFetch = globalThis.fetch;
let ghUser;
let tokenOk;
let calls;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === 'https://github.com/login/oauth/access_token') {
    calls.push({ url: u, body: JSON.parse(init.body) });
    return Response.json(tokenOk ? { access_token: 'gho_fake' } : { error: 'bad_verification_code' });
  }
  if (u === 'https://api.github.com/user') {
    calls.push({ url: u, auth: init.headers.Authorization });
    return Response.json(ghUser);
  }
  return realFetch(url, init);
};

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch {} // Windows では SQLite のファイルが開いたままで消せない
});

const reset = () => {
  ghUser = { id: 4242, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/4242' };
  tokenOk = true;
  calls = [];
};

const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
// Set-Cookie から name=value と属性を取り出す
const setCookies = (r) => r.headers.getSetCookie();
const cookieValue = (r, name) => {
  const line = setCookies(r).find((c) => c.startsWith(name + '='));
  return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
};

// ログイン開始→コールバックまでを通す
async function login() {
  const start = await get('/auth/github');
  const state = cookieValue(start, STATE_COOKIE);
  const cb = await get(`/auth/github/callback?code=abc&state=${state}`, { Cookie: `${STATE_COOKIE}=${state}` });
  return { start, cb };
}

test('Cookie 名は HTTPS のとき __Host- つき', () => {
  assert.equal(SESSION_COOKIE, '__Host-devbox_session');
  assert.equal(STATE_COOKIE, '__Host-devbox_oauth');
});

test('/auth/github: GitHub の認可画面へ。state を発行し、シークレットは URL に出さない', async () => {
  reset();
  const r = await get('/auth/github');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'test-client-id');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://devbox.example.com/auth/github/callback');
  const state = loc.searchParams.get('state');
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.ok(!loc.toString().includes('test-client-secret'));

  const line = setCookies(r).find((c) => c.startsWith(STATE_COOKIE + '='));
  assert.ok(line, 'state が Cookie にも入る');
  assert.equal(cookieValue(r, STATE_COOKIE), state);
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(line.includes(attr), attr);
  assert.ok(!/Domain=/i.test(line), 'Domain を付けない(__Host- の条件)');
});

test('コールバック: state が無い・違うと拒否。ユーザーも作られない', async () => {
  reset();
  const noCookie = await get('/auth/github/callback?code=abc&state=zzz');
  assert.equal(noCookie.status, 400);
  const wrong = await get('/auth/github/callback?code=abc&state=zzz', { Cookie: `${STATE_COOKIE}=different` });
  assert.equal(wrong.status, 400);
  const noState = await get('/auth/github/callback?code=abc', { Cookie: `${STATE_COOKIE}=x` });
  assert.equal(noState.status, 400);
  assert.equal(calls.length, 0, 'GitHub には問い合わせない');
  assert.equal(getUser(1), undefined);
});

test('コールバック: GitHub 側でキャンセルされた(code なし)', async () => {
  reset();
  const state = 's'.repeat(32);
  const r = await get(`/auth/github/callback?error=access_denied&state=${state}`, { Cookie: `${STATE_COOKIE}=${state}` });
  assert.equal(r.status, 400);
});

test('初回ログイン: 「承認待ち」で作られ、安全な属性のセッション Cookie が発行される', async () => {
  reset();
  const { cb } = await login();
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/');

  // GitHub への問い合わせ内容
  assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(calls[0].body.client_secret, 'test-client-secret');
  assert.equal(calls[0].body.redirect_uri, 'https://devbox.example.com/auth/github/callback');
  assert.equal(calls[1].auth, 'Bearer gho_fake');

  const line = setCookies(cb).find((c) => c.startsWith(SESSION_COOKIE + '='));
  assert.ok(line);
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(line.includes(attr), attr);
  assert.ok(!/Domain=/i.test(line));
  // state の Cookie は使い終わったので消す
  assert.ok(setCookies(cb).some((c) => c.startsWith(STATE_COOKIE + '=;') && c.includes('Max-Age=0')));

  const token = cookieValue(cb, SESSION_COOKIE);
  assert.ok(token.length >= 40);
  const user = getSessionUser(token);
  assert.equal(user.login, 'octocat');
  assert.equal(user.status, 'pending', '最初は承認待ち');
  assert.equal(user.avatar_url, 'https://avatars.githubusercontent.com/u/4242');

  // 画面からは、承認待ちとして見える
  const me = await fetch(base + '/api/me', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.status, 'pending');
  assert.deepEqual(body.limits, { maxProjects: 3, maxRunning: 1, memoryBudgetMb: 512 });
  const post = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', repoUrl: 'https://github.com/a/b' }),
  });
  assert.equal(post.status, 403);
});

test('2回目のログイン: 同じ人として扱い、名前は更新、承認状態は変えない', async () => {
  reset();
  const first = getSessionUser(cookieValue((await login()).cb, SESSION_COOKIE));
  updateUser(first.id, { status: 'approved' });

  ghUser = { ...ghUser, login: 'octocat-renamed' };
  const second = getSessionUser(cookieValue((await login()).cb, SESSION_COOKIE));
  assert.equal(second.id, first.id, '同じ GitHub ID なら同じ利用者');
  assert.equal(second.login, 'octocat-renamed');
  assert.equal(second.status, 'approved', '勝手に承認待ちへ戻らない');

  // 凍結された人が再ログインしても、凍結のまま
  updateUser(first.id, { status: 'suspended' });
  const third = getSessionUser(cookieValue((await login()).cb, SESSION_COOKIE));
  assert.equal(third.status, 'suspended');
});

test('GitHub がエラーを返したら、ログインさせない(Cookie も出さない)', async () => {
  reset();
  tokenOk = false;
  const { cb } = await login();
  assert.equal(cb.status, 502);
  assert.equal(cookieValue(cb, SESSION_COOKIE), null);
});

test('GitHub のユーザー情報が不正なら、拒否する。アバターは GitHub 以外のURLなら保存しない', async () => {
  reset();
  ghUser = { id: 5, login: '../evil', avatar_url: 'https://avatars.githubusercontent.com/u/5' };
  assert.equal((await login()).cb.status, 502);
  ghUser = { id: 'not-a-number', login: 'ok', avatar_url: null };
  assert.equal((await login()).cb.status, 502);

  ghUser = { id: 6, login: 'sneaky', avatar_url: 'https://evil.example.com/a.png' };
  const { cb } = await login();
  assert.equal(cb.status, 302);
  assert.equal(getSessionUser(cookieValue(cb, SESSION_COOKIE)).avatar_url, null);
});

test('ログアウト: セッションが消え、別サイトからのログアウト要求は断る', async () => {
  reset();
  const token = cookieValue((await login()).cb, SESSION_COOKIE);
  const headers = { Cookie: `${SESSION_COOKIE}=${token}` };
  assert.equal((await fetch(base + '/api/me', { headers })).status, 200);

  const cross = await fetch(base + '/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'https://x-dev.example.com' } });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(base + '/api/me', { headers })).status, 200, '断られたのでまだ有効');

  const out = await fetch(base + '/auth/logout', { method: 'POST', headers });
  assert.equal(out.status, 200);
  assert.equal((await fetch(base + '/api/me', { headers })).status, 401);
  assert.equal(getSessionUser(token), null);
});

test('同じ Cookie 名が複数あっても、最初のものだけを使う(別ホストから送り込まれても影響しない)', async () => {
  reset();
  const token = cookieValue((await login()).cb, SESSION_COOKIE);
  const r = await fetch(base + '/api/me', { headers: { Cookie: `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=attacker` } });
  assert.equal(r.status, 200);
  const r2 = await fetch(base + '/api/me', { headers: { Cookie: `${SESSION_COOKIE}=attacker; ${SESSION_COOKIE}=${token}` } });
  assert.equal(r2.status, 401, '最初の値が不正なら、ログインしていない扱い');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-ghtoken-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_TOKEN = 'x';
process.env.PUBLIC_URL = 'https://devbox.example.com';
process.env.GITHUB_CLIENT_ID = 'Iv1.test';
process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_APP_SLUG = 'devbox-test-app';

const { app } = await import('../src/server.js');
const { config } = await import('../src/config.js');
const { upsertGithubUser, updateUser, getUser, createSession } = await import('../src/db.js');
const { SESSION_COOKIE, STATE_COOKIE } = await import('../src/auth.js');
const { saveTokens, getAccessToken, clearToken, hasToken, privateReposEnabled, installUrl } = await import('../src/ghtoken.js');
const { gitAuthEnv, scrubToken } = await import('../src/manager.js');
const { DatabaseSync } = await import('node:sqlite');

// GitHub への通信だけ差し替える
const realFetch = globalThis.fetch;
let refreshCalls = [];
let refreshReply;
let userInfo = { id: 7001, login: 'privuser', avatar_url: 'https://avatars.githubusercontent.com/u/7001' };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(init.body);
    if (body.grant_type === 'refresh_token') {
      refreshCalls.push(body);
      await new Promise((r) => setTimeout(r, 20)); // 同時の呼び出しが重なるように
      return Response.json(refreshReply);
    }
    return Response.json({
      access_token: 'ghu_login_access', expires_in: 28800,
      refresh_token: 'ghr_login_refresh', refresh_token_expires_in: 15811200,
    });
  }
  if (u === 'https://api.github.com/user') return Response.json(userInfo);
  return realFetch(url, init);
};

let server;
let base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch {} // Windows では SQLite のファイルが開いたままで消せない
});

const mkUser = (gid) => {
  const u = upsertGithubUser({ githubId: gid, login: `g${gid}`, avatarUrl: null });
  updateUser(u.id, { status: 'approved' });
  return u;
};
const HOUR = 3_600_000;

test('有効になるのは、GITHUB_APP_SLUG がそろったとき。インストール画面のURLも出る', () => {
  assert.equal(privateReposEnabled(), true);
  assert.equal(installUrl(), 'https://github.com/apps/devbox-test-app/installations/new');
  const keep = config.github.appSlug;
  config.github.appSlug = '';
  try {
    assert.equal(privateReposEnabled(), false);
    const u = mkUser(1);
    saveTokens(u.id, { access_token: 'ghu_x' }); // 無効のときは、保存しない
    assert.equal(hasToken(getUser(u.id)), false);
  } finally {
    config.github.appSlug = keep;
  }
});

test('保存したトークンは暗号化されていて、期限内ならそのまま返す', async () => {
  const u = mkUser(2);
  saveTokens(u.id, { access_token: 'ghu_plain_secret', expires_in: 28800, refresh_token: 'ghr_plain_refresh' });
  assert.equal(hasToken(getUser(u.id)), true);
  const raw = new DatabaseSync(path.join(tmp, 'devbox.db')).prepare('SELECT gh_token_enc FROM users WHERE id = ?').get(u.id);
  assert.doesNotMatch(raw.gh_token_enc, /ghu_plain_secret|ghr_plain_refresh/);
  assert.equal(await getAccessToken(u.id), 'ghu_plain_secret');
  clearToken(u.id);
  assert.equal(await getAccessToken(u.id), null);
});

test('期限が近いときは、リフレッシュトークンで更新して、新しいトークンを保存する', async () => {
  const u = mkUser(3);
  saveTokens(u.id, { access_token: 'ghu_old', expires_in: 28800, refresh_token: 'ghr_old', refresh_token_expires_in: 15811200 });
  refreshCalls = [];
  refreshReply = { access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 15811200 };
  const later = Date.now() + 8 * HOUR; // 8時間後(期限切れ)
  assert.equal(await getAccessToken(u.id, later), 'ghu_new');
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].refresh_token, 'ghr_old');
  assert.equal(refreshCalls[0].grant_type, 'refresh_token');
  assert.equal(refreshCalls[0].client_id, 'Iv1.test');
  // 更新後は、新しいリフレッシュトークンが使われる(期限内なら、更新しない)
  assert.equal(await getAccessToken(u.id, Date.now() + HOUR), 'ghu_new');
  assert.equal(refreshCalls.length, 1);
});

test('同じ人の更新が同時に走っても、リフレッシュは1回だけ', async () => {
  const u = mkUser(4);
  saveTokens(u.id, { access_token: 'ghu_a', expires_in: 28800, refresh_token: 'ghr_a', refresh_token_expires_in: 15811200 });
  refreshCalls = [];
  refreshReply = { access_token: 'ghu_b', expires_in: 28800, refresh_token: 'ghr_b', refresh_token_expires_in: 15811200 };
  const later = Date.now() + 8 * HOUR;
  const got = await Promise.all([getAccessToken(u.id, later), getAccessToken(u.id, later), getAccessToken(u.id, later)]);
  assert.deepEqual(got, ['ghu_b', 'ghu_b', 'ghu_b']);
  assert.equal(refreshCalls.length, 1);
});

test('更新に失敗(取り消し・期限切れ)したら、トークンを捨てて null。通信の失敗なら、捨てない', async () => {
  const u = mkUser(5);
  saveTokens(u.id, { access_token: 'ghu_c', expires_in: 28800, refresh_token: 'ghr_c', refresh_token_expires_in: 15811200 });
  refreshReply = { error: 'bad_refresh_token' };
  assert.equal(await getAccessToken(u.id, Date.now() + 8 * HOUR), null);
  assert.equal(hasToken(getUser(u.id)), false);

  // リフレッシュトークンも期限切れ
  const v = mkUser(6);
  saveTokens(v.id, { access_token: 'ghu_d', expires_in: 28800, refresh_token: 'ghr_d', refresh_token_expires_in: 100 });
  assert.equal(await getAccessToken(v.id, Date.now() + 8 * HOUR), null);
  assert.equal(hasToken(getUser(v.id)), false);

  // 通信の失敗は、トークンを残す
  const w = mkUser(7);
  saveTokens(w.id, { access_token: 'ghu_e', expires_in: 28800, refresh_token: 'ghr_e', refresh_token_expires_in: 15811200 });
  const f = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://github.com/login/oauth/access_token') throw new Error('network down');
    return f(url, init);
  };
  try {
    assert.equal(await getAccessToken(w.id, Date.now() + 8 * HOUR), null);
  } finally {
    globalThis.fetch = f;
  }
  assert.equal(hasToken(getUser(w.id)), true);
});

test('ログインのコールバックで、トークンを暗号化して保存する(機能が無効のときは保存しない)', async () => {
  const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
  const cookieValue = (r, name) => {
    const line = r.headers.getSetCookie().find((c) => c.startsWith(name + '='));
    return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
  };
  const login = async () => {
    const start = await get('/auth/github');
    const state = cookieValue(start, STATE_COOKIE);
    return get(`/auth/github/callback?code=abc&state=${state}`, { Cookie: `${STATE_COOKIE}=${state}` });
  };

  const cb = await login();
  assert.equal(cb.status, 302);
  const row = new DatabaseSync(path.join(tmp, 'devbox.db')).prepare('SELECT id, gh_token_enc FROM users WHERE github_id = 7001').get();
  assert.ok(row.gh_token_enc);
  assert.doesNotMatch(row.gh_token_enc, /ghu_login_access/);
  assert.equal(await getAccessToken(row.id), 'ghu_login_access');

  // 無効のとき: 新しい人のログインでは、保存しない
  const keep = config.github.appSlug;
  config.github.appSlug = '';
  userInfo = { id: 7002, login: 'nopriv', avatar_url: null };
  try {
    await login();
  } finally {
    config.github.appSlug = keep;
  }
  const none = new DatabaseSync(path.join(tmp, 'devbox.db')).prepare('SELECT gh_token_enc FROM users WHERE github_id = 7002').get();
  assert.equal(none.gh_token_enc, null);
});

test('API: /me は privateRepos を返し、連携を解除するとトークンが消える', async () => {
  const u = mkUser(8);
  const { token } = createSession(u.id);
  const headers = { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${token}` };
  const me = () => fetch(`${base}/api/me`, { headers }).then((r) => r.json());

  let m = await me();
  assert.deepEqual(m.privateRepos, { enabled: true, installUrl: installUrl(), connected: false });
  assert.doesNotMatch(JSON.stringify(m), /gh_token|ghu_|enc/);

  saveTokens(u.id, { access_token: 'ghu_api', expires_in: 28800 });
  assert.equal((await me()).privateRepos.connected, true);

  const r = await fetch(`${base}/api/me/github/disconnect`, { method: 'POST', headers });
  assert.equal(r.status, 200);
  assert.equal((await me()).privateRepos.connected, false);
  assert.equal(hasToken(getUser(u.id)), false);
});

test('gitAuthEnv: トークンは環境変数で、github.com 宛てのヘッダーとして渡す。scrubToken で伏せられる', () => {
  const env = gitAuthEnv('ghu_secret');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  const basic = Buffer.from('x-access-token:ghu_secret').toString('base64');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${basic}`);

  const msg = `fatal: unable to access (token ghu_secret / header ${basic})`;
  assert.doesNotMatch(scrubToken(msg, 'ghu_secret'), /ghu_secret/);
  assert.doesNotMatch(scrubToken(msg, 'ghu_secret'), new RegExp(basic.replace(/[+/=]/g, '.')));
  assert.equal(scrubToken('そのまま', null), 'そのまま');
});

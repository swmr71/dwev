import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-keepalive-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_TOKEN = 'x';
process.env.MAX_RUNNING = '100';
process.env.KEEPALIVE_MINUTES = '10';
process.env.KEEPALIVE_GRACE_MINUTES = '5';
process.env.TURNSTILE_SITE_KEY = 'site';
process.env.TURNSTILE_SECRET_KEY = 'secret';
delete process.env.PUBLIC_URL;

// Turnstile への問い合わせだけ差し替える。トークンは "ok|ホスト名|action|cdata" の形で、その中身を応答として返す
// (本物の Turnstile が、ウィジェットに付けた action / cdata と、発行したホスト名を返すのと同じ)
const realFetch = globalThis.fetch;
let verifyCalls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://challenges.cloudflare.com/')) {
    verifyCalls++;
    const [kind, hostname, action, cdata] = new URLSearchParams(init.body).get('response').split('|');
    const body = kind === 'ok' ? { success: true, hostname, action, cdata } : { success: false };
    return new Response(JSON.stringify(body), { status: 200 });
  }
  return realFetch(url, init);
};
const tok = (cdata, over = {}) => ['ok', over.hostname ?? 'devbox.example.com', over.action ?? 'keepalive', cdata].join('|');

const { app } = await import('../src/server.js');
const { confirmDue, secondsToConfirm, confirmSecondsLeft, acknowledgeConfirm, ConfirmError, stopReason } =
  await import('../src/manager.js');
const { config } = await import('../src/config.js');
const { verifyHuman } = await import('../src/humancheck.js');
const { insertProject, updateProject, getProject, newId, upsertGithubUser, updateUser, createSession } =
  await import('../src/db.js');
const { SESSION_COOKIE } = await import('../src/auth.js');
const { encryptJson } = await import('../src/crypto.js');

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
  const u = upsertGithubUser({ githubId: gid, login: `k${gid}`, avatarUrl: null });
  updateUser(u.id, { status: 'approved' });
  const { token } = createSession(u.id);
  return { id: u.id, headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${token}` } };
};
const mkRunning = (userId, fields = {}) =>
  updateProject(
    insertProject({
      id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000,
      envEnc: encryptJson({}), userId,
    }).id,
    { status: 'running', ...fields }
  );
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min) => new Date(Date.now() + min * 60_000).toISOString();
const post = (user, id, body) =>
  fetch(`${base}/api/projects/${id}/keepalive`, { method: 'POST', headers: user.headers, body: JSON.stringify(body) });

test('確認は、使っていても使っていなくても、前回の確認(無ければ起動)から10分で求める', () => {
  const u = mkUser(1);
  assert.equal(confirmDue(mkRunning(u.id, { keepalive_at: ago(5) })), false);
  assert.equal(confirmDue(mkRunning(u.id, { keepalive_at: ago(11) })), true);
  // 記録が無ければ起動時刻から
  assert.equal(confirmDue(mkRunning(u.id, { started_at: ago(11) })), true);
  // 通信があっても(last_active_at が新しくても)確認は求める
  assert.equal(confirmDue(mkRunning(u.id, { keepalive_at: ago(11), last_active_at: ago(0) })), true);
  // 確認待ちの間は、重ねて求めない / 動いていなければ対象外
  assert.equal(confirmDue(mkRunning(u.id, { keepalive_at: ago(11), confirm_deadline_at: ahead(3) })), false);
  assert.equal(confirmDue({ ...mkRunning(u.id, { keepalive_at: ago(11) }), status: 'stopped' }), false);
  // 次の確認までの秒数
  const s = secondsToConfirm(mkRunning(u.id, { keepalive_at: ago(4) }));
  assert.ok(s > 5 * 60 - 5 && s <= 6 * 60, `残り ${s} 秒`);
  assert.equal(secondsToConfirm(mkRunning(u.id, { keepalive_at: ago(4), confirm_deadline_at: ahead(3) })), null);
});

test('stopReason: 確認の期限が切れたら止める。期限内なら止めない', () => {
  const u = mkUser(2);
  assert.match(stopReason(mkRunning(u.id, { keepalive_at: ago(16), confirm_deadline_at: ago(1) })), /応答がなかった/);
  assert.equal(stopReason(mkRunning(u.id, { keepalive_at: ago(11), confirm_deadline_at: ahead(4) })), null);
  assert.equal(stopReason(mkRunning(u.id, { keepalive_at: ago(11) })), null); // 求める前は、止めない
  assert.equal(confirmSecondsLeft(mkRunning(u.id, { confirm_deadline_at: ago(1) })), 0);
});

test('acknowledgeConfirm: 確認を求められている間だけ受け付け、前回の確認の時刻を更新する', () => {
  const u = mkUser(3);
  const pending = mkRunning(u.id, { keepalive_at: ago(11), confirm_deadline_at: ahead(3) });
  const acked = acknowledgeConfirm(pending.id);
  assert.equal(acked.confirm_deadline_at, null);
  assert.ok(Date.now() - Date.parse(acked.keepalive_at) < 5000);
  // 先回しはできない / 期限が切れたら受け付けない
  assert.throws(() => acknowledgeConfirm(mkRunning(u.id, { keepalive_at: ago(1) }).id), ConfirmError);
  assert.throws(() => acknowledgeConfirm(mkRunning(u.id, { confirm_deadline_at: ago(1) }).id), /期限/);
});

test('verifyHuman: 正しいトークンだけ通す。ホスト名・action・cdata が違えば断る。形が変なものは問い合わせず断る', async () => {
  const keepUrl = config.publicUrl;
  config.publicUrl = 'https://devbox.example.com';
  try {
    const exp = { action: 'keepalive', cdata: 'p1' };
    assert.equal(await verifyHuman(tok('p1'), exp), true);
    assert.equal(await verifyHuman('bad', exp), false);
    assert.equal(await verifyHuman(tok('p1', { hostname: 'evil.example.net' }), exp), false); // 別のサイトで取ったトークン
    assert.equal(await verifyHuman(tok('p1', { action: 'login' }), exp), false); // 別の画面で取ったトークン
    assert.equal(await verifyHuman(tok('p2'), exp), false); // 別のプロジェクトで取ったトークン
    // PUBLIC_URL が無ければ、ホスト名は見ない
    config.publicUrl = '';
    assert.equal(await verifyHuman(tok('p1', { hostname: 'anything' }), exp), true);
  } finally {
    config.publicUrl = keepUrl;
  }
  const calls = verifyCalls;
  assert.equal(await verifyHuman(undefined), false);
  assert.equal(await verifyHuman(''), false);
  assert.equal(await verifyHuman('x'.repeat(3000)), false);
  assert.equal(verifyCalls, calls);
  // キーが無ければ(開発用)確認を省く
  const keep = { ...config.turnstile };
  Object.assign(config.turnstile, { siteKey: '', secret: '' });
  assert.equal(await verifyHuman(undefined), true);
  Object.assign(config.turnstile, keep);
});

test('API: 確認を求められていなければ409。人の確認に失敗すれば400で、確認は進まない', async () => {
  const u = mkUser(4);
  const idle = mkRunning(u.id, { keepalive_at: ago(1) });
  assert.equal((await post(u, idle.id, { token: tok(idle.id) })).status, 409);

  const pending = mkRunning(u.id, { keepalive_at: ago(11), confirm_deadline_at: ahead(4) });
  const bad = await post(u, pending.id, { token: 'bad' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'human');
  assert.equal((await post(u, pending.id, {})).status, 400);
  assert.ok(getProject(pending.id).confirm_deadline_at);

  // 別のプロジェクトのために取ったトークンは、通らない
  const other = mkRunning(u.id, { keepalive_at: ago(11), confirm_deadline_at: ahead(4) });
  assert.equal((await post(u, pending.id, { token: tok(other.id) })).status, 400);
  assert.ok(getProject(pending.id).confirm_deadline_at);

  const ok = await post(u, pending.id, { token: tok(pending.id) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.confirmSecondsLeft, null);
  assert.equal(getProject(pending.id).confirm_deadline_at, null);
});

test('API: 他人のプロジェクトは404。失敗が続くと429で断る', async () => {
  const owner = mkUser(5);
  const other = mkUser(6);
  const pending = mkRunning(owner.id, { keepalive_at: ago(11), confirm_deadline_at: ahead(4) });
  assert.equal((await post(other, pending.id, { token: tok(pending.id) })).status, 404);

  const calls = verifyCalls;
  for (let i = 0; i < 5; i++) assert.equal((await post(owner, pending.id, { token: 'bad' })).status, 400);
  assert.equal((await post(owner, pending.id, { token: tok(pending.id) })).status, 429); // 正しくても、いったん断る
  assert.equal(verifyCalls, calls + 5); // 断った回は、Turnstile に問い合わせない
});

test('API: /info は、確認の設定と Turnstile のサイトキー(秘密鍵は出さない)を返す', async () => {
  const u = mkUser(7);
  const info = await (await fetch(`${base}/api/info`, { headers: u.headers })).json();
  assert.equal(info.keepaliveMinutes, 10);
  assert.equal(info.keepaliveGraceMinutes, 5);
  assert.equal(info.turnstileSiteKey, 'site');
  assert.doesNotMatch(JSON.stringify(info), /secret/);
});

test('runtimeSecondsLeft: 最大稼働時間までの残り秒数。上限なし・動いていなければ null', async () => {
  const { runtimeSecondsLeft } = await import('../src/manager.js');
  const u = mkUser(8);
  const keep = config.maxRuntimeHours;
  try {
    config.maxRuntimeHours = 1;
    const s = runtimeSecondsLeft(mkRunning(u.id, { started_at: ago(15) }));
    assert.ok(s > 45 * 60 - 5 && s <= 45 * 60, `残り ${s} 秒`);
    assert.equal(runtimeSecondsLeft(mkRunning(u.id, { started_at: ago(90) })), 0); // 超えていれば 0
    assert.equal(runtimeSecondsLeft({ ...mkRunning(u.id, { started_at: ago(1) }), status: 'stopped' }), null);
    config.maxRuntimeHours = 0;
    assert.equal(runtimeSecondsLeft(mkRunning(u.id, { started_at: ago(1) })), null);
  } finally {
    config.maxRuntimeHours = keep;
  }
});

test('startDueConfirms: 確認の時刻が来たものに期限を付ける。まだのもの・確認待ちのものには付けない', async () => {
  const { startDueConfirms } = await import('../src/manager.js');
  const u = mkUser(9);
  const due = mkRunning(u.id, { keepalive_at: ago(10.1) });
  const notYet = mkRunning(u.id, { keepalive_at: ago(9) });
  const already = mkRunning(u.id, { keepalive_at: ago(12), confirm_deadline_at: ahead(2) });
  const before = getProject(already.id).confirm_deadline_at;
  startDueConfirms();
  const d = getProject(due.id).confirm_deadline_at;
  assert.ok(d);
  const left = (Date.parse(d) - Date.now()) / 1000;
  assert.ok(left > 4 * 60 + 50 && left <= 5 * 60, `猶予 ${left} 秒`);
  assert.equal(getProject(notYet.id).confirm_deadline_at, null);
  assert.equal(getProject(already.id).confirm_deadline_at, before); // 期限を延ばさない
});

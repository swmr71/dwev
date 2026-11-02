import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { safeEqual } from './crypto.js';
import { upsertGithubUser, createSession, getSessionUser, deleteSession } from './db.js';

// ---- Cookie -------------------------------------------------------------------
// HTTPS のときは「__Host-」付きの名前にする。これは、同じドメインの別ホスト
// (利用者が動かしているプレビュー {id}-dev.clusters-prj.com など)から、
// Domain 属性つきで同名のCookieを送り込まれても、ブラウザが拒否してくれる仕組み。
const secure = config.publicUrl.startsWith('https://');
export const SESSION_COOKIE = secure ? '__Host-devbox_session' : 'devbox_session';
export const STATE_COOKIE = secure ? '__Host-devbox_oauth' : 'devbox_oauth';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue; // 同名が複数あれば、最初のものだけ使う
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* 壊れた値は無視 */
    }
  }
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
const clearCookie = (res, name) => setCookie(res, name, '', 0);

// ---- ミドルウェア ----------------------------------------------------------------

// Cookie からログイン中の利用者を取り出す(いなければ req.user = null)
export function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  req.user = getSessionUser(token) || null;
  req.sessionToken = token || null;
  next();
}

export function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です', code: 'login' });
  next();
}

export function requireApproved(req, res, next) {
  const s = req.user?.status;
  if (s === 'approved') return next();
  if (s === 'pending') {
    return res.status(403).json({ error: '管理者の承認待ちです。承認されるまでお待ちください', code: 'pending' });
  }
  return res.status(403).json({ error: 'このアカウントは利用できません', code: 'suspended' });
}

// 管理者用API: 管理トークン (Bearer)
export function adminAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || !safeEqual(token, config.adminToken)) {
    return res.status(401).json({ error: '認証に失敗しました' });
  }
  next();
}

// 他のサイトや、同じドメインの別ホスト(プレビュー)から、ログイン中の利用者になりすまして
// 変更系のリクエストを送られるのを防ぐ。SameSite=Lax は「同じドメインの別ホスト」を防げないので、
// ブラウザが付ける Sec-Fetch-Site / Origin で、同じ出どころ(same-origin)だけを許す。
// curl など、ブラウザ以外はこれらのヘッダーを付けないので通る(その場合は Cookie も持っていない)。
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: '不正なリクエストです' });
  }
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.get('host');
    } catch {
      /* 不正な Origin は拒否 */
    }
    if (!ok) return res.status(403).json({ error: '不正なリクエストです' });
  }
  next();
}

// ---- GitHub OAuth ------------------------------------------------------------------

export const githubEnabled = () => Boolean(config.github.clientId && config.github.clientSecret && config.publicUrl);

async function githubJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GitHub が ${r.status} を返しました`);
  return r.json();
}

// 認可コードを GitHub のユーザー情報に換える。GitHub のトークンは、ここで使うだけで保存しない。
export async function fetchGithubUser(code) {
  const tok = await githubJson('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'devbox' },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: `${config.publicUrl}/auth/github/callback`,
    }),
  });
  if (!tok.access_token) throw new Error('GitHub の認可コードが無効です');
  const u = await githubJson('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'devbox',
    },
  });
  if (!Number.isSafeInteger(u.id) || typeof u.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(u.login)) {
    throw new Error('GitHub のユーザー情報が不正です');
  }
  const avatar =
    typeof u.avatar_url === 'string' && u.avatar_url.startsWith('https://avatars.githubusercontent.com/')
      ? u.avatar_url
      : null;
  return { githubId: u.id, login: u.login, avatarUrl: avatar };
}

export const authRouter = express.Router();

const page = (res, status, message) =>
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>devbox</title><body style="font-family:system-ui,sans-serif;background:#0f1117;color:#e8eaf0;padding:40px">` +
        `<p>${message}</p><p><a style="color:#60a5fa" href="/">トップへ戻る</a></p></body>`
    );

// ログイン開始: GitHub の認可画面へ移動させる
authRouter.get('/github', (_req, res) => {
  if (!githubEnabled()) return page(res, 503, 'GitHub ログインはまだ設定されていません。');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, state, 600);
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', config.github.clientId);
  u.searchParams.set('redirect_uri', `${config.publicUrl}/auth/github/callback`);
  u.searchParams.set('state', state);
  res.redirect(302, u.toString());
});

// GitHub から戻ってくる所
authRouter.get('/github/callback', async (req, res) => {
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
  clearCookie(res, STATE_COOKIE);
  const state = String(req.query.state || '');
  if (!state || !expected || !safeEqual(state, expected)) {
    return page(res, 400, 'ログインの確認に失敗しました。もう一度お試しください。');
  }
  const code = String(req.query.code || '');
  if (!code) return page(res, 400, 'ログインがキャンセルされました。');
  let gh;
  try {
    gh = await fetchGithubUser(code);
  } catch (e) {
    console.warn(`[auth] GitHub ログインに失敗: ${e.message}`);
    return page(res, 502, 'GitHub との通信に失敗しました。しばらくしてからもう一度お試しください。');
  }
  const user = upsertGithubUser(gh);
  const { token } = createSession(user.id);
  setCookie(res, SESSION_COOKIE, token, config.sessionDays * 86_400);
  res.redirect(302, '/');
});

authRouter.post('/logout', sameOriginOnly, (req, res) => {
  if (req.sessionToken) deleteSession(req.sessionToken);
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

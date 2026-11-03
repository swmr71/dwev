// プライベートリポジトリの clone に使う、利用者の GitHub トークン。
// GitHub App でのログインで受け取った「ユーザートークン」を、暗号化して保存する。
//   - 権限は GitHub App に付けた Contents の読み取りだけ。対象は、利用者がインストール時に許可したリポジトリだけ
//   - 有効期限は8時間。期限が切れたら、リフレッシュトークン(最長6か月)で更新する
//   - clone のときに、devbox 本体のプロセスが使うだけ。コンテナにも、ログにも出さない
// GITHUB_APP_SLUG が未設定のときは、この機能全体を無効にして、トークンも保存しない。
import { config } from './config.js';
import { encryptJson, decryptJson } from './crypto.js';
import { getUser, updateUser } from './db.js';

export const privateReposEnabled = () =>
  Boolean(config.github.appSlug && config.github.clientId && config.github.clientSecret);

// GitHub App のインストール画面(使うリポジトリを選んで許可する)
export const installUrl = () => `https://github.com/apps/${config.github.appSlug}/installations/new`;

export const hasToken = (user) => Boolean(user?.gh_token_enc);

// GitHub のトークン応答({access_token, expires_in, refresh_token, refresh_token_expires_in})を保存する形にする
export function toStored(tok, nowMs = Date.now()) {
  return {
    access: tok.access_token,
    expiresAt: tok.expires_in ? nowMs + Number(tok.expires_in) * 1000 : null,
    refresh: tok.refresh_token || null,
    refreshExpiresAt: tok.refresh_token_expires_in ? nowMs + Number(tok.refresh_token_expires_in) * 1000 : null,
  };
}

export function saveTokens(userId, tok, nowMs = Date.now()) {
  if (!privateReposEnabled() || !tok?.access_token) return;
  updateUser(userId, { gh_token_enc: encryptJson(toStored(tok, nowMs)) });
}

export function clearToken(userId) {
  updateUser(userId, { gh_token_enc: null });
}

// 同じ人の更新が同時に走ると、リフレッシュトークンが入れ替わって、片方が失敗する。人ごとに1つずつにする
const refreshing = new Map();

async function refresh(userId, stored, nowMs) {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'devbox' },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: stored.refresh,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = res.ok ? await res.json() : null;
    if (!tok?.access_token) {
      clearToken(userId); // 取り消された・期限切れ。再ログインしてもらう
      return null;
    }
    saveTokens(userId, tok, nowMs);
    return tok.access_token;
  } catch {
    return null; // 通信の失敗は、トークンを捨てずに、今回だけ使わない
  }
}

// 使えるアクセストークンを返す。無い・更新できないときは null
export async function getAccessToken(userId, nowMs = Date.now()) {
  if (!privateReposEnabled()) return null;
  const user = getUser(userId);
  if (!hasToken(user)) return null;
  let stored;
  try {
    stored = decryptJson(user.gh_token_enc);
  } catch {
    return null;
  }
  if (!stored.expiresAt || stored.expiresAt - 60_000 > nowMs) return stored.access;
  if (!stored.refresh || (stored.refreshExpiresAt && stored.refreshExpiresAt <= nowMs)) {
    clearToken(userId);
    return null;
  }
  if (!refreshing.has(userId)) {
    refreshing.set(userId, refresh(userId, stored, nowMs).finally(() => refreshing.delete(userId)));
  }
  return refreshing.get(userId);
}

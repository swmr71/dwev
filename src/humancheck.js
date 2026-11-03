// 「人が押している」ことの確認。Cloudflare Turnstile を使う(無料・CAPTCHAより邪魔になりにくい)。
// TURNSTILE_SECRET_KEY が無いときは確認を省く(開発用)。公開するときは必ず設定すること。
import { config } from './config.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const humanCheckEnabled = () => Boolean(config.turnstile.secret && config.turnstile.siteKey);

// 「続ける」のトークンに結びつける action。ほかの画面・ほかのプロジェクトで取ったトークンを流用できなくする
export const KEEPALIVE_ACTION = 'keepalive';

// token: 画面から送られた使い捨てのトークン。
// expected.action / expected.cdata: ウィジェットを出すときに付けた値と一致しなければ断る。
// 応答のホスト名も、PUBLIC_URL のホスト名と一致しなければ断る(PUBLIC_URL が未設定なら、見ない)。
export async function verifyHuman(token, expected = {}) {
  if (!humanCheckEnabled()) return true;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstile.secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.success !== true) return false;
    const host = config.publicUrl ? new URL(config.publicUrl).hostname : '';
    if (host && data.hostname !== host) return false;
    if (expected.action && data.action !== expected.action) return false;
    if (expected.cdata && data.cdata !== expected.cdata) return false;
    return true;
  } catch {
    return false; // 確認できなかったときは、通さない
  }
}

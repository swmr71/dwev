// 「人が押している」ことの確認。Cloudflare Turnstile を使う(無料・CAPTCHAより邪魔になりにくい)。
// TURNSTILE_SECRET_KEY が無いときは確認を省く(開発用)。公開するときは必ず設定すること。
import { config } from './config.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const humanCheckEnabled = () => Boolean(config.turnstile.secret && config.turnstile.siteKey);

export async function verifyHuman(token) {
  if (!humanCheckEnabled()) return true;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstile.secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    return (await res.json()).success === true;
  } catch {
    return false; // 確認できなかったときは、通さない
  }
}

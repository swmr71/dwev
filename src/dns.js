import { config } from './config.js';

// Cloudflare の DNS レコード(プレビュー用 CNAME)を作成・削除する。
//
// 安全のための決まり:
//  - 操作してよいのは、ホスト名が PREVIEW_HOST_TEMPLATE の {id}(16進10文字)に一致するものだけ
//  - 削除してよいのは、devbox が作った印(comment)が付いたレコードだけ
//  → ほかの手作りのレコード(www や nextcloud など)には、絶対に触らない。
export const TAG = 'devbox-preview';
const API = 'https://api.cloudflare.com/client/v4';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// テンプレートから「ホスト名 → id」を取り出す正規表現を作る
export function hostRegex(template = config.previewHostTemplate) {
  if (!template.includes('{id}')) return null;
  const parts = template.split('{id}').map(escapeRe);
  return new RegExp(`^${parts.join('([0-9a-f]{10})')}$`);
}

export const dnsEnabled = () => {
  const c = config.cloudflare;
  return Boolean(c.token && c.zoneId && c.target);
};

export function assertDnsConfig() {
  const c = config.cloudflare;
  const some = c.token || c.zoneId || c.target;
  if (!some) return; // 無効(LAN内だけで使う等)
  if (!dnsEnabled()) {
    throw new Error('CF_API_TOKEN / CF_ZONE_ID / DNS_TARGET は3つ全部設定してください');
  }
  if (!hostRegex()) throw new Error('DNS連動には PREVIEW_HOST_TEMPLATE に {id} が必要です');
}

function guardHost(host) {
  const re = hostRegex();
  if (!re || typeof host !== 'string' || !re.test(host)) {
    throw new Error(`プレビュー用ではないホスト名のため DNS を操作しません: ${host}`);
  }
}

async function cf(method, path, body) {
  const res = await fetch(`${API}/zones/${config.cloudflare.zoneId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.cloudflare.token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* JSON でない応答 */
  }
  if (!res.ok || data.success === false) {
    const msg = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API エラー (${method} ${path.split('?')[0]}): ${msg}`);
  }
  return data.result;
}

const findByName = (host) => cf('GET', `/dns_records?name=${encodeURIComponent(host)}&per_page=10`);
const isOurs = (r) => r?.comment === TAG && r?.type === 'CNAME';

// 作成(すでに devbox が作ったものがあれば何もしない)
export async function createPreviewRecord(host) {
  if (!dnsEnabled()) return false;
  guardHost(host);
  const existing = await findByName(host);
  if (existing.length > 0) {
    if (existing.every(isOurs)) return true;
    throw new Error(`同名のDNSレコードが既にあり、devbox 管理外のため作成できません: ${host}`);
  }
  await cf('POST', '/dns_records', {
    type: 'CNAME',
    name: host,
    content: config.cloudflare.target,
    proxied: true,
    ttl: 1, // 自動
    comment: TAG,
  });
  return true;
}

// 削除(devbox が作った印があるものだけ)
export async function deletePreviewRecord(host) {
  if (!dnsEnabled()) return false;
  guardHost(host);
  const existing = await findByName(host);
  let removed = false;
  for (const r of existing) {
    if (!isOurs(r)) continue; // 管理外は触らない
    await cf('DELETE', `/dns_records/${r.id}`);
    removed = true;
  }
  return removed;
}

// devbox が作った印のあるレコードを一覧する(孤児掃除用)
export async function listPreviewRecords() {
  if (!dnsEnabled()) return [];
  const re = hostRegex();
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await cf(
      'GET',
      `/dns_records?type=CNAME&comment.startswith=${TAG}&per_page=100&page=${page}`
    );
    for (const r of rows) {
      if (isOurs(r) && re.test(r.name)) out.push({ id: r.id, name: r.name, projectId: re.exec(r.name)[1] });
    }
    if (rows.length < 100) break;
  }
  return out;
}

// 動いていないプロジェクトのレコードを消す。keepIds は残すべきプロジェクトID
export async function sweepOrphans(keepIds) {
  if (!dnsEnabled()) return 0;
  const keep = new Set(keepIds);
  let n = 0;
  for (const r of await listPreviewRecords()) {
    if (keep.has(r.projectId)) continue;
    await cf('DELETE', `/dns_records/${r.id}`);
    n++;
  }
  return n;
}

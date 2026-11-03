import { config } from './config.js';

export class ValidationError extends Error {}

const fail = (msg) => {
  throw new ValidationError(msg);
};

export function validateName(name) {
  if (typeof name !== 'string') fail('name は文字列で指定してください');
  const n = name.trim();
  if (n.length < 1 || n.length > 40) fail('name は1〜40文字にしてください');
  return n;
}

// https://<許可ホスト>/<owner>/<repo>[.git] のみ許可。認証情報・ポート・クエリは不可。
export function validateRepoUrl(url) {
  if (typeof url !== 'string') fail('repoUrl は文字列で指定してください');
  const m = url.trim().match(/^https:\/\/([a-z0-9.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) fail('repoUrl は https://<host>/<owner>/<repo> の形式で指定してください');
  const host = m[1].toLowerCase();
  if (!config.allowedGitHosts.includes(host)) {
    fail(`このホストは許可されていません (許可: ${config.allowedGitHosts.join(', ')})`);
  }
  if (m[2] === '..' || m[3] === '..' || m[2] === '.' || m[3] === '.') fail('repoUrl が不正です');
  return `https://${host}/${m[2]}/${m[3]}.git`;
}

export function validateBranch(branch) {
  if (typeof branch !== 'string') fail('branch は文字列で指定してください');
  const b = branch.trim();
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b) || b.startsWith('-') || b.includes('..') || b.endsWith('/')) {
    fail('branch が不正です');
  }
  return b;
}

export function validatePort(port) {
  const p = port === undefined || port === null || port === '' ? 3000 : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) fail('port は1〜65535の整数にしてください');
  return p;
}

const RESERVED_ENV = new Set(['PORT', 'HOST']);

export function validateEnv(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) fail('env は {KEY: "value"} の形式で指定してください');
  const entries = Object.entries(env);
  if (entries.length > 50) fail('env は50個までです');
  const out = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) fail(`env のキー名が不正です: ${k}`);
    if (RESERVED_ENV.has(k)) fail(`${k} は dwev が設定するため指定できません`);
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      fail(`env ${k} の値は文字列で指定してください`);
    }
    const s = String(v);
    if (s.length > 4096 || s.includes('\0')) fail(`env ${k} の値が不正です`);
    out[k] = s;
  }
  return out;
}

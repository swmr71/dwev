// リポジトリの docker-compose.yml から、「補助サービス」(DB・キャッシュなど)だけを安全に読み取る。
//
// 方針: compose を、そのまま docker compose に渡して動かすことは、しない。
//   他人が書いたファイルなので、privileged・ホストのパスのマウント・docker.sock・host ネットワークなどが書ける。
//   そこで、ここでは YAML を「データ」として読み、許可した項目だけを取り出して、devbox 自身が、
//   リソース制限つきのコンテナとして作る。許可リストに無いものは、黙って無視せず、エラーにする。
//
//   - 補助サービスになるのは、`image:` だけで `build:` が無いサービス
//   - イメージは、許可リスト(既定: postgres / mysql / mariadb / redis / valkey / mongo / memcached)の公式イメージだけ
//   - `build:` があるサービスは、アプリ本体(リポジトリの Dockerfile で動く)なので、補助にはしない
//   - 取り出すのは image / environment / command だけ。ports / volumes / restart など、
//     捨てても安全な項目は、無視して注意書きを残す。それ以外の項目(privileged など)はエラー
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { config } from './config.js';

export class ComposeError extends Error {}

const fail = (msg) => {
  throw new ComposeError(msg);
};

const FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const MAX_BYTES = 64 * 1024;

// 捨てても、安全に動く項目(補助サービスでは使わない)。無視したことを注意書きに残す
const IGNORED = new Set([
  'ports', 'expose', 'volumes', 'restart', 'depends_on', 'networks', 'healthcheck', 'container_name',
  'hostname', 'labels', 'deploy', 'platform', 'stop_grace_period', 'tty', 'stdin_open', 'pull_policy', 'init',
  'mem_limit', 'cpus', 'working_dir', 'stop_signal',
]);
const ALLOWED = new Set(['image', 'environment', 'command']);
// トップレベルで、無視してよいもの
const TOP_IGNORED = new Set(['version', 'name', 'volumes', 'networks']);

// symlink は読まない(ホストのファイルを読ませないため)。見つからなければ null
export function findComposeFile(dir) {
  for (const f of FILES) {
    const full = path.join(dir, f);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) fail(`${f} は通常のファイルにしてください(symlink などは使えません)`);
    if (st.size > MAX_BYTES) fail(`${f} が大きすぎます(上限 ${MAX_BYTES / 1024}KB)`);
    return full;
  }
  return null;
}

// ${VAR} / ${VAR:-既定} / ${VAR-既定} / $VAR を、利用者がプロジェクトに設定した環境変数だけで置き換える。
// devbox 自身の環境変数(ADMIN_TOKEN など)は、決して見ない。$$ は $ のこと
export function interpolate(text, vars) {
  return String(text).replace(/\$\$|\$\{([A-Za-z_]\w*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_]\w*)/g, (m, braced, op, dflt, bare) => {
    if (m === '$$') return '$';
    const name = braced ?? bare;
    const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (v !== undefined && !(op === ':-' && v === '')) return v;
    return op ? (dflt ?? '') : '';
  });
}

// 空白区切りで、'..' と ".." の引用に対応した分割(シェルは通さない)
export function splitCommand(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
    }
  }
  if (quote) fail('command の引用符が閉じていません');
  if (started || cur) out.push(cur);
  return out;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// environment は {K: v} でも ["K=v"] でも書ける。値は文字列にそろえる
function readEnvironment(raw, vars, where) {
  const out = {};
  const put = (k, v) => {
    if (!KEY_RE.test(k)) fail(`${where}: 環境変数のキー名が不正です: ${k}`);
    if (v === null || v === undefined) v = Object.hasOwn(vars, k) ? vars[k] : '';
    if (!['string', 'number', 'boolean'].includes(typeof v)) fail(`${where}: 環境変数 ${k} の値は文字列にしてください`);
    const s = interpolate(String(v), vars);
    if (s.length > 4096 || s.includes('\0')) fail(`${where}: 環境変数 ${k} の値が不正です`);
    out[k] = s;
  };
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') fail(`${where}: environment の書き方が不正です`);
      const i = item.indexOf('=');
      if (i < 0) put(item, undefined);
      else put(item.slice(0, i), item.slice(i + 1));
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) put(k, v);
  } else {
    fail(`${where}: environment の書き方が不正です`);
  }
  if (Object.keys(out).length > 50) fail(`${where}: 環境変数は50個までです`);
  return out;
}

// 公式イメージ(registry も、ユーザー名も付かない)で、許可リストにあるものだけ。タグは任意(既定 latest)
export function validateImage(image, allowed = config.composeServices.allowedImages) {
  if (typeof image !== 'string') fail('image は文字列にしてください');
  const m = image.trim().match(/^([a-z0-9][a-z0-9._-]*)(?::([A-Za-z0-9][A-Za-z0-9._-]{0,127}))?$/);
  if (!m) fail(`image が不正です: ${String(image).slice(0, 80)}(registry・ユーザー名・ダイジェストは指定できません)`);
  const [, name, tag] = m;
  if (!allowed.includes(name)) {
    fail(`image「${name}」は許可されていません(許可: ${allowed.join(', ')})`);
  }
  return { name, tag: tag || 'latest', ref: `${name}:${tag || 'latest'}` };
}

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/;

// compose の文字列を読んで、補助サービスと、アプリ本体の環境変数を返す。
//   vars: 利用者がプロジェクトに設定した環境変数(${VAR} の置き換えにだけ使う)
// 戻り値: { services: [{name, image, env, command}], appEnv, notes: [注意書き] }
export function parseCompose(text, vars = {}) {
  let doc;
  try {
    doc = parse(String(text), { maxAliasCount: 20, uniqueKeys: true });
  } catch (e) {
    fail(`docker-compose.yml を解析できません: ${String(e.message).split('\n')[0].slice(0, 200)}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('docker-compose.yml の形式が不正です');
  for (const k of Object.keys(doc)) {
    if (k !== 'services' && !TOP_IGNORED.has(k) && !k.startsWith('x-')) {
      fail(`docker-compose.yml の「${k}」は使えません(secrets / configs / include などは未対応です)`);
    }
  }
  const svcs = doc.services;
  if (!svcs || typeof svcs !== 'object' || Array.isArray(svcs)) fail('docker-compose.yml に services がありません');

  const notes = [];
  const services = [];
  const apps = [];
  for (const [name, def] of Object.entries(svcs)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) fail(`サービス ${name} の書き方が不正です`);
    if (def.profiles !== undefined) {
      notes.push(`${name}: profiles があるため、使いません`);
      continue;
    }
    if (def.build !== undefined) {
      apps.push({ name, def });
      continue;
    }
    if (!SERVICE_NAME.test(name)) fail(`サービス名が不正です: ${name}(英数字・- ・_ で、31文字まで)`);
    const where = `サービス ${name}`;
    for (const k of Object.keys(def)) {
      if (ALLOWED.has(k)) continue;
      if (IGNORED.has(k)) {
        notes.push(`${name}: ${k} は使えないため、無視します`);
        continue;
      }
      fail(`${where}: 「${k}」は使えません(許可: ${[...ALLOWED].join(' / ')})`);
    }
    if (def.image === undefined) fail(`${where}: image がありません`);
    const image = validateImage(interpolate(String(def.image), vars));
    let command;
    if (def.command !== undefined) {
      if (typeof def.command === 'string') command = splitCommand(def.command);
      else if (Array.isArray(def.command) && def.command.every((c) => typeof c === 'string')) command = def.command;
      else fail(`${where}: command は文字列か、文字列の配列にしてください`);
      if (command.length > 50 || command.some((c) => c.length > 1024 || c.includes('\0'))) fail(`${where}: command が長すぎます`);
    }
    services.push({ name, image: image.ref, env: readEnvironment(def.environment, vars, where), command });
  }

  if (services.length > config.composeServices.maxServices) {
    fail(`補助サービスは ${config.composeServices.maxServices} 個までです(${services.length} 個あります)`);
  }
  if (new Set(services.map((s) => s.name.toLowerCase())).size !== services.length) fail('サービス名が重複しています');

  // アプリ本体(build があるサービス)は、リポジトリの Dockerfile で動かす。1つだけのときは、
  // その environment を、アプリの環境変数の既定値として使う(例: DATABASE_URL=postgres://…@db/…)
  let appEnv = {};
  if (apps.length === 1) {
    try {
      appEnv = readEnvironment(apps[0].def.environment, vars, `サービス ${apps[0].name}`);
    } catch (e) {
      notes.push(`${apps[0].name}: environment を読めないため使いません(${e.message})`);
    }
    notes.push(`${apps[0].name}: build があるため、リポジトリの Dockerfile(または自動判定)で動かします`);
  } else if (apps.length > 1) {
    notes.push(`build があるサービスが ${apps.length} 個あります。複数のアプリは動かせないため、補助サービスだけ使います`);
  }
  return { services, appEnv, notes };
}

// リポジトリの中から探して読む。無い・機能が無効のときは、補助サービスなし
export function loadComposePlan(dir, vars = {}) {
  const empty = { services: [], appEnv: {}, notes: [] };
  if (!config.composeServices.enabled) return empty;
  const file = findComposeFile(dir);
  if (!file) return empty;
  return parseCompose(fs.readFileSync(file, 'utf8'), vars);
}

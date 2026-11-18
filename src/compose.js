// リポジトリの docker-compose.yml を読んで、dwev で動かすための「計画」を作る。
//
// 方針: compose を、そのまま docker compose に渡して動かすことは、しない。
//   他人が書いたファイルなので、privileged・ホストのパスのマウント・docker.sock・host ネットワークなどが書ける。
//   そこで、ここでは YAML を「データ」として読み、意味の分かる項目だけを取り出す。実際のコンテナは、
//   devbox 自身が、決まった制限つきで作る。それ以外の項目は、使わない(ビルドログに注意書きを残す)。
//   使わない項目は、コンテナにも、ホストにも、一切反映されないので、無視しても安全。
//
//   - アプリ本体: `build:` があるサービス(1つだけ)。context / dockerfile / target / args、command / entrypoint、
//     environment / env_file を使う。context と dockerfile は、リポジトリの中だけ
//   - 補助サービス: `image:` だけのサービスのうち、許可リスト(既定: DB・キャッシュ・nginx)の公式イメージだけ。
//     許可リストに無いものは、動かさない
//   - volumes:
//       名前つきボリューム(media:/app/media)… プロジェクト専用の Docker ボリュームにする(サービス間で共有できる)
//       リポジトリの中のパス(./nginx.conf:/etc/nginx/...)… マウントせず、イメージに COPY する(ホストに触れない)
//       ホストのパス(/var/run/docker.sock:… や ~/…)・リポジトリの外(../)… 使わない
//   - ports: ホストには公開しない。「127.0.0.1 以外に公開しているサービス」を、プレビューURLの入口にする
//   - depends_on: 起動の順番にだけ使う
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

const APP_KEYS = new Set(['build', 'command', 'entrypoint', 'environment', 'env_file', 'volumes', 'ports', 'expose', 'depends_on']);
const SIDECAR_KEYS = new Set(['image', 'command', 'environment', 'env_file', 'volumes', 'ports', 'expose', 'depends_on']);
// 使わないが、動きに関わらないので、注意書きも出さない
const QUIET = new Set([
  'restart', 'container_name', 'hostname', 'stdin_open', 'tty', 'init', 'stop_grace_period', 'stop_signal',
  'pull_policy', 'platform', 'labels', 'logging', 'healthcheck', 'image',
]);
const TOP_QUIET = new Set(['version', 'name', 'volumes', 'networks']);
// 小さいイメージは、メモリを少なめにする(枠とポイントの消費が減る)
const SMALL_IMAGES = new Set(['nginx', 'redis', 'valkey', 'memcached']);
const MAX_MOUNTS = 10;
const MAX_VOLUMES = 5;

export const serviceMemoryMb = (imageName) =>
  SMALL_IMAGES.has(imageName) ? config.composeServices.smallMemoryMb : config.composeServices.memoryMb;

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

// リポジトリの中の相対パスを、実際の場所にする。外に出るもの(絶対パス・~・..・外を指す symlink)は null。
// dir が無い(ファイルを見ずに解析するだけ)ときは、書き方だけを確かめる。
//   戻り値: { rel: 正規化した相対パス, full: 実際の場所(dir があるとき), exists }
export function repoPath(dir, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || rel.startsWith('~')) return null;
  const norm = path.posix.normalize(rel.replaceAll('\\', '/'));
  if (norm === '..' || norm.startsWith('../')) return null;
  if (!dir) return { rel: norm, full: null, exists: true };
  const root = fs.realpathSync(dir);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const full = path.resolve(root, norm);
  if (!inside(full)) return null;
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    return { rel: norm, full, exists: false };
  }
  if (!inside(real)) return null; // symlink で外を指している
  return { rel: norm, full: real, exists: true };
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

// 空白区切りで、'..' と ".." の引用に対応した分割(シェルは通さない。compose と同じ)
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

function readCommand(raw, where, key) {
  if (raw === undefined || raw === null) return undefined;
  let cmd;
  if (typeof raw === 'string') cmd = splitCommand(raw);
  else if (Array.isArray(raw) && raw.every((c) => typeof c === 'string')) cmd = raw;
  else fail(`${where}: ${key} は文字列か、文字列の配列にしてください`);
  if (cmd.length > 50 || cmd.some((c) => c.length > 4096 || c.includes('\0'))) fail(`${where}: ${key} が長すぎます`);
  return cmd;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function checkEnvValue(k, v, where) {
  if (!KEY_RE.test(k)) fail(`${where}: 環境変数のキー名が不正です: ${k}`);
  if (v.length > 4096 || v.includes('\0')) fail(`${where}: 環境変数 ${k} の値が不正です`);
}

// environment は {K: v} でも ["K=v"] でも書ける。値は文字列にそろえる
function readEnvironment(raw, vars, where) {
  const out = {};
  const put = (k, v) => {
    if (v === null || v === undefined) v = Object.hasOwn(vars, k) ? vars[k] : '';
    if (!['string', 'number', 'boolean'].includes(typeof v)) fail(`${where}: 環境変数 ${k} の値は文字列にしてください`);
    const s = interpolate(String(v), vars);
    checkEnvValue(k, s, where);
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
  return out;
}

// .env 形式(KEY=VALUE。# はコメント。export と、前後の引用符を許す)
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (KEY_RE.test(k)) out[k] = v;
  }
  return out;
}

// env_file は、リポジトリの中のファイルだけ。無ければ、注意書きを残して使わない
function readEnvFiles(raw, dir, where, notes) {
  if (raw === undefined || raw === null) return {};
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : fail(`${where}: env_file の書き方が不正です`);
  const out = {};
  for (const item of list) {
    const rel = typeof item === 'string' ? item : item?.path;
    const r = repoPath(dir, rel);
    if (!r) {
      notes.push(`${where}: env_file ${rel} はリポジトリの外のため、使いません`);
      continue;
    }
    if (!dir) continue;
    if (!r.exists) {
      notes.push(`${where}: env_file ${rel} がリポジトリに無いため、使いません(必要な値は、dwev の画面の環境変数に設定してください)`);
      continue;
    }
    const st = fs.statSync(r.full);
    if (!st.isFile() || st.size > MAX_BYTES) {
      notes.push(`${where}: env_file ${rel} を読めないため、使いません`);
      continue;
    }
    for (const [k, v] of Object.entries(parseDotenv(fs.readFileSync(r.full, 'utf8')))) {
      checkEnvValue(k, v, where);
      out[k] = v;
    }
  }
  return out;
}

function mergeEnv(fromFiles, fromEnv, where) {
  const env = { ...fromFiles, ...fromEnv };
  if (Object.keys(env).length > 50) fail(`${where}: 環境変数は50個までです`);
  return env;
}

const VOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;

// コンテナの中の、マウント先。絶対パスで、.. を含まない(/ そのものは不可)
function checkTarget(t) {
  if (typeof t !== 'string' || !t.startsWith('/') || /[\0\r\n]/.test(t)) return null;
  const norm = path.posix.normalize(t).replace(/\/+$/, '');
  if (!norm || norm === '/' || norm !== t.replace(/\/+$/, '')) return null;
  return norm;
}

// volumes を、名前つきボリュームと、リポジトリの中のファイル(イメージに COPY する)に分ける
function readVolumes(raw, dir, where, notes) {
  const binds = [];
  const volumes = [];
  if (raw === undefined || raw === null) return { binds, volumes };
  if (!Array.isArray(raw)) fail(`${where}: volumes の書き方が不正です`);
  if (raw.length > MAX_MOUNTS) fail(`${where}: volumes は ${MAX_MOUNTS} 個までです`);
  for (const v of raw) {
    let type;
    let source;
    let target;
    let readOnly = false;
    if (typeof v === 'string') {
      const parts = v.split(':');
      if (parts.length === 1) {
        notes.push(`${where}: 名前の無いボリューム ${v} は使いません`);
        continue;
      }
      [source, target] = parts;
      readOnly = (parts[2] || '').split(',').includes('ro');
      type = /^[./~]/.test(source) ? 'bind' : 'volume';
    } else if (v && typeof v === 'object') {
      ({ type, source, target } = v);
      readOnly = v.read_only === true;
    } else {
      fail(`${where}: volumes の書き方が不正です`);
    }
    const label = typeof v === 'string' ? v : `${source}:${target}`;
    const t = checkTarget(target);
    if (!t) {
      notes.push(`${where}: volumes ${label} のマウント先が不正なため、使いません`);
      continue;
    }
    if (type === 'volume') {
      if (typeof source !== 'string' || !VOL_NAME.test(source)) {
        notes.push(`${where}: volumes ${label} は使えないため、使いません`);
        continue;
      }
      volumes.push({ name: source, target: t, readOnly });
    } else if (type === 'bind') {
      const r = repoPath(dir, source);
      if (!r) {
        notes.push(`${where}: volumes ${label} はホストのパス・リポジトリの外のため、使いません`);
        continue;
      }
      binds.push({ source: r.rel, full: r.full, exists: r.exists, target: t, readOnly });
    } else {
      notes.push(`${where}: volumes ${label}(${type})は使えないため、使いません`);
    }
  }
  return { binds, volumes };
}

const LOOPBACK = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);

// ports のうち、ホストの 127.0.0.1 以外に公開しているもの(=外から見せたいもの)の、コンテナ側のポート
export function publicPorts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    let host = null;
    let target;
    if (typeof e === 'number') {
      target = e;
    } else if (typeof e === 'string') {
      let s = e.trim();
      if (/\/udp$/i.test(s)) continue;
      s = s.replace(/\/tcp$/i, '');
      const v6 = s.match(/^\[([^\]]+)\]:(.*)$/);
      if (v6) {
        host = v6[1];
        s = v6[2];
      }
      const parts = s.split(':');
      if (parts.length === 3) [host, , target] = parts;
      else target = parts[parts.length - 1];
    } else if (e && typeof e === 'object') {
      if (String(e.protocol || 'tcp').toLowerCase() === 'udp') continue;
      host = e.host_ip ?? null;
      target = e.target;
    } else {
      continue;
    }
    if (host && LOOPBACK(String(host))) continue;
    const n = Number.parseInt(String(target), 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) out.push(n);
  }
  return out;
}

function readDeps(raw) {
  if (Array.isArray(raw)) return raw.filter((d) => typeof d === 'string');
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
}

function ignoredKeys(def, used, where, notes) {
  for (const k of Object.keys(def)) {
    if (used.has(k) || QUIET.has(k)) continue;
    notes.push(`${where}: ${k} は使えないため、無視します`);
  }
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
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// compose が無いとき(今まで通り): リポジトリの直下の Dockerfile(または自動判定)で動かす
export const emptyPlan = () => ({
  app: { name: '', context: '.', dockerfile: null, target: undefined, args: {}, command: undefined, entrypoint: undefined, env: {}, binds: [], volumes: [] },
  services: [],
  entry: null,
  order: [''],
  volumes: [],
  notes: [],
});

function readApp(name, def, vars, dir, notes) {
  const where = `サービス ${name}`;
  ignoredKeys(def, APP_KEYS, where, notes);
  const b = def.build;
  let context = '.';
  let dockerfile = null;
  let target;
  let args = {};
  if (typeof b === 'string') {
    context = b;
  } else if (b && typeof b === 'object' && !Array.isArray(b)) {
    context = b.context ?? '.';
    dockerfile = b.dockerfile ?? null;
    target = b.target;
    args = b.args === undefined ? {} : readEnvironment(b.args, vars, `${where} の build.args`);
    for (const k of Object.keys(b)) {
      if (!['context', 'dockerfile', 'target', 'args'].includes(k)) notes.push(`${where}: build.${k} は使えないため、無視します`);
    }
  } else {
    fail(`${where}: build の書き方が不正です`);
  }
  const ctx = repoPath(dir, String(context));
  if (!ctx) fail(`${where}: build の context(${context})は、リポジトリの中のフォルダにしてください`);
  if (dir && (!ctx.exists || !fs.statSync(ctx.full).isDirectory())) fail(`${where}: build の context(${context})が見つかりません`);
  if (dockerfile !== null) {
    if (typeof dockerfile !== 'string') fail(`${where}: build.dockerfile は文字列にしてください`);
    const df = repoPath(dir, path.posix.join(ctx.rel, dockerfile));
    if (!df || !(df.rel === ctx.rel || df.rel.startsWith(ctx.rel === '.' ? '' : ctx.rel + '/'))) {
      fail(`${where}: build.dockerfile(${dockerfile})は、context の中にしてください`);
    }
    if (dir && !df.exists) fail(`${where}: build.dockerfile(${dockerfile})が見つかりません`);
    dockerfile = ctx.rel === '.' ? df.rel : path.posix.relative(ctx.rel, df.rel);
  }
  if (target !== undefined && (typeof target !== 'string' || !TARGET_RE.test(target))) fail(`${where}: build.target が不正です`);

  let env;
  try {
    env = mergeEnv(readEnvFiles(def.env_file, dir, where, notes), readEnvironment(def.environment, vars, where), where);
  } catch (e) {
    if (!(e instanceof ComposeError)) throw e;
    notes.push(`${name}: environment を読めないため使いません(${e.message})`);
    env = {};
  }
  return {
    name,
    context: ctx.rel,
    dockerfile,
    target,
    args,
    command: readCommand(def.command, where, 'command'),
    entrypoint: readCommand(def.entrypoint, where, 'entrypoint'),
    env,
    ...readVolumes(def.volumes, dir, where, notes),
  };
}

function readSidecar(name, def, image, vars, dir, notes) {
  const where = `サービス ${name}`;
  ignoredKeys(def, SIDECAR_KEYS, where, notes);
  return {
    name,
    image: image.ref,
    memoryMb: serviceMemoryMb(image.name),
    env: mergeEnv(readEnvFiles(def.env_file, dir, where, notes), readEnvironment(def.environment, vars, where), where),
    command: readCommand(def.command, where, 'command'),
    ...readVolumes(def.volumes, dir, where, notes),
  };
}

// compose の文字列を読んで、計画を返す。
//   vars: 利用者がプロジェクトに設定した環境変数(${VAR} の置き換えにだけ使う)
//   dir : リポジトリの場所(ファイルの有無・場所を確かめる。省略すると、書き方だけを見る)
// 戻り値: { app, services, entry: {service, port} | null, order: [起動順のサービス名(アプリは app.name)], volumes, notes }
export function parseCompose(text, vars = {}, dir = null) {
  let doc;
  try {
    doc = parse(String(text), { maxAliasCount: 20, uniqueKeys: true });
  } catch (e) {
    fail(`docker-compose.yml を解析できません: ${String(e.message).split('\n')[0].slice(0, 200)}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('docker-compose.yml の形式が不正です');
  const notes = [];
  for (const k of Object.keys(doc)) {
    if (k !== 'services' && !TOP_QUIET.has(k) && !k.startsWith('x-')) notes.push(`${k} は使えないため、無視します`);
  }
  const svcs = doc.services;
  if (!svcs || typeof svcs !== 'object' || Array.isArray(svcs)) fail('docker-compose.yml に services がありません');

  // 1) 分類: build があればアプリ、image だけなら補助サービスの候補
  const builds = [];
  const sides = [];
  for (const [name, def] of Object.entries(svcs)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) fail(`サービス ${name} の書き方が不正です`);
    if (!SERVICE_NAME.test(name)) fail(`サービス名が不正です: ${name}(英数字・- ・_ で、31文字まで)`);
    if (def.profiles !== undefined) {
      notes.push(`${name}: profiles があるため、使いません`);
    } else if (def.build !== undefined) {
      builds.push([name, def]);
    } else if (def.image === undefined) {
      notes.push(`${name}: image も build も無いため、使いません`);
    } else {
      sides.push([name, def]);
    }
  }

  // 2) アプリ本体
  let app = emptyPlan().app;
  if (builds.length === 1) {
    app = readApp(builds[0][0], builds[0][1], vars, dir, notes);
    notes.push(`${app.name}: アプリとして、${app.context === '.' ? 'リポジトリの直下' : app.context} でビルドします`);
  } else if (builds.length > 1) {
    notes.push(`build があるサービスが ${builds.length} 個あります。複数のアプリは動かせないため、リポジトリの直下でビルドします`);
  }

  // 3) 補助サービス(許可リストのイメージだけ)
  const services = [];
  const deps = new Map([[app.name, builds.length === 1 ? readDeps(builds[0][1].depends_on) : []]]);
  const ports = new Map();
  for (const [name, def] of sides) {
    let image;
    try {
      image = validateImage(interpolate(String(def.image), vars));
    } catch (e) {
      notes.push(`${name}: ${e.message}。このサービスは動かしません`);
      continue;
    }
    services.push(readSidecar(name, def, image, vars, dir, notes));
    deps.set(name, readDeps(def.depends_on));
    ports.set(name, publicPorts(def.ports));
  }
  if (services.length > config.composeServices.maxServices) {
    fail(`補助サービスは ${config.composeServices.maxServices} 個までです(${services.length} 個あります)`);
  }

  const volumes = [...new Set([app, ...services].flatMap((s) => s.volumes.map((v) => v.name)))];
  if (volumes.length > MAX_VOLUMES) fail(`名前つきボリュームは ${MAX_VOLUMES} 個までです`);

  // 4) 入口: 外に公開している補助サービス(リバースプロキシなど)があれば、そこ。無ければ、今まで通りアプリ
  let entry = null;
  const front = services.filter((s) => ports.get(s.name).length > 0);
  if (front.length > 0) {
    entry = { service: front[0].name, port: ports.get(front[0].name)[0] };
    notes.push(`プレビューURLは ${entry.service}:${entry.port} につなぎます`);
    if (front.length > 1) notes.push(`ほかに公開しているサービス(${front.slice(1).map((s) => s.name).join(', ')})は、プレビューURLにつなぎません`);
  }

  // 5) 起動の順番(depends_on)。アプリが compose に無いときは、最後
  const known = new Set(deps.keys());
  const nodes = Object.keys(svcs).filter((n) => known.has(n));
  if (!nodes.includes(app.name)) nodes.push(app.name);
  const order = [];
  const rest = [...nodes];
  while (rest.length) {
    const i = rest.findIndex((n) => deps.get(n).every((d) => d === n || !known.has(d) || order.includes(d)));
    if (i < 0) {
      notes.push('depends_on が循環しているため、残りは書かれた順に起動します');
      order.push(...rest);
      break;
    }
    order.push(rest.splice(i, 1)[0]);
  }

  return { app, services, entry, order, volumes, notes };
}

// リポジトリの中から探して読む。無い・機能が無効のときは、今まで通り(compose を使わない)
export function loadComposePlan(dir, vars = {}) {
  if (!config.composeServices.enabled) return emptyPlan();
  const file = findComposeFile(dir);
  if (!file) return emptyPlan();
  return parseCompose(fs.readFileSync(file, 'utf8'), vars, dir);
}

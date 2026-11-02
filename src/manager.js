import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import Docker from 'dockerode';
import tar from 'tar-fs';
import { config } from './config.js';
import { decryptJson } from './crypto.js';
import { getProject, updateProject, listProjects, getUser, limitsFor } from './db.js';
import { appendLog, resetLog } from './logs.js';
import { detectRuntime } from './runtimes.js';
import { dnsEnabled, createPreviewRecord, deletePreviewRecord, sweepOrphans } from './dns.js';

const docker = new Docker(); // /var/run/docker.sock

export const previewHost = (id) => config.previewHostTemplate.replace('{id}', id);
export const previewUrl = (id) =>
  `${config.previewScheme}://${previewHost(id)}${config.previewPort ? `:${config.previewPort}` : ''}`;
const imageName = (id) => `devbox/${id}:latest`;
const containerName = (id) => `devbox-${id}`;

// ---- 同時ビルド数の制限 (簡易セマフォ) -------------------------------------
let activeBuilds = 0;
const waiters = [];
async function acquireBuildSlot() {
  if (activeBuilds < config.limits.maxConcurrentBuilds) {
    activeBuilds++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
}
function releaseBuildSlot() {
  const next = waiters.shift();
  if (next) next();
  else activeBuilds--;
}

// ---- プロジェクトごとの排他 -------------------------------------------------
const busy = new Set();
export const isBusy = (id) => busy.has(id);

// 利用者に見せる文字列から、サーバー内部のフォルダの場所を伏せる(git や docker のエラーに含まれる)
export function redact(text) {
  return String(text).split(config.dataDir).join('<data>');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function cloneRepo(p, dir) {
  appendLog(p.id, `==> git clone ${p.repo_url} (branch: ${p.branch})`);
  try {
    await run(
      'git',
      [
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        'clone', '--depth', '1', '--single-branch', '--no-tags',
        '--branch', p.branch, '--', p.repo_url, dir,
      ],
      {
        timeout: config.limits.cloneTimeoutSec * 1000,
        env: { PATH: process.env.PATH, HOME: dir + '.home', GIT_TERMINAL_PROMPT: '0' },
      }
    );
  } catch (e) {
    throw new Error(`git clone に失敗しました: ${redact((e.stderr || e.message).toString().trim()).slice(0, 500)}`);
  }
  // リポジトリサイズの上限チェック
  let total = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) total += fs.statSync(full).size;
      if (total > config.limits.maxRepoMb * 1024 * 1024) {
        throw new Error(`リポジトリが大きすぎます (上限 ${config.limits.maxRepoMb}MB)`);
      }
    }
  };
  walk(dir);
}

// Dockerfile があればそれを使い、無ければ中身から実行環境を判定して自動生成する。
function pickDockerfile(p, dir) {
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) {
    appendLog(p.id, '==> Dockerfile を検出');
    return 'Dockerfile';
  }
  const rt = detectRuntime(dir);
  appendLog(p.id, `==> ${rt.label} を検出 → Dockerfile を自動生成`);
  fs.writeFileSync(path.join(dir, '.devbox.Dockerfile'), rt.dockerfile);
  return '.devbox.Dockerfile';
}

// ビルドのリソース制限。メモリ・CPU・ネットワーク(実行時と同じ devbox-net)
export function buildLimitOpts() {
  const mem = config.limits.buildMemoryMb * 1024 * 1024;
  return {
    memory: mem,
    memswap: mem, // swap無効
    cpuperiod: 100_000,
    cpuquota: Math.round(config.limits.buildCpus * 100_000),
    networkmode: config.dockerNetwork,
  };
}

async function buildImage(p, dir, dockerfile) {
  appendLog(p.id, '==> docker build');
  await ensureNetwork();
  const context = tar.pack(dir, { ignore: (name) => name.split(path.sep).includes('.git') });
  const stream = await docker.buildImage(context, {
    t: imageName(p.id),
    dockerfile,
    rm: true,
    forcerm: true,
    labels: { 'devbox.id': p.id },
    ...buildLimitOpts(),
  });
  await new Promise((resolve, reject) => {
    // 時間切れ: 接続を切るとビルドが中断される
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`ビルドが長すぎます (上限 ${config.limits.buildTimeoutSec}秒)`));
    }, config.limits.buildTimeoutSec * 1000);
    docker.modem.followProgress(
      stream,
      (err, res) => {
        clearTimeout(timer);
        if (err) return reject(err);
        const last = res?.find((r) => r.error);
        if (last) return reject(new Error(last.error.trim()));
        resolve();
      },
      (ev) => {
        if (ev.stream) appendLog(p.id, ev.stream.replace(/\n$/, ''));
        else if (ev.status && !ev.progress) appendLog(p.id, ev.status);
        else if (ev.error) appendLog(p.id, `ERROR: ${ev.error}`);
      }
    );
  });
}

async function removeContainer(id) {
  try {
    const c = docker.getContainer(containerName(id));
    await c.remove({ force: true });
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
}

async function ensureNetwork() {
  try {
    await docker.getNetwork(config.dockerNetwork).inspect();
  } catch (e) {
    if (e.statusCode === 404) {
      await docker.createNetwork({ Name: config.dockerNetwork, Driver: 'bridge' });
    } else throw e;
  }
}

async function runContainer(p) {
  await ensureNetwork();
  await removeContainer(p.id);

  const host = previewHost(p.id);
  const userEnv = decryptJson(p.env_enc);
  // devbox 側の値を最後に置いて上書きされないようにする
  const env = { ...userEnv, HOST: '0.0.0.0', PORT: String(p.port) };
  const router = `devbox-${p.id}`;

  const container = await docker.createContainer({
    name: containerName(p.id),
    Image: imageName(p.id),
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: { [`${p.port}/tcp`]: {} },
    Labels: {
      'devbox.id': p.id,
      'traefik.enable': 'true',
      'traefik.docker.network': config.dockerNetwork,
      [`traefik.http.routers.${router}.rule`]: `Host(\`${host}\`)`,
      [`traefik.http.routers.${router}.entrypoints`]: config.traefikEntrypoint,
      [`traefik.http.services.${router}.loadbalancer.server.port`]: String(p.port),
    },
    HostConfig: {
      NetworkMode: config.dockerNetwork,
      Memory: config.limits.memoryMb * 1024 * 1024,
      MemorySwap: config.limits.memoryMb * 1024 * 1024, // swap無効
      NanoCpus: Math.round(config.limits.cpus * 1e9),
      PidsLimit: config.limits.pids,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Init: true,
      RestartPolicy: { Name: 'no' },
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
      ...(config.dockerRuntime ? { Runtime: config.dockerRuntime } : {}),
    },
  });
  await container.start();
  return container.id;
}

// ---- 同時稼働数の管理と待機キュー ---------------------------------------------
const ACTIVE = new Set(['building', 'running']);
const nowIso = () => new Date().toISOString();

// 自分自身を除いた、ビルド中+実行中のプロジェクト数
export const activeCount = (excludeId) =>
  listProjects().filter((p) => ACTIVE.has(p.status) && p.id !== excludeId).length;

// ---- 利用者ごとの同時起動数 ---------------------------------------------------------
// 上限に達したときに投げる。画面には、そのまま理由として表示される。
export class QuotaError extends Error {}

// その人が枠を使っているもの(ビルド中・実行中・順番待ち)。順番待ちも数えるのは、
// 待機列に何件も積んで、全体の枠を独占されないようにするため。
const OCCUPY = new Set(['building', 'running', 'queued']);
export const userOccupied = (userId, excludeId) =>
  listProjects(userId).filter((p) => OCCUPY.has(p.status) && p.id !== excludeId).length;

// 持ち主のいないプロジェクト(管理者が作った古いもの)は、制限しない
export function assertRunQuota(userId, excludeId) {
  if (!userId) return;
  const user = getUser(userId);
  if (!user) return;
  const { maxRunning } = limitsFor(user);
  if (userOccupied(userId, excludeId) >= maxRunning) {
    throw new QuotaError(
      `同時に起動できるのは ${maxRunning} 件までです。ほかのプロジェクトを停止してから起動してください`
    );
  }
}

// 待機中のプロジェクトを、待ち始めた順に返す
export function queueOrder() {
  return listProjects()
    .filter((p) => p.status === 'queued')
    .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
}

export function queuePosition(id) {
  const i = queueOrder().findIndex((p) => p.id === id);
  return i < 0 ? null : i + 1;
}

// DNS の削除は失敗してもプロジェクトの状態は進める(取り残しは定期的な掃除で消える)
async function safeDeleteDns(id) {
  if (!dnsEnabled()) return;
  try {
    await deletePreviewRecord(previewHost(id));
  } catch (e) {
    appendLog(id, `DNS レコードの削除に失敗しました(あとで自動で掃除されます): ${e.message}`);
  }
}

// ---- 公開API ----------------------------------------------------------------

// 起動の依頼。上限に達していれば「待機中」にする
export function startProject(id) {
  const p = getProject(id);
  if (!p) throw new Error('not found');
  if (busy.has(id)) throw new Error('このプロジェクトは処理中です');
  if (p.status === 'queued') return; // すでに順番待ち
  assertRunQuota(p.user_id, id);
  if (activeCount(id) >= config.maxRunning) {
    updateProject(id, { status: 'queued', error: null, queued_at: nowIso() });
    resetLog(id);
    appendLog(id, `==> 同時稼働数の上限(${config.maxRunning})に達しているため、順番待ちです`);
    return;
  }
  launch(id);
}

// 空きができたら、待機中のものを順番に起動する
export function drainQueue() {
  for (const q of queueOrder()) {
    if (busy.has(q.id)) continue;
    if (activeCount(q.id) >= config.maxRunning) break;
    launch(q.id);
  }
}

// ビルド→DNS作成→起動を非同期で実行 (呼び出し側は待たない)
function launch(id) {
  busy.add(id);
  updateProject(id, { status: 'building', error: null, queued_at: null });
  resetLog(id);

  (async () => {
    const p = getProject(id);
    const dir = path.join(config.dataDir, 'work', id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir + '.home', { recursive: true });
    let slot = false;
    try {
      appendLog(id, '==> ビルド待機中...');
      await acquireBuildSlot();
      slot = true;
      await cloneRepo(p, dir);
      const dockerfile = pickDockerfile(p, dir);
      await buildImage(p, dir, dockerfile);
      if (dnsEnabled()) {
        appendLog(id, `==> DNS レコードを作成: ${previewHost(id)}`);
        await createPreviewRecord(previewHost(id));
      }
      appendLog(id, '==> コンテナを起動');
      const containerId = await runContainer(p);
      updateProject(id, { status: 'running', container_id: containerId, error: null, started_at: nowIso(), last_active_at: nowIso() });
      appendLog(id, `==> 起動しました: ${previewUrl(id)}`);
    } catch (e) {
      const msg = redact(e.message);
      appendLog(id, `!! 失敗: ${msg}`);
      updateProject(id, { status: 'failed', error: msg.slice(0, 1000), started_at: null });
      // 失敗したら何も動いていない状態にそろえる
      try {
        await removeContainer(id);
      } catch {
        /* 後続の掃除に任せる */
      }
      await safeDeleteDns(id);
    } finally {
      if (slot) releaseBuildSlot();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dir + '.home', { recursive: true, force: true });
      busy.delete(id);
      drainQueue();
    }
  })();
}

export async function stopProject(id) {
  const p = getProject(id);
  if (!p) throw new Error('not found');
  if (busy.has(id)) throw new Error('このプロジェクトは処理中です');
  if (p.status === 'queued') {
    updateProject(id, { status: 'stopped', queued_at: null });
    return;
  }
  busy.add(id);
  try {
    await removeContainer(id);
    await safeDeleteDns(id);
    updateProject(id, { status: 'stopped', container_id: null, started_at: null, last_active_at: null });
    lastRx.delete(id);
  } finally {
    busy.delete(id);
  }
  drainQueue();
}

// 凍結されたときなどに、その人の動いているものを止める(処理中のものは、定期処理が後で止める)
export async function stopUserProjects(userId) {
  for (const p of listProjects(userId)) {
    if (busy.has(p.id) || !(p.status === 'running' || p.status === 'queued')) continue;
    try {
      appendLog(p.id, '==> アカウントが利用できない状態になったため停止します');
      await stopProject(p.id);
    } catch (e) {
      console.warn(`[stopUserProjects] ${p.id} を停止できません: ${e.message}`);
    }
  }
}

export async function deleteProjectResources(id) {
  if (busy.has(id)) throw new Error('このプロジェクトは処理中です');
  busy.add(id);
  try {
    await removeContainer(id);
    await safeDeleteDns(id);
    try {
      await docker.getImage(imageName(id)).remove({ force: true });
    } catch (e) {
      if (e.statusCode !== 404) throw e;
    }
  } finally {
    busy.delete(id);
  }
}

// 実行中コンテナの末尾ログ
export async function runtimeLogs(id, tail = 300) {
  try {
    const buf = await docker.getContainer(containerName(id)).logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    });
    return demux(buf);
  } catch (e) {
    if (e.statusCode === 404) return '(コンテナは存在しません)';
    throw e;
  }
}

// Docker の多重化ログ(8バイトヘッダ)を平文にする
function demux(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf);
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'));
    i += 8 + len;
  }
  return out.join('');
}

// 動いていないプロジェクトの DNS レコードを消す(devbox が作った印のあるものだけ)
export async function sweepDns() {
  if (!dnsEnabled()) return;
  try {
    const keep = listProjects().filter((p) => ACTIVE.has(p.status)).map((p) => p.id);
    const n = await sweepOrphans(keep);
    if (n > 0) console.log(`[dns] 取り残しのレコードを ${n} 件削除しました`);
  } catch (e) {
    console.warn(`[dns] 掃除に失敗しました: ${e.message}`);
  }
}

// 起動時に DB と Docker の実状態を突き合わせる
export async function reconcile() {
  let running = new Set();
  try {
    const list = await docker.listContainers({ all: true, filters: { label: ['devbox.id'] } });
    running = new Set(list.filter((c) => c.State === 'running').map((c) => c.Labels['devbox.id']));
  } catch (e) {
    console.warn(`[reconcile] Docker に接続できません: ${e.message}`);
    return;
  }
  for (const p of listProjects()) {
    if (p.status === 'building') {
      updateProject(p.id, { status: 'failed', error: 'サーバー再起動によりビルドが中断されました', started_at: null });
    } else if (p.status === 'running' && !running.has(p.id)) {
      updateProject(p.id, { status: 'stopped', container_id: null, started_at: null });
    }
  }
  await sweepDns();
  drainQueue();
}

// 停止すべきプロジェクトを探す。理由を返す(止めなくてよければ null)
//   - 持ち主のアカウントが「承認済み」でなくなった(凍結など)
//   - 最大稼働時間を超えた
//   - 無操作の時間が長い
export function stopReason(p, nowMs = Date.now()) {
  if (p.user_id) {
    const owner = getUser(p.user_id);
    if (!owner || owner.status !== 'approved') return 'アカウントが利用できない状態のため停止します';
  }
  if (config.maxRuntimeHours && p.status === 'running' && p.started_at) {
    if (nowMs - Date.parse(p.started_at) > config.maxRuntimeHours * 3600 * 1000) {
      return `最大稼働時間(${config.maxRuntimeHours}時間)を超えたため停止します`;
    }
  }
  if (config.idleStopMinutes && p.status === 'running') {
    const last = Date.parse(p.last_active_at || p.started_at || '');
    if (last && nowMs - last > config.idleStopMinutes * 60_000) {
      return `${config.idleStopMinutes}分間操作がなかったため停止します`;
    }
  }
  return null;
}

// ---- 無操作の検知 -----------------------------------------------------------
// コンテナが受け取った通信量(rx_bytes)が、前回より IDLE_RX_BYTES 以上増えていれば「操作あり」とする。
// プレビューへのアクセスは必ずコンテナへの受信になる。コンテナが再起動して数字が戻った場合も「操作あり」。
const IDLE_RX_BYTES = 2048;
const lastRx = new Map();

async function sampleActivity(p) {
  if (!config.idleStopMinutes || p.status !== 'running' || !p.container_id) return;
  try {
    const stats = await docker.getContainer(p.container_id).stats({ stream: false, 'one-shot': true });
    const rx = Object.values(stats.networks || {}).reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
    const prev = lastRx.get(p.id);
    lastRx.set(p.id, rx);
    if (prev !== undefined && (rx < prev || rx - prev >= IDLE_RX_BYTES)) {
      updateProject(p.id, { last_active_at: nowIso() });
    }
  } catch {
    /* 取れなかった回は、操作なしとして数える */
  }
}

// 1分ごとに、止めるべきものを止める / DNS の取り残しを定期的に掃除
export function startReaper() {
  setInterval(async () => {
    await Promise.all(listProjects().filter((p) => !busy.has(p.id)).map(sampleActivity));
    for (const p of listProjects()) {
      if (busy.has(p.id) || !(p.status === 'running' || p.status === 'queued')) continue;
      const reason = stopReason(p);
      if (!reason) continue;
      try {
        appendLog(p.id, `==> ${reason}`);
        await stopProject(p.id);
      } catch (e) {
        console.warn(`[reaper] ${p.id} を停止できません: ${e.message}`);
      }
    }
  }, 60_000).unref();
  if (dnsEnabled()) setInterval(sweepDns, 30 * 60_000).unref();
}

export async function dockerPing() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

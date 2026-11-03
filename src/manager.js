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

let docker = new Docker(); // /var/run/docker.sock
// テストで Docker の代わりを差し込む
export function setDockerForTest(d) {
  docker = d;
}

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

// 停止だけ行い、コンテナ(と、書き込んだデータ)は残す。すでに止まっていても、無くても、失敗にしない。
// 戻り値は、コンテナが残っているか
async function stopContainer(id) {
  try {
    await docker.getContainer(containerName(id)).stop({ t: 5 });
    return true;
  } catch (e) {
    if (e.statusCode === 304) return true; // すでに止まっている
    if (e.statusCode === 404) return false;
    throw e;
  }
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
// rebuild: true なら、コンテナを作り直す(書き込んだデータは消える)。実行中のものへの依頼は、常に再ビルド。
export function startProject(id, { rebuild = false } = {}) {
  const p = getProject(id);
  if (!p) throw new Error('not found');
  if (busy.has(id)) throw new Error('このプロジェクトは処理中です');
  if (p.status === 'queued') return; // すでに順番待ち
  if (rebuild || p.status === 'running') updateProject(id, { dirty: 1 });
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

// 前回のコンテナが残っていて、設定も変えていなければ、ビルドせずにそのまま再開できる
export const canResume = (p) => p.status !== 'running' && Boolean(p.container_id) && !p.dirty;

// 残っているコンテナを再開する。再開できたら(失敗して停止に戻した場合も)true、コンテナが無くて
// ビルドからやり直すべきなら false。
async function resumeContainer(p) {
  const id = p.id;
  appendLog(id, '==> 前回のコンテナを再開します(書き込んだデータは残っています)');
  try {
    await ensureNetwork();
    if (dnsEnabled()) {
      appendLog(id, `==> DNS レコードを作成: ${previewHost(id)}`);
      await createPreviewRecord(previewHost(id));
    }
    await docker.getContainer(containerName(id)).start();
    const info = await docker.getContainer(containerName(id)).inspect();
    updateProject(id, { status: 'running', container_id: info.Id, error: null, started_at: nowIso(), last_active_at: nowIso(),
      keepalive_at: nowIso(), confirm_deadline_at: null });
    appendLog(id, `==> 再開しました: ${previewUrl(id)}`);
    return true;
  } catch (e) {
    if (e.statusCode === 404) {
      appendLog(id, '==> コンテナが見つからないため、ビルドからやり直します(データは消えています)');
      updateProject(id, { container_id: null });
      return false;
    }
    const msg = redact(e.message);
    appendLog(id, `!! 再開に失敗: ${msg}`);
    updateProject(id, { status: 'stopped', error: msg.slice(0, 1000), started_at: null });
    await safeDeleteDns(id);
    return true;
  }
}

// ビルド→DNS作成→起動を非同期で実行 (呼び出し側は待たない)
function launch(id) {
  busy.add(id);
  updateProject(id, { status: 'building', error: null, queued_at: null });
  resetLog(id);

  (async () => {
    const p = getProject(id);
    if (canResume(p)) {
      let handled = false;
      try {
        handled = await resumeContainer(p);
      } finally {
        if (handled) {
          busy.delete(id);
          drainQueue();
        }
      }
      if (handled) return;
    }
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
      updateProject(id, { status: 'running', container_id: containerId, error: null, started_at: nowIso(), last_active_at: nowIso(),
        keepalive_at: nowIso(), confirm_deadline_at: null, dirty: 0 });
      appendLog(id, `==> 起動しました: ${previewUrl(id)}`);
    } catch (e) {
      const msg = redact(e.message);
      appendLog(id, `!! 失敗: ${msg}`);
      updateProject(id, { status: 'failed', error: msg.slice(0, 1000), started_at: null, container_id: null });
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
    const kept = await stopContainer(id); // 消さずに止める(次の「起動」で、データのまま再開できる)
    await safeDeleteDns(id);
    updateProject(id, { status: 'stopped', container_id: kept ? p.container_id : null, started_at: null, last_active_at: null, keepalive_at: null, confirm_deadline_at: null });
    lastRx.delete(id);
    lastCpuNs.delete(id);
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
  let existing = new Set();
  try {
    const list = await docker.listContainers({ all: true, filters: { label: ['devbox.id'] } });
    running = new Set(list.filter((c) => c.State === 'running').map((c) => c.Labels['devbox.id']));
    existing = new Set(list.map((c) => c.Labels['devbox.id']));
  } catch (e) {
    console.warn(`[reconcile] Docker に接続できません: ${e.message}`);
    return;
  }
  for (const p of listProjects()) {
    if (p.status === 'building') {
      updateProject(p.id, { status: 'failed', error: 'サーバー再起動によりビルドが中断されました', started_at: null });
    } else if (p.status === 'running' && !running.has(p.id)) {
      // コンテナが残っていれば、次の「起動」で再開できるように、そのまま持っておく
      updateProject(p.id, { status: 'stopped', container_id: existing.has(p.id) ? p.container_id : null, started_at: null, keepalive_at: null, confirm_deadline_at: null });
    } else if (p.status === 'stopped' && p.container_id && !existing.has(p.id)) {
      updateProject(p.id, { container_id: null });
    }
  }
  await sweepDns();
  drainQueue();
}

// 停止すべきプロジェクトを探す。理由を返す(止めなくてよければ null)
//   - 持ち主のアカウントが「承認済み」でなくなった(凍結など)
//   - 最大稼働時間を超えた
//   - 無操作の時間が長い
//   - 「まだ使っていますか?」の確認に、猶予の間に応答がなかった
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
  if (config.keepaliveMinutes && p.status === 'running' && p.confirm_deadline_at) {
    if (nowMs > Date.parse(p.confirm_deadline_at)) {
      return `${config.keepaliveMinutes}分ごとの「まだ使っていますか?」に応答がなかったため停止します`;
    }
  }
  return null;
}

// ---- 「まだ使っていますか?」の確認 -------------------------------------------------
// 起動(または前回の確認)から keepaliveMinutes たつと、確認を求める(confirm_deadline_at に期限を入れる)。
// 期限までに利用者が確認ボタンを押さなければ、stopReason が停止させる。通信の有無は見ない。
const keepaliveBase = (p) => Date.parse(p.keepalive_at || p.started_at || '');

export function confirmDue(p, nowMs = Date.now()) {
  if (!config.keepaliveMinutes || p.status !== 'running' || p.confirm_deadline_at) return false;
  const base = keepaliveBase(p);
  return Boolean(base) && nowMs - base >= config.keepaliveMinutes * 60_000;
}

// 次に確認が入るまでの秒数(確認待ちのとき・無効のときは null)
export function secondsToConfirm(p, nowMs = Date.now()) {
  if (!config.keepaliveMinutes || p.status !== 'running' || p.confirm_deadline_at) return null;
  const base = keepaliveBase(p);
  return base ? Math.max(0, Math.ceil((base + config.keepaliveMinutes * 60_000 - nowMs) / 1000)) : null;
}

// 最大稼働時間までの残り秒数(動いていない・上限なしのときは null)
export function runtimeSecondsLeft(p, nowMs = Date.now()) {
  if (!config.maxRuntimeHours || p.status !== 'running' || !p.started_at) return null;
  return Math.max(0, Math.ceil((Date.parse(p.started_at) + config.maxRuntimeHours * 3_600_000 - nowMs) / 1000));
}

// 確認待ちの残り秒数(確認待ちでなければ null)
export function confirmSecondsLeft(p, nowMs = Date.now()) {
  if (!config.keepaliveMinutes || p.status !== 'running' || !p.confirm_deadline_at) return null;
  return Math.max(0, Math.ceil((Date.parse(p.confirm_deadline_at) - nowMs) / 1000));
}

export class ConfirmError extends Error {}

// 確認ボタンが押されたとき。確認を求められている間だけ受け付ける(先回しの確認はできない)
export function acknowledgeConfirm(id, nowMs = Date.now()) {
  const p = getProject(id);
  if (!p || p.status !== 'running' || !p.confirm_deadline_at) throw new ConfirmError('いま確認は求められていません');
  if (nowMs > Date.parse(p.confirm_deadline_at)) throw new ConfirmError('確認の期限が切れました');
  return updateProject(id, { keepalive_at: new Date(nowMs).toISOString(), confirm_deadline_at: null });
}

// ---- 実行中の計測(無操作の検知・CPU時間) ---------------------------------------
// 1分ごとにコンテナの統計を1回読み、前回との差から次の2つを求める。
//  - 無操作の検知: 受信した通信量(rx_bytes)が IDLE_RX_BYTES 以上増えていれば「操作あり」。
//    プレビューへのアクセスは必ずコンテナへの受信になる。
//  - CPU時間: コンテナが使ったCPU時間(ナノ秒)の増え分を、ミリ秒にしてプロジェクトごとに累計する。
// どちらもコンテナが再起動して数字が戻った場合は、「操作あり」として、戻った後の値から数え直す。
// 基準値はメモリ上に持つので、devbox の再起動後、最初の1回は基準を取るだけ(その分は数えない)。
const IDLE_RX_BYTES = 2048;
const lastRx = new Map();
const lastCpuNs = new Map();

// 前回との差。数字が戻っていたら(再起動)、今の値そのものを差とみなす
export const counterDelta = (prev, cur) => (prev === undefined ? 0 : cur >= prev ? cur - prev : cur);

async function sampleContainer(p) {
  if (p.status !== 'running' || !p.container_id) return;
  try {
    const stats = await docker.getContainer(p.container_id).stats({ stream: false, 'one-shot': true });
    const fields = {};

    const rx = Object.values(stats.networks || {}).reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
    const prevRx = lastRx.get(p.id);
    lastRx.set(p.id, rx);
    if (prevRx !== undefined && (rx < prevRx || rx - prevRx >= IDLE_RX_BYTES)) fields.last_active_at = nowIso();

    const cpuNs = stats.cpu_stats?.cpu_usage?.total_usage;
    if (typeof cpuNs === 'number') {
      const deltaMs = Math.round(counterDelta(lastCpuNs.get(p.id), cpuNs) / 1e6);
      lastCpuNs.set(p.id, cpuNs);
      if (deltaMs > 0) fields.cpu_ms = (p.cpu_ms || 0) + deltaMs;
    }
    if (Object.keys(fields).length) updateProject(p.id, fields);
  } catch {
    /* 取れなかった回は、操作なし・CPU時間0として数える */
  }
}

// ---- 残してあるコンテナ(書き込んだデータ)の掃除 ----------------------------------
// 停止してもコンテナを消さないので、増え続けないように2つの上限で消す。消すと、次の「起動」はビルドからになる。
//  - 書き込み層が DATA_LIMIT_MB を超えたもの(動いていれば、止めてから消す)
//  - 停止してから STOPPED_KEEP_DAYS 日たったもの
export function storageVerdict(p, sizeRw, nowMs = Date.now()) {
  if (config.limits.dataLimitMb && sizeRw > config.limits.dataLimitMb * 1024 * 1024) {
    return `データが上限(${config.limits.dataLimitMb}MB)を超えたため、コンテナを削除しました`;
  }
  if (config.limits.stoppedKeepDays && p.status === 'stopped' && nowMs - Date.parse(p.updated_at) > config.limits.stoppedKeepDays * 86_400_000) {
    return `停止から${config.limits.stoppedKeepDays}日たったため、保存していたデータを削除しました`;
  }
  return null;
}

export async function sweepStorage() {
  let list;
  try {
    list = await docker.listContainers({ all: true, size: true, filters: { label: ['devbox.id'] } });
  } catch (e) {
    console.warn(`[sweepStorage] Docker に接続できません: ${e.message}`);
    return;
  }
  for (const c of list) {
    const id = c.Labels['devbox.id'];
    const p = getProject(id);
    if (!p || busy.has(id)) continue;
    const reason = storageVerdict(p, c.SizeRw || 0);
    if (!reason) continue;
    try {
      appendLog(id, `==> ${reason}`);
      if (p.status === 'running' || p.status === 'queued') await stopProject(id);
      busy.add(id);
      try {
        await removeContainer(id);
        updateProject(id, { container_id: null, error: reason });
      } finally {
        busy.delete(id);
      }
    } catch (e) {
      console.warn(`[sweepStorage] ${id} を削除できません: ${e.message}`);
    }
  }
}

// 確認の時刻が来たものに、期限を付けて確認を始める。時刻ちょうどに画面に出るように、5秒ごとに呼ぶ
export function startDueConfirms(nowMs = Date.now()) {
  for (const p of listProjects()) {
    if (busy.has(p.id) || !confirmDue(p, nowMs)) continue;
    const deadline = new Date(nowMs + config.keepaliveGraceMinutes * 60_000).toISOString();
    updateProject(p.id, { confirm_deadline_at: deadline });
    appendLog(p.id, `==> まだ使っていますか? ${config.keepaliveGraceMinutes}分以内に、devbox の画面で「続ける」を押してください`);
  }
}

// 1分ごとに、止めるべきものを止める / DNS の取り残しを定期的に掃除
// 確認を始める・止めるべきものを止める。表示のタイマーが 0:00 になったとき、ちょうど動くように、5秒ごとに呼ぶ
let enforcing = false;
export async function enforceStops() {
  if (enforcing) return; // 前回の停止(docker stop)が長引いているときは、重ねない
  enforcing = true;
  try {
    startDueConfirms();
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
  } finally {
    enforcing = false;
  }
}

// 5秒ごとに停止の判定、1分ごとに計測(通信量・CPU時間)、30分ごとに掃除
export function startReaper() {
  setInterval(enforceStops, 5_000).unref();
  setInterval(() => Promise.all(listProjects().filter((p) => !busy.has(p.id)).map(sampleContainer)), 60_000).unref();
  if (dnsEnabled()) setInterval(sweepDns, 30 * 60_000).unref();
  setInterval(sweepStorage, 30 * 60_000).unref();
}

export async function dockerPing() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

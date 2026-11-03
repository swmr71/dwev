import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { encryptJson, decryptJson } from './crypto.js';
import {
  insertProject, getProject, listProjects, updateProject, deleteProject, countProjects, newId,
  getUser, listUsers, updateUser, limitsFor, deleteUserSessions, purgeExpiredSessions, USER_STATUSES,
} from './db.js';
import {
  ValidationError, validateName, validateRepoUrl, validateBranch, validatePort, validateEnv,
} from './validate.js';
import {
  startProject, stopProject, deleteProjectResources, runtimeLogs, reconcile, dockerPing, previewUrl, isBusy,
  drainQueue, queuePosition, activeCount, startReaper, QuotaError, assertRunQuota, userOccupied, stopUserProjects,
  confirmSecondsLeft, secondsToConfirm, runtimeSecondsLeft, acknowledgeConfirm, ConfirmError, canResume,
} from './manager.js';
import { assertDnsConfig, dnsEnabled } from './dns.js';
import { readLog, removeLog } from './logs.js';
import { verifyHuman, humanCheckEnabled, KEEPALIVE_ACTION } from './humancheck.js';
import { privateReposEnabled, installUrl, hasToken, clearToken } from './ghtoken.js';
import {
  loadUser, requireLogin, requireApproved, adminAuth, sameOriginOnly, authRouter, githubEnabled,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/healthz', async (_req, res) => {
  res.json({ ok: true, docker: await dockerPing() });
});

app.use(loadUser);
app.use('/auth', authRouter);

// 公開用の表現。env の値は返さずキー名だけ返す。
function present(p) {
  let envKeys = [];
  try {
    envKeys = Object.keys(decryptJson(p.env_enc));
  } catch {
    /* 復号失敗時は空 */
  }
  return {
    id: p.id,
    name: p.name,
    repoUrl: p.repo_url,
    branch: p.branch,
    port: p.port,
    status: p.status,
    busy: isBusy(p.id),
    error: p.error,
    envKeys,
    previewUrl: previewUrl(p.id),
    cpuMs: p.cpu_ms || 0,
    // 停止中で、前回のコンテナ(書き込んだデータ)が残っている。「起動」でそのまま再開できる
    resumable: p.status === 'stopped' && canResume(p),
    // 設定を変えたので、次の起動はビルドからになる(データは消える)
    needsRebuild: Boolean(p.dirty && p.container_id && p.status !== 'running'),
    confirmSecondsLeft: confirmSecondsLeft(p),
    secondsToConfirm: secondsToConfirm(p),
    runtimeSecondsLeft: runtimeSecondsLeft(p),
    queuePosition: p.status === 'queued' ? queuePosition(p.id) : null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function presentUser(u) {
  return {
    id: u.id,
    login: u.login,
    avatarUrl: u.avatar_url,
    status: u.status,
    limits: limitsFor(u),
    // 上限に対して、今どれだけ使っているか
    usage: { projects: countProjects(u.id), running: userOccupied(u.id) },
  };
}

const api = express.Router();
api.use(sameOriginOnly);

// ---- 利用者向けAPI(GitHub でログインして、承認された人だけ) --------------------------
const guard = [requireLogin, requireApproved];

// 状態の確認。ログイン前は 401、承認待ちでも返す(画面がメッセージを出すため)
api.get('/me', requireLogin, (req, res) => {
  res.json({
    ...presentUser(req.user),
    githubLogin: githubEnabled(),
    // プライベートリポジトリ。installUrl: 使うリポジトリを許可する GitHub App のインストール画面
    // connected: 読み取りの権限(トークン)を受け取り済み。まだなら、ログインし直してもらう
    privateRepos: privateReposEnabled()
      ? { enabled: true, installUrl: installUrl(), connected: hasToken(req.user) }
      : { enabled: false },
  });
});

// 受け取った GitHub のトークンを、devbox から消す(プライベートリポジトリは使えなくなる)
api.post('/me/github/disconnect', requireLogin, (req, res) => {
  clearToken(req.user.id);
  res.json({ ok: true });
});

api.get('/info', ...guard, (_req, res) => {
  res.json({
    active: activeCount(),
    maxRunning: config.maxRunning,
    maxRuntimeHours: config.maxRuntimeHours,
    idleStopMinutes: config.idleStopMinutes,
    keepaliveMinutes: config.keepaliveMinutes,
    keepaliveGraceMinutes: config.keepaliveGraceMinutes,
    turnstileSiteKey: humanCheckEnabled() ? config.turnstile.siteKey : '',
  });
});

api.get('/projects', ...guard, (req, res) => {
  res.json(listProjects(req.user.id).map(present));
});

api.post('/projects', ...guard, (req, res) => {
  const b = req.body || {};
  const name = validateName(b.name);
  const repoUrl = validateRepoUrl(b.repoUrl);
  const branch = validateBranch(b.branch ?? 'main');
  const port = validatePort(b.port);
  const env = validateEnv(b.env);
  const { maxProjects } = limitsFor(req.user);
  if (countProjects(req.user.id) >= maxProjects) {
    return res.status(429).json({ error: `作れるプロジェクトは ${maxProjects} 件までです。不要なものを削除してください` });
  }
  if (countProjects() >= config.limits.maxProjects) {
    return res.status(429).json({ error: 'サーバー全体のプロジェクト数の上限に達しています' });
  }
  // 作ってから起動に失敗する、ということがないように、先に確認する
  if (b.autoStart !== false) assertRunQuota(req.user.id);
  const p = insertProject({ id: newId(), name, repoUrl, branch, port, envEnc: encryptJson(env), userId: req.user.id });
  if (b.autoStart !== false) startProject(p.id);
  res.status(201).json(present(getProject(p.id)));
});

// 自分のプロジェクトだけを取り出す。他人のものは、存在しないのと同じ 404 にする。
function load(req, res, next) {
  const p = /^[0-9a-f]{10}$/.test(req.params.id) ? getProject(req.params.id) : null;
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: '見つかりません' });
  req.project = p;
  next();
}

api.get('/projects/:id', ...guard, load, (req, res) => res.json(present(req.project)));

// env / branch / port / name の更新 (反映には再ビルド・再起動が必要)
api.patch('/projects/:id', ...guard, load, (req, res) => {
  if (isBusy(req.project.id)) return res.status(409).json({ error: '処理中です' });
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = validateName(b.name);
  if (b.branch !== undefined) fields.branch = validateBranch(b.branch);
  if (b.port !== undefined) fields.port = validatePort(b.port);
  if (b.env !== undefined) fields.env_enc = encryptJson(validateEnv(b.env));
  // コンテナは作ったときの設定のままなので、変えたら次の起動はビルドからにする
  if (b.branch !== undefined || b.port !== undefined || b.env !== undefined) fields.dirty = 1;
  res.json(present(updateProject(req.project.id, fields)));
});

api.post('/projects/:id/start', ...guard, load, (req, res) => {
  if (isBusy(req.project.id)) return res.status(409).json({ error: '処理中です' });
  startProject(req.project.id, { rebuild: req.body?.rebuild === true });
  res.status(202).json(present(getProject(req.project.id)));
});

// 「まだ使っていますか?」への応答。確認を求められている間だけ受け付け、人かどうかも確かめる。
// 失敗が続くとしばらく断る(スクリプトで総当たりされないように)。
const humanFails = new Map(); // userId -> { count, resetAt }
api.post('/projects/:id/keepalive', ...guard, load, async (req, res) => {
  const fail = humanFails.get(req.user.id);
  if (fail && fail.resetAt > Date.now() && fail.count >= 5) {
    return res.status(429).json({ error: '失敗が続いています。しばらくしてからやり直してください' });
  }
  if (confirmSecondsLeft(req.project) === null) {
    return res.status(409).json({ error: 'いま確認は求められていません' });
  }
  if (!(await verifyHuman(req.body?.token, { action: KEEPALIVE_ACTION, cdata: req.project.id }))) {
    const cur = fail && fail.resetAt > Date.now() ? fail : { count: 0, resetAt: Date.now() + 60_000 };
    cur.count++;
    humanFails.set(req.user.id, cur);
    return res.status(400).json({ error: '人であることを確認できませんでした。もう一度お試しください', code: 'human' });
  }
  try {
    res.json(present(acknowledgeConfirm(req.project.id)));
  } catch (e) {
    if (e instanceof ConfirmError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

api.post('/projects/:id/stop', ...guard, load, async (req, res) => {
  await stopProject(req.project.id);
  res.json(present(getProject(req.project.id)));
});

async function removeProject(id) {
  await deleteProjectResources(id);
  deleteProject(id);
  removeLog(id);
  drainQueue();
}

api.delete('/projects/:id', ...guard, load, async (req, res) => {
  await removeProject(req.project.id);
  res.json({ ok: true });
});

// ビルドログ (offset 以降の差分を返す。UI がポーリングする)
api.get('/projects/:id/build-log', ...guard, load, (req, res) => {
  const offset = Number.parseInt(req.query.offset ?? '0', 10) || 0;
  res.json(readLog(req.project.id, offset));
});

api.get('/projects/:id/runtime-log', ...guard, load, async (req, res) => {
  res.json({ text: await runtimeLogs(req.project.id) });
});

// ---- 管理者向けAPI(管理トークン。公開側では、Cloudflare Access でも /admin と /api/admin を守る) -----
const admin = express.Router();
admin.use(adminAuth);

admin.get('/info', (_req, res) => {
  const users = listUsers();
  res.json({
    active: activeCount(),
    maxRunning: config.maxRunning,
    maxRuntimeHours: config.maxRuntimeHours,
    dnsAutomation: dnsEnabled(),
    githubLogin: githubEnabled(),
    defaults: { maxProjects: config.defaultMaxProjects, maxRunning: config.defaultMaxRunning },
    users: Object.fromEntries(USER_STATUSES.map((s) => [s, users.filter((u) => u.status === s).length])),
  });
});

admin.get('/users', (_req, res) => {
  res.json(
    listUsers().map((u) => ({
      ...presentUser(u),
      githubId: u.github_id,
      maxProjectsSetting: u.max_projects, // null = 既定値を使う
      maxRunningSetting: u.max_running,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    }))
  );
});

// null / 空文字 = 既定値に戻す
function limitValue(v, label, max) {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ValidationError(`${label} は 0〜${max} の整数にしてください`);
  return n;
}

admin.patch('/users/:id', async (req, res) => {
  const user = /^\d{1,12}$/.test(req.params.id) ? getUser(Number(req.params.id)) : null;
  if (!user) return res.status(404).json({ error: '見つかりません' });
  const b = req.body || {};
  const fields = {};
  if (b.status !== undefined) {
    if (!USER_STATUSES.includes(b.status)) throw new ValidationError('status が不正です');
    fields.status = b.status;
  }
  if (b.maxProjects !== undefined) fields.max_projects = limitValue(b.maxProjects, 'maxProjects', 100);
  if (b.maxRunning !== undefined) fields.max_running = limitValue(b.maxRunning, 'maxRunning', 20);
  const updated = updateUser(user.id, fields);
  if (updated.status !== 'approved') {
    // 承認を外した(凍結など)ら、ログインを無効にして、動いているものを止める
    deleteUserSessions(user.id);
    await stopUserProjects(user.id);
  }
  res.json(presentUser(updated));
});

admin.get('/projects', (_req, res) => {
  res.json(
    listProjects().map((p) => ({ ...present(p), owner: p.user_id ? (getUser(p.user_id)?.login ?? null) : null }))
  );
});

function loadAny(req, res, next) {
  const p = /^[0-9a-f]{10}$/.test(req.params.id) ? getProject(req.params.id) : null;
  if (!p) return res.status(404).json({ error: '見つかりません' });
  req.project = p;
  next();
}

admin.post('/projects/:id/stop', loadAny, async (req, res) => {
  await stopProject(req.project.id);
  res.json(present(getProject(req.project.id)));
});

admin.delete('/projects/:id', loadAny, async (req, res) => {
  await removeProject(req.project.id);
  res.json({ ok: true });
});

api.use('/admin', admin);

app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- エラー処理 -------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof QuotaError) return res.status(409).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON が不正です' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'リクエストが大きすぎます' });
  if (err?.message === '処理中です' || /処理中/.test(err?.message || '')) {
    return res.status(409).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'サーバーエラーが発生しました' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertDnsConfig();
  if (!githubEnabled()) {
    console.warn('[auth] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / PUBLIC_URL が未設定のため、利用者はログインできません');
  }
  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 3600_000).unref();
  await reconcile();
  startReaper();
  app.listen(config.port, () => {
    console.log(`devbox listening on :${config.port}`);
    if (config.generatedToken) {
      console.log(`ADMIN_TOKEN が未設定のため一時トークンを生成しました: ${config.adminToken}`);
      console.log('(再起動で変わります。固定するには環境変数 ADMIN_TOKEN を設定してください)');
    }
  });
}

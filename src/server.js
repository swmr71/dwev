import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { encryptJson, decryptJson, safeEqual } from './crypto.js';
import { insertProject, getProject, listProjects, updateProject, deleteProject, countProjects, newId } from './db.js';
import {
  ValidationError, validateName, validateRepoUrl, validateBranch, validatePort, validateEnv,
} from './validate.js';
import {
  startProject, stopProject, deleteProjectResources, runtimeLogs, reconcile, dockerPing, previewUrl, isBusy,
  drainQueue, queuePosition, activeCount, startReaper,
} from './manager.js';
import { assertDnsConfig, dnsEnabled } from './dns.js';
import { readLog, removeLog } from './logs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/healthz', async (_req, res) => {
  res.json({ ok: true, docker: await dockerPing() });
});

// ---- 認証 (管理トークン) ----------------------------------------------------
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || !safeEqual(token, config.adminToken)) {
    return res.status(401).json({ error: '認証に失敗しました' });
  }
  next();
}

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
    queuePosition: p.status === 'queued' ? queuePosition(p.id) : null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const api = express.Router();
api.use(auth);

// 画面の上部に出す情報(稼働数・上限など)
api.get('/info', (_req, res) => {
  res.json({
    active: activeCount(),
    maxRunning: config.maxRunning,
    maxRuntimeHours: config.maxRuntimeHours,
    dnsAutomation: dnsEnabled(),
  });
});

api.get('/projects', (_req, res) => {
  res.json(listProjects().map(present));
});

api.post('/projects', (req, res) => {
  const b = req.body || {};
  const name = validateName(b.name);
  const repoUrl = validateRepoUrl(b.repoUrl);
  const branch = validateBranch(b.branch ?? 'main');
  const port = validatePort(b.port);
  const env = validateEnv(b.env);
  if (countProjects() >= config.limits.maxProjects) {
    return res.status(429).json({ error: `プロジェクト数の上限(${config.limits.maxProjects})に達しています` });
  }
  const p = insertProject({ id: newId(), name, repoUrl, branch, port, envEnc: encryptJson(env) });
  if (b.autoStart !== false) startProject(p.id);
  res.status(201).json(present(getProject(p.id)));
});

function load(req, res, next) {
  const p = /^[0-9a-f]{10}$/.test(req.params.id) ? getProject(req.params.id) : null;
  if (!p) return res.status(404).json({ error: '見つかりません' });
  req.project = p;
  next();
}

api.get('/projects/:id', load, (req, res) => res.json(present(req.project)));

// env / branch / port / name の更新 (反映には再ビルド・再起動が必要)
api.patch('/projects/:id', load, (req, res) => {
  if (isBusy(req.project.id)) return res.status(409).json({ error: '処理中です' });
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = validateName(b.name);
  if (b.branch !== undefined) fields.branch = validateBranch(b.branch);
  if (b.port !== undefined) fields.port = validatePort(b.port);
  if (b.env !== undefined) fields.env_enc = encryptJson(validateEnv(b.env));
  res.json(present(updateProject(req.project.id, fields)));
});

api.post('/projects/:id/start', load, (req, res) => {
  if (isBusy(req.project.id)) return res.status(409).json({ error: '処理中です' });
  startProject(req.project.id);
  res.status(202).json(present(getProject(req.project.id)));
});

api.post('/projects/:id/stop', load, async (req, res) => {
  await stopProject(req.project.id);
  res.json(present(getProject(req.project.id)));
});

api.delete('/projects/:id', load, async (req, res) => {
  await deleteProjectResources(req.project.id);
  deleteProject(req.project.id);
  removeLog(req.project.id);
  drainQueue();
  res.json({ ok: true });
});

// ビルドログ (offset 以降の差分を返す。UI がポーリングする)
api.get('/projects/:id/build-log', load, (req, res) => {
  const offset = Number.parseInt(req.query.offset ?? '0', 10) || 0;
  res.json(readLog(req.project.id, offset));
});

api.get('/projects/:id/runtime-log', load, async (req, res) => {
  res.json({ text: await runtimeLogs(req.project.id) });
});

app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- エラー処理 -------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
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

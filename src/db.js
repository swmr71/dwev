import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const db = new DatabaseSync(path.join(config.dataDir, 'devbox.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    repo_url     TEXT NOT NULL,
    branch       TEXT NOT NULL,
    env_enc      TEXT,
    port         INTEGER NOT NULL DEFAULT 3000,
    status       TEXT NOT NULL DEFAULT 'created',
    container_id TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- 利用者 (GitHub アカウントでログイン)。status: pending(承認待ち) / approved / suspended(凍結)
  -- max_projects / max_running が NULL のときは、設定の既定値を使う
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id     INTEGER NOT NULL UNIQUE,
    login         TEXT NOT NULL,
    avatar_url    TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    max_projects  INTEGER,
    max_running   INTEGER,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  -- ログインセッション。Cookie の値そのものは保存せず、ハッシュだけを持つ
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`);

// 既存DBへの列追加(待機に入った時刻・稼働開始時刻・持ち主)
const existingCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
for (const col of ['queued_at TEXT', 'started_at TEXT', 'user_id INTEGER', 'last_active_at TEXT', 'cpu_ms INTEGER DEFAULT 0',
  'keepalive_at TEXT', 'confirm_deadline_at TEXT', 'dirty INTEGER DEFAULT 0', 'memory_mb INTEGER']) {
  const name = col.split(' ')[0];
  if (!existingCols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${col}`);
}
db.exec('CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id)');

// 利用者の GitHub トークン(暗号化)。プライベートリポジトリの clone 用
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
for (const col of ['gh_token_enc TEXT', 'memory_budget_mb INTEGER', 'points REAL', 'points_cap REAL']) {
  if (!userCols.includes(col.split(' ')[0])) db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
}

const now = () => new Date().toISOString();

export const newId = () => crypto.randomBytes(5).toString('hex'); // DNS-safe (hex, 10文字)

// ---- プロジェクト --------------------------------------------------------------

// userId を渡すとその人のものだけ、省略すると全部(管理者・内部処理用)
export function listProjects(userId) {
  if (userId === undefined) return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  return db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function countProjects(userId) {
  if (userId === undefined) return db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  return db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(userId).n;
}

export function insertProject(p) {
  const t = now();
  db.prepare(
    `INSERT INTO projects (id, name, repo_url, branch, env_enc, port, status, user_id, memory_mb, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`
  ).run(p.id, p.name, p.repoUrl, p.branch, p.envEnc, p.port, p.userId ?? null, p.memoryMb ?? null, t, t);
  return getProject(p.id);
}

const COLUMNS = new Set([
  'name', 'branch', 'env_enc', 'port', 'status', 'container_id', 'error', 'queued_at', 'started_at', 'last_active_at', 'cpu_ms',
  'keepalive_at', 'confirm_deadline_at', 'dirty', 'memory_mb',
]);

export function updateProject(id, fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!COLUMNS.has(k)) throw new Error(`unknown column: ${k}`);
  if (keys.length === 0) return getProject(id);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k] ?? null),
    now(),
    id
  );
  return getProject(id);
}

export function deleteProject(id) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ---- 利用者 --------------------------------------------------------------------

export const USER_STATUSES = ['pending', 'approved', 'suspended'];

export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

// 初めてのログインは「承認待ち」で作る。2回目以降は名前とアイコンだけ更新(状態は変えない)。
export function upsertGithubUser({ githubId, login, avatarUrl }) {
  const t = now();
  const ex = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId);
  if (ex) {
    db.prepare('UPDATE users SET login = ?, avatar_url = ?, last_login_at = ? WHERE id = ?').run(
      login, avatarUrl ?? null, t, ex.id
    );
    return getUser(ex.id);
  }
  const r = db
    .prepare(
      `INSERT INTO users (github_id, login, avatar_url, status, created_at, last_login_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    )
    .run(githubId, login, avatarUrl ?? null, t, t);
  return getUser(Number(r.lastInsertRowid));
}

const USER_COLUMNS = new Set(['status', 'max_projects', 'max_running', 'memory_budget_mb', 'points', 'points_cap', 'gh_token_enc']);

export function updateUser(id, fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!USER_COLUMNS.has(k)) throw new Error(`unknown column: ${k}`);
  if (fields.status !== undefined && !USER_STATUSES.includes(fields.status)) throw new Error('invalid status');
  if (keys.length === 0) return getUser(id);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  return getUser(id);
}

// その人の上限。個別の設定が無ければ既定値
export const limitsFor = (user) => ({
  maxProjects: user.max_projects ?? config.defaultMaxProjects,
  maxRunning: user.max_running ?? config.defaultMaxRunning,
  memoryBudgetMb: user.memory_budget_mb ?? config.defaultMemoryBudgetMb,
});

// ---- セッション ----------------------------------------------------------------

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionDays * 86_400_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha(token), userId, created.toISOString(), expires.toISOString()
  );
  return { token, expiresAt: expires };
}

export function getSessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    deleteSession(token);
    return null;
  }
  return getUser(row.user_id) || null;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function deleteUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

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
`);

// 既存DBへの列追加(待機に入った時刻・稼働開始時刻)
const existingCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
for (const col of ['queued_at', 'started_at']) {
  if (!existingCols.includes(col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
}

const now = () => new Date().toISOString();

export const newId = () => crypto.randomBytes(5).toString('hex'); // DNS-safe (hex, 10文字)

export function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function countProjects() {
  return db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
}

export function insertProject(p) {
  const t = now();
  db.prepare(
    `INSERT INTO projects (id, name, repo_url, branch, env_enc, port, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)`
  ).run(p.id, p.name, p.repoUrl, p.branch, p.envEnc, p.port, t, t);
  return getProject(p.id);
}

const COLUMNS = new Set([
  'name', 'branch', 'env_enc', 'port', 'status', 'container_id', 'error', 'queued_at', 'started_at',
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

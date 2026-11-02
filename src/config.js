import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'work'), { recursive: true });

// 暗号鍵: 環境変数 > data/secret.key (無ければ生成して 0600 で保存)
function loadSecret() {
  if (process.env.SECRET_KEY) {
    const buf = Buffer.from(process.env.SECRET_KEY, 'hex');
    if (buf.length !== 32) throw new Error('SECRET_KEY must be 64 hex chars (32 bytes)');
    return buf;
  }
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

// 管理トークン: 環境変数が無ければ起動ごとに生成して表示
let generatedToken = false;
let adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  adminToken = crypto.randomBytes(24).toString('hex');
  generatedToken = true;
}

export const config = {
  port: int(process.env.PORT, 3000),
  dataDir,
  secretKey: loadSecret(),
  adminToken,
  generatedToken,

  // プレビューURL。{id} が置換される。
  // 例: "{id}-dev.clusters-prj.com" (Cloudflareの無料Universal SSLは1階層ワイルドカードのみ対応)
  previewHostTemplate: process.env.PREVIEW_HOST_TEMPLATE || '{id}.localtest.me',
  previewScheme: process.env.PREVIEW_SCHEME || 'http',
  // プレビューURLに付けるポート(LAN内で :8080 のまま使うときなど)。未設定なら付けない
  previewPort: int(process.env.PREVIEW_PORT, 0) || '',

  // Traefik と接続する Docker ネットワーク
  dockerNetwork: process.env.DOCKER_NETWORK || 'devbox-net',
  traefikEntrypoint: process.env.TRAEFIK_ENTRYPOINT || 'web',

  // git のクローン元として許可するホスト (SSRF/内部アクセス対策)
  allowedGitHosts: (process.env.ALLOWED_GIT_HOSTS || 'github.com,gitlab.com,bitbucket.org')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // コンテナのリソース制限
  limits: {
    memoryMb: int(process.env.LIMIT_MEMORY_MB, 512),
    cpus: Number(process.env.LIMIT_CPUS) > 0 ? Number(process.env.LIMIT_CPUS) : 1,
    pids: int(process.env.LIMIT_PIDS, 256),
    maxProjects: int(process.env.MAX_PROJECTS, 10),
    maxConcurrentBuilds: int(process.env.MAX_CONCURRENT_BUILDS, 2),
    cloneTimeoutSec: int(process.env.CLONE_TIMEOUT_SEC, 120),
    maxRepoMb: int(process.env.MAX_REPO_MB, 300),
  },

  // gVisor等を使う場合: DOCKER_RUNTIME=runsc
  dockerRuntime: process.env.DOCKER_RUNTIME || undefined,
};

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

  // 公開URL(OAuthのコールバックURLと、CookieのSecure判定に使う)。例: https://devbox.clusters-prj.com
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // GitHub OAuth App の認証情報。両方そろったときだけ利用者のログインが有効になる。
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  },
  sessionDays: int(process.env.SESSION_DAYS, 14),
  // 利用者ごとの既定の上限(管理画面から人ごとに変えられる)
  defaultMaxProjects: int(process.env.DEFAULT_MAX_PROJECTS, 3),
  defaultMaxRunning: int(process.env.DEFAULT_MAX_RUNNING_PER_USER, 1),

  // プレビューURL。{id} が置換される。
  // 例: "{id}-dev.clusters-prj.com" (Cloudflareの無料Universal SSLは1階層ワイルドカードのみ対応)
  previewHostTemplate: process.env.PREVIEW_HOST_TEMPLATE || '{id}.localtest.me',
  previewScheme: process.env.PREVIEW_SCHEME || 'http',
  // プレビューURLに付けるポート(LAN内で :8080 のまま使うときなど)。未設定なら付けない
  previewPort: int(process.env.PREVIEW_PORT, 0) || '',

  // 同時に動かせる(ビルド中+実行中)プロジェクト数の上限。超えたら「待機中」になる。
  maxRunning: int(process.env.MAX_RUNNING, 30),
  // 最大稼働時間(時間)。超えたら自動停止。0 なら無効。
  maxRuntimeHours: Number(process.env.MAX_RUNTIME_HOURS) > 0 ? Number(process.env.MAX_RUNTIME_HOURS) : 0,

  // 利用者への「まだ使っていますか?」の確認。使っていても使っていなくても、N分ごとに求める。
  // 確認ボタンを押す(人かどうかの確認つき)まで、猶予の分数が過ぎると自動停止。0 なら無効。
  keepaliveMinutes: Number(process.env.KEEPALIVE_MINUTES ?? 10) > 0 ? Number(process.env.KEEPALIVE_MINUTES ?? 10) : 0,
  keepaliveGraceMinutes: Number(process.env.KEEPALIVE_GRACE_MINUTES) > 0 ? Number(process.env.KEEPALIVE_GRACE_MINUTES) : 5,
  // 確認ボタンを、スクリプトに押させないための Cloudflare Turnstile。2つそろったときだけ有効。
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    secret: process.env.TURNSTILE_SECRET_KEY || '',
  },

  // 無操作でこの時間(分)たったら自動停止。0 なら無効。
  // 「操作」は、コンテナが受け取った通信量(プレビューへのアクセス)が増えたかどうかで見る。
  idleStopMinutes: Number(process.env.IDLE_STOP_MINUTES) > 0 ? Number(process.env.IDLE_STOP_MINUTES) : 0,

  // プレビュー用DNSレコードの自動作成・削除 (Cloudflare API)。3つ全部設定したときだけ有効。
  //   CF_API_TOKEN : 権限は「対象ゾーンの DNS 編集」だけにすること
  //   CF_ZONE_ID   : clusters-prj.com のゾーンID
  //   DNS_TARGET   : CNAME の向き先。例 <トンネルUUID>.cfargotunnel.com
  cloudflare: {
    token: process.env.CF_API_TOKEN || '',
    zoneId: process.env.CF_ZONE_ID || '',
    target: process.env.DNS_TARGET || '',
  },

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
    memoryMb: int(process.env.LIMIT_MEMORY_MB, 256),
    cpus: Number(process.env.LIMIT_CPUS) > 0 ? Number(process.env.LIMIT_CPUS) : 0.5,
    pids: int(process.env.LIMIT_PIDS, 128),
    // サーバー全体のプロジェクト数の上限(利用者ごとの上限とは別)
    maxProjects: int(process.env.MAX_PROJECTS, 200),
    maxConcurrentBuilds: int(process.env.MAX_CONCURRENT_BUILDS, 2),
    cloneTimeoutSec: int(process.env.CLONE_TIMEOUT_SEC, 120),
    maxRepoMb: int(process.env.MAX_REPO_MB, 300),
    // 停止してもコンテナは消さず、書き込んだデータを残す。その上限(コンテナの書き込み層の大きさ)と、残しておく日数。
    // 上限を超えたコンテナは削除し、停止から日数がたったコンテナも削除する(次の起動は再ビルドになり、データは消える)。
    dataLimitMb: int(process.env.DATA_LIMIT_MB, 1024),
    stoppedKeepDays: Number(process.env.STOPPED_KEEP_DAYS ?? 7) >= 0 ? Number(process.env.STOPPED_KEEP_DAYS ?? 7) : 7,
    // docker build(Dockerfile の RUN)の制限。ビルドは実行中のコンテナと同じネットワークで動かし、
    // 社内LAN・VM本体への通信遮断(egress-firewall.sh)をビルド中にも効かせる。
    buildMemoryMb: int(process.env.BUILD_MEMORY_MB, 2048),
    buildCpus: Number(process.env.BUILD_CPUS) > 0 ? Number(process.env.BUILD_CPUS) : 2,
    buildTimeoutSec: int(process.env.BUILD_TIMEOUT_SEC, 900),
  },

  // gVisor等を使う場合: DOCKER_RUNTIME=runsc
  dockerRuntime: process.env.DOCKER_RUNTIME || undefined,
};

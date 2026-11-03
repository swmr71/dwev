// Dockerfile が無いリポジトリの中身から、実行環境(Node / Django / FastAPI / Flask)を判定して
// Dockerfile を作る。コンテナには HOST=0.0.0.0 と PORT が渡るので、起動コマンドはシェル経由で $PORT を使う。
import fs from 'node:fs';
import path from 'node:path';

const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const readText = (dir, f) => (exists(dir, f) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
const shCmd = (cmd) => `CMD ["sh", "-c", ${JSON.stringify(cmd)}]`;

function node(dir) {
  let pkg;
  try {
    pkg = JSON.parse(readText(dir, 'package.json'));
  } catch {
    throw new Error('package.json を解析できません');
  }
  const script = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null;
  if (!script) throw new Error('package.json に dev / start スクリプトがありません');

  const pm = exists(dir, 'pnpm-lock.yaml') ? 'pnpm' : exists(dir, 'yarn.lock') ? 'yarn' : 'npm';
  const install = { npm: 'npm install', yarn: 'yarn install', pnpm: 'corepack enable && pnpm install' }[pm];
  const run = { npm: `npm run ${script} --`, yarn: `yarn ${script}`, pnpm: `pnpm run ${script}` }[pm];

  // HOST / PORT を見ない開発サーバーには、引数で待ち受け先を渡す
  const body = String(pkg.scripts[script]);
  const args = /\bvite\b/.test(body)
    ? ' --host 0.0.0.0 --port $PORT'
    : /\bnext\b/.test(body)
      ? ' -H 0.0.0.0 -p $PORT'
      : '';

  return {
    label: `Node (${pm} run ${script})`,
    dockerfile: [
      'FROM node:22-slim',
      'WORKDIR /app',
      'COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./',
      `RUN ${install}`,
      'COPY . .',
      shCmd(run + args),
      '',
    ].join('\n'),
  };
}

// 最初に見つかったファイルを、"app" / "app.main" のようなモジュール名にして返す
function findModule(dir, candidates) {
  const f = candidates.find((c) => exists(dir, c));
  return f ? f.replace(/(\/__init__)?\.py$/, '').replaceAll('/', '.') : null;
}

function python(dir) {
  const deps = (readText(dir, 'requirements.txt') + '\n' + readText(dir, 'pyproject.toml')).toLowerCase();
  const has = (name) => new RegExp(`(^|[^a-z0-9_-])${name}($|[^a-z0-9_-])`, 'm').test(deps);

  let label;
  let cmd;
  let extra = [];
  if (exists(dir, 'manage.py')) {
    // マイグレーションを流してから起動(開発用なので SQLite でも動く)
    label = 'Django (manage.py runserver)';
    cmd = 'python manage.py migrate --noinput && python manage.py runserver 0.0.0.0:$PORT';
  } else if (has('fastapi')) {
    const mod = findModule(dir, ['main.py', 'app.py', 'app/main.py', 'src/main.py']);
    if (!mod) throw new Error('FastAPI のアプリ(main.py か app.py)が見つかりません。Dockerfile を追加してください');
    label = `FastAPI (uvicorn ${mod}:app)`;
    cmd = `uvicorn ${mod}:app --host 0.0.0.0 --port $PORT`;
    if (!has('uvicorn')) extra = ['RUN pip install --no-cache-dir uvicorn'];
  } else if (has('flask')) {
    const mod = findModule(dir, ['app.py', 'wsgi.py', 'main.py', 'app/__init__.py']);
    if (!mod) throw new Error('Flask のアプリ(app.py か wsgi.py)が見つかりません。Dockerfile を追加してください');
    label = `Flask (flask --app ${mod} run)`;
    cmd = `flask --app ${mod} run --host 0.0.0.0 --port $PORT`;
  } else {
    throw new Error('Python のアプリの種類(Django / FastAPI / Flask)を判定できません。Dockerfile を追加してください');
  }

  // ホイール(ビルド済み)が無くて、ビルドに C のコンパイラやライブラリが要るパッケージは、そのときだけ入れる
  const apt = new Set();
  if (has('mysqlclient')) ['build-essential', 'pkg-config', 'default-libmysqlclient-dev'].forEach((x) => apt.add(x));
  if (has('psycopg2')) ['build-essential', 'libpq-dev'].forEach((x) => apt.add(x)); // psycopg2-binary は不要
  const aptLine = apt.size
    ? [`RUN apt-get update && apt-get install -y --no-install-recommends ${[...apt].join(' ')} && rm -rf /var/lib/apt/lists/*`]
    : [];

  const install = exists(dir, 'requirements.txt')
    ? ['COPY requirements.txt ./', 'RUN pip install --no-cache-dir -r requirements.txt']
    : ['COPY . .', 'RUN pip install --no-cache-dir .'];
  return {
    label,
    dockerfile: [
      'FROM python:3.12-slim',
      'ENV PYTHONUNBUFFERED=1',
      'WORKDIR /app',
      ...aptLine,
      ...install,
      ...extra,
      'COPY . .',
      shCmd(cmd),
      '',
    ].join('\n'),
  };
}

// Python のマーカーがあれば Python。ただし package.json も同居していて manage.py が無いときは、
// フロント用の package.json とみなして Node を優先する
export function detectRuntime(dir) {
  const hasPyMarker = ['manage.py', 'requirements.txt', 'pyproject.toml'].some((f) => exists(dir, f));
  if (hasPyMarker && (!exists(dir, 'package.json') || exists(dir, 'manage.py'))) return python(dir);
  if (exists(dir, 'package.json')) return node(dir);
  throw new Error('Dockerfile も、対応するアプリ(Node / Django / FastAPI / Flask)も見つかりません。Dockerfile を追加してください');
}

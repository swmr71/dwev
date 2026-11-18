import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-compose-'));
process.env.ADMIN_TOKEN = 'x';
process.env.MAX_RUNNING = '100';
process.env.COMPOSE_SERVICES = '1';
process.env.SERVICE_READY_WAIT_SEC = '1';

const { parseCompose, validateImage, interpolate, splitCommand, loadComposePlan, publicPorts, parseDotenv, repoPath, emptyPlan, ComposeError } =
  await import('../src/compose.js');
const { insertProject, updateProject, getProject, newId, upsertGithubUser, updateUser } = await import('../src/db.js');
const {
  setDockerForTest, startProject, stopProject, deleteProjectResources, totalMemoryMb, sweepStorage, startAll, runContainer,
  planServices, planInfo, assertNoRouterLabels, QuotaError, buildOverlay,
} = await import('../src/manager.js');
const { encryptJson } = await import('../src/crypto.js');
const { config } = await import('../src/config.js');

const ok = (yaml, vars, dir) => parseCompose(yaml, vars, dir);
const bad = (yaml, re, dir) =>
  assert.throws(() => parseCompose(yaml, {}, dir), (e) => e instanceof ComposeError && re.test(e.message), yaml);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));

// rakunavi の docker-compose.yml(開発用一式: MariaDB + Redis + Next.js + nginx)
const RAKUNAVI = `
services:
  db:
    image: mariadb:11
    environment:
      MARIADB_DATABASE: rakunavi
      MARIADB_USER: rakunavi
      MARIADB_PASSWORD: rakunavi
      MARIADB_ROOT_PASSWORD: root
    ports:
      - "127.0.0.1:3306:3306"
    volumes:
      - dbdata:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
  redis:
    image: redis:7
    ports:
      - "127.0.0.1:6379:6379"
  next:
    build: ./web
    env_file: .env.docker
    environment:
      DATABASE_URL: mysql://rakunavi:rakunavi@db:3306/rakunavi
      REDIS_HOST: redis
      DEBUG: \${DEBUG:-True}
      MEDIA_ROOT: /app/media
      DOCS_DIR: /docs
    command: >
      sh -c "npx prisma migrate deploy &&
             npm run setup-db &&
             npm start"
    volumes:
      - media:/app/media
      - ./docs:/docs:ro
      - ./db_files:/db_files
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
  nginx:
    image: nginx:1.27
    ports:
      - "8080:80"
    volumes:
      - ./docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - media:/app/media:ro
    depends_on:
      - next
volumes:
  dbdata:
  media:
`;
function rakunaviRepo() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'web'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.mkdirSync(path.join(dir, 'docker'));
  fs.writeFileSync(path.join(dir, 'web', 'Dockerfile'), 'FROM node:22-slim\n');
  fs.writeFileSync(path.join(dir, 'docker', 'nginx.conf'), 'server { location / { proxy_pass http://next:3000; } }\n');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), RAKUNAVI);
  return dir;
}

// ---- 読み取り ---------------------------------------------------------------------

test('rakunavi: アプリは web でビルド、DB・Redis・nginx は補助サービス、入口は nginx:80、depends_on の順に起動', () => {
  const dir = rakunaviRepo();
  const r = loadComposePlan(dir, {});
  assert.equal(r.app.name, 'next');
  assert.equal(r.app.context, 'web');
  assert.equal(r.app.command[0], 'sh');
  assert.match(r.app.command[2], /prisma migrate deploy &&\s+npm run setup-db &&\s+npm start/);
  assert.equal(r.app.env.DEBUG, 'True');
  assert.equal(r.app.env.DATABASE_URL, 'mysql://rakunavi:rakunavi@db:3306/rakunavi');
  assert.deepEqual(r.app.volumes, [{ name: 'media', target: '/app/media', readOnly: false }]);
  assert.deepEqual(r.app.binds.map((b) => [b.source, b.target, b.exists, b.readOnly]), [['docs', '/docs', true, true], ['db_files', '/db_files', false, false]]);
  assert.deepEqual(r.services.map((s) => [s.name, s.image, s.memoryMb]), [['db', 'mariadb:11', 256], ['redis', 'redis:7', 64], ['nginx', 'nginx:1.27', 64]]);
  assert.deepEqual(r.services[2].volumes, [{ name: 'media', target: '/app/media', readOnly: true }]);
  assert.deepEqual(r.services[2].binds.map((b) => [b.source, b.target]), [['docker/nginx.conf', '/etc/nginx/conf.d/default.conf']]);
  assert.deepEqual(r.entry, { service: 'nginx', port: 80 }); // 127.0.0.1 だけのものは入口にしない
  assert.deepEqual(r.order, ['db', 'redis', 'next', 'nginx']);
  assert.deepEqual(r.volumes.sort(), ['dbdata', 'media']);
  assert.ok(r.notes.some((n) => /env_file .env.docker がリポジトリに無い/.test(n)));
});

test('image: 許可リストの公式イメージだけ。registry・ユーザー名・ダイジェスト・不正な文字は不可', () => {
  assert.equal(validateImage('postgres:16').ref, 'postgres:16');
  assert.equal(validateImage('nginx').ref, 'nginx:latest');
  for (const x of ['evil/postgres', 'ghcr.io/a/b:1', 'postgres@sha256:abc', 'docker.io/library/redis', 'postgres:1 6', 'adminer', '', 5]) {
    assert.throws(() => validateImage(x), ComposeError, String(x));
  }
});

test('許可リストに無いイメージのサービスは、動かさない(全体は失敗にしない)', () => {
  const r = ok('services:\n  m:\n    image: evil/miner\n  a:\n    image: adminer\n  r:\n    image: redis\n');
  assert.deepEqual(r.services.map((s) => s.name), ['r']);
  assert.ok(r.notes.some((n) => /m: .*このサービスは動かしません/.test(n)));
});

test('危険な項目は、コンテナに一切反映しない(注意書きだけ残す)', () => {
  const keys = ['privileged: true', 'cap_add: [SYS_ADMIN]', 'network_mode: host', 'devices: ["/dev/sda:/dev/sda"]', 'user: root',
    'pid: host', 'security_opt: ["seccomp=unconfined"]', 'sysctls: {a: 1}', 'extra_hosts: ["a:1.1.1.1"]', 'volumes_from: [x]', 'ipc: host'];
  for (const key of keys) {
    for (const head of ['    image: postgres\n', '    build: .\n']) {
      const r = ok(`services:\n  s:\n${head}    ${key}\n`);
      const svc = r.services[0] ?? r.app;
      assert.deepEqual(Object.keys(svc).sort(), (r.services[0]
        ? ['binds', 'command', 'env', 'image', 'memoryMb', 'name', 'volumes']
        : ['args', 'binds', 'command', 'context', 'dockerfile', 'entrypoint', 'env', 'name', 'target', 'volumes']).sort(), key);
      assert.ok(r.notes.some((n) => n.includes(key.split(':')[0])), key);
    }
  }
});

test('volumes: ホストのパス・リポジトリの外・docker.sock は使わない。名前つきとリポジトリの中だけ', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.conf'), 'x');
  fs.symlinkSync('/etc', path.join(dir, 'etc-link'));
  const r = ok(`services:
  s:
    image: nginx
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /:/host
      - ~/secret:/s
      - ../outside:/o
      - ./etc-link/passwd:/p
      - ./etc-link:/e
      - ./a.conf:/etc/nginx/a.conf:ro
      - data:/data
  t:
    image: redis
    volumes:
      - data2:/
      - x:../../etc
      - /anon
      - type: tmpfs
        target: /t
      - type: bind
        source: ./a.conf
        target: /b.conf
        read_only: true
`, {}, dir);
  const [s, t] = r.services;
  assert.deepEqual(s.binds.map((b) => [b.source, b.target, b.readOnly]), [['a.conf', '/etc/nginx/a.conf', true]]);
  assert.deepEqual(t.binds.map((b) => [b.source, b.target, b.readOnly]), [['a.conf', '/b.conf', true]]);
  assert.deepEqual(t.volumes, []);
  assert.ok(s.binds.every((b) => b.full.startsWith(fs.realpathSync(dir))));
  assert.deepEqual(s.volumes, [{ name: 'data', target: '/data', readOnly: false }]);
  assert.equal(r.notes.filter((n) => /ホストのパス・リポジトリの外/.test(n)).length, 6);
  assert.ok(r.notes.some((n) => /data2/.test(n)) && r.notes.some((n) => /名前の無いボリューム/.test(n)) && r.notes.some((n) => /tmpfs/.test(n)));
  // 11個以上は断る
  const many = Array.from({ length: 11 }, (_, i) => `      - v${i}:/d${i}`).join('\n');
  bad(`services:\n  s:\n    image: redis\n    volumes:\n${many}\n`, /10 個まで/);
});

test('repoPath: 外に出るもの(絶対・~・..・外を指す symlink)は null', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.symlinkSync('/tmp', path.join(dir, 'out'));
  assert.equal(repoPath(dir, '/etc'), null);
  assert.equal(repoPath(dir, '~/x'), null);
  assert.equal(repoPath(dir, '../x'), null);
  assert.equal(repoPath(dir, 'sub/../../x'), null);
  assert.equal(repoPath(dir, 'out'), null);
  assert.equal(repoPath(dir, 'sub').exists, true);
  assert.equal(repoPath(dir, 'nope').exists, false);
  assert.equal(repoPath(dir, '.').rel, '.');
});

test('build: context と dockerfile はリポジトリの中だけ。target / args も読む', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'web'));
  fs.writeFileSync(path.join(dir, 'web', 'Dev.Dockerfile'), 'FROM x\n');
  const r = ok('services:\n  w:\n    build:\n      context: ./web\n      dockerfile: Dev.Dockerfile\n      target: dev\n      args:\n        A: ${X:-1}\n', {}, dir);
  assert.deepEqual([r.app.context, r.app.dockerfile, r.app.target, r.app.args], ['web', 'Dev.Dockerfile', 'dev', { A: '1' }]);
  bad('services:\n  w:\n    build: ../\n', /リポジトリの中/, dir);
  bad('services:\n  w:\n    build: /etc\n', /リポジトリの中/, dir);
  bad('services:\n  w:\n    build: ./nope\n', /見つかりません/, dir);
  bad('services:\n  w:\n    build:\n      context: web\n      dockerfile: ../../../etc/passwd\n', /context の中|リポジトリの中/, dir);
  bad('services:\n  w:\n    build:\n      context: web\n      dockerfile: Nope\n', /見つかりません/, dir);
  bad('services:\n  w:\n    build:\n      context: web\n      target: "a b"\n', /target/, dir);
});

test('ports: 127.0.0.1 などのループバックだけのものは、公開とみなさない', () => {
  assert.deepEqual(publicPorts(['8080:80', '127.0.0.1:3306:3306', '[::1]:1:2', '0.0.0.0:9000:90/tcp', '53:53/udp', 3000, '5000',
    { target: 81, published: 8081 }, { target: 82, host_ip: '127.0.0.1' }]), [80, 90, 3000, 5000, 81]);
  assert.deepEqual(publicPorts(undefined), []);
});

test('入口: 公開している補助サービスが無ければ、今まで通りアプリ', () => {
  const r = ok('services:\n  web:\n    build: .\n    ports: ["3000:3000"]\n  db:\n    image: postgres\n');
  assert.equal(r.entry, null);
  assert.deepEqual(r.order, ['web', 'db']); // depends_on が無ければ、書かれた順
});

test('depends_on: 順番を守る。循環していれば、書かれた順で注意書き', () => {
  const r = ok('services:\n  p:\n    image: nginx\n    depends_on: [a]\n  a:\n    build: .\n    depends_on: [d]\n  d:\n    image: redis\n');
  assert.deepEqual(r.order, ['d', 'a', 'p']);
  const c = ok('services:\n  x:\n    image: redis\n    depends_on: [y]\n  y:\n    image: redis\n    depends_on: [x]\n');
  assert.deepEqual(c.order.filter(Boolean), ['x', 'y']);
  assert.ok(c.notes.some((n) => /循環/.test(n)));
  // compose にアプリが無ければ、最後に起動
  assert.deepEqual(ok('services:\n  r:\n    image: redis\n').order, ['r', '']);
});

test('environment / env_file: ${VAR} は利用者の環境変数だけ。env_file はリポジトリの中だけで、environment が優先', () => {
  assert.equal(interpolate('${A}-${B:-x}-${C-y}-$A-$$', { A: '1' }), '1-x-y-1-$');
  assert.equal(interpolate('${ADMIN_TOKEN}', {}), '');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env.dev'), '# c\nexport A=file\nB="q v"\nC=1 # note\n');
  const r = ok('services:\n  d:\n    image: postgres\n    env_file: [.env.dev, /etc/environment]\n    environment:\n      A: env\n      T: ${ADMIN_TOKEN}\n', {}, dir);
  assert.deepEqual(r.services[0].env, { A: 'env', B: 'q v', C: '1', T: '' });
  assert.ok(r.notes.some((n) => /\/etc\/environment はリポジトリの外/.test(n)));
  assert.deepEqual(parseDotenv("X='a'\n=bad\nbad-key=1\n"), { X: 'a' });
});

test('splitCommand: 引用符に対応。シェルは通さない', () => {
  assert.deepEqual(splitCommand('a  b "c d" \'e f\' ""'), ['a', 'b', 'c d', 'e f', '']);
  assert.throws(() => splitCommand('a "b'), ComposeError);
});

test('不正な YAML・サービス数の上限・トップレベルの使えない項目', () => {
  bad('services: [', /解析できません/);
  bad('- a\n- b\n', /形式が不正/);
  bad('services:\n  "a b":\n    image: redis\n', /サービス名/);
  const many = ['a', 'b', 'c', 'd'].map((n) => `  ${n}:\n    image: redis\n`).join('');
  bad(`services:\n${many}`, /3 個まで/);
  const r = ok('include: [/etc/x.yml]\nsecrets: {s: {file: /etc/shadow}}\nservices:\n  r:\n    image: redis\n');
  assert.ok(r.notes.some((n) => /include/.test(n)) && r.notes.some((n) => /secrets/.test(n)));
});

test('findComposeFile: symlink は読まない。無効のとき・ファイルが無いときは、今まで通り', () => {
  const dir = tmp();
  assert.deepEqual(loadComposePlan(dir), emptyPlan());
  fs.symlinkSync('/etc/passwd', path.join(dir, 'docker-compose.yml'));
  assert.throws(() => loadComposePlan(dir), /通常のファイル/);
  fs.rmSync(path.join(dir, 'docker-compose.yml'));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  r:\n    image: redis:7\n');
  assert.equal(loadComposePlan(dir).services[0].image, 'redis:7');
  config.composeServices.enabled = false;
  assert.deepEqual(loadComposePlan(dir), emptyPlan());
  config.composeServices.enabled = true;
});

// ---- 起動・停止・削除(Docker は偽物) -------------------------------------------------

function fakeDocker({ existingSidecars = [], imageLabels = {} } = {}) {
  const calls = [];
  const containers = [...existingSidecars];
  return {
    calls,
    containers,
    modem: { followProgress: (_s, done) => done(null, []) },
    pull: async (ref) => { calls.push(['pull', ref]); return { destroy() {} }; },
    getImage: (ref) => ({
      inspect: async () => ({ Config: { Labels: imageLabels[ref] || {} } }),
      remove: async () => { calls.push(['removeImage', ref]); },
    }),
    listImages: async () => [],
    getNetwork: (name) => ({
      inspect: async () => { if (!calls.some((c) => c[0] === 'createNetwork' && c[1].Name === name)) throw Object.assign(new Error('nf'), { statusCode: 404 }); return {}; },
      connect: async (o) => { calls.push(['connect', name, o]); },
      remove: async () => { calls.push(['removeNetwork', name]); },
    }),
    createNetwork: async (o) => { calls.push(['createNetwork', o]); },
    createVolume: async (o) => { calls.push(['createVolume', o]); },
    listVolumes: async () => ({ Volumes: [] }),
    createContainer: async (o) => {
      calls.push(['createContainer', o]);
      containers.push({ Id: `id-${o.name}`, Names: [`/${o.name}`], Labels: o.Labels });
      return { id: `id-${o.name}`, start: async () => { calls.push(['start', o.name]); } };
    },
    listContainers: async (opts) => {
      const want = opts?.filters?.label?.[0] ?? '';
      return containers.filter((c) => !want || (want.includes('=') ? c.Labels?.['devbox.sidecar'] === want.split('=')[1] : want in (c.Labels || {})));
    },
    getContainer: (name) => ({
      start: async () => { calls.push(['start', name]); },
      stop: async () => { calls.push(['stop', name]); },
      remove: async () => { calls.push(['remove', name]); },
      inspect: async () => ({ Id: `id-of-${name}`, State: { Health: { Status: 'healthy' } } }),
    }),
  };
}

const mk = (fields = {}, env = {}) =>
  updateProject(
    insertProject({ id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000, envEnc: encryptJson(env), userId: null }).id,
    fields
  );
const created = (d) => d.calls.filter((c) => c[0] === 'createContainer').map((c) => c[1]);

test('rakunavi を起動: 順番・入口(nginx)・ネットワーク・ボリューム・権限の削除・ホストに出さない', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  const p = mk({}, { DATABASE_URL: 'mine' });
  const plan = loadComposePlan(rakunaviRepo(), {});
  const cid = await startAll(p, plan);
  assert.equal(cid, `id-devbox-${p.id}`);

  const net = d.calls.find((c) => c[0] === 'createNetwork')[1];
  assert.equal(net.Name, `devbox-p-${p.id}`);
  assert.equal(net.Internal, true, '補助サービスのネットワークは、外への経路を持たない');
  assert.deepEqual(d.calls.filter((c) => c[0] === 'createVolume').map((c) => c[1].Name).sort(), [`devbox-${p.id}-v-dbdata`, `devbox-${p.id}-v-media`]);

  const cs = created(d);
  assert.deepEqual(cs.map((c) => c.name), [`devbox-${p.id}-db`, `devbox-${p.id}-redis`, `devbox-${p.id}`, `devbox-${p.id}-nginx`]);
  const [db, redis, app, nginx] = cs;

  for (const c of [db, redis, nginx]) {
    const h = c.HostConfig;
    assert.equal(h.NetworkMode, `devbox-p-${p.id}`);
    assert.equal(h.Privileged, false);
    assert.deepEqual(h.CapDrop, ['ALL']);
    assert.ok(h.CapAdd.every((x) => ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'].includes(x)));
    assert.deepEqual(h.SecurityOpt, ['no-new-privileges:true']);
    assert.equal(h.MemorySwap, h.Memory, 'swap 無効');
    assert.equal(h.PidsLimit, config.composeServices.pids);
    assert.equal(h.PortBindings, undefined, 'ホストにポートを公開しない');
    assert.equal(h.Binds, undefined, 'ホストのフォルダをマウントしない');
    assert.ok((h.Mounts || []).every((m) => m.Type === 'volume' && m.Source.startsWith(`devbox-${p.id}-v-`)));
    assert.equal(c.Labels['devbox.id'], undefined, 'アプリの一覧・掃除の対象に混ざらない');
  }
  assert.equal(db.Image, 'mariadb:11');
  assert.ok(db.Healthcheck, 'mariadb は起動の完了を待つ');
  assert.deepEqual(db.HostConfig.Mounts, [{ Type: 'volume', Source: `devbox-${p.id}-v-dbdata`, Target: '/var/lib/mysql', ReadOnly: false }]);
  assert.equal(db.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(redis.HostConfig.Memory, 64 * 1024 * 1024);
  assert.equal(db.Labels['traefik.enable'], undefined, '入口でないものは Traefik に出さない');

  // nginx が入口: Traefik のラベル・devbox-net にも入る・COPY したイメージ・media は読み取り専用
  assert.equal(nginx.Image, `devbox/${p.id}-nginx:latest`);
  assert.equal(nginx.Labels['traefik.enable'], 'true');
  assert.equal(nginx.Labels[`traefik.http.services.devbox-${p.id}.loadbalancer.server.port`], '80');
  assert.match(nginx.Labels[`traefik.http.routers.devbox-${p.id}.rule`], new RegExp(p.id));
  assert.ok(d.calls.some((c) => c[0] === 'connect' && c[1] === config.dockerNetwork && c[2].Container === `id-devbox-${p.id}-nginx`));
  assert.deepEqual(nginx.HostConfig.Mounts, [{ Type: 'volume', Source: `devbox-${p.id}-v-media`, Target: '/app/media', ReadOnly: true }]);

  // アプリ: 入口ではないので Traefik に出さない。compose の command・environment。サービス名 next で届く
  assert.equal(app.Labels['traefik.enable'], 'false');
  assert.equal(app.HostConfig.NetworkMode, config.dockerNetwork);
  assert.deepEqual(app.HostConfig.CapDrop, ['ALL']);
  assert.equal(app.Cmd[0], 'sh');
  assert.ok(app.Env.includes('DATABASE_URL=mine'), '画面で設定した値が優先');
  assert.ok(app.Env.includes('REDIS_HOST=redis'));
  assert.ok(app.Env.includes('PORT=3000'));
  assert.deepEqual(app.HostConfig.Mounts, [{ Type: 'volume', Source: `devbox-${p.id}-v-media`, Target: '/app/media', ReadOnly: false }]);
  const conn = d.calls.find((c) => c[0] === 'connect' && c[1] === `devbox-p-${p.id}`);
  assert.deepEqual(conn[2].EndpointConfig.Aliases, ['next']);
});

test('compose が無ければ、今まで通り(アプリだけ・Traefik のラベルはアプリ)', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  const p = mk();
  await startAll(p, emptyPlan());
  const cs = created(d);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].Labels['traefik.enable'], 'true');
  assert.equal(cs[0].Cmd, undefined);
  assert.equal(cs[0].HostConfig.Mounts, undefined);
  assert.ok(!d.calls.some((c) => c[0] === 'createNetwork' && c[1].Name !== config.dockerNetwork), '専用ネットワークは作らない');
  assert.ok(!d.calls.some((c) => ['createVolume', 'connect'].includes(c[0])));
});

test('イメージのラベルに traefik.* があれば使わない(ほかのホスト名の乗っ取りを防ぐ)', async () => {
  setDockerForTest(fakeDocker({ imageLabels: { 'devbox/x:latest': { 'traefik.http.routers.evil.rule': 'Host(`devbox.clusters-prj.com`)' }, 'devbox/y:latest': { 'Traefik.enable': 'true' } } }));
  await assert.rejects(assertNoRouterLabels('devbox/x:latest'), /traefik/);
  await assert.rejects(assertNoRouterLabels('devbox/y:latest'), /traefik/i);
  await assertNoRouterLabels('devbox/z:latest');
});

test('計画: メモリが枠(既定512MB)を超えるなら断る。収まれば保存する。compose を消せば元に戻る', () => {
  const u = updateUser(upsertGithubUser({ githubId: 77, login: 'u77', avatarUrl: null }).id, { status: 'approved' });
  const mkp = () => updateProject(
    insertProject({ id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000, envEnc: encryptJson({}), userId: u.id }).id, {});

  // rakunavi: アプリ 256 + mariadb 256 + redis 64 + nginx 64 = 640MB > 512MB
  const dir = rakunaviRepo();
  assert.throws(() => planServices(mkp(), dir), QuotaError);
  updateUser(u.id, { memory_budget_mb: 1024 });
  const p = mkp();
  planServices(p, dir);
  assert.equal(getProject(p.id).service_mb, 384);
  assert.equal(totalMemoryMb(getProject(p.id)), 640);
  const info = planInfo(getProject(p.id));
  assert.deepEqual(info.order, ['db', 'redis', 'next', 'nginx']);
  assert.deepEqual(info.entry, { service: 'nginx', port: 80 });
  assert.equal(info.app, 'next');

  fs.rmSync(path.join(dir, 'docker-compose.yml'));
  planServices(getProject(p.id), dir);
  assert.equal(getProject(p.id).service_mb, 0);
  assert.equal(getProject(p.id).services_json, null);
});

test('planInfo: 古い形(配列)も読む', () => {
  assert.deepEqual(planInfo({ services_json: '[{"name":"db","image":"postgres:16"}]' }).order, ['db', '']);
  assert.deepEqual(planInfo({ services_json: null }).order, ['']);
  assert.deepEqual(planInfo({ services_json: '{bad' }).order, ['']);
});

test('停止: アプリのあとに補助サービスも止める(消さない)。削除: 補助サービス・ネットワークも消す。他人のものには触れない', async () => {
  const p = mk({ status: 'running', container_id: 'cid' });
  const sidecar = { Id: 'sc1', Names: ['/s'], Labels: { 'devbox.sidecar': p.id } };
  const other = { Id: 'sc2', Names: ['/o'], Labels: { 'devbox.sidecar': 'someone-else' } };
  const d = fakeDocker({ existingSidecars: [sidecar, other] });
  setDockerForTest(d);

  await stopProject(p.id);
  assert.deepEqual(d.calls.filter((c) => c[0] === 'stop').map((c) => c[1]), [`devbox-${p.id}`, 'sc1']);
  assert.ok(!d.calls.some((c) => c[0] === 'remove'));

  d.calls.length = 0;
  await deleteProjectResources(p.id);
  const removed = d.calls.filter((c) => c[0] === 'remove').map((c) => c[1]);
  assert.deepEqual(removed, [`devbox-${p.id}`, 'sc1']);
  assert.ok(d.calls.some((c) => c[0] === 'removeNetwork' && c[1] === `devbox-p-${p.id}`));
});

test('再開: 計画の順番で起動する(nginx はアプリのあと)。補助サービスが足りなければ、ビルドからやり直す', async () => {
  const order = ['db', 'next', 'nginx'];
  const json = JSON.stringify({ app: 'next', order, services: [{ name: 'db' }, { name: 'nginx' }], entry: { service: 'nginx', port: 80 } });
  const p = mk({ status: 'stopped', container_id: 'cid', services_json: json, service_mb: 320 });
  const d = fakeDocker({ existingSidecars: ['db', 'nginx'].map((n) => ({ Id: n, Names: [`/devbox-${p.id}-${n}`], Labels: { 'devbox.sidecar': p.id } })) });
  setDockerForTest(d);
  startProject(p.id);
  const end = Date.now() + 3000;
  while (Date.now() < end && getProject(p.id).status !== 'running') await new Promise((r) => setTimeout(r, 20));
  assert.equal(getProject(p.id).status, 'running');
  assert.deepEqual(d.calls.filter((c) => c[0] === 'start').map((c) => c[1]), [`devbox-${p.id}-db`, `devbox-${p.id}`, `devbox-${p.id}-nginx`]);

  // 補助サービスのコンテナが無い → 再開せず、ビルドからやり直す(アプリだけを起動しない)
  const d2 = fakeDocker();
  setDockerForTest(d2);
  const q = mk({ status: 'stopped', container_id: 'cid', services_json: json, service_mb: 320 });
  startProject(q.id);
  const end2 = Date.now() + 3000;
  while (Date.now() < end2 && getProject(q.id).container_id) await new Promise((r) => setTimeout(r, 20));
  assert.equal(getProject(q.id).container_id, null);
  assert.ok(!d2.calls.some((c) => c[0] === 'start' && c[1] === `devbox-${q.id}`));
  await new Promise((r) => setTimeout(r, 300)); // 以降のビルドの失敗(clone できない)を待つ
});

test('データの上限: 補助サービスの書き込みと、ボリュームも合算する', async () => {
  const p = mk({ status: 'stopped', container_id: 'cid' });
  const app = { Id: 'a', Names: ['/a'], Labels: { 'devbox.id': p.id }, State: 'exited', SizeRw: 1024 };
  const side = { Id: 'sc9', Names: ['/s'], Labels: { 'devbox.sidecar': p.id }, SizeRw: 10 * 1024 * 1024 };
  const calls = [];
  setDockerForTest({
    listContainers: async (o) => (o.filters.label[0].startsWith('devbox.sidecar') ? [side] : [app]),
    df: async () => ({ Volumes: [{ Name: 'v', Labels: { 'devbox.volume': p.id }, UsageData: { Size: 2000 * 1024 * 1024 } }] }),
    listVolumes: async () => ({ Volumes: [{ Name: 'v', Labels: { 'devbox.volume': p.id } }] }),
    getVolume: (n) => ({ remove: async () => calls.push(['removeVolume', n]) }),
    getContainer: (n) => ({ remove: async () => calls.push(['remove', n]), stop: async () => {} }),
    getNetwork: () => ({ remove: async () => calls.push(['removeNetwork']) }),
  });
  await sweepStorage();
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === 'sc9'), '補助サービスも消える');
  assert.ok(calls.some((c) => c[0] === 'removeVolume' && c[1] === 'v'), 'ボリュームも消える');
  assert.equal(getProject(p.id).container_id, null);
  assert.match(getProject(p.id).error, /上限/);
});

test('アプリだけの runContainer は、今まで通り(引数なしでも動く)', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  await runContainer(mk());
  assert.equal(created(d)[0].Labels['traefik.enable'], 'true');
});

// tar の中身を、文字列として集める(Dockerfile と COPY するファイルが入っているか確かめる)
function buildCapture(user) {
  const builds = [];
  return {
    builds,
    modem: { followProgress: (_s, done) => done(null, []) },
    getImage: () => ({ inspect: async () => ({ Config: { User: user, Labels: {} } }) }),
    getNetwork: () => ({ inspect: async () => ({}) }),
    buildImage: async (stream, opts) => {
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      builds.push({ opts, text: Buffer.concat(chunks).toString('latin1') });
      return {};
    },
  };
}

test('buildOverlay: リポジトリのファイルを COPY する。無いものは空のフォルダ。root でない USER なら、書き込めるようにして戻す', async () => {
  const dir = rakunaviRepo();
  const plan = loadComposePlan(dir, {});
  const p = mk();

  const d = buildCapture('');
  setDockerForTest(d);
  await buildOverlay(p, 'nginx:1.27', plan.services[2].binds, `devbox/${p.id}-nginx:latest`, { 'devbox.sidecar': p.id });
  const [b] = d.builds;
  assert.equal(b.opts.t, `devbox/${p.id}-nginx:latest`);
  assert.deepEqual(b.opts.labels, { 'devbox.sidecar': p.id });
  assert.equal(b.opts.networkmode, config.dockerNetwork, 'ビルドも devbox-net(遮断が効く)');
  assert.match(b.text, /FROM nginx:1\.27\nCOPY \["m0","\/etc\/nginx\/conf\.d\/default\.conf"\]\n/);
  assert.match(b.text, /proxy_pass http:\/\/next:3000/);
  assert.doesNotMatch(b.text, /USER|RUN/);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'work', `${p.id}.ovl`)), false, '作業フォルダは消す');

  const d2 = buildCapture('nextjs');
  setDockerForTest(d2);
  await buildOverlay(p, `devbox/${p.id}:latest`, plan.app.binds, `devbox/${p.id}:latest`, { 'devbox.id': p.id });
  const t = d2.builds[0].text;
  assert.match(t, /USER root\nCOPY \["m0","\/docs"\]\nCOPY \["m1","\/db_files"\]\nRUN \["chmod","-R","a\+rwX","\/db_files"\]\nUSER nextjs\n/);
});

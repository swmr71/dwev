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

const { parseCompose, validateImage, interpolate, splitCommand, loadComposePlan, ComposeError } =
  await import('../src/compose.js');
const { insertProject, updateProject, getProject, newId, upsertGithubUser, updateUser } = await import('../src/db.js');
const { setDockerForTest, startProject, stopProject, deleteProjectResources, totalMemoryMb, sweepStorage, startSidecars, runContainer, planServices, QuotaError } =
  await import('../src/manager.js');
const { encryptJson } = await import('../src/crypto.js');
const { config } = await import('../src/config.js');

const ok = (yaml, vars) => parseCompose(yaml, vars);
const bad = (yaml, re) => assert.throws(() => parseCompose(yaml), (e) => e instanceof ComposeError && re.test(e.message), yaml);

test('image: 許可リストの公式イメージだけ。registry・ユーザー名・ダイジェスト・不正な文字は不可', () => {
  assert.equal(validateImage('postgres:16').ref, 'postgres:16');
  assert.equal(validateImage('redis').ref, 'redis:latest');
  for (const x of ['evil/postgres', 'ghcr.io/a/b:1', 'postgres@sha256:abc', 'docker.io/library/redis', 'postgres:1 6', 'nginx', 'POSTGRES:16x/y', '', 5]) {
    assert.throws(() => validateImage(x), ComposeError, String(x));
  }
});

test('補助サービス: image / environment / command だけを取り出す(map でも list でも)', () => {
  const r = ok(`
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: pw
      POSTGRES_DB: app
  cache:
    image: redis:7
    command: redis-server --maxmemory "64mb" --appendonly no
    environment:
      - FOO=bar
      - EMPTY=
`);
  assert.deepEqual(r.services.map((s) => s.name), ['db', 'cache']);
  assert.deepEqual(r.services[0].env, { POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' });
  assert.deepEqual(r.services[1].command, ['redis-server', '--maxmemory', '64mb', '--appendonly', 'no']);
  assert.deepEqual(r.services[1].env, { FOO: 'bar', EMPTY: '' });
});

test('build があるサービスはアプリ本体。その environment は、アプリの既定の環境変数になる', () => {
  const r = ok(`
services:
  web:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:pw@db:5432/app
    depends_on: [db]
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports: ["5432:5432"]
    restart: always
volumes:
  pgdata:
`);
  assert.deepEqual(r.services.map((s) => s.name), ['db']);
  assert.deepEqual(r.appEnv, { DATABASE_URL: 'postgres://postgres:pw@db:5432/app' });
  // 捨てた項目は、注意書きに残る(黙って無視しない)
  assert.ok(r.notes.some((n) => /ports/.test(n)));
  assert.ok(r.notes.some((n) => /volumes/.test(n)));
});

test('危険な項目は、無視せずエラー(privileged・cap_add・network_mode・devices・user・entrypoint など)', () => {
  for (const key of ['privileged: true', 'cap_add: [SYS_ADMIN]', 'network_mode: host', 'devices: ["/dev/sda:/dev/sda"]',
    'user: root', 'entrypoint: /bin/sh', 'pid: host', 'security_opt: ["seccomp=unconfined"]', 'sysctls: {a: 1}',
    'env_file: .env', 'extra_hosts: ["a:1.1.1.1"]', 'volumes_from: [x]', 'ipc: host']) {
    bad(`services:\n  db:\n    image: postgres\n    ${key}\n`, /使えません/);
  }
});

test('許可リストに無いイメージ・トップレベルの危険な項目・不正な YAML は、エラー', () => {
  bad('services:\n  x:\n    image: evil/miner\n', /許可されていません|不正/);
  bad('services:\n  x:\n    image: nginx\n', /許可されていません/);
  bad('services:\n  x:\n    image: redis\nsecrets:\n  s: {file: /etc/shadow}\n', /secrets/);
  bad('include:\n  - /etc/other.yml\nservices:\n  x:\n    image: redis\n', /include/);
  bad('services: [', /解析できません/);
  bad('- a\n- b\n', /形式が不正/);
  bad('services:\n  "a b":\n    image: redis\n', /サービス名/);
  bad('services:\n  x:\n    image: redis\n    environment:\n      "BAD-KEY": 1\n', /キー名/);
});

test('サービス数の上限。profiles のサービスは使わない。build が複数あれば、補助サービスだけ使う', () => {
  const many = ['a', 'b', 'c', 'd'].map((n) => `  ${n}:\n    image: redis\n`).join('');
  bad(`services:\n${many}`, /3 個まで/);
  const r = ok('services:\n  a:\n    image: redis\n    profiles: [debug]\n  b:\n    image: redis\n');
  assert.deepEqual(r.services.map((s) => s.name), ['b']);
  const two = ok('services:\n  f:\n    build: ./f\n  g:\n    build: ./g\n  r:\n    image: redis\n');
  assert.equal(two.services.length, 1);
  assert.deepEqual(two.appEnv, {});
});

test('${VAR} の置き換えは、利用者の環境変数だけ。devbox 自身の環境変数(ADMIN_TOKEN)は見ない', () => {
  assert.equal(interpolate('${A}-${B:-x}-${C-y}-$A-$$', { A: '1' }), '1-x-y-1-$');
  assert.equal(interpolate('${ADMIN_TOKEN}', {}), '');
  const r = ok('services:\n  d:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: ${PW:-dev}\n      T: ${ADMIN_TOKEN}\n', { PW: 'secret' });
  assert.equal(r.services[0].env.POSTGRES_PASSWORD, 'secret');
  assert.equal(r.services[0].env.T, '');
  assert.equal(ok('services:\n  d:\n    image: postgres\n    environment:\n      P: ${PW:-dev}\n').services[0].env.P, 'dev');
});

test('splitCommand: 引用符に対応。シェルは通さない', () => {
  assert.deepEqual(splitCommand('a  b "c d" \'e f\' ""'), ['a', 'b', 'c d', 'e f', '']);
  assert.throws(() => splitCommand('a "b'), ComposeError);
});

test('findComposeFile: symlink は読まない。無効のとき・ファイルが無いときは、補助サービスなし', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  assert.deepEqual(loadComposePlan(dir).services, []);
  fs.symlinkSync('/etc/passwd', path.join(dir, 'docker-compose.yml'));
  assert.throws(() => loadComposePlan(dir), /通常のファイル/);
  fs.rmSync(path.join(dir, 'docker-compose.yml'));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  r:\n    image: redis:7\n');
  assert.equal(loadComposePlan(dir).services[0].image, 'redis:7');
  config.composeServices.enabled = false;
  assert.deepEqual(loadComposePlan(dir).services, []); // 機能が無効なら、読まない
  config.composeServices.enabled = true;
});

// ---- 起動・停止・削除(Docker は偽物) -------------------------------------------------

function fakeDocker({ existingSidecars = [] } = {}) {
  const calls = [];
  const containers = [...existingSidecars];
  return {
    calls,
    containers,
    modem: { followProgress: (_s, done) => done(null, []) },
    pull: async (ref) => { calls.push(['pull', ref]); return { destroy() {} }; },
    getImage: (ref) => ({ inspect: async () => { throw Object.assign(new Error('nf'), { statusCode: 404 }); }, remove: async () => {}, ref }),
    getNetwork: (name) => ({
      inspect: async () => { if (!calls.some((c) => c[0] === 'createNetwork' && c[1].Name === name)) throw Object.assign(new Error('nf'), { statusCode: 404 }); return {}; },
      connect: async (o) => { calls.push(['connect', name, o]); },
      remove: async () => { calls.push(['removeNetwork', name]); },
    }),
    createNetwork: async (o) => { calls.push(['createNetwork', o]); },
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

const mk = (fields = {}) =>
  updateProject(
    insertProject({ id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000, envEnc: encryptJson({}), userId: null }).id,
    fields
  );

test('補助サービスの作り方: 専用の Internal ネットワーク・権限の削除・メモリ上限・サービス名の別名・外へ公開しない', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  const p = mk();
  const plan = ok(`
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: pw
    ports: ["5432:5432"]
    volumes: ["/:/host"]
  mc:
    image: memcached
`);
  await startSidecars(p, plan);

  const net = d.calls.find((c) => c[0] === 'createNetwork')[1];
  assert.equal(net.Name, `devbox-p-${p.id}`);
  assert.equal(net.Internal, true, '外(インターネット・社内LAN)への経路を持たない');

  const created = d.calls.filter((c) => c[0] === 'createContainer').map((c) => c[1]);
  assert.deepEqual(created.map((c) => c.name), [`devbox-${p.id}-db`, `devbox-${p.id}-mc`]);
  for (const c of created) {
    const h = c.HostConfig;
    assert.equal(h.NetworkMode, `devbox-p-${p.id}`);
    assert.equal(h.Privileged, false);
    assert.deepEqual(h.CapDrop, ['ALL']);
    assert.ok(h.CapAdd.every((x) => ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'].includes(x)));
    assert.ok(!h.CapAdd.includes('SYS_ADMIN') && !h.CapAdd.includes('NET_ADMIN') && !h.CapAdd.includes('NET_RAW'));
    assert.deepEqual(h.SecurityOpt, ['no-new-privileges:true']);
    assert.equal(h.Memory, config.composeServices.memoryMb * 1024 * 1024);
    assert.equal(h.MemorySwap, h.Memory, 'swap 無効');
    assert.equal(h.PidsLimit, config.composeServices.pids);
    // ホストへ出る経路を作らない: ポート公開・マウント・Binds が無い
    assert.equal(h.PortBindings, undefined);
    assert.equal(h.Binds, undefined);
    assert.equal(h.Mounts, undefined);
    assert.equal(c.ExposedPorts, undefined);
    assert.equal(c.Labels['traefik.enable'], undefined, 'Traefik には公開しない');
    assert.equal(c.Labels['devbox.id'], undefined, 'アプリの一覧・掃除の対象に混ざらない');
  }
  assert.deepEqual(created[0].NetworkingConfig.EndpointsConfig[`devbox-p-${p.id}`].Aliases, ['db']);
  assert.deepEqual(created[0].Env, ['POSTGRES_PASSWORD=pw']);
  assert.ok(created[0].Healthcheck, 'postgres は起動の完了を待つ');
  assert.equal(created[1].Healthcheck, undefined);
  assert.deepEqual(d.calls.filter((c) => c[0] === 'pull').map((c) => c[1]), ['postgres:16', 'memcached:latest']);
  // 補助サービスが無ければ、何も作らない
  d.calls.length = 0;
  await startSidecars(p, { services: [], appEnv: {}, notes: [] });
  assert.equal(d.calls.length, 0);
});

test('アプリのコンテナ: 補助サービスの専用ネットワークにも入る。compose の environment は既定値で、利用者の設定が勝つ', async () => {
  const d = fakeDocker();
  setDockerForTest(d);
  const p = updateProject(
    insertProject({ id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000,
      envEnc: encryptJson({ DATABASE_URL: 'mine', PORT: '1' }), userId: null }).id,
    {}
  );
  const plan = ok('services:\n  web:\n    build: .\n    environment:\n      DATABASE_URL: theirs\n      OTHER: o\n  db:\n    image: postgres\n');
  await startSidecars(p, plan);
  await runContainer(p, plan);
  const app = d.calls.filter((c) => c[0] === 'createContainer').map((c) => c[1]).find((c) => c.name === `devbox-${p.id}`);
  assert.ok(d.calls.some((c) => c[0] === 'connect' && c[1] === `devbox-p-${p.id}`), '専用ネットワークに入る');
  assert.ok(app.Env.includes('DATABASE_URL=mine'));
  assert.ok(app.Env.includes('OTHER=o'));
  assert.ok(app.Env.includes('PORT=3000'), 'PORT は devbox が上書き');
  assert.equal(app.HostConfig.NetworkMode, config.dockerNetwork);
});

test('メモリの枠とポイントに、補助サービスの分も数える', () => {
  const p = mk({ status: 'running', service_mb: 256 });
  assert.equal(totalMemoryMb(p), config.limits.memoryMb + 256);
  assert.equal(totalMemoryMb(mk()), config.limits.memoryMb);
});

test('停止: アプリのあとに、補助サービスも止める(消さない)。削除: 補助サービスとネットワークも消す', async () => {
  const sidecar = { Id: 'sc1', Names: ['/devbox-xyz-db'], Labels: { 'devbox.sidecar': 'PLACEHOLDER' } };
  const p = mk({ status: 'running', container_id: 'cid' });
  sidecar.Labels['devbox.sidecar'] = p.id;
  const other = { Id: 'sc2', Names: ['/devbox-other-db'], Labels: { 'devbox.sidecar': 'someone-else' } };
  const d = fakeDocker({ existingSidecars: [sidecar, other] });
  setDockerForTest(d);

  await stopProject(p.id);
  const stops = d.calls.filter((c) => c[0] === 'stop').map((c) => c[1]);
  assert.deepEqual(stops, [`devbox-${p.id}`, 'sc1']); // アプリ → 補助サービス。他人のものには触れない
  assert.ok(!d.calls.some((c) => c[0] === 'remove'));

  d.calls.length = 0;
  await deleteProjectResources(p.id);
  const removed = d.calls.filter((c) => c[0] === 'remove').map((c) => c[1]);
  assert.deepEqual(removed, [`devbox-${p.id}`, 'sc1']);
  assert.ok(d.calls.some((c) => c[0] === 'removeNetwork' && c[1] === `devbox-p-${p.id}`));
  assert.ok(!removed.includes('sc2'));
});

test('再開: 補助サービスが足りなければ、ビルドからやり直す(再開しない)', async () => {
  const d = fakeDocker(); // 補助サービスのコンテナが1つも無い
  setDockerForTest(d);
  const p = mk({ status: 'stopped', container_id: 'cid', services_json: JSON.stringify([{ name: 'db', image: 'postgres:16' }]), service_mb: 256 });
  // 起動(再開できるか)。補助サービスが無いので、再開は 404 扱いになり、container_id が空になる
  startProject(p.id);
  const end = Date.now() + 3000;
  while (Date.now() < end && getProject(p.id).container_id) await new Promise((r) => setTimeout(r, 20));
  assert.equal(getProject(p.id).container_id === 'cid', false);
  assert.ok(!d.calls.some((c) => c[0] === 'start' && c[1] === `devbox-${p.id}`), 'アプリだけを再開してはいけない');
  await new Promise((r) => setTimeout(r, 300)); // 以降のビルドの失敗(clone できない)を待つ
});

test('データの上限: 補助サービスの書き込みも合算する', async () => {
  const p = mk({ status: 'stopped', container_id: 'cid' });
  const side = { Id: 'sc9', Names: ['/s'], Labels: { 'devbox.sidecar': p.id }, SizeRw: 2000 * 1024 * 1024 };
  const app = { Id: 'a', Names: ['/a'], Labels: { 'devbox.id': p.id }, State: 'exited', SizeRw: 1024 };
  const calls = [];
  setDockerForTest({
    listContainers: async (o) => (o.filters.label[0].startsWith('devbox.sidecar') ? [side] : [app]),
    getContainer: (n) => ({ remove: async () => calls.push(['remove', n]), stop: async () => {} }),
    getNetwork: () => ({ remove: async () => calls.push(['removeNetwork']) }),
  });
  await sweepStorage();
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === 'sc9'), '補助サービスも消える');
  assert.equal(getProject(p.id).container_id, null);
  assert.match(getProject(p.id).error, /上限/);
});

test('計画: 補助サービスのメモリが、その人の枠(既定512MB)を超えるなら、起動を断る。収まれば保存する', () => {
  const u = updateUser(upsertGithubUser({ githubId: 77, login: 'u77', avatarUrl: null }).id, { status: 'approved' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const mkp = () => updateProject(
    insertProject({ id: newId(), name: 'p', repoUrl: 'https://github.com/a/b.git', branch: 'main', port: 3000, envEnc: encryptJson({}), userId: u.id }).id, {});

  // アプリ 256MB + 補助 3 × 256MB = 1024MB > 512MB
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services:\n  a:\n    image: redis\n  b:\n    image: redis\n  c:\n    image: redis\n');
  const big = mkp();
  assert.throws(() => planServices(big, dir), QuotaError);

  // アプリ 256MB + 補助 1 × 256MB = 512MB。ちょうど収まる
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services:\n  a:\n    image: redis\n');
  const small = mkp();
  const plan = planServices(small, dir);
  assert.equal(plan.services.length, 1);
  assert.equal(getProject(small.id).service_mb, 256);
  assert.deepEqual(JSON.parse(getProject(small.id).services_json), [{ name: 'a', image: 'redis:latest' }]);

  // compose を消して再ビルドしたら、補助サービスの分は 0 に戻る
  fs.rmSync(path.join(dir, 'compose.yml'));
  planServices(getProject(small.id), dir);
  assert.equal(getProject(small.id).service_mb, 0);
  assert.equal(getProject(small.id).services_json, null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffEnv, render, sync } from '../scripts/env-sync.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-envsync-'));
const quiet = () => {};

test('diffEnv: 例にだけある項目(コメントアウトのものも)を見つけ、.env だけにある項目も分かる', () => {
  const ex = 'A=1\n# B=2   # 説明\nC=\n# 説明だけの行\n';
  const env = 'A=changed\n# C=\nMY_OWN=x\n';
  const { missing, unknown } = diffEnv(ex, env);
  assert.deepEqual(missing.map((m) => [m.key, m.active]), [['B', false]]);
  assert.deepEqual(unknown, ['MY_OWN']);
});

test('render: 例の構成に、.env の有効な値をはめ込む。説明は例のものを残し、例に無い項目は末尾に残す', () => {
  const ex = [
    '# === 見出し ===',
    '# 説明の行',
    'A=default',
    '# B=2    # Bの説明',
    '# C=3',
    '',
    '# MAX=8   # 上限',
  ].join('\n');
  const env = [
    '# 古い見出し',
    'A=mine',
    '# B=2',
    'B=20',
    'MAX=5',
    'OLD_KEY=keep',
  ].join('\n');
  const { text, unknown } = render(ex, env);
  assert.equal(text, [
    '# === 見出し ===',
    '# 説明の行',
    'A=mine',
    'B=20    # Bの説明',
    '# C=3',
    '',
    'MAX=5   # 上限',
    '',
    '# === .env.example に無い項目(削除済みか、独自の設定) ===',
    'OLD_KEY=keep',
    '',
  ].join('\n'));
  assert.deepEqual(unknown, ['OLD_KEY']);
});

test('render: 同じキーが複数あれば最後の値。値に「 # 」があれば例の説明は足さない。改行コードは .env に合わせる', () => {
  const { text } = render('# B=2   # 説明\n', 'B=1\nB=3  # 自分のメモ\n', '\r\n');
  assert.equal(text, 'B=3  # 自分のメモ\r\n');
});

test('sync: 組み直し→2回目は何も変わらない。dry-run は書かない。直前の内容を .bak に残す', () => {
  const ex = path.join(tmp, 'ex'), env = path.join(tmp, 'env');
  fs.writeFileSync(ex, '# 見出し\nA=1\n# B=2  # 説明\nNEW_REQUIRED=\n');
  const before = '# 古い\nB=9\nA=secret'; // 末尾に改行なし
  fs.writeFileSync(env, before);

  const dry = sync({ examplePath: ex, envPath: env, dryRun: true, log: quiet });
  assert.equal(dry.changed, true);
  assert.equal(fs.readFileSync(env, 'utf8'), before); // dry-run は書かない

  const r = sync({ examplePath: ex, envPath: env, log: quiet });
  assert.deepEqual(r.missing.map((m) => m.key), ['NEW_REQUIRED']);
  assert.equal(fs.readFileSync(env, 'utf8'), '# 見出し\nA=secret\nB=9  # 説明\nNEW_REQUIRED=\n');
  assert.equal(fs.readFileSync(env + '.bak', 'utf8'), before);

  const again = sync({ examplePath: ex, envPath: env, log: quiet });
  assert.equal(again.changed, false);
});

test('sync: .env が無ければ例をコピーする', () => {
  const ex = path.join(tmp, 'ex2'), env = path.join(tmp, 'env2');
  fs.writeFileSync(ex, 'A=1\n');
  assert.equal(sync({ examplePath: ex, envPath: env, log: quiet }).created, true);
  assert.equal(fs.readFileSync(env, 'utf8'), 'A=1\n');
});

test('実際の .env.example: 値を引き継いで組み直しても、値は1つも変わらない', () => {
  const ex = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const env = 'ADMIN_TOKEN=abc\nMAX_RUNNING=10\nMAX_RUNTIME_HOURS=8\nGITHUB_CLIENT_SECRET=s3cr#t\nCUSTOM=1\n';
  const { text } = render(ex, env);
  const lines = text.split('\n');
  for (const want of ['ADMIN_TOKEN=abc', 'MAX_RUNNING=10', 'GITHUB_CLIENT_SECRET=s3cr#t', 'CUSTOM=1']) {
    assert.ok(lines.includes(want) || lines.some((l) => l.startsWith(want + ' ')), `${want} が見つからない`);
  }
  assert.ok(lines.some((l) => l.startsWith('MAX_RUNTIME_HOURS=8')), '値の入った行が、自動停止の見出しの下に来る');
  assert.ok(lines.indexOf('# === 自動停止 ===========================================================') < lines.findIndex((l) => l.startsWith('MAX_RUNTIME_HOURS=8')));
  assert.equal(render(ex, text).text, text); // もう一度かけても変わらない
});

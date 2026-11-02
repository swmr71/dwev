import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffEnv, sync } from '../scripts/env-sync.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-envsync-'));
const quiet = () => {};

test('diffEnv: 例にだけある項目(コメントアウトのものも)を見つけ、.env だけにある項目も分かる', () => {
  const ex = 'A=1\n# B=2   # 説明\nC=\n# 説明だけの行\n';
  const env = 'A=changed\n# C=\nMY_OWN=x\n';
  const { missing, unknown } = diffEnv(ex, env);
  assert.deepEqual(missing.map((m) => [m.key, m.active]), [['B', false]]);
  assert.deepEqual(unknown, ['MY_OWN']);
});

test('sync: 足りない行だけを末尾に足し、既存の行は変えない。2回目は何もしない', () => {
  const ex = path.join(tmp, 'ex'), env = path.join(tmp, 'env');
  fs.writeFileSync(ex, 'A=1\n# B=2  # 説明\nNEW_REQUIRED=\n');
  fs.writeFileSync(env, 'A=secret'); // 末尾に改行なし
  sync({ examplePath: ex, envPath: env, dryRun: true, log: quiet });
  assert.equal(fs.readFileSync(env, 'utf8'), 'A=secret'); // dry-run は書かない
  sync({ examplePath: ex, envPath: env, log: quiet, today: new Date('2026-11-03') });
  const out = fs.readFileSync(env, 'utf8');
  assert.ok(out.startsWith('A=secret\n'));
  assert.match(out, /# --- \.env\.example から追加 \(2026-11-03\) ---\n# B=2  # 説明\nNEW_REQUIRED=\n$/);
  const again = sync({ examplePath: ex, envPath: env, log: quiet });
  assert.equal(again.missing.length, 0);
  assert.equal(fs.readFileSync(env, 'utf8'), out);
});

test('sync: .env が無ければ例をコピーする', () => {
  const ex = path.join(tmp, 'ex2'), env = path.join(tmp, 'env2');
  fs.writeFileSync(ex, 'A=1\n');
  assert.equal(sync({ examplePath: ex, envPath: env, log: quiet }).created, true);
  assert.equal(fs.readFileSync(env, 'utf8'), 'A=1\n');
});

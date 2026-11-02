import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRuntime } from '../src/runtimes.js';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-rt-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
};
const pkg = (scripts) => JSON.stringify({ scripts });

test('Node: dev があれば dev、無ければ start。ロックファイルでパッケージマネージャを選ぶ', () => {
  assert.match(detectRuntime(mk({ 'package.json': pkg({ dev: 'node a.js', start: 'node b.js' }) })).dockerfile, /npm install[\s\S]*npm run dev --/);
  assert.match(detectRuntime(mk({ 'package.json': pkg({ start: 'node b.js' }) })).dockerfile, /npm run start/);
  assert.match(detectRuntime(mk({ 'package.json': pkg({ dev: 'x' }), 'yarn.lock': '' })).dockerfile, /yarn install[\s\S]*yarn dev/);
  assert.match(detectRuntime(mk({ 'package.json': pkg({ dev: 'x' }), 'pnpm-lock.yaml': '' })).dockerfile, /corepack enable && pnpm install[\s\S]*pnpm run dev/);
  assert.throws(() => detectRuntime(mk({ 'package.json': pkg({ build: 'x' }) })), /dev \/ start/);
  assert.throws(() => detectRuntime(mk({ 'package.json': '{bad' })), /解析できません/);
});

test('Node: Vite と Next には、待ち受け先を引数で渡す', () => {
  assert.match(detectRuntime(mk({ 'package.json': pkg({ dev: 'vite' }) })).dockerfile, /--host 0\.0\.0\.0 --port \$PORT/);
  assert.match(detectRuntime(mk({ 'package.json': pkg({ dev: 'next dev' }) })).dockerfile, /-H 0\.0\.0\.0 -p \$PORT/);
  assert.doesNotMatch(detectRuntime(mk({ 'package.json': pkg({ dev: 'node server.js' }) })).dockerfile, /0\.0\.0\.0/);
});

test('Django: manage.py があれば migrate してから runserver', () => {
  const rt = detectRuntime(mk({ 'manage.py': '', 'requirements.txt': 'Django==5.0\n' }));
  assert.match(rt.label, /Django/);
  assert.match(rt.dockerfile, /FROM python:3\.12-slim/);
  assert.match(rt.dockerfile, /pip install --no-cache-dir -r requirements\.txt/);
  assert.match(rt.dockerfile, /migrate --noinput && python manage\.py runserver 0\.0\.0\.0:\$PORT/);
  // requirements.txt が無く pyproject だけでも Django と判定できる
  assert.match(detectRuntime(mk({ 'manage.py': '', 'pyproject.toml': '[project]' })).dockerfile, /pip install --no-cache-dir \./);
});

test('FastAPI / Flask: 依存からの判定と、アプリのモジュール名の検出', () => {
  const fa = detectRuntime(mk({ 'requirements.txt': 'fastapi\n', 'app/main.py': '' }));
  assert.match(fa.dockerfile, /pip install --no-cache-dir uvicorn/);
  assert.match(fa.dockerfile, /uvicorn app\.main:app --host 0\.0\.0\.0 --port \$PORT/);
  assert.doesNotMatch(detectRuntime(mk({ 'requirements.txt': 'fastapi\nuvicorn[standard]\n', 'main.py': '' })).dockerfile, /pip install --no-cache-dir uvicorn/);
  assert.match(detectRuntime(mk({ 'requirements.txt': 'Flask>=3\n', 'app.py': '' })).dockerfile, /flask --app app run --host 0\.0\.0\.0 --port \$PORT/);
  assert.throws(() => detectRuntime(mk({ 'requirements.txt': 'fastapi\n' })), /FastAPI のアプリ/);
  assert.throws(() => detectRuntime(mk({ 'requirements.txt': 'requests\n' })), /判定できません/);
});

test('Python と Node が同居していても、manage.py が無ければ Node(フロント用)を優先する', () => {
  assert.match(detectRuntime(mk({ 'package.json': pkg({ dev: 'vite' }), 'requirements.txt': 'flask\n' })).label, /Node/);
  assert.throws(() => detectRuntime(mk({ 'README.md': '' })), /Dockerfile も/);
});

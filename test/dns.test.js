import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-dns-'));
process.env.ADMIN_TOKEN = 'x';
process.env.PREVIEW_HOST_TEMPLATE = '{id}-dev.example.com';
process.env.CF_API_TOKEN = 'SECRET-TOKEN-VALUE';
process.env.CF_ZONE_ID = 'zone123';
process.env.DNS_TARGET = 'uuid.cfargotunnel.com';

const dns = await import('../src/dns.js');

const HOST = 'abcdef0123-dev.example.com';
let calls;
let responder;

// Cloudflare への通信を偽物に差し替える
beforeEach(() => {
  calls = [];
  responder = () => ({ ok: true, status: 200, json: async () => ({ success: true, result: [] }) });
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = responder(call);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? { success: true, result: r.result ?? [] } };
  };
});

const ours = (id, name) => ({ id, name, type: 'CNAME', comment: dns.TAG });

test('hostRegex: プレビュー用のホスト名だけに一致する', () => {
  const re = dns.hostRegex();
  assert.ok(re.test(HOST));
  for (const bad of [
    'www.example.com', 'nextcloud.example.com', 'ABCDEF0123-dev.example.com', '*-dev.example.com',
    'abcdef0123-dev.example.com.evil.com', 'evil-abcdef0123-dev.example.com', 'abcdef012-dev.example.com',
  ]) assert.ok(!re.test(bad), `should reject ${bad}`);
  assert.equal(re.exec(HOST)[1], 'abcdef0123');
});

test('create: 無ければ印(comment)付きの proxied CNAME を作る', async () => {
  await dns.createPreviewRecord(HOST);
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'POST されること');
  assert.match(post.url, /\/zones\/zone123\/dns_records$/);
  assert.deepEqual(post.body, {
    type: 'CNAME', name: HOST, content: 'uuid.cfargotunnel.com', proxied: true, ttl: 1, comment: dns.TAG,
  });
});

test('create: devbox が作った同名レコードが既にあれば何もしない', async () => {
  responder = () => ({ result: [ours('r1', HOST)] });
  await dns.createPreviewRecord(HOST);
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('create: 手作りの同名レコードがあれば上書きせずエラー', async () => {
  responder = () => ({ result: [{ id: 'r9', name: HOST, type: 'A', content: '1.2.3.4', comment: '' }] });
  await assert.rejects(() => dns.createPreviewRecord(HOST), /管理外/);
  assert.ok(!calls.some((c) => c.method !== 'GET'));
});

test('guard: プレビュー用でないホスト名は、通信する前に拒否する', async () => {
  for (const bad of ['www.example.com', 'clusters-prj.com', '*-dev.example.com', '']) {
    await assert.rejects(() => dns.createPreviewRecord(bad), /DNS を操作しません/);
    await assert.rejects(() => dns.deletePreviewRecord(bad), /DNS を操作しません/);
  }
  assert.equal(calls.length, 0);
});

test('delete: devbox の印があるレコードだけを消す', async () => {
  responder = (c) =>
    c.method === 'GET'
      ? { result: [ours('mine', HOST), { id: 'theirs', name: HOST, type: 'CNAME', comment: 'manual' }, { id: 'a', name: HOST, type: 'A', comment: dns.TAG }] }
      : { result: { id: 'x' } };
  const removed = await dns.deletePreviewRecord(HOST);
  assert.equal(removed, true);
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());
  assert.deepEqual(deletes, ['mine']);
});

test('sweep: 動いていないプロジェクトの、devbox 製レコードだけを消す', async () => {
  const keepId = 'aaaaaaaaaa';
  const orphan1 = 'bbbbbbbbbb';
  const orphan2 = 'cccccccccc';
  responder = (c) =>
    c.method === 'GET'
      ? {
          result: [
            ours('keep', `${keepId}-dev.example.com`),
            ours('o1', `${orphan1}-dev.example.com`),
            ours('o2', `${orphan2}-dev.example.com`),
            { id: 'manual', name: `dddddddddd-dev.example.com`, type: 'CNAME', comment: 'manual' }, // 印なし
            ours('weird', 'www.example.com'), // 印はあるが名前が対象外
          ],
        }
      : { result: { id: 'x' } };
  const n = await dns.sweepOrphans([keepId]);
  assert.equal(n, 2);
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()).sort();
  assert.deepEqual(deletes, ['o1', 'o2']);
});

test('API エラー: メッセージにトークンが含まれない', async () => {
  responder = () => ({ ok: false, status: 403, body: { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] } });
  await assert.rejects(
    () => dns.createPreviewRecord(HOST),
    (e) => /9109/.test(e.message) && !e.message.includes('SECRET-TOKEN-VALUE')
  );
});

test('認証ヘッダーは Bearer トークンで、URLにトークンを含めない', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ success: true, result: [] }) };
  };
  await dns.createPreviewRecord(HOST).catch(() => {});
  assert.equal(seen.auth, 'Bearer SECRET-TOKEN-VALUE');
  assert.ok(!seen.url.includes('SECRET'));
});

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const logPath = (id) => path.join(config.dataDir, 'logs', `${id}.log`);

export function resetLog(id) {
  fs.writeFileSync(logPath(id), '');
}

export function appendLog(id, line) {
  const text = String(line).endsWith('\n') ? String(line) : `${line}\n`;
  fs.appendFileSync(logPath(id), text);
}

export function removeLog(id) {
  fs.rmSync(logPath(id), { force: true });
}

// ログファイルを offset から読む。UI側はこれをポーリングして追記分だけ取得する。
export function readLog(id, offset = 0) {
  const file = logPath(id);
  if (!fs.existsSync(file)) return { text: '', offset: 0 };
  const size = fs.statSync(file).size;
  const start = Math.min(Math.max(offset, 0), size);
  if (start === size) return { text: '', offset: size };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size - start, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), offset: start + buf.length };
  } finally {
    fs.closeSync(fd);
  }
}

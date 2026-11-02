// .env.example に増えた設定項目を、.env の末尾に足す。.env の既存の行は一切書き換えない。
//   npm run env:sync              # 足す
//   npm run env:sync -- --dry-run # 足さずに、何が足されるかだけ表示
//   npm run env:sync -- --example 別のファイル --env 別の.env
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// "KEY=..." と "# KEY=..." (コメントアウトされた既定値)の、どちらからもキーを取る
const KEY_LINE = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=/;

export function parseKeys(text) {
  const keys = new Map(); // key -> { line, active }
  for (const line of text.split(/\r?\n/)) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const [, hash, key] = m;
    const prev = keys.get(key);
    if (!prev || (prev && !prev.active && !hash)) keys.set(key, { line: line.trimEnd(), active: !hash });
  }
  return keys;
}

// 例にあって .env にまだ無いキーの行と、.env にあって例に無いキーを返す
export function diffEnv(exampleText, envText) {
  const example = parseKeys(exampleText);
  const env = parseKeys(envText);
  const missing = [...example].filter(([k]) => !env.has(k)).map(([key, v]) => ({ key, ...v }));
  const unknown = [...env.keys()].filter((k) => !example.has(k));
  return { missing, unknown };
}

export function sync({ examplePath, envPath, dryRun = false, log = console.log, today = new Date() }) {
  const exampleText = fs.readFileSync(examplePath, 'utf8');
  if (!fs.existsSync(envPath)) {
    log(`${envPath} が無いので、${examplePath} をコピーします`);
    if (!dryRun) fs.copyFileSync(examplePath, envPath);
    return { created: true, missing: [], unknown: [] };
  }
  const envText = fs.readFileSync(envPath, 'utf8');
  const { missing, unknown } = diffEnv(exampleText, envText);

  if (missing.length === 0) {
    log('.env は、.env.example の項目をすべて持っています');
  } else {
    log(`${dryRun ? '足される' : '足した'}項目 (${missing.length}件):`);
    for (const m of missing) log(`  ${m.active ? '【値が必要】' : '            '}${m.line}`);
    if (!dryRun) {
      const eol = envText.includes('\r\n') ? '\r\n' : '\n';
      const head = `# --- .env.example から追加 (${today.toISOString().slice(0, 10)}) ---`;
      const sep = envText === '' || envText.endsWith('\n') ? '' : eol;
      fs.appendFileSync(envPath, sep + eol + [head, ...missing.map((m) => m.line)].join(eol) + eol);
    }
    if (missing.some((m) => m.active)) log('「値が必要」の項目は、足した行を編集して値を入れてください');
  }
  if (unknown.length) log(`.env.example に無い項目 (削除済みか、独自の設定): ${unknown.join(', ')}`);
  return { created: false, missing, unknown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  sync({ examplePath: opt('--example', '.env.example'), envPath: opt('--env', '.env'), dryRun: args.includes('--dry-run') });
}

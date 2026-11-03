// .env を、.env.example の構成に組み直す。実行するたびに、見出し・説明・項目の並びが例と同じになる。
//   - .env で有効な行(KEY=値)の値は、そのまま引き継ぐ
//   - 例に増えた項目は足す(有効な行で値が空・仮の値のものは「値が必要」と表示)
//   - 例から消えた項目は、末尾に残す(消さない)。.env にだけあったコメントや空行は、組み直しで無くなる
//   - 変わるときは、直前の内容を .env.bak に残す
//   npm run env:sync              # 組み直す
//   npm run env:sync -- --dry-run # 書かずに、何が変わるかだけ表示
//   npm run env:sync -- --example 別のファイル --env 別の.env
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// "KEY=..." と "# KEY=..." (コメントアウトされた既定値)の、どちらからもキーを取る
const KEY_LINE = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;
// 値のあとの「 # 説明」
const INLINE_COMMENT = /^(.*?)(\s+#\s.*)$/;

const splitLines = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

export function parseKeys(text) {
  const keys = new Map(); // key -> { line, active }
  for (const line of splitLines(text)) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const [, hash, key] = m;
    const prev = keys.get(key);
    if (!prev || (!prev.active && !hash)) keys.set(key, { line: line.trimEnd(), active: !hash });
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

// .env で有効な行の値(同じキーが複数あれば、最後のもの。docker compose と同じ)
function activeValues(envText) {
  const vals = new Map();
  for (const line of splitLines(envText)) {
    const m = KEY_LINE.exec(line);
    if (m && !m[1]) vals.set(m[2], m[3].trimEnd());
  }
  return vals;
}

// 例の構成に、.env の値をはめ込んだ文字列を作る。eol は出力の改行
export function render(exampleText, envText, eol = '\n') {
  const vals = activeValues(envText);
  const placed = new Set();
  const out = [];
  for (const line of splitLines(exampleText)) {
    const m = KEY_LINE.exec(line);
    if (m && vals.has(m[2]) && !placed.has(m[2])) {
      placed.add(m[2]);
      const value = vals.get(m[2]);
      // 例に「 # 説明」があれば残す(値の側に既にあるときは足さない)
      const note = INLINE_COMMENT.exec(m[3]);
      out.push(`${m[2]}=${value}${note && !INLINE_COMMENT.test(value) ? note[2] : ''}`);
    } else {
      out.push(line.trimEnd());
    }
  }
  const unknown = [...vals.keys()].filter((k) => !placed.has(k));
  if (unknown.length) {
    out.push('', '# === .env.example に無い項目(削除済みか、独自の設定) ===');
    for (const k of unknown) out.push(`${k}=${vals.get(k)}`);
  }
  return { text: out.join(eol) + eol, unknown };
}

export function sync({ examplePath, envPath, dryRun = false, log = console.log }) {
  const exampleText = fs.readFileSync(examplePath, 'utf8');
  if (!fs.existsSync(envPath)) {
    log(`${envPath} が無いので、${examplePath} をコピーします`);
    if (!dryRun) fs.copyFileSync(examplePath, envPath);
    return { created: true, missing: [], unknown: [], changed: true };
  }
  const envText = fs.readFileSync(envPath, 'utf8');
  const eol = envText.includes('\r\n') ? '\r\n' : '\n';
  const { missing } = diffEnv(exampleText, envText);
  const { text, unknown } = render(exampleText, envText, eol);
  const changed = text !== envText;

  if (missing.length) {
    log(`${dryRun ? '足される' : '足した'}項目 (${missing.length}件):`);
    for (const m of missing) log(`  ${m.active ? '【値が必要】' : '            '}${m.line}`);
    if (missing.some((m) => m.active)) log('「値が必要」の項目は、.env の該当の行を編集して値を入れてください');
  }
  if (unknown.length) log(`.env.example に無い項目(末尾に残しています): ${unknown.join(', ')}`);

  if (!changed) {
    log('.env は、すでに .env.example の構成どおりです');
  } else {
    if (!missing.length) log(`.env を .env.example の構成に${dryRun ? '組み直します(値は変わりません)' : '組み直しました(値は変わっていません)'}`);
    if (!dryRun) {
      fs.copyFileSync(envPath, envPath + '.bak', fs.constants.COPYFILE_FICLONE);
      fs.writeFileSync(envPath, text); // 既存のファイルへの書き込みなので、権限と持ち主はそのまま
      log(`直前の内容は ${envPath}.bak に残しました`);
    }
  }
  return { created: false, missing, unknown, changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  sync({ examplePath: opt('--example', '.env.example'), envPath: opt('--env', '.env'), dryRun: args.includes('--dry-run') });
}

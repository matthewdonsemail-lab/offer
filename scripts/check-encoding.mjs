// Pre-push gate: no mojibake in tracked text files.
//
// Windows PowerShell 5.1 Get-Content defaults to Windows-1252, not UTF-8. A
// file read and written back through it silently mangles every non-ASCII
// character: an em dash (U+2014) turns into a 17 code point run of Latin-1
// garbage. It reaches a commit because the file still "looks fine" in a diff
// and nothing else checks for it.
//
// This catches the replacement character and the classic double-encoded
// prefixes, so the damage is caught before review rather than after.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEXT_EXT = new Set([
  '.md', '.mmd', '.mdx', '.txt', '.json', '.yml', '.yaml', '.ts', '.tsx',
  '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.svg', '.sql', '.sh',
  '.ps1', '.env', '.example',
]);

const SKIP_PREFIXES = ['node_modules/', 'dist/', 'build/', 'bun.lock', 'package-lock.json', 'yarn.lock'];

// U+FFFD is the replacement character, the clearest signal.
// The rest are the mojibake prefixes a Windows-1252 round trip produces.
// Written as escapes on purpose: if the source contained the literal
// characters, this file would match its own pattern forever.
const BAD = new RegExp(
  [
    '\\uFFFD', // replacement character
    '\\u00C3\\u0192', // the A-circumflex-f-hook a cp1252 read produces
    '\\u00C3\\u00A2', // A-tilde, from a second encoding round
    '\\u00E2\\u20AC', // a-circumflex + euro sign
    '\\u00C2\\u00A0', // non-breaking space
  ].join('|'),
);

let files;
try {
  files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SKIP_PREFIXES.some((p) => f.startsWith(p)))
    .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()) || path.basename(f).startsWith('.env'));
} catch {
  console.error('check-encoding: could not run git ls-files, skipping.');
  process.exit(0);
}

const findings = [];
for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (BAD.test(line)) findings.push(`${rel}:${i + 1}`);
  });
}

if (findings.length > 0) {
  console.error('check-encoding: FAIL - mojibake in tracked files:');
  for (const f of findings.slice(0, 40)) console.error(`  - ${f}`);
  if (findings.length > 40) console.error(`  ... and ${findings.length - 40} more`);
  console.error('');
  console.error('This is what a Windows-1252 round trip does to UTF-8. To repair,');
  console.error('rewrite the affected lines with a UTF-8 aware editor, or revert with:');
  console.error('  git checkout -- <file>');
  console.error('Do not fix it with PowerShell Get-Content | WriteAllLines; that is the cause.');
  process.exit(1);
}

console.log(`check-encoding: OK - no mojibake in ${files.length} tracked files.`);

// Minimal .env loader — zero dependencies. Reads KEY=value lines from a .env
// file in the project root and sets them on process.env (without overriding
// variables already set in the real environment). Lines starting with # and
// blank lines are ignored; surrounding quotes are stripped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function loadEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let txt;
  try {
    txt = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return; // no .env file — that's fine
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = val;
  }
}

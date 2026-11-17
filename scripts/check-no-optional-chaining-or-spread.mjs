#!/usr/bin/env node
// CloudFront Functions runtime 2.0 does not support optional chaining (`a?.b`) or spread
// (`...args`, `{ ...obj }`). Like `for...of`, the function publishes and then fails at run time.
// Fix: explicit checks (`a && a.b`) and Object.assign / Array.prototype.concat.
//
// Usage: node scripts/check-no-optional-chaining-or-spread.mjs [file ...]   (default: every functions/cloudfront/*.js)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Comments and string literals blanked out, line breaks kept, so line numbers still match.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));

export function findUnsupported(src) {
  const hits = [];
  code(src).split('\n').forEach((line, n) => {
    if (/\?\.(?!\d)/.test(line)) hits.push({ line: n + 1, what: 'optional chaining' });
    if (/\.\.\.\s*[\w$[{(]/.test(line)) hits.push({ line: n + 1, what: 'spread' });
  });
  return hits;
}

const dir = join('functions', 'cloudfront');
const files = process.argv.length > 2 ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f));
let failed = false;
for (const file of files) {
  const hits = findUnsupported(readFileSync(file, 'utf8'));
  failed ||= hits.length > 0;
  if (!hits.length) console.log(`✔ ${file}: no optional chaining or spread`);
  for (const h of hits) console.error(`✖ ${file}:${h.line}: ${h.what} (not supported in cloudfront-js-2.0)`);
}
process.exit(failed ? 1 : 0);

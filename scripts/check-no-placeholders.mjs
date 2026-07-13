// CI guard: the published landing site (docs/) AND the two root files whose
// placeholders 404 hardest — the README clone command and package.json's
// repository URL — must not ship a `your-handle` placeholder. Every CTA on
// blueteam.news would 404 and the star widget would silently no-op.
// Pure Node, no dependencies.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const NEEDLE = /your-handle/i;
const failures = [];

function scanFile(p) {
  if (!/\.(html?|css|js|json|svg|md|txt)$/i.test(p)) return;
  readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
    if (NEEDLE.test(line)) failures.push(`  ${p}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    scanFile(p);
  }
}

try {
  walk(join(ROOT, 'docs'));
  scanFile(join(ROOT, 'README.md'));
  scanFile(join(ROOT, 'package.json'));
} catch (e) {
  console.error('check-placeholders: cannot read a scan target —', e.message);
  process.exit(1);
}

if (failures.length) {
  console.error('✖ Placeholder "your-handle" still present — replace with the real repo slug:');
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log('✓ No "your-handle" placeholders in docs/, README.md, or package.json.');

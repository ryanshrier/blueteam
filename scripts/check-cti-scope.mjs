// Release guard: shipping code and public documentation must stay focused on
// cyber threat intelligence. Test fixtures are intentionally excluded so the
// internal profile abstraction can still be exercised without becoming product.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const TARGETS = [
  'config', 'lib', 'routes', 'public', 'docs', '.github',
  'server.js', 'config.json', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SUPPORT.md', '.env.example',
];
const RULES = [
  [/\bclosingQuote\b/i, 'retired closing-quote setting'],
  [/\bclosingThought\b/i, 'retired closing-thought field'],
  [/CLOSING THOUGHT/i, 'retired closing-thought section'],
  [/Macro Risk/i, 'non-CTI Macro Risk product language'],
  [/investment committee/i, 'non-CTI investment audience'],
  [/\ballocators?\b/i, 'non-CTI allocator audience'],
  [/Horizons? 4/i, 'retired fourth horizon'],
  [/reading shift/i, 'learning-system cadence language'],
  [/forming edge/i, 'formation-era language'],
  [/\bpersonal project\b/i, 'hobby-project positioning'],
  [/\bweekend project\b/i, 'hobby-project positioning'],
  [/\bpull requests? (?:are )?welcome\b/i, 'contribution invitation conflicts with maintainer-led governance'],
  [/\bcontributions? (?:are )?welcome\b/i, 'contribution invitation conflicts with maintainer-led governance'],
  [/\bfeature requests? (?:are )?welcome\b/i, 'feature-request invitation conflicts with maintainer-led governance'],
];
const failures = [];

function scanFile(path) {
  if (!/\.(?:c?js|mjs|json|md|html?|txt|ya?ml)$/i.test(path)) return;
  const name = relative(ROOT, path);
  readFileSync(path, 'utf-8').split(/\r?\n/).forEach((line, index) => {
    for (const [pattern, reason] of RULES) {
      if (pattern.test(line)) failures.push(`${name}:${index + 1} ${reason}`);
    }
  });
}

function scan(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return scanFile(path);
  for (const name of readdirSync(path)) scan(join(path, name));
}

try {
  for (const target of TARGETS) scan(join(ROOT, target));
} catch (error) {
  console.error(`check-cti-scope: cannot scan release files — ${error.message}`);
  process.exit(1);
}

if (failures.length) {
  console.error('✖ CTI scope guard found release-language regressions:');
  failures.forEach(failure => console.error(`  ${failure}`));
  process.exit(1);
}

console.log('✓ Shipping code and public documentation remain CTI-focused.');

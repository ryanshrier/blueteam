// CI guard: every LOCAL static asset referenced by the published pages, README,
// and package files manifest must exist with exact case. A typo or stale path
// would otherwise ship a broken page, README image, or release package.
// Pure Node, no dependencies.
//
// Scope: page href/src/social-image references, README image targets, and every
// package.json `files` entry. External URLs, mailto:, data:, and #anchors are
// skipped — except the site's own absolute social image, which maps back into
// docs/ for validation.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
const SITE = 'https://blueteam.news/';
const pages = new Map([
  ['index.html', readFileSync(join(DOCS, 'index.html'), 'utf-8')],
  ['404.html', readFileSync(join(DOCS, '404.html'), 'utf-8')],
]);
const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

// Resolve a raw reference to a docs/-relative path, or null to skip it.
function resolve(ref) {
  ref = ref.trim();
  if (!ref || ref.startsWith('#') || ref.startsWith('mailto:') || ref.startsWith('data:')) return null;
  if (ref.startsWith(SITE)) ref = ref.slice(SITE.length); // own absolute URL → relative
  else if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) return null; // external
  ref = ref.replace(/^\//, '').split(/[?#]/)[0]; // drop leading slash, query, hash
  return ref || null;
}

const refs = new Map(); // docs-relative path → source attribute (for the report)
function collect(source, html, attr, re) {
  for (const m of html.matchAll(re)) {
    const rel = resolve(m[1]);
    if (rel && !refs.has(rel)) refs.set(rel, `${source}:${attr}`);
  }
}
for (const [source, html] of pages) {
  collect(source, html, 'href', /\bhref\s*=\s*"([^"]*)"/gi);
  collect(source, html, 'src', /\bsrc\s*=\s*"([^"]*)"/gi);
  collect(source, html, 'content', /<meta\b[^>]*\b(?:property|name)\s*=\s*"(?:og:image|twitter:image)"[^>]*\bcontent\s*=\s*"([^"]*)"/gi);
}

const repoRefs = new Map(); // repo-relative path → source
for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
  const raw = match[1].trim();
  if (!raw || raw.startsWith('data:') || /^https?:\/\//i.test(raw) || raw.startsWith('//')) continue;
  const rel = raw.replace(/^\.\//, '').split(/[?#]/)[0];
  if (rel) repoRefs.set(rel, 'README.md:image');
}
for (const entry of packageJson.files ?? []) {
  if (typeof entry === 'string' && entry.trim()) repoRefs.set(entry.trim(), 'package.json:files');
}

// GitHub Pages is case-sensitive even when this release check runs on Windows.
// existsSync alone accepts `Assets/og.png` for a real `assets/og.png` here, then
// the published URL 404s. Walk each URL path segment and require an exact name;
// this also makes `../` references fail instead of escaping docs/ via join().
function existsWithExactCase(root, rel) {
  if (rel.includes('\\') || rel.split('/').some(part => part === '..')) return false;
  let cursor = root;
  for (const part of rel.split('/').filter(part => part && part !== '.')) {
    let names;
    try { names = readdirSync(cursor); } catch { return false; }
    if (!names.includes(part)) return false;
    cursor = join(cursor, part);
  }
  return existsSync(cursor);
}

const missing = [];
const missingRepoRefs = [];
const invalidTypes = [];
const signatures = new Map([
  ['.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['.jpg', Buffer.from([0xff, 0xd8, 0xff])],
  ['.jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['.woff2', Buffer.from('wOF2')],
]);
for (const [rel, attr] of refs) {
  if (!existsWithExactCase(DOCS, rel)) {
    missing.push(`  docs/${rel}  (${attr})`);
    continue;
  }
  const expected = signatures.get(extname(rel).toLowerCase());
  if (!expected) continue;
  const bytes = readFileSync(join(DOCS, rel)).subarray(0, expected.length);
  if (!bytes.equals(expected)) invalidTypes.push(`  docs/${rel}  (extension does not match file signature)`);
}
for (const [rel, source] of repoRefs) {
  if (!existsWithExactCase(ROOT, rel)) {
    missingRepoRefs.push(`  ${rel}  (${source})`);
    continue;
  }
  const expected = signatures.get(extname(rel).toLowerCase());
  if (!expected) continue;
  const bytes = readFileSync(join(ROOT, rel)).subarray(0, expected.length);
  if (!bytes.equals(expected)) invalidTypes.push(`  ${rel}  (extension does not match file signature)`);
}

if (missing.length) {
  console.error('✖ Referenced asset(s) missing from docs/:');
  for (const m of missing) console.error(m);
  process.exit(1);
}
if (missingRepoRefs.length) {
  console.error('✖ Referenced repository/package path(s) missing:');
  for (const m of missingRepoRefs) console.error(m);
  process.exit(1);
}
if (invalidTypes.length) {
  console.error('✖ Referenced asset type mismatch(es):');
  for (const m of invalidTypes) console.error(m);
  process.exit(1);
}
console.log(`✓ All ${refs.size} published-page asset(s) and ${repoRefs.size} README/package path(s) exist with exact case.`);

// Pre-release / CI guard: fail if a real secret is present in the tree being
// packaged. Catches two classes of mistake:
//   1. a populated .env (or .env.<anything> that isn't .env.example) on disk
//   2. a hardcoded provider credential pasted into any source file
// Pure Node, no dependencies. Exits non-zero (with a report) on any hit.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';

const ROOT = process.cwd();

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'briefs', 'coverage', 'dist']);
const SKIP_FILES = new Set(['package-lock.json', 'check-no-secrets.mjs']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.db-shm', '.db-wal', '.sqlite', '.zip', '.gz', '.tgz',
]);
const MAX_BYTES = 512 * 1024;

// High-signal credential patterns. Kept deliberately narrow to avoid false
// positives on ordinary code.
const SECRET_PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'OpenAI project key', re: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Slack webhook secret', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/-]{20,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
];

// In a dotenv file, any KEY/SECRET/TOKEN/PASSWORD var with a non-empty value.
const DOTENV_SECRET_VAR = /^\s*([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(\S.*)$/;

const offenders = [];

function isDotenv(name) {
  return name === '.env' || name.startsWith('.env.');
}

function scanFile(abs) {
  const name = basename(abs);
  if (SKIP_FILES.has(name)) return;
  if (BINARY_EXT.has(extname(abs).toLowerCase())) return;

  let size;
  try { size = statSync(abs).size; } catch { return; }
  if (size > MAX_BYTES) return;

  let text;
  try { text = readFileSync(abs, 'utf-8'); } catch { return; }
  const rel = relative(ROOT, abs) || name;

  if (isDotenv(name)) {
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(DOTENV_SECRET_VAR);
      if (m && m[2].trim() !== '') {
        offenders.push(`${rel}:${i + 1}  populated secret var ${m[1]} (must be empty/absent in the packaged tree)`);
      }
    });
    // Real dotenv files are private and checked structurally. The committed
    // example is also checked structurally, but continue through high-signal
    // patterns so a credential pasted into a comment is caught too.
    if (name !== '.env.example') return;
  }

  for (const { name: label, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      offenders.push(`${rel}:${line}  looks like a ${label}`);
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      scanFile(join(dir, entry.name));
    }
  }
}

walk(ROOT);

if (offenders.length) {
  console.error('✖ Secret scan failed — do not commit or package these:\n');
  for (const o of offenders) console.error('  ' + o);
  console.error('\nRotate any exposed credential, then remove it from the tree.');
  process.exit(1);
}
console.log('✓ Secret scan clean — no populated .env secrets or hardcoded credentials found.');

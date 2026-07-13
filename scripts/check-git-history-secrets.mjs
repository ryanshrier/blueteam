// Release/CI guard: scan every tree reachable from every local Git ref without
// ever printing a matched value. The working-tree scanner catches accidents in
// the checkout; this companion catches credentials removed in a later commit or
// retained by an old branch/tag.

import { spawnSync } from 'node:child_process';

const runGit = (args, { allowNoMatch = false } = {}) => {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 0 || (allowNoMatch && result.status === 1)) return result.stdout || '';
  const detail = (result.stderr || '').trim();
  throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
};

let commits;
try {
  commits = runGit(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean);
} catch (err) {
  console.error(`✖ Git-history secret scan could not run: ${err.message}`);
  process.exit(1);
}

if (commits.length === 0) {
  console.error('✖ Git-history secret scan found no commits.');
  process.exit(1);
}

// Extended-regexp forms understood by `git grep -E`. Keep these aligned with
// check-no-secrets.mjs; matching output is restricted to filenames (`-l`).
const HIGH_SIGNAL_PATTERN = [
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'sk-[A-Za-z0-9]{32,}',
  'sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}',
  'AKIA[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{35}',
  'gh[pousr]_[A-Za-z0-9]{36,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'https://hooks\.slack\.com/services/[A-Za-z0-9_/-]{20,}',
  '-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----',
].join('|');

const DOTENV_SECRET_VAR = /^\s*([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(\S.*)$/;
const offenders = new Set();
const seenTrees = new Set();

for (const commit of commits) {
  const tree = runGit(['rev-parse', `${commit}^{tree}`]).trim();
  if (!tree || seenTrees.has(tree)) continue;
  seenTrees.add(tree);

  const hits = runGit([
    'grep', '-I', '-l', '-E', HIGH_SIGNAL_PATTERN, tree, '--', '.',
    ':(exclude)scripts/check-no-secrets.mjs',
    ':(exclude)scripts/check-git-history-secrets.mjs',
  ], { allowNoMatch: true });
  for (const hit of hits.split(/\r?\n/).filter(Boolean)) {
    offenders.add(`${tree.slice(0, 12)}:${hit.replace(/^[^:]+:/, '')} (credential pattern)`);
  }

  const paths = runGit(['ls-tree', '-r', '--name-only', tree]).split(/\r?\n/).filter(Boolean);
  for (const path of paths) {
    const name = path.split('/').at(-1);
    if (!(name === '.env' || name.startsWith('.env.'))) continue;
    const text = runGit(['show', `${tree}:${path}`]);
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(DOTENV_SECRET_VAR);
      if (match && match[2].trim()) {
        offenders.add(`${tree.slice(0, 12)}:${path}:${index + 1} (populated ${match[1]})`);
      }
    });
  }
}

if (offenders.size > 0) {
  console.error('✖ Secret scan failed in Git history. Rotate the credential and remove every public ref that retains it:\n');
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}

console.log(`✓ Git-history secret scan clean — ${seenTrees.size} reachable tree(s) checked without exposing matched values.`);

// A separate, durable inventory distinguishes legacy editions from modern
// editions whose evidence receipt was lost. Only the first upgrade may adopt
// legacy files; later missing/corrupt inventories fail closed.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RECEIPT_POLICY_FILE = '.receipt-policy.json';
export const RECEIPT_POLICY_KEY = 'brief_receipt_policy_v1';
const validName = name => /^brief-\d{4}-\d{2}-\d{2}(?:-\d{1,6})?\.md$/.test(name);
const digest = text => createHash('sha256').update(text).digest('hex');
const initializedDirectories = new Set();

function readPolicy(directory) {
  const raw = readFileSync(join(directory, RECEIPT_POLICY_FILE), 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Oversized receipt policy');
  const value = JSON.parse(raw);
  if (value?.schemaVersion !== 1 || !value.legacy || typeof value.legacy !== 'object' || Array.isArray(value.legacy)
      || Object.entries(value.legacy).some(([name, hash]) => !validName(name) || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid receipt policy');
  }
  return value;
}

export function initializeBriefReceiptPolicy(directory, { adoptLegacy = false, wasInitialized = false, generationLedger = null } = {}) {
  const path = join(directory, RECEIPT_POLICY_FILE);
  if (existsSync(path)) { readPolicy(directory); initializedDirectories.add(resolve(directory)); return; }
  if (wasInitialized || initializedDirectories.has(resolve(directory))) throw new Error('The briefing receipt inventory is missing. Restore .receipt-policy.json with the archive; refusing to reclassify missing receipts as legacy.');
  const legacy = {};
  if (adoptLegacy) {
    // Positive evidence of modern publication beats the compatibility fallback.
    // The ledger is bounded, so it cannot classify every pre-upgrade loss.
    const recorded = generationLedger ? JSON.parse(generationLedger) : { schemaVersion: 1, jobs: [] };
    if (recorded?.schemaVersion !== 1 || !Array.isArray(recorded.jobs)) throw new Error('Invalid generation ledger; cannot safely initialize legacy receipt inventory.');
    const required = new Set(recorded.jobs.map(job => job?.filename).filter(name => typeof name === 'string' && validName(name)));
    const files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && validName(entry.name));
    for (const { name: filename } of files) {
      if (!required.has(filename) && !existsSync(join(directory, filename.replace(/\.md$/, '.manifest.json')))) {
        legacy[filename] = digest(readFileSync(join(directory, filename), 'utf8'));
      }
    }
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, legacy }) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    initializedDirectories.add(resolve(directory));
    if (process.platform !== 'win32') {
      let dirFd;
      try { dirFd = openSync(directory, 'r'); fsyncSync(dirFd); }
      catch { /* Not all filesystems support directory fsync. */ }
      finally { if (dirFd !== undefined) closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function missingBriefReceiptIntegrity(directory, filename, original) {
  try {
    const policy = readPolicy(directory);
    return policy.legacy[filename] === digest(original) ? 'missing' : 'required';
  } catch (error) {
    // Uninitialized standalone readers retain backwards compatibility. The
    // production boot boundary always initializes and verifies the inventory.
    return error.code === 'ENOENT' && !initializedDirectories.has(resolve(directory)) ? 'missing' : 'invalid';
  }
}

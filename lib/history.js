// BlueTeam.News — briefing history: save, load, and continuity extraction.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { SECTIONS, parseBluf, parseSignalTitles, section, splitEntries, stripMd } from './brief-schema.js';
import { normalizeRenderedMarkdownDelimiters } from './grounding.js';
import { generationManifestFilename, serializeGenerationManifest, sha256, validBriefFilename } from './generation-manifest.js';
import { loadBriefReadingState } from './brief-reading-checks.js';
import { initializeBriefReceiptPolicy } from './brief-receipts.js';

// Continuity is prior MODEL OUTPUT, not source evidence. Preserve safe topic
// labels, but drop any prior line containing a factual identifier/status that
// could be laundered into today's brief without a current source. Dates, clock
// times, and deadline-state prose are unsafe too: a prior "due today" or fixed
// shift cutoff describes the OLD edition and must never become today's target.
const UNSAFE_CONTINUITY_FACT_RE = new RegExp([
  String.raw`CVE-\d{4}-\d{3,7}|https?:\/\/|\]\([^)]+\)|\bKEV\b|\bCVSS\b`,
  String.raw`\bscore\s*[:=]?\s*\d|\d+(?:\.\d+)?\s*\/\s*10|\d{1,3}\s*%`,
  String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b`,
  String.raw`\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b`,
  String.raw`\b\d{1,2}:\d{2}\s*(?:[AP]\.?M\.?)?(?:\s*[A-Z]{2,5})?\b|\b\d{1,2}\s*[AP]\.?M\.?(?:\s*[A-Z]{2,5})?\b`,
  String.raw`\b(?:deadline|deadlines|due|overdue|past[- ]due|expires?|expired|expiring|closes?|closing|today|tonight|tomorrow|same[- ]day|as\s+of)\b`,
  String.raw`\b(?:this|current)\s+(?:shift|morning|afternoon|evening|week|weekend|month)\b|\b(?:close|end)\s+of\s+(?:business|day|week|month)\b`,
  String.raw`\b(?:within|next|last)\s+\d+\s+(?:hours?|days?|weeks?)\b|\b(?:by|through|until)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b`,
].join('|'), 'i');

function continuityTopic(value) {
  if (!value || UNSAFE_CONTINUITY_FACT_RE.test(value)) return '';
  const normalized = stripMd(normalizeRenderedMarkdownDelimiters(value));
  return UNSAFE_CONTINUITY_FACT_RE.test(normalized) ? '' : normalized;
}

/**
 * Server-LOCAL calendar date (YYYY-MM-DD), not UTC. A brief belongs to the
 * operator's day: saveBrief's filename/dateline, the prompt's {weekday}, and
 * the Monday/Friday/weekend day-mode selection must all agree on which day it
 * is. Mixing `toISOString()` (UTC) with local-time weekday/day-mode checks
 * self-contradicts for any operator west of UTC generating in the evening
 * (e.g. files as tomorrow's date, dated "Tuesday", after already switching to
 * Wednesday's day-mode). Exported so other callers (prompt building, the
 * brief route's genDate) can standardize on the same clock.
 */
export function localDateISO(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertEditionDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new TypeError('edition date must be YYYY-MM-DD');
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    throw new TypeError('edition date must be a real calendar date');
  }
  return date;
}

export function scheduledBriefJobKey(date) {
  return `daily-brief:${assertEditionDate(date)}`;
}

export function scheduledBriefFilename(date) {
  return `brief-${assertEditionDate(date)}-00.md`;
}

function writePrivateAtomic(historyDir, filename, brief) {
  const target = join(historyDir, filename);
  const temp = join(
    historyDir,
    `.${filename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, brief, { encoding: 'utf-8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
    // `mode` applies only when a file is created. Tighten it explicitly as a
    // defense against unusual umasks; Windows has no POSIX mode boundary.
    if (process.platform !== 'win32') {
      try { chmodSync(target, 0o600); } catch { /* preserve prior save behavior */ }
      // Persist the directory entry as well as the file contents so a host
      // crash immediately after publication cannot resurrect only the temp
      // name and lose the deterministic idempotency marker.
      let dirFd = null;
      try {
        dirFd = openSync(historyDir, 'r');
        fsyncSync(dirFd);
      } catch {
        // Some filesystems do not support fsync on directories. The atomically
        // renamed, file-fsynced archive still remains the recovery marker.
      } finally {
        if (dirFd !== null) {
          try { closeSync(dirFd); } catch { /* best effort */ }
        }
      }
    }
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the original write error */ }
    }
    if (existsSync(temp)) {
      try { unlinkSync(temp); } catch { /* preserve the original write error */ }
    }
  }
}

export function saveBrief(historyDir, brief, {
  date = localDateISO(),
  scheduled = false,
  manifest = null,
  beforeCommit,
} = {}) {
  assertEditionDate(date);
  if (scheduled) {
    const filename = scheduledBriefFilename(date);
    // The reserved -00 name is the durable idempotency marker for this daily
    // job. A retry after a lost SSE response must never overwrite it.
    if (existsSync(join(historyDir, filename))) return filename;
    publishBrief(historyDir, filename, brief, manifest, beforeCommit);
    return filename;
  }

  let counter = 1;
  let filename;
  do {
    filename = `brief-${date}-${String(counter).padStart(2, '0')}.md`;
    counter++;
  } while (existsSync(join(historyDir, filename)));
  publishBrief(historyDir, filename, brief, manifest, beforeCommit);
  return filename;
}

function publishBrief(historyDir, filename, brief, manifest, beforeCommit) {
  if (!manifest) return writePrivateAtomic(historyDir, filename, brief);
  initializeBriefReceiptPolicy(historyDir);
  const manifestName = generationManifestFilename(filename);
  // The archive is the completion/idempotency marker. Make the required input
  // receipt durable first, so a crash can leave only an orphan receipt, never a
  // completed new edition without its inputs. A later retry replaces an orphan.
  const receipt = serializeGenerationManifest({ ...manifest, filename, outputSha256: sha256(brief) });
  writePrivateAtomic(historyDir, manifestName, receipt);
  let rollback;
  try {
    // An exact-copy approval must be durable before the archive becomes visible.
    rollback = beforeCommit?.(filename);
    writePrivateAtomic(historyDir, filename, brief);
  } catch (err) {
    try { if (typeof rollback === 'function') rollback(); } catch { /* preserve commit failure */ }
    try { unlinkSync(join(historyDir, manifestName)); } catch { /* best effort; no archive was published */ }
    throw err;
  }
}

/**
 * The calendar date (YYYY-MM-DD) a brief filename belongs to, stripping the
 * optional `-NN` same-day disambiguator saveBrief appends. Returns null for a
 * name that isn't a brief file.
 *
 * Anchoring on a full YYYY-MM-DD capture is load-bearing: a naive
 * `.replace(/(-\d+)?\.md$/, '')` over-matches — for a suffixless
 * `brief-2026-07-01.md` the greedy `(-\d+)?` eats the day too, yielding
 * "2026-07". The validator (routes/brief.js) accepts both suffixed and
 * suffixless shapes, so date extraction has to as well.
 */
export function briefDateFromFilename(filename) {
  const m = /^brief-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/.exec(filename);
  return m ? m[1] : null;
}

// Filenames identify editions; their reserved scheduled -00 and manual counters
// do not express evidence freshness. Repairs keep their original attempt's
// position while their displayed publication time records the repair commit.
function editionFiles(historyDir) {
  return readdirSync(historyDir, { withFileTypes: true }).filter(entry => entry.isFile() && validBriefFilename(entry.name)).map(entry => entry.name);
}

export function countBriefEditions(historyDir) { return editionFiles(historyDir).length; }

export function listBriefEditions(historyDir, { getMeta = () => null, limit = Infinity, offset = 0, dateLimit = Infinity, eligibleOnly = false, reviewDirectory } = {}) {
  if (limit <= 0) return [];
  const readEdition = filename => {
    let meta = null;
    try { meta = getMeta(filename); } catch { /* metadata unavailable: archive remains readable */ }
    // Eligibility needs the full receipt, but archive rows must not retain all
    // historical source payloads in memory after this decision is made.
    const { manifest, ...reading } = loadBriefReadingState(historyDir, filename, { reviewDirectory });
    let generatedAt = meta?.generated_at;
    if (!Number.isFinite(Date.parse(generatedAt || ''))) {
      generatedAt = manifest?.generatedAt;
    }
    const generatedAtMs = Number.isFinite(Date.parse(generatedAt || ''))
      ? Date.parse(generatedAt)
      : statSync(join(historyDir, filename)).mtimeMs;
    const attemptAt = manifest?.repairedDraft?.originalGeneratedAt || (manifest?.repairedDraft ? manifest.capturedAt : null);
    const evidenceAtMs = Number.isFinite(Date.parse(attemptAt || '')) ? Date.parse(attemptAt) : generatedAtMs;
    return { filename, date: briefDateFromFilename(filename), generatedAt: new Date(generatedAtMs).toISOString(), generatedAtMs, evidenceAtMs, meta, disposition: reading.disposition, reading };
  };
  // Calendar date is the primary ordering key. Skip whole old dates before
  // opening their receipts; within a date retain the original evidence order.
  const groups = new Map();
  for (const filename of editionFiles(historyDir)) {
    const date = briefDateFromFilename(filename);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(filename);
  }
  const results = [];
  let remainingOffset = Math.max(0, offset);
  let dates = 0;
  for (const date of [...groups.keys()].sort().reverse()) {
    const files = groups.get(date);
    if (!eligibleOnly && remainingOffset >= files.length) { remainingOffset -= files.length; continue; }
    const editions = files.map(readEdition).filter(edition => !eligibleOnly || edition.disposition.eligibleForLatest)
      .sort((a, b) => b.evidenceAtMs - a.evidenceAtMs || b.generatedAtMs - a.generatedAtMs || b.filename.localeCompare(a.filename, undefined, { numeric: true }));
    if (!editions.length) continue;
    const selected = editions.slice(remainingOffset, remainingOffset + limit - results.length);
    remainingOffset = Math.max(0, remainingOffset - editions.length);
    results.push(...selected);
    if (selected.length) dates++;
    if (results.length >= limit || dates >= dateLimit) break;
  }
  return results;
}

export function loadRecentBriefs(historyDir, depth = 5, options = {}) {
  if (!Number.isFinite(depth) || depth <= 0) return [];
  try {
    const editions = listBriefEditions(historyDir, { ...options, eligibleOnly: true, dateLimit: depth });

    // Keep only the most recently published brief per calendar date, then
    // take `depth` distinct days. Same-day regenerations (multiple manual
    // refreshes) previously could fill the whole continuity window with near-
    // identical copies of a single day, starving multi-day trajectory tracking.
    const seenDates = new Set();
    const deduped = [];
    for (const edition of editions) {
      const date = edition.date;
      if (seenDates.has(date)) continue;
      seenDates.add(date);
      deduped.push(edition);
      if (deduped.length >= depth) break;
    }

    return deduped.map(edition => ({
      filename: edition.filename,
      date: edition.date,
      content: edition.reading.content,
    }));
  } catch {
    return [];
  }
}

export function extractBluf(content) {
  return parseBluf(content);
}

/** Signal titles with horizon tags, for continuity and the wall. */
export function extractSignalTitles(content) {
  return parseSignalTitles(content);
}

/**
 * Compact continuity context from recent briefings, injected into the next
 * generation so developing situations are tracked across days.
 */
export function extractContinuityContext(briefs) {
  if (briefs.length === 0) return '';

  const entries = briefs.map(b => {
    const c = b.content;

    const bluf = continuityTopic(extractBluf(c));
    const signals = extractSignalTitles(c)
      .slice(0, 5)
      .map(s => ({ ...s, title: continuityTopic(s.title) }))
      .filter(s => s.title)
      .map(s => `[H${s.horizon}] ${s.title}`);

    const situations = splitEntries(section(c, SECTIONS.developing))
      .map(part => continuityTopic(part.split('\n')[0] || ''))
      .filter(Boolean)
      .slice(0, 3);

    let entry = `[${b.date}]`;
    if (bluf) entry += ` BLUF topic: ${bluf}`;
    if (signals.length) entry += `\n  Signal topics: ${signals.join('; ')}`;
    if (situations.length) entry += `\n  Developing topics: ${situations.join('; ')}`;
    return entry;
  }).join('\n\n');

  return '\n\nPREVIOUS BRIEFINGS (topic continuity only — not evidence; prior Watchlist items and factual identifiers/status are intentionally omitted):\n' + entries;
}

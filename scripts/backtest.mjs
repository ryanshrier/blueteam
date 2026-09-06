// Read-only diagnostics for immutable first-observation snapshots.
// node scripts/backtest.mjs [days]
//
// The archive contains selected headlines only. Each saved rank belongs to its
// original selected run; it is never recomputed or pooled into a synthetic rank.
// Later edits to the archive's latest score/KEV/title cannot change this report.
// Legacy rows without a snapshot are excluded. CISA catalog outcomes are dated
// by calendar day, so same-day ordering and hourly lead times are unknowable.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'watchfloor.db');
const DAY_MS = 86_400_000;
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,7}\b/gi;

function dayTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

export function parseFirstSnapshot(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const s = JSON.parse(raw);
    if (s?.version !== 1 || typeof s.title !== 'string'
      || !Number.isInteger(s.rank) || s.rank < 1
      || !Number.isInteger(s.candidateCount) || s.candidateCount < s.rank
      || !Number.isFinite(s.score) || s.score < 0 || s.score > 100
      || typeof s.observedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s.observedAt)
      || !Number.isFinite(dayTimestamp(s.observedAt.slice(0, 10)))
      || !Number.isFinite(Date.parse(s.observedAt))) return null;
    return { ...s, observedAt: new Date(s.observedAt).toISOString() };
  } catch { return null; }
}

function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return null;
  const percentile = p => ordered[Math.min(ordered.length - 1, Math.floor(p * ordered.length))];
  return { min: ordered[0], p25: percentile(.25), median: percentile(.5), p75: percentile(.75), max: ordered.at(-1) };
}

export function analyzeFirstSnapshots(rows, kevRows, { days = 14, now = new Date(), topK = 20 } = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('A valid observation-window end is required.');
  const sinceMs = nowMs - Math.max(1, days) * DAY_MS;
  const report = {
    days, totalRows: rows.length, missing: 0, invalid: 0, outsideWindow: 0,
    snapshots: [], laterKev: [], sameDay: 0, alreadyCataloged: 0, unmatchedCves: 0,
    topK, laterKevTopK: 0,
  };
  for (const row of rows) {
    // Never read mutable latest-title/score/KEV columns as historical evidence.
    if (!row.first_snapshot_json) { report.missing++; continue; }
    const snapshot = parseFirstSnapshot(row.first_snapshot_json);
    if (!snapshot) { report.invalid++; continue; }
    const observedMs = Date.parse(snapshot.observedAt);
    if (observedMs < sinceMs || observedMs > nowMs) { report.outsideWindow++; continue; }
    report.snapshots.push(snapshot);
  }
  report.ranks = distribution(report.snapshots.map(s => s.rank));
  report.scores = distribution(report.snapshots.map(s => s.score));

  const kevByCve = new Map();
  for (const row of kevRows) {
    const dateAdded = dayTimestamp(row.date_added);
    if (Number.isFinite(dateAdded) && dateAdded <= nowMs) {
      kevByCve.set(String(row.cve_id).toUpperCase(), { dateAdded, date: row.date_added });
    }
  }
  // Repeated articles about one CVE are one diagnostic observation. Keep its
  // earliest retained first selection in this window, with its own run's rank.
  const firstByCve = new Map();
  for (const snapshot of report.snapshots) {
    const cves = new Set((snapshot.title.match(CVE_PATTERN) || []).map(cve => cve.toUpperCase()));
    if (/^CVE-\d{4}-\d{4,7}$/i.test(snapshot.kevCVE || '')) cves.add(snapshot.kevCVE.toUpperCase());
    for (const cve of cves) {
      const previous = firstByCve.get(cve);
      if (!previous || snapshot.observedAt < previous.observedAt
        || (snapshot.observedAt === previous.observedAt && snapshot.rank < previous.rank)) firstByCve.set(cve, snapshot);
    }
  }
  for (const [cve, snapshot] of firstByCve) {
    const kev = kevByCve.get(cve);
    if (!kev) { report.unmatchedCves++; continue; }
    const observedDay = dayTimestamp(snapshot.observedAt.slice(0, 10));
    const calendarDays = (kev.dateAdded - observedDay) / DAY_MS;
    if (calendarDays === 0) { report.sameDay++; continue; }
    // A snapshot already marked KEV cannot demonstrate an earlier unknown CVE.
    if (calendarDays < 0 || snapshot.isKEV) { report.alreadyCataloged++; continue; }
    report.laterKev.push({
      cve, observedAt: snapshot.observedAt, dateAdded: kev.date,
      calendarDays, rank: snapshot.rank, candidateCount: snapshot.candidateCount,
      title: snapshot.title, score: snapshot.score,
    });
  }
  report.laterKev.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.cve.localeCompare(b.cve));
  report.laterKevTopK = report.laterKev.filter(observation => observation.rank <= topK).length;
  return report;
}

function distributionLine(label, value) {
  if (!value) return `${label}: no eligible snapshots`;
  return `${label}: min ${value.min} · p25 ${value.p25} · median ${value.median} · p75 ${value.p75} · max ${value.max}`;
}

export function formatSnapshotReport(report) {
  const lines = [
    `ARCHIVED FIRST-OBSERVATION DIAGNOSTICS — ${report.snapshots.length} selected headlines (last ${report.days}d)`,
    'Selected-only sample: unselected candidates are absent; this is not a predictive evaluation.',
    'Ranks and scores are immutable observations from each original selected run, never rescored or pooled.',
    `Excluded retained rows: ${report.missing} without snapshots, ${report.invalid} invalid snapshots, ${report.outsideWindow} outside the observation window.`,
    distributionLine('Observed first rank (within its own selected run)', report.ranks),
    distributionLine('Observed first score', report.scores),
    '',
    'LATER KEV CATALOG DATES — distinct mentioned CVEs, earliest retained selection in this window',
    `${report.laterKev.length} CVEs have a later catalog calendar date; ${report.laterKevTopK} had recorded rank <= ${report.topK} in their own selected run.`,
    `${report.sameDay} same-day CVEs excluded because intraday ordering is unknown; ${report.alreadyCataloged} already cataloged/verified; ${report.unmatchedCves} without a dated catalog match.`,
    'Date differences are UTC calendar days, not measured lead hours. Catalog timing does not establish prediction quality.',
  ];
  for (const observation of report.laterKev.slice(0, 20)) {
    lines.push(`  ${observation.cve}: observed ${observation.observedAt}; KEV ${observation.dateAdded}; ${observation.calendarDays} calendar day(s); rank ${observation.rank}/${observation.candidateCount}`);
  }
  if (report.laterKev.length > 20) lines.push(`  ${report.laterKev.length - 20} more dated CVEs omitted from this display.`);
  if (!report.snapshots.length) lines.push('No eligible immutable snapshots yet. New pipeline observations populate them; legacy rows are never reconstructed.');
  return lines.join('\n');
}

export function runSnapshotReport({ dbPath = DB_PATH, days = 14, now = new Date(), log = console.log } = {}) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(headline_archive)').all();
    if (!columns.some(column => column.name === 'first_snapshot_json')) {
      log('No immutable first-observation snapshots in this archive schema. Legacy latest-state rows cannot establish historical rank.');
      return null;
    }
    const rows = db.prepare('SELECT first_snapshot_json FROM headline_archive').all();
    const kevRows = db.prepare('SELECT cve_id, date_added FROM kev_cache WHERE date_added IS NOT NULL').all();
    const report = analyzeFirstSnapshots(rows, kevRows, { days, now });
    log(formatSnapshotReport(report));
    return report;
  } catch (error) {
    log(`No readable snapshot archive at ${dbPath} (${error.code || error.message}).`);
    return null;
  } finally { db?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSnapshotReport({ days: Math.max(1, parseInt(process.argv[2], 10) || 14) });
}

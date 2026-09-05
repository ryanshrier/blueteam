import { afterEach, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { analyzeFirstSnapshots, formatSnapshotReport, parseFirstSnapshot, runSnapshotReport } from '../scripts/backtest.mjs';

const now = new Date('2026-09-05T12:00:00Z');
const snapshot = overrides => ({ version: 1, observedAt: '2026-09-01T23:55:00Z',
  title: 'CVE-2026-1234 reported', rank: 7, candidateCount: 30, score: 64,
  isKEV: false, kevCVE: null, ...overrides });
const row = overrides => ({ first_snapshot_json: JSON.stringify(snapshot(overrides)) });
let taskDir;
afterEach(() => {
  if (!taskDir) return;
  const target = resolve(taskDir);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('bt-backtest-fixture-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(target, { recursive: true, force: true });
  taskDir = null;
});

test('mutable latest-state fields cannot rewrite recorded rank, title, score or verification', () => {
  const report = analyzeFirstSnapshots([
    { ...row(), title: 'Changed to CVE-2026-9999', score: 100, is_kev: 1, kev_cve: 'CVE-2026-9999' },
    row({ title: 'Another report', rank: 2, score: 12 }),
  ], [{ cve_id: 'CVE-2026-1234', date_added: '2026-09-03' }], { now });
  expect(report.laterKev).toMatchObject([{ cve: 'CVE-2026-1234', rank: 7, score: 64, calendarDays: 2 }]);
  expect(report.ranks).toMatchObject({ min: 2, max: 7 });
  expect(report.snapshots[0].title).toBe('CVE-2026-1234 reported');
});

test('compares day-granular outcomes, deduplicates CVEs and does not manufacture hourly ordering', () => {
  const report = analyzeFirstSnapshots([
    row(),
    row({ observedAt: '2026-09-02T01:00:00Z', rank: 1 }),
    row({ title: 'CVE-2026-2222 reported' }),
    row({ title: 'CVE-2026-3333 reported' }),
    row({ title: 'CVE-2026-4444 reported', isKEV: true, kevCVE: 'CVE-2026-4444' }),
  ], [
    { cve_id: 'CVE-2026-1234', date_added: '2026-09-03' },
    { cve_id: 'CVE-2026-2222', date_added: '2026-09-01' },
    { cve_id: 'CVE-2026-3333', date_added: '2026-08-30' },
    { cve_id: 'CVE-2026-4444', date_added: '2026-09-03' },
  ], { now });
  expect(report.laterKev).toHaveLength(1);
  expect(report.laterKev[0]).toMatchObject({ rank: 7, calendarDays: 2 });
  expect(report.sameDay).toBe(1);
  expect(report.alreadyCataloged).toBe(2);
  const output = formatSnapshotReport(report);
  expect(output).toContain('Selected-only sample');
  expect(output).toContain('not measured lead hours');
  expect(output).not.toMatch(/precision|recall|calibration/i);
});

test('filters by original observation time, excludes corrupt/legacy records and never fills them', () => {
  const rows = [
    { first_snapshot_json: null, score: 90, title: 'Legacy' },
    { first_snapshot_json: '{broken', score: 80 },
    row({ observedAt: '2026-08-01T12:00:00Z' }),
    row({ observedAt: '2026-09-06T12:00:00Z' }),
    row({ rank: 31, candidateCount: 30 }), row(),
  ];
  const before = JSON.stringify(rows);
  const report = analyzeFirstSnapshots(rows, [], { now });
  expect(report).toMatchObject({ missing: 1, invalid: 2, outsideWindow: 2 });
  expect(report.snapshots).toHaveLength(1);
  expect(JSON.stringify(rows)).toBe(before);
  expect(parseFirstSnapshot(JSON.stringify(snapshot({ version: 2 })))).toBeNull();
  expect(parseFirstSnapshot(JSON.stringify(snapshot({ observedAt: '2026-09-01' })))).toBeNull();
  expect(parseFirstSnapshot(JSON.stringify(snapshot({ observedAt: '2026-02-31T12:00:00Z' })))).toBeNull();
});

test('reads a fixture archive without changing it and reports old schemas honestly', () => {
  taskDir = mkdtempSync(join(tmpdir(), 'bt-backtest-fixture-'));
  const dbPath = join(taskDir, 'archive.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE headline_archive (title TEXT, first_snapshot_json TEXT); CREATE TABLE kev_cache (cve_id TEXT, date_added TEXT);');
  db.prepare('INSERT INTO headline_archive VALUES (?, ?)').run('Mutable latest value', row().first_snapshot_json);
  db.prepare('INSERT INTO kev_cache VALUES (?, ?)').run('CVE-2026-1234', '2026-09-03');
  const original = db.prepare('SELECT * FROM headline_archive').all();
  const report = runSnapshotReport({ dbPath, now, log: () => {} });
  expect(report.laterKev[0].rank).toBe(7);
  expect(db.prepare('SELECT * FROM headline_archive').all()).toEqual(original);
  db.exec('ALTER TABLE headline_archive DROP COLUMN first_snapshot_json');
  const messages = [];
  expect(runSnapshotReport({ dbPath, now, log: message => messages.push(message) })).toBeNull();
  expect(messages[0]).toContain('Legacy latest-state rows cannot establish historical rank');
  db.close();
});

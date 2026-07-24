import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initDB, closeDB, archiveHeadlines, getArchivedHeadlines, getDB,
  bulkInsertKEV, getKEVSet, getRecentKEV, countKEVAddedToday,
  saveBriefMeta, getBriefMeta, titleKey, indexBrief, searchBriefs,
} from '../lib/db.js';

describe('SQLite private file permissions', () => {
  const posixTest = process.platform === 'win32' ? test.skip : test;

  posixTest('tightens the database and any WAL sidecars to owner-only access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-db-mode-'));
    const dbPath = join(dir, 'watchfloor.db');
    try {
      initDB(dbPath);
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(path)) expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      closeDB();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('brief_meta — publication freshness', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('round-trips the exact generation timestamp for archive/export folios', () => {
    saveBriefMeta({
      filename: 'brief-2026-07-12.md',
      date: '2026-07-12',
      bluf: 'A concise bottom line.',
      word_count: 220,
      generated_at: '2026-07-12T12:31:00.000Z',
    });

    expect(getBriefMeta('brief-2026-07-12.md').generated_at)
      .toBe('2026-07-12T12:31:00.000Z');
  });
});

describe('brief_search idempotent indexing', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('reindexing one filename replaces its FTS row instead of duplicating results', () => {
    indexBrief('brief-2026-07-12.md', 'old unique phrase');
    indexBrief('brief-2026-07-12.md', 'new unique phrase');
    expect(searchBriefs('"unique"', 20)).toHaveLength(1);
    expect(searchBriefs('"old"', 20)).toHaveLength(0);
    expect(searchBriefs('"new"', 20)).toHaveLength(1);
  });
});

// headline_archive persists the distinct-PUBLISHER identities behind a story, not
// just the corroboration count, so the auditable source set survives a reload and
// stays in lockstep with the count. These tests pin the round-trip and the
// per-run (non-MAX) corroboration semantics.
describe('headline_archive — publisher identity round-trip', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('persists and restores the distinct-publisher list', () => {
    archiveHeadlines([{
      title: 'Critical VPN zero-day exploited in the wild',
      source: 'BleepingComputer',
      link: 'https://bleepingcomputer.com/a',
      horizon: 1, score: 9, urgency: 'critical',
      corroboration: 2,
      publishers: ['bleepingcomputer.com', 'thehackernews.com'],
    }]);

    const [row] = getArchivedHeadlines(7);
    expect(row.publishers).toEqual(['bleepingcomputer.com', 'thehackernews.com']);
    expect(row.corroboration).toBe(2);
    // sources mirrors the restored identities — it can never read length-1 while
    // corroboration reads 2 (the bug this column exists to remove).
    expect(row.sources).toEqual(['bleepingcomputer.com', 'thehackernews.com']);
    expect(row).not.toHaveProperty('publishers_json');
  });

  test('corroboration is assigned per-run, not MAX — a peak does not stick', () => {
    const key = { title: 'Same story, two runs', source: 'A', link: 'https://a.com/x' };
    // Run 1: three distinct publisher identities carry it.
    archiveHeadlines([{ ...key, corroboration: 3, publishers: ['a.com', 'b.com', 'c.com'] }]);
    // Run 2: only one publisher still carries it.
    archiveHeadlines([{ ...key, corroboration: 1, publishers: ['a.com'] }]);

    const [row] = getArchivedHeadlines(7);
    expect(row.corroboration).toBe(1);              // current-run truth, not the stale peak of 3
    expect(row.publishers).toEqual(['a.com']);      // list and count stay in lockstep
    expect(row.sources).toEqual(['a.com']);
  });

  test('a repeated story refreshes corrected display fields while retaining known publication time', () => {
    archiveHeadlines([{
      title: 'Vendor patches critical flaw', source: 'Old Feed', link: 'https://old.example/story',
      horizon: 2, date: '2026-07-10T00:00:00Z',
    }]);
    archiveHeadlines([{
      title: 'Vendor patches critical flaw!', source: 'Primary Advisory', link: 'https://vendor.example/advisory',
      horizon: 1,
    }]);
    const [row] = getArchivedHeadlines(7);
    expect(row.title).toBe('Vendor patches critical flaw!');
    expect(row.source).toBe('Primary Advisory');
    expect(row.link).toBe('https://vendor.example/advisory');
    expect(row.horizon).toBe(1);
    expect(row.published_at).toBe('2026-07-10T00:00:00.000Z');
  });

  test('a row with no publisher list degrades to the single feed label', () => {
    archiveHeadlines([{ title: 'No publishers here', source: 'SomeWire', corroboration: 1 }]);
    const [row] = getArchivedHeadlines(7);
    expect(row.publishers).toEqual([]);
    expect(row.sources).toEqual(['SomeWire']);
  });

  test('corrupt or non-array publisher JSON degrades to count-only, never throws', () => {
    // Smuggle a malformed value past archiveHeadlines by writing the column directly.
    getDB().prepare(`INSERT INTO headline_archive (title, title_key, source, corroboration, publishers_json)
                     VALUES ('x', 'x', 'FeedX', 2, 'not json')`).run();
    const [row] = getArchivedHeadlines(7);
    expect(row.publishers).toEqual([]);
    expect(row.sources).toEqual(['FeedX']);
  });

  test('getArchivedHeadlines filters by free-text title substring when q is given', () => {
    archiveHeadlines([
      { title: 'Ivanti Connect Secure exploited in the wild', source: 'A' },
      { title: 'Fortinet patches critical RCE', source: 'B' },
    ]);
    const hits = getArchivedHeadlines(7, 'ivanti');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('Ivanti');
  });

  test('getArchivedHeadlines with q treats % and _ as literals, not SQL wildcards', () => {
    archiveHeadlines([{ title: '50% of orgs affected', source: 'A' }]);
    expect(getArchivedHeadlines(7, '50%')).toHaveLength(1);
    expect(getArchivedHeadlines(7, 'zz%zz')).toHaveLength(0);
  });

  test('Unicode-only headlines retain distinct non-empty archive identities', () => {
    expect(titleKey('重大漏洞')).toBe('重大漏洞');
    expect(titleKey('重大漏洞')).not.toBe(titleKey('緊急更新'));
    archiveHeadlines([
      { title: '重大漏洞', source: 'Japanese Feed' },
      { title: '緊急更新', source: 'Japanese Feed' },
    ]);
    expect(getArchivedHeadlines(7).map(row => row.title).sort()).toEqual(['緊急更新', '重大漏洞'].sort());
  });
});

// #19 — bulkInsertKEV must prune rows CISA has withdrawn from the catalog,
// not just upsert. A retracted KEV entry that lingers keeps asserting
// "KEV-verified" and keeps feeding the overdue/due-soon counts.
describe('bulkInsertKEV — prunes withdrawn catalog entries', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('a CVE present in one fetch but absent from the next is deleted', () => {
    bulkInsertKEV([
      { cveID: 'CVE-2026-0001', vendorProject: 'Acme', product: 'Widget', dateAdded: '2026-06-01' },
      { cveID: 'CVE-2026-0002', vendorProject: 'Acme', product: 'Gadget', dateAdded: '2026-06-01' },
    ]);
    expect(getKEVSet().has('CVE-2026-0001')).toBe(true);
    expect(getKEVSet().has('CVE-2026-0002')).toBe(true);

    // CISA withdraws CVE-2026-0002 from the catalog — next fetch omits it.
    bulkInsertKEV([
      { cveID: 'CVE-2026-0001', vendorProject: 'Acme', product: 'Widget', dateAdded: '2026-06-01' },
    ]);
    const set = getKEVSet();
    expect(set.has('CVE-2026-0001')).toBe(true);
    expect(set.has('CVE-2026-0002')).toBe(false);
  });

  test('an empty entries array never wipes the cache', () => {
    bulkInsertKEV([{ cveID: 'CVE-2026-0003', dateAdded: '2026-06-01' }]);
    bulkInsertKEV([]);
    expect(getKEVSet().has('CVE-2026-0003')).toBe(true);
  });
});

// #24 — the "KEV · NEWLY ADDED" page must not serve entries added months ago
// once the cache has ever been populated; it needs a recency cutoff.
describe('getRecentKEV — recency window', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('excludes entries older than the default 14-day window', () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
    const fresh = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    bulkInsertKEV([
      { cveID: 'CVE-2020-0001', dateAdded: old },
      { cveID: 'CVE-2026-0002', dateAdded: fresh },
    ]);
    const recent = getRecentKEV(8);
    expect(recent.map(k => k.cve_id)).toEqual(['CVE-2026-0002']);
  });

  test('an explicit days window overrides the default', () => {
    const fresh = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    bulkInsertKEV([{ cveID: 'CVE-2026-0009', dateAdded: fresh }]);
    expect(getRecentKEV(8, 1)).toHaveLength(0); // 2 days ago, 1-day window
    expect(getRecentKEV(8, 7)).toHaveLength(1);
  });
});

// #83 — a "today" stat must count only the current UTC calendar date, not a
// day-granular ">= yesterday" comparison that actually spans up to ~48h.
describe('countKEVAddedToday', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('counts only entries dated today, excluding yesterday', () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    bulkInsertKEV([
      { cveID: 'CVE-2026-1111', dateAdded: today },
      { cveID: 'CVE-2026-2222', dateAdded: yesterday },
    ]);
    expect(countKEVAddedToday()).toBe(1);
  });
});

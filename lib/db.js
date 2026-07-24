// BlueTeam.News — SQLite layer (better-sqlite3).
// Stores: briefing metadata + FTS5 search, feed/KEV caches, feed health,
// and a rolling headline archive that powers landscape trends.

import Database from 'better-sqlite3';
import { chmodSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { log } from './logger.js';

let db = null;

function hardenDatabaseFiles(dbPath) {
  if (
    process.platform === 'win32'
    || typeof dbPath !== 'string'
    || dbPath === ':memory:'
    || dbPath.startsWith('file:')
  ) return;

  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    try {
      chmodSync(path, 0o600);
    } catch (err) {
      // Do not make an otherwise usable deployment unavailable on a filesystem
      // that cannot represent POSIX modes, but make the residual risk visible.
      log.warn('db', `Could not set private permissions on ${path}: ${err.message}`);
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS brief_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  bluf TEXT,
  model_used TEXT,
  generation_time_ms INTEGER,
  headline_count INTEGER,
  word_count INTEGER,
  horizon_counts TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS brief_search USING fts5(
  filename, content, tokenize='porter'
);

CREATE TABLE IF NOT EXISTS feed_cache (
  feed_url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  items_json TEXT,
  cached_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kev_cache (
  cve_id TEXT PRIMARY KEY,
  vendor TEXT,
  product TEXT,
  vulnerability_name TEXT,
  date_added TEXT,
  due_date TEXT,
  cached_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feed_health_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_source TEXT NOT NULL,
  status TEXT NOT NULL,
  item_count INTEGER DEFAULT 0,
  checked_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feed_health_source ON feed_health_log(feed_source);

CREATE TABLE IF NOT EXISTS headline_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  source TEXT,
  link TEXT,
  horizon INTEGER CHECK(horizon BETWEEN 1 AND 3),  -- 3 CTI tiers; legacy 4-horizon DBs are remapped + retightened by the v1→v2 migration below
  score REAL,
  urgency TEXT,
  is_kev INTEGER DEFAULT 0,
  kev_cve TEXT,
  corroboration INTEGER DEFAULT 1,   -- distinct-publisher count; publishers_json (the identities behind it) is added by the v2→v3 migration below
  published_at TEXT,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_title_key ON headline_archive(title_key);
CREATE INDEX IF NOT EXISTS idx_archive_last_seen ON headline_archive(last_seen);
`;

// ── Schema migrations (PRAGMA user_version) ──
// Ordered list; index i upgrades the DB from version i to i+1. Each runs once,
// in a transaction, and user_version is bumped on success. To change the schema
// in a future release, append a migration — never edit an existing one.
const MIGRATIONS = [
  // v0 → v1: baseline schema (idempotent CREATE … IF NOT EXISTS, so existing
  // pre-migration deployments adopt v1 cleanly).
  (database) => database.exec(SCHEMA),

  // v1 → v2: collapse the four time-horizons into the three CTI tiers
  // (1 Tactical / 2 Operational / 3 Strategic). Remap archived headline horizons:
  // old Emerging (3) folds into Operational (2); old Horizon (4) becomes
  // Strategic (3). ORDER IS LOAD-BEARING — 3→2 must run before 4→3, or the
  // old-Emerging rows get stranded as Strategic. Then rebuild headline_archive
  // to tighten its CHECK to 1..3 (SQLite cannot ALTER a CHECK constraint in place).
  // The whole migration runs in one transaction; the stray-row assertion below
  // aborts and rolls back if anything lands outside 1..3.
  (database) => {
    database.exec(`
      UPDATE headline_archive SET horizon = 2 WHERE horizon = 3;
      UPDATE headline_archive SET horizon = 3 WHERE horizon = 4;
    `);
    const stray = database
      .prepare('SELECT COUNT(*) AS n FROM headline_archive WHERE horizon IS NOT NULL AND horizon NOT BETWEEN 1 AND 3')
      .get().n;
    if (stray > 0) throw new Error(`3-tier migration: ${stray} headline_archive row(s) outside 1..3 after remap — aborting`);
    database.exec(`
      CREATE TABLE headline_archive_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        title_key TEXT NOT NULL,
        source TEXT,
        link TEXT,
        horizon INTEGER CHECK(horizon BETWEEN 1 AND 3),
        score REAL,
        urgency TEXT,
        is_kev INTEGER DEFAULT 0,
        kev_cve TEXT,
        corroboration INTEGER DEFAULT 1,
        published_at TEXT,
        first_seen TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO headline_archive_new
        SELECT id, title, title_key, source, link, horizon, score, urgency, is_kev, kev_cve, corroboration, published_at, first_seen, last_seen
        FROM headline_archive;
      DROP TABLE headline_archive;
      ALTER TABLE headline_archive_new RENAME TO headline_archive;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_title_key ON headline_archive(title_key);
      CREATE INDEX IF NOT EXISTS idx_archive_last_seen ON headline_archive(last_seen);
    `);
  },

  // v2 → v3: persist the distinct-PUBLISHER identities behind each archived
  // headline. Earlier versions stored only the corroboration COUNT, so on reload
  // the auditable source identities were lost — a story reported by N publishers
  // re-rendered as a single feed label while corroboration still read N. The list
  // is the count's basis (see lib/feeds.js deduplicateWithCorroboration), so we
  // store it alongside and keep the two in lockstep. Additive column — no rebuild;
  // existing rows get NULL and degrade to count-only until next seen.
  (database) => database.exec('ALTER TABLE headline_archive ADD COLUMN publishers_json TEXT;'),

  // v3 → v4: persist the generation-time validation warnings on each brief. The client
  // could only re-derive a structural subset on load, so an archived brief that was
  // flagged (ungrounded CVE, banned phrase, missing section) re-rendered as clean and
  // authoritative. Store the set so it re-surfaces. Additive column — existing rows get
  // NULL and degrade to the lightweight structural check.
  (database) => database.exec('ALTER TABLE brief_meta ADD COLUMN warnings TEXT;'),

  // v4 → v5: retain the publication timestamp, not just the calendar date.
  // The briefing/export folio needs honest freshness metadata after an edition is
  // reopened from the archive; file mtime is only a fallback because operators may
  // legitimately edit an archived Markdown file after generation.
  (database) => database.exec('ALTER TABLE brief_meta ADD COLUMN generated_at TEXT;'),
];

function runMigrations(database) {
  const from = database.pragma('user_version', { simple: true });
  if (from >= MIGRATIONS.length) return;
  for (let v = from; v < MIGRATIONS.length; v++) {
    const tx = database.transaction(() => {
      MIGRATIONS[v](database);
      database.pragma(`user_version = ${v + 1}`);
    });
    tx();
  }
  log.info('db', `Schema migrated v${from} → v${MIGRATIONS.length}`);
}

export function initDB(dbPath) {
  // Tighten an existing database before opening it; new databases are tightened
  // immediately after creation. The real deployment's parent data directory is
  // also mode 0700, closing the short creation window.
  hardenDatabaseFiles(dbPath);
  db = new Database(dbPath);
  hardenDatabaseFiles(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');        // transparent retry under WAL write-lock contention (scheduled refresh + manual refresh + brief indexing overlap)
  db.pragma('wal_autocheckpoint = 1000');  // bound -wal growth on a 24/7 kiosk
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // WAL/SHM sidecars may first appear during the pragmas or migrations.
  hardenDatabaseFiles(dbPath);
  log.info('db', `SQLite initialized: ${dbPath} (schema v${db.pragma('user_version', { simple: true })})`);
  return db;
}

// ── App-level key/value markers ──
export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

export function getDB() {
  if (!db) throw new Error('Database not initialized — call initDB() first');
  return db;
}

// ── Briefing metadata + search ──
export function saveBriefMeta(meta) {
  db.prepare(`
    INSERT OR REPLACE INTO brief_meta
    (filename, date, bluf, model_used, generation_time_ms, headline_count, word_count, horizon_counts, input_tokens, output_tokens, warnings, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meta.filename, meta.date, meta.bluf || null, meta.model_used || null,
    meta.generation_time_ms || null, meta.headline_count || null, meta.word_count || null,
    meta.horizon_counts ? JSON.stringify(meta.horizon_counts) : null,
    meta.input_tokens || null, meta.output_tokens || null,
    meta.warnings && meta.warnings.length ? JSON.stringify(meta.warnings) : null,
    meta.generated_at || null
  );
}

export function getBriefMeta(filename) {
  return db.prepare('SELECT * FROM brief_meta WHERE filename = ?').get(filename);
}

export function indexBrief(filename, content) {
  // FTS5 has no UNIQUE constraint on filename, so INSERT OR REPLACE only
  // appended another row. Delete first to keep search results one-per-brief.
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM brief_search WHERE filename = ?').run(filename);
    db.prepare('INSERT INTO brief_search (filename, content) VALUES (?, ?)').run(filename, content);
  });
  replace();
}

export function searchBriefs(query, limit = 20) {
  return db.prepare(`
    SELECT filename, snippet(brief_search, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM brief_search
    WHERE content MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);
}

export function backfillBriefSearch(briefsDir) {
  const indexed = new Set(
    db.prepare('SELECT filename FROM brief_search').all().map(r => r.filename)
  );

  let count = 0;
  const insert = db.prepare('INSERT INTO brief_search (filename, content) VALUES (?, ?)');
  try {
    const files = readdirSync(briefsDir).filter(f => f.startsWith('brief-') && f.endsWith('.md'));
    const tx = db.transaction(() => {
      for (const f of files) {
        if (indexed.has(f)) continue;
        try {
          insert.run(f, readFileSync(join(briefsDir, f), 'utf-8'));
          count++;
        } catch { /* skip unreadable */ }
      }
    });
    tx();
  } catch (err) {
    log.warn('db', `FTS5 backfill error: ${err.message}`);
  }
  if (count > 0) log.info('db', `FTS5 backfill: indexed ${count} briefings`);
}

// ── Feed cache (conditional GET) ──
export function getFeedCache(feedUrl) {
  return db.prepare('SELECT etag, last_modified, items_json, cached_at FROM feed_cache WHERE feed_url = ?').get(feedUrl);
}

export function setFeedCache(feedUrl, etag, lastModified, items) {
  db.prepare(`
    INSERT OR REPLACE INTO feed_cache (feed_url, etag, last_modified, items_json, cached_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(feedUrl, etag || null, lastModified || null, JSON.stringify(items));
}

// ── KEV cache ──
export function getKEVSet() {
  return new Set(db.prepare('SELECT cve_id FROM kev_cache').all().map(r => r.cve_id));
}

export function bulkInsertKEV(entries) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO kev_cache (cve_id, vendor, product, vulnerability_name, date_added, due_date, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = db.transaction(() => {
    for (const e of entries) {
      insert.run(
        e.cveID, e.vendorProject || null, e.product || null,
        e.vulnerabilityName || null, e.dateAdded || null, e.dueDate || null
      );
    }
    // Prune rows CISA has withdrawn from the catalog since our last fetch. Only
    // upserting let retracted entries linger forever, still asserting a
    // "KEV-verified" badge and still counted in overdue/due-soon — a stale
    // catalog membership is exactly the kind of honesty gap this product can't
    // afford. Guarded by entries.length (checked by the caller's non-empty-
    // response contract) so a transient empty fetch can never wipe the cache.
    if (entries.length > 0) {
      const keep = entries.map(e => e.cveID);
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(`DELETE FROM kev_cache WHERE cve_id NOT IN (${placeholders})`).run(...keep);
    }
    // Stamp the refresh time explicitly. Deriving it from cached_at was wrong:
    // CISA occasionally removes entries, whose rows then linger with an old
    // cached_at, so MIN() stayed ancient and the catalog refreshed every run.
    setMeta('kev_last_refresh', new Date().toISOString());
  });
  tx();
}

export function getKEVAge() {
  const ts = getMeta('kev_last_refresh');
  if (!ts) return Infinity;
  const parsed = Date.parse(ts); // stored as ISO 8601 — reliably parseable
  if (Number.isNaN(parsed)) return Infinity;
  return (Date.now() - parsed) / 3600000; // hours
}

/**
 * Most-recently-added KEV entries, windowed to a recency cutoff. Without the
 * cutoff this always returns the 8 most-recent-EVER entries — during a quiet
 * stretch the Wall's "KEV · NEWLY ADDED" page would keep rotating rows added
 * weeks ago under a freshness-asserting slug. `days` bounds date_added so the
 * page goes empty (and the Wall skips it) rather than serving stale "new".
 */
export function getRecentKEV(limit = 8, days = 14) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT cve_id, vendor, product, vulnerability_name, date_added, due_date
    FROM kev_cache
    WHERE date_added >= ?
    ORDER BY date_added DESC, cve_id DESC
    LIMIT ?
  `).all(cutoff, limit);
}

export function countKEVAddedSince(isoDate) {
  const row = db.prepare('SELECT COUNT(*) as n FROM kev_cache WHERE date_added >= ?').get(isoDate);
  return row?.n || 0;
}

/**
 * KEV entries added on today's UTC calendar date. CISA's date_added is
 * day-granular, so a naive "since 24h ago" comparison (date_added >= a date
 * string one day back) actually spans up to ~48h — at 14:00 UTC it includes
 * everything added since yesterday morning; just after midnight it approaches
 * two full days. Day-granular source data can't honestly back a rolling-24h
 * figure, so this counts only the current UTC day for a stat that's actually
 * labeled/consumed as "today".
 */
export function countKEVAddedToday() {
  const today = new Date().toISOString().slice(0, 10);
  return countKEVAddedSince(today);
}

/**
 * Batch-resolve remediation due dates for a set of CVE ids.
 * Returns { CVE: { due_date, overdue } } for cataloged CVEs that carry a
 * due_date; CVEs absent or with a null due_date are simply omitted. `overdue`
 * is computed against today (UTC date).
 */
export function getKEVDueDates(cveIds) {
  const ids = [...new Set((cveIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const today = new Date().toISOString().slice(0, 10);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT cve_id, due_date, date_added,
      CASE WHEN due_date < ? THEN 1 ELSE 0 END as overdue
    FROM kev_cache
    WHERE due_date IS NOT NULL AND cve_id IN (${placeholders})
  `).all(today, ...ids);

  const out = {};
  for (const r of rows) out[r.cve_id] = { due_date: r.due_date, date_added: r.date_added, overdue: Boolean(r.overdue) };
  return out;
}

/**
 * date_added for the given CVE IDs (regardless of due_date). Feeds the KEV-age
 * decay in scoring: a catalog entry's rank credit ages even though its
 * membership is permanent. Returns { cve_id: 'YYYY-MM-DD' }.
 */
export function getKEVDatesAdded(cveIds) {
  const ids = [...new Set((cveIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT cve_id, date_added FROM kev_cache WHERE cve_id IN (${placeholders})`).all(...ids);
  const out = {};
  for (const r of rows) out[r.cve_id] = r.date_added;
  return out;
}

// ── Feed health ──
export function logFeedHealth(source, status, itemCount = 0) {
  db.prepare('INSERT INTO feed_health_log (feed_source, status, item_count) VALUES (?, ?, ?)')
    .run(source, status, itemCount);
}

export function pruneFeedHealth(days = 7) {
  db.prepare("DELETE FROM feed_health_log WHERE checked_at < datetime('now', '-' || ? || ' days')").run(days);
}

// ── Headline archive (rolling window for trends) ──
// Exported so lib/landscape.js can normalize current-run titles the same way
// when deduping against archived rows (see buildActorLeaderboard).
export function titleKey(title) {
  const normalized = String(title)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  // Truncate by Unicode code point so a supplementary-plane letter is never
  // split into an invalid lone surrogate at the boundary.
  return Array.from(normalized).slice(0, 160).join('');
}

export function archiveHeadlines(headlines) {
  const upsert = db.prepare(`
    INSERT INTO headline_archive
      (title, title_key, source, link, horizon, score, urgency, is_kev, kev_cve, corroboration, publishers_json, published_at)
    VALUES (@title, @title_key, @source, @link, @horizon, @score, @urgency, @is_kev, @kev_cve, @corroboration, @publishers_json, @published_at)
    ON CONFLICT(title_key) DO UPDATE SET
      title = excluded.title,
      source = COALESCE(excluded.source, headline_archive.source),
      link = COALESCE(excluded.link, headline_archive.link),
      horizon = COALESCE(excluded.horizon, headline_archive.horizon),
      score = excluded.score,
      urgency = excluded.urgency,
      is_kev = excluded.is_kev,
      kev_cve = excluded.kev_cve,
      -- corroboration is a PER-RUN distinct-publisher count (lib/feeds.js), so we
      -- ASSIGN the current run's value rather than MAX(old, new). MAX kept a stale
      -- peak: a story carried by 3 publishers one day stayed "3" even after only 1
      -- publisher still ran it — and, now that we persist the identities alongside,
      -- that peak would outlive its publishers_json, leaving corroboration=3 next to
      -- a 1-entry list (the exact inconsistency this column removes). Assignment keeps
      -- count and list in lockstep at current-run truth; trend lives in the rolling
      -- window + getHeadlineVelocity, not a sticky per-row peak.
      corroboration = excluded.corroboration,
      publishers_json = excluded.publishers_json,
      published_at = COALESCE(excluded.published_at, headline_archive.published_at),
      last_seen = datetime('now')
  `);
  const tx = db.transaction(() => {
    for (const h of headlines) {
      let publishedAt = null;
      if (h.date) {
        const parsed = Date.parse(h.date);
        if (!isNaN(parsed)) publishedAt = new Date(parsed).toISOString();
      }
      const publishers = Array.isArray(h.publishers) ? h.publishers.filter(p => typeof p === 'string') : [];
      upsert.run({
        title: h.title,
        title_key: titleKey(h.title),
        source: h.source || null,
        link: h.link || null,
        horizon: h.horizon || null,
        score: h.score || 0,
        urgency: h.urgency || 'routine',
        is_kev: h.isKEV ? 1 : 0,
        kev_cve: h.kevCVE || null,
        corroboration: h.corroboration || 1,
        publishers_json: publishers.length ? JSON.stringify(publishers) : null,
        published_at: publishedAt,
      });
    }
  });
  tx();
}

export function pruneHeadlineArchive(days = 14) {
  const result = db.prepare(
    "DELETE FROM headline_archive WHERE last_seen < datetime('now', '-' || ? || ' days')"
  ).run(days);
  if (result.changes > 0) log.info('db', `Pruned ${result.changes} archived headlines older than ${days}d`);
}

/**
 * Archived headlines from the rolling window, optionally filtered by a
 * free-text substring match on the title (case-insensitive). `q` powers an
 * analyst-facing "what did I miss" and powers the seven-day trend comparisons
 * assembled by lib/landscape.js.
 */
export function getArchivedHeadlines(days = 7, q = null) {
  const query = (q || '').trim();
  const rows = query
    ? db.prepare(`
        SELECT title, source, link, horizon, score, urgency, is_kev, kev_cve, corroboration, publishers_json, published_at, first_seen
        FROM headline_archive
        WHERE last_seen >= datetime('now', '-' || ? || ' days')
          AND title LIKE ? ESCAPE '\\'
        ORDER BY score DESC
      `).all(days, `%${query.replace(/[\\%_]/g, c => '\\' + c)}%`)
    : db.prepare(`
        SELECT title, source, link, horizon, score, urgency, is_kev, kev_cve, corroboration, publishers_json, published_at, first_seen
        FROM headline_archive
        WHERE last_seen >= datetime('now', '-' || ? || ' days')
        ORDER BY score DESC
      `).all(days);

  for (const r of rows) {
    // Restore the distinct-publisher identities so a reloaded headline carries the
    // same corroboration basis it had live. h.sources mirrors the list so
    // compactHeadline (lib/landscape.js) can't emit sources.length 1 while
    // corroboration reads >1. The original per-feed display labels aren't separately
    // persisted; the wire "via" trail already tolerates this divergence on reload
    // (see public/modules/wire/wire-view.js). Pre-v3 rows have no list and degrade
    // to the single stored feed label — count-only, as before.
    let publishers = [];
    if (r.publishers_json) {
      try {
        const parsed = JSON.parse(r.publishers_json);
        if (Array.isArray(parsed)) publishers = parsed.filter(p => typeof p === 'string');
      } catch { /* corrupt JSON — degrade to count-only */ }
    }
    r.publishers = publishers;
    r.sources = publishers.length ? [...publishers] : (r.source ? [r.source] : []);
    delete r.publishers_json;
  }
  return rows;
}

/** KEV entries with remediation deadlines — recent catalog entries, overdue first. */
export function getKEVDeadlines(limit = 6) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT cve_id, vendor, product, vulnerability_name, date_added, due_date,
      CASE WHEN due_date < ? THEN 1 ELSE 0 END as overdue,
      CASE WHEN due_date >= ? AND due_date <= date(?, '+14 days') THEN 1 ELSE 0 END as due_soon
    FROM kev_cache
    WHERE due_date IS NOT NULL
      AND date_added >= date(?, '-120 days')
    ORDER BY overdue DESC, due_date ASC, date_added DESC
    LIMIT ?
  `).all(today, today, today, today, limit);
}

/** Overdue KEV among recently cataloged entries (actionable window). */
export function countKEVOverdue() {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM kev_cache
    WHERE due_date IS NOT NULL AND due_date < ?
      AND date_added >= date(?, '-120 days')
  `).get(today, today);
  return row?.n || 0;
}

export function countKEVDueSoon(days = 14) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM kev_cache
    WHERE due_date IS NOT NULL AND due_date >= ? AND due_date <= date(?, '+' || ? || ' days')
      AND date_added >= date(?, '-120 days')
  `).get(today, today, days, today);
  return row?.n || 0;
}

/** Headlines-per-hour for the last N hours — wall sparkline. */
export function getHeadlineVelocity(hours = 24) {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00', COALESCE(published_at, first_seen)) as hour, COUNT(*) as count
    FROM headline_archive
    WHERE COALESCE(published_at, first_seen) >= datetime('now', '-' || ? || ' hours')
    GROUP BY hour
    ORDER BY hour
  `).all(hours);

  // Fill gaps so the sparkline is continuous
  const byHour = Object.fromEntries(rows.map(r => [r.hour, r.count]));
  const out = [];
  const now = Date.now();
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now - i * 3600_000);
    const key = d.toISOString().slice(0, 13) + ':00';
    out.push({ hour: key, count: byHour[key] || 0 });
  }
  return out;
}

// ── Lifecycle ──
export function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

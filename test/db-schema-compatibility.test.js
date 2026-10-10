import { expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDB, closeDB, getDB, archiveHeadlines } from '../lib/db.js';

test('v9 upgrade preserves every historical row and first snapshot while replacing title-prefix uniqueness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blueteam-schema-upgrade-'));
  const file = join(dir, 'previous.db');
  try {
    initDB(file);
    const database = getDB();
    // Recreate the immediately preceding schema without relying on an external
    // operator database. Two old titles can refer to the same source URL.
    database.exec(`DROP TABLE decision_evidence; DROP TABLE decision_revisions; DROP TABLE decisions; DROP INDEX idx_archive_identity;
      ALTER TABLE headline_archive DROP COLUMN archive_key;
      DROP INDEX idx_archive_title_key;
      CREATE UNIQUE INDEX idx_archive_title_key ON headline_archive(title_key);
      PRAGMA user_version = 9;`);
    const insert = database.prepare('INSERT INTO headline_archive(title, title_key, source, link, horizon, first_snapshot_json) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('Original report', 'original report', 'Vendor', 'https://example.test/advisory', 1, '{"score":42}');
    insert.run('Retitled report', 'retitled report', 'Vendor', 'https://example.test/advisory?utm_source=feed', 1, '{"score":63}');
    const before = database.prepare('SELECT id, title, first_snapshot_json FROM headline_archive ORDER BY id').all();
    closeDB();
    initDB(file);
    expect(getDB().pragma('user_version', { simple: true })).toBe(11);
    expect(getDB().prepare('SELECT id, title, first_snapshot_json FROM headline_archive ORDER BY id').all()).toEqual(before);
    expect(getDB().prepare('SELECT COUNT(DISTINCT archive_key) AS n FROM headline_archive').get().n).toBe(2);
    const prefix = 'Long shared headline '.repeat(10);
    archiveHeadlines([
      { title: `${prefix}incident A`, source: 'Vendor', link: 'https://example.test/a', horizon: 1 },
      { title: `${prefix}incident B`, source: 'Vendor', link: 'https://example.test/b', horizon: 1 },
    ]);
    expect(getDB().prepare('SELECT COUNT(*) AS n FROM headline_archive').get().n).toBe(4);
  } finally { closeDB(); rmSync(dir, { recursive: true, force: true }); }
});

test('a future schema is rejected before journal changes or migrations, releasing the connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blueteam-schema-compatibility-'));
  const file = join(dir, 'future.db');
  try {
    const future = new Database(file);
    future.exec('PRAGMA user_version = 999; CREATE TABLE future_record(value TEXT); INSERT INTO future_record VALUES (\'preserved\');');
    future.close();
    expect(() => initDB(file)).toThrow('newer than supported');
    expect(() => getDB()).toThrow('not initialized');
    const retained = new Database(file, { readonly: true });
    try {
      expect(retained.pragma('user_version', { simple: true })).toBe(999);
      expect(retained.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(retained.prepare('SELECT value FROM future_record').get()).toEqual({ value: 'preserved' });
    } finally { retained.close(); }
  } finally { closeDB(); rmSync(dir, { recursive: true, force: true }); }
});

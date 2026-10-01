import { expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDB, closeDB, getDB } from '../lib/db.js';

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

import { assertSupportedNode } from '../lib/runtime-policy.js';
import Database from 'better-sqlite3';
assertSupportedNode();
const db = new Database(':memory:');
try {
  if (db.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('SQLite runtime check failed.');
  console.log(JSON.stringify({ node: process.version, executable: process.execPath, nativeSqlite: 'ok' }));
} finally { db.close(); }

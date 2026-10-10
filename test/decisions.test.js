import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { initDB, closeDB, getDB } from '../lib/db.js';
import { observeSources, pruneEvidence } from '../lib/evidence.js';
import { saveDecision, getDecision, decisionId, decisionHistory, importDecisions, listDecisions } from '../lib/decisions.js';
import { createDecisionRouter } from '../routes/decisions.js';

const signal = 'https://example.test/advisory';
const value = extra => ({ state: 'investigate', note: 'Verify installed versions', owner: 'Endpoint', nextReview: '2026-10-12', evidence: '', evidenceBinding: [], ...extra });
const request = extra => ({ signal, decision: value(), baseRevision: 0, requestId: randomUUID(), ...extra });
beforeEach(() => initDB(':memory:'));
afterEach(() => closeDB());

test('edits append revisions atomically and reject stale browser baselines without losing either version', () => {
  const first = saveDecision(request());
  expect(first).toMatchObject({ record: { revision: 1, signal, decision: { state: 'investigate' } }, savedRevision: 1 });
  const second = saveDecision(request({ baseRevision: 1, decision: value({ state: 'affected', note: 'Exact affected build confirmed' }) }));
  expect(() => saveDecision(request({ baseRevision: 1, decision: value({ state: 'unaffected' }) }))).toThrow('newer decision');
  expect(getDecision(first.record.id).decision.state).toBe('affected');
  const history = decisionHistory(first.record.id, { limit: 1 });
  expect(history.items[0]).toMatchObject({ revision: 2, actor: { identity: 'not-recorded' }, decision: second.record.decision });
  expect(history.nextCursor).toBe(2);
  expect(decisionHistory(first.record.id, { before: history.nextCursor }).items[0].decision).toEqual(first.record.decision);
});

test('retrying an uncertain successful request is idempotent, even after another edit, and cannot reuse its ID for different content', () => {
  const initial = request();
  saveDecision(initial);
  expect(saveDecision(initial)).toMatchObject({ replayed: true, savedRevision: 1, record: { revision: 1 } });
  saveDecision(request({ baseRevision: 1, decision: value({ note: 'Later edit' }) }));
  expect(saveDecision(initial)).toMatchObject({ replayed: true, savedRevision: 1, record: { revision: 2 } });
  expect(() => saveDecision({ ...initial, decision: value({ note: 'Different request' }) })).toThrow('identifier was already used');
  expect(decisionHistory(decisionId(signal)).items).toHaveLength(2);
});

test('transaction rollback leaves the previous decision intact when revision persistence fails', () => {
  saveDecision(request());
  getDB().exec("CREATE TRIGGER fail_decision_revision BEFORE INSERT ON decision_revisions BEGIN SELECT RAISE(FAIL, 'simulated disk error'); END;");
  expect(() => saveDecision(request({ baseRevision: 1, decision: value({ note: 'Must not partly save' }) }))).toThrow('simulated disk error');
  expect(getDecision(decisionId(signal))).toMatchObject({ revision: 1, decision: { note: 'Verify installed versions' } });
});

test('bound evidence survives source pruning, further edits, backup and database restart', async () => {
  closeDB();
  const dir = mkdtempSync(join(tmpdir(), 'decision-durability-'));
  const file = join(dir, 'decisions.db'), backup = join(dir, 'backup.db');
  try {
    initDB(file);
    const [reference] = observeSources([{ title: 'Synthetic advisory', source: 'Synthetic Vendor', link: signal, description: 'Exact retained technical passage', date: '2026-10-01', retrievedAt: '2026-10-01T00:00:00Z' }], { observedAt: '2026-10-01T00:00:00Z' });
    const saved = saveDecision(request({ decision: value({ evidenceBinding: [reference] }) }));
    expect(saved.record.evidenceSnapshots[0]).toMatchObject({ passage: 'Exact retained technical passage', provenance: 'server-observation', status: 'retained' });
    pruneEvidence({ now: '2026-12-01T00:00:00Z' });
    expect(getDB().prepare('SELECT COUNT(*) AS n FROM evidence_revisions').get().n).toBe(0);
    saveDecision(request({ baseRevision: 1, decision: value({ state: 'mitigated', evidenceBinding: [reference] }) }));
    await getDB().backup(backup);
    closeDB(); initDB(backup);
    const recovered = decisionHistory(saved.record.id);
    expect(recovered.items).toHaveLength(2);
    for (const item of recovered.items) expect(item.evidenceSnapshots[0].passage).toBe('Exact retained technical passage');
    expect(getDecision(saved.record.id).decision.state).toBe('mitigated');
  } finally { closeDB(); rmSync(dir, { recursive: true, force: true }); }
});

test('imports are additive, repeat safely, preserve conflicts, and distinguish missing/imported evidence', () => {
  const ref = { sourceId: 'source-old', revisionId: 'revision-old', contentHash: 'a'.repeat(64) };
  const records = [{ signal, decision: value({ recordedAt: '2026-09-01T00:00:00Z', evidenceBinding: [ref] }) }];
  expect(importDecisions(records)).toMatchObject({ imported: 1, conflicts: 0 });
  expect(getDecision(decisionId(signal)).evidenceSnapshots[0].status).toBe('unavailable');
  expect(importDecisions(records)).toMatchObject({ unchanged: 1, imported: 0 });
  expect(importDecisions([{ ...records[0], decision: value({ state: 'affected' }) }])).toMatchObject({ conflicts: 1, imported: 0 });
  expect(decisionHistory(decisionId(signal)).items).toHaveLength(1);
  const portable = { signal: 'https://example.test/portable', decision: records[0].decision, evidenceSnapshots: [{ ...ref, status: 'retained', title: 'Imported passage', source: 'Publisher', passage: 'Copied evidence', provenance: 'server-observation' }] };
  expect(importDecisions([portable]).imported).toBe(1);
  expect(getDecision(decisionId(portable.signal)).evidenceSnapshots[0]).toMatchObject({ passage: 'Copied evidence', provenance: 'imported-copy-unverified' });
});

test('pagination exposes all records and rejects invalid pages and oversize/malformed imports', () => {
  for (const suffix of ['a', 'b', 'c']) saveDecision(request({ signal: signal + suffix }));
  const one = listDecisions({ limit: 2 });
  const two = listDecisions({ after: one.nextCursor, limit: 2 });
  expect(new Set([...one.items, ...two.items].map(item => item.id)).size).toBe(3);
  expect(two.nextCursor).toBeNull();
  expect(() => listDecisions({ limit: 201 })).toThrow('page size');
  expect(() => listDecisions({ after: 'bad' })).toThrow('cursor');
  expect(() => importDecisions(Array(26).fill({}))).toThrow('25');
  expect(importDecisions([{ signal, decision: value({ nextReview: '2026-02-30' }) }])).toMatchObject({ invalid: 1, imported: 0 });
});

test('an imported evidence copy upgrades when observed by this server and stays verified after pruning', () => {
  const item = { title: 'Synthetic advisory', source: 'Synthetic Vendor', link: signal, description: 'Observed technical passage', date: '2026-10-01', retrievedAt: '2026-10-01T00:00:00Z' };
  const [reference] = observeSources([{ ...item }], { observedAt: '2026-10-01T00:00:00Z' });
  pruneEvidence({ now: '2026-12-01T00:00:00Z' });
  importDecisions([{ signal, decision: value({ evidenceBinding: [reference] }), evidenceSnapshots: [{ ...reference,
    status: 'retained', title: item.title, source: item.source, passage: 'Unverified imported passage' }] }]);
  expect(getDecision(decisionId(signal)).evidenceSnapshots[0].provenance).toBe('imported-copy-unverified');
  const [observedAgain] = observeSources([{ ...item, retrievedAt: '2026-12-01T00:00:00Z' }], { observedAt: '2026-12-01T00:00:00Z' });
  expect(observedAgain.revisionId).toBe(reference.revisionId);
  saveDecision(request({ baseRevision: 1, decision: value({ evidenceBinding: [reference] }) }));
  pruneEvidence({ now: '2027-02-01T00:00:00Z' });
  saveDecision(request({ baseRevision: 2, decision: value({ evidenceBinding: [reference], state: 'mitigated' }) }));
  expect(getDecision(decisionId(signal)).evidenceSnapshots[0]).toMatchObject({ provenance: 'server-observation', passage: item.description });
  expect(decisionHistory(decisionId(signal)).items.at(-1).evidenceSnapshots[0]).toMatchObject({ provenance: 'imported-copy-unverified', passage: 'Unverified imported passage' });
});

test('capacity is explicit and never removes existing decisions or audit history', () => {
  const saved = saveDecision(request());
  getDB().prepare('UPDATE decisions SET revision = 1000 WHERE signal_id = ?').run(saved.record.id);
  expect(() => saveDecision(request({ baseRevision: 1000 }))).toThrow('revision limit');
  expect(getDB().prepare('SELECT COUNT(*) AS n FROM decision_revisions').get().n).toBe(1);
});

test('real router returns 409 current state and exports retained snapshots without accepting user attribution', async () => {
  const app = express(); app.use(express.json()); app.use('/api', createDecisionRouter());
  const server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const put = body => fetch(`${origin}/api/decisions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await (await put({ ...request(), actor: 'Invented user' })).json();
    const conflict = await put(request());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'E_DECISION_CONFLICT', current: { revision: 1 } });
    const exported = await fetch(`${origin}/api/decisions/export`);
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    expect(await exported.json()).toEqual([created.record]);
    const history = await (await fetch(`${origin}/api/decisions/${created.record.id}/history`)).json();
    expect(JSON.stringify(history)).not.toContain('Invented user');
    expect(history.items[0].actor.identity).toBe('not-recorded');
  } finally { await new Promise(done => server.close(done)); }
});

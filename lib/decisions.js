// One operator/server, no user identity inference. SQLite backup includes both
// current decisions and immutable edits/evidence; rolling source pruning does not.
import { createHash } from 'node:crypto';
import { getDB } from './db.js';
import { getSourceEvidence } from './evidence.js';
import { recordStorageOutcome } from './storage-health.js';

export const DECISION_LIMITS = Object.freeze({ records: 20_000, revisions: 1000, importRecords: 25, importBytes: 4_000_000, evidenceBindings: 100 });
const states = new Set(['unreviewed', 'investigate', 'affected', 'unaffected', 'mitigated']);
const digest = text => createHash('sha256').update(text).digest('hex');
const problem = (message, code = 'E_DECISION_INPUT', status = 400, details = {}) => Object.assign(new Error(message), { code, status, ...details });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, field, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) throw problem(`Invalid ${field}.`);
  return value.trim();
}
function signalKey(value) {
  const signal = text(value, 8192, 'signal');
  if (!signal) throw problem('A signal key is required.');
  return signal;
}
export const decisionId = signal => digest(signalKey(signal));
function recordInput(value) {
  if (!object(value) || !states.has(value.state)) throw problem('Invalid decision assessment.');
  const nextReview = text(value.nextReview, 10, 'review date');
  if (nextReview && (!/^\d{4}-\d{2}-\d{2}$/.test(nextReview) || !Number.isFinite(Date.parse(nextReview)) || new Date(nextReview).toISOString().slice(0, 10) !== nextReview)) throw problem('Invalid review date.');
  const refs = value.evidenceBinding ?? [];
  if (!Array.isArray(refs) || refs.length > DECISION_LIMITS.evidenceBindings) throw problem('Too many or invalid evidence references.');
  const evidenceBinding = [...new Map(refs.map(ref => {
    if (!object(ref)) throw problem('Invalid evidence reference.');
    const sourceId = text(ref.sourceId, 128, 'source reference'), revisionId = text(ref.revisionId, 128, 'revision reference');
    if (!sourceId || !revisionId || !/^[\w-]+$/.test(sourceId) || !/^[\w-]+$/.test(revisionId)) throw problem('Invalid evidence reference.');
    const contentHash = text(ref.contentHash, 64, 'content hash').toLowerCase();
    if (contentHash && !/^[a-f\d]{64}$/.test(contentHash)) throw problem('Invalid evidence content hash.');
    return [`${sourceId}:${revisionId}`, { sourceId, revisionId, ...(contentHash ? { contentHash } : {}) }];
  })).values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.revisionId.localeCompare(b.revisionId));
  const recordedAt = text(value.recordedAt, 40, 'recorded time');
  if (recordedAt && !Number.isFinite(Date.parse(recordedAt))) throw problem('Invalid recorded time.');
  return { state: value.state, owner: text(value.owner, 100, 'owner'), nextReview,
    note: text(value.note, 2000, 'basis'), evidence: text(value.evidence, 6000, 'evidence'), recordedAt, evidenceBinding };
}
const payloadKey = value => JSON.stringify({ ...value, recordedAt: '' });
const rowRecord = row => row ? { id: row.signal_id, signal: row.signal_key, revision: row.revision,
  createdAt: row.created_at, updatedAt: row.updated_at, decision: JSON.parse(row.decision_json) } : null;
const byId = id => getDB().prepare('SELECT * FROM decisions WHERE signal_id = ?').get(id);
function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|credential|signature|api[-_]?key|authorization/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    return url.href;
  } catch { return ''; }
}
function snapshot(ref, source, provenance) {
  return { ...ref, status: 'retained', provenance,
    title: text(source.title, 4096, 'snapshot title'), source: text(source.source, 128, 'snapshot source'),
    canonicalUrl: safeUrl(source.canonicalUrl), passage: text(source.passage, 8192, 'snapshot passage'),
    passageKind: text(source.passageKind, 64, 'snapshot passage kind'), passageTruncated: source.passageTruncated === true,
    publishedAt: text(source.publishedAt ?? '', 256, 'source publication date'),
    retrievedAt: text(source.retrievedAt ?? '', 256, 'source retrieval date'),
  };
}
function captureEvidence(signalId, refs, supplied = []) {
  if (!Array.isArray(supplied) || supplied.length > DECISION_LIMITS.evidenceBindings) throw problem('Invalid imported evidence copies.');
  const database = getDB();
  // Indexed copies outlive rolling evidence. A missing ref must never parse
  // hundreds of unrelated historic revision payloads to reconstruct its basis.
  const previousExact = database.prepare('SELECT snapshot_json FROM decision_evidence WHERE signal_id = ? AND source_id = ? AND revision_id = ? AND content_hash = ?');
  const previousRevision = database.prepare('SELECT snapshot_json FROM decision_evidence WHERE signal_id = ? AND source_id = ? AND revision_id = ? ORDER BY rowid DESC LIMIT 1');
  const sources = new Map();
  return refs.map(ref => {
    if (!sources.has(ref.sourceId)) sources.set(ref.sourceId, getSourceEvidence(ref.sourceId));
    const source = sources.get(ref.sourceId)?.revisions.find(item => item.revisionId === ref.revisionId);
    const storedHash = source && database.prepare('SELECT content_hash FROM evidence_revisions WHERE revision_id = ? AND source_id = ?').get(ref.revisionId, ref.sourceId)?.content_hash;
    if (source && (!ref.contentHash || ref.contentHash === storedHash)) return snapshot({ ...ref, contentHash: storedHash }, source, 'server-observation');
    const prior = ref.contentHash ? previousExact.get(signalId, ref.sourceId, ref.revisionId, ref.contentHash) : previousRevision.get(signalId, ref.sourceId, ref.revisionId);
    if (prior) return JSON.parse(prior.snapshot_json);
    const imported = supplied.find(item => object(item) && item.sourceId === ref.sourceId && item.revisionId === ref.revisionId && item.status === 'retained'
      && (!ref.contentHash || item.contentHash === ref.contentHash));
    if (imported) return snapshot(ref, imported, 'imported-copy-unverified');
    return { ...ref, status: 'unavailable', reason: source ? 'Content hash does not match the retained observation.' : 'The bound source revision is no longer available on this server.' };
  });
}

export function getDecision(id, { evidence = true } = {}) {
  const record = rowRecord(byId(id));
  if (record && evidence) record.evidenceSnapshots = JSON.parse(getDB().prepare('SELECT evidence_json FROM decision_revisions WHERE signal_id = ? AND revision = ?').get(id, record.revision).evidence_json);
  return record;
}
export function listDecisions({ after = '', limit = 100 } = {}) {
  if (after && !/^[a-f\d]{64}$/.test(after)) throw problem('Invalid decision cursor.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw problem('Decision page size must be between 1 and 200.');
  const rows = getDB().prepare('SELECT * FROM decisions WHERE signal_id > ? ORDER BY signal_id LIMIT ?').all(after, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowRecord);
  return { items, nextCursor: more ? items.at(-1).id : null, total: getDB().prepare('SELECT COUNT(*) AS n FROM decisions').get().n, limits: DECISION_LIMITS };
}
export function lookupDecisions(signals) {
  if (!Array.isArray(signals) || signals.length > 100) throw problem('Lookup accepts at most 100 signals.');
  return { items: [...new Set(signals.map(signalKey))].map(signal => getDecision(decisionId(signal), { evidence: false })).filter(Boolean) };
}
export function decisionHistory(id, { before = 0, limit = 10 } = {}) {
  if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw problem('Invalid history pagination.');
  const record = getDecision(id, { evidence: false });
  if (!record) throw problem('Decision not found.', 'E_DECISION_NOT_FOUND', 404);
  const rows = getDB().prepare('SELECT * FROM decision_revisions WHERE signal_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?').all(id, before || Number.MAX_SAFE_INTEGER, limit + 1);
  return { signal: record.signal, total: record.revision, items: rows.slice(0, limit).map(row => ({ revision: row.revision, operation: row.operation,
    savedAt: row.saved_at, actor: { kind: 'shared-server-operator', identity: 'not-recorded' },
    decision: JSON.parse(row.decision_json), evidenceSnapshots: JSON.parse(row.evidence_json) })),
    nextCursor: rows.length > limit ? rows[limit - 1].revision : null };
}
export function* exportDecisions() {
  // A read transaction would hold the WAL open across a slow network client.
  // Read one stable ID at a time; each exported record is a committed revision.
  let after = '';
  while (true) {
    const rows = getDB().prepare('SELECT signal_id FROM decisions WHERE signal_id > ? ORDER BY signal_id LIMIT 100').all(after);
    if (!rows.length) return;
    for (const row of rows) { after = row.signal_id; yield getDecision(after); }
  }
}
function insertRevision({ signal, decision, baseRevision, requestId, operation, snapshots = [], now = new Date().toISOString() }) {
  const database = getDB(), id = decisionId(signal);
  const current = byId(id);
  const requestHash = digest(JSON.stringify([baseRevision, decision, operation]));
  const replay = database.prepare('SELECT revision, request_hash FROM decision_revisions WHERE signal_id = ? AND request_id = ?').get(id, requestId);
  if (replay) {
    if (replay.request_hash !== requestHash) throw problem('This save identifier was already used for different content.', 'E_DECISION_REQUEST_REUSE', 409, { current: getDecision(id) });
    return { record: getDecision(id), replayed: true, savedRevision: replay.revision };
  }
  if ((current?.revision || 0) !== baseRevision) throw problem('A newer decision exists. Your draft has not replaced it.', 'E_DECISION_CONFLICT', 409, { current: getDecision(id) });
  if (!current && database.prepare('SELECT COUNT(*) AS n FROM decisions').get().n >= DECISION_LIMITS.records) throw problem('The server decision limit is reached. Export your draft; no record was removed.', 'E_DECISION_LIMIT', 409);
  if (baseRevision >= DECISION_LIMITS.revisions) throw problem('This decision reached its revision limit. Export your draft; its history is retained.', 'E_DECISION_LIMIT', 409);
  const evidenceSnapshots = captureEvidence(id, decision.evidenceBinding, snapshots);
  const revision = baseRevision + 1;
  const stored = { ...decision, recordedAt: operation === 'import' && decision.recordedAt ? decision.recordedAt : now };
  database.prepare(`INSERT INTO decisions(signal_id,signal_key,revision,decision_json,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(signal_id) DO UPDATE SET revision=excluded.revision, decision_json=excluded.decision_json, updated_at=excluded.updated_at`)
    .run(id, signal, revision, JSON.stringify(stored), now, now);
  database.prepare(`INSERT INTO decision_revisions(signal_id,revision,decision_json,evidence_json,operation,saved_at,request_id,request_hash) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, revision, JSON.stringify(stored), JSON.stringify(evidenceSnapshots), operation, now, requestId, requestHash);
  const retain = database.prepare(`INSERT INTO decision_evidence(signal_id,source_id,revision_id,content_hash,snapshot_json) VALUES (?,?,?,?,?)
    ON CONFLICT(signal_id,source_id,revision_id,content_hash) DO UPDATE SET snapshot_json=excluded.snapshot_json
    WHERE json_extract(decision_evidence.snapshot_json, '$.provenance') = 'imported-copy-unverified'
      AND json_extract(excluded.snapshot_json, '$.provenance') = 'server-observation'`);
  for (const evidence of evidenceSnapshots) if (evidence.status === 'retained') retain.run(id, evidence.sourceId, evidence.revisionId, evidence.contentHash || '', JSON.stringify(evidence));
  return { record: getDecision(id), replayed: false, savedRevision: revision };
}
function durable(work) {
  try { const result = getDB().transaction(work)(); recordStorageOutcome('decisions'); return result; }
  catch (error) { if (!error.status || error.status >= 500) recordStorageOutcome('decisions', error); throw error; }
}
export function saveDecision(input) {
  if (!object(input)) throw problem('Invalid decision request.');
  const signal = signalKey(input.signal), decision = recordInput(input.decision);
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw problem('A base revision is required.');
  const requestId = text(input.requestId, 128, 'save identifier');
  if (!/^[\w-]{16,128}$/.test(requestId)) throw problem('A unique save identifier is required.');
  return durable(() => insertRevision({ signal, decision, baseRevision: input.baseRevision, requestId, operation: 'save' }));
}
export function importDecisions(records) {
  if (!Array.isArray(records) || records.length > DECISION_LIMITS.importRecords || Buffer.byteLength(JSON.stringify(records)) > DECISION_LIMITS.importBytes) throw problem('Import at most 25 records and 4 MB per request.');
  // Each valid row commits independently; malformed rows are reported explicitly.
  const results = [];
  for (let index = 0; index < records.length; index++) {
    try {
      const source = records[index];
      if (!object(source)) throw problem('Invalid import record.');
      const signal = signalKey(source.signal), decision = recordInput(source.decision), id = decisionId(signal);
      results.push(durable(() => {
        const existing = getDecision(id);
        if (existing) return { index, signal, status: payloadKey(existing.decision) === payloadKey(decision) ? 'unchanged' : 'conflict', current: existing };
        const saved = insertRevision({ signal, decision, baseRevision: 0, requestId: `import-${digest(JSON.stringify(decision))}`, operation: 'import', snapshots: source.evidenceSnapshots });
        return { index, signal, status: 'imported', current: saved.record };
      }));
    } catch (error) {
      if (!error.status) throw error;
      results.push({ index, signal: typeof records[index]?.signal === 'string' ? records[index].signal : '', status: error.code === 'E_DECISION_LIMIT' ? 'limit' : 'invalid', error: error.message });
    }
  }
  return { results, imported: results.filter(item => item.status === 'imported').length, unchanged: results.filter(item => item.status === 'unchanged').length,
    conflicts: results.filter(item => item.status === 'conflict').length, invalid: results.filter(item => ['invalid', 'limit'].includes(item.status)).length };
}

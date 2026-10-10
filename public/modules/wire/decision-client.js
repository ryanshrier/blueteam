import { normalizeDecision, readDecisions } from './wire-workspace.js';

export const DECISION_CACHE_KEY = 'wire.server-decisions.v1';
export const DECISION_DRAFT_KEY = 'wire.decision-drafts.v1';
export const DECISION_CHANGED_KEY = 'wire.decisions.changed';
export const decisionRecord = record => ({ ...normalizeDecision(record.decision), revision: record.revision, serverId: record.id, updatedAt: record.updatedAt });
export const newDecisionRequestId = () => globalThis.crypto?.randomUUID?.() || `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function readDecisionDrafts(storage) {
  try {
    const entries = Object.entries(JSON.parse(storage?.getItem(DECISION_DRAFT_KEY) || '{}'));
    return new Map(entries.filter(([key, draft]) => key && draft && typeof draft.values === 'object' && !Array.isArray(draft.values)));
  } catch { return new Map(); }
}
export function persistDecisionDrafts(storage, drafts) {
  try { storage.setItem(DECISION_DRAFT_KEY, JSON.stringify(Object.fromEntries(drafts))); return true; } catch { return false; }
}

export function createDecisionClient({ storage, fetchImpl = (...args) => fetch(...args) } = {}) {
  const records = new Map();
  let mutation = 0;
  let phase = 'loading';
  try {
    const cached = JSON.parse(storage?.getItem(DECISION_CACHE_KEY) || '[]');
    if (Array.isArray(cached)) for (const record of cached) {
      if (typeof record?.signal === 'string' && Number.isSafeInteger(record.revision) && record.revision > 0 && record.decision) records.set(record.signal, record);
    }
  } catch { /* a damaged read cache cannot remove the server's decisions */ }
  const cache = () => {
    try { storage?.setItem(DECISION_CACHE_KEY, JSON.stringify([...records.values()].slice(-2000).map(({ evidenceSnapshots, ...record }) => record))); } catch { /* reconstructible read cache */ }
  };
  const notify = () => {
    try { storage?.setItem(DECISION_CHANGED_KEY, newDecisionRequestId()); } catch { /* polling still refreshes other tabs */ }
  };
  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`/api/decisions${path}`, { method, cache: 'no-store', signal: AbortSignal.timeout(15_000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Decision request failed (${response.status}).`), { status: response.status, code: data.code, current: data.current });
    return data;
  }
  function values() {
    // Old browser records remain independently recoverable; they are never
    // overwritten by the cache or erased after a successful server import.
    const combined = new Map([...readDecisions(storage)].map(([key, value]) => [key, { ...value, localOnly: true, revision: 0 }]));
    for (const [key, record] of records) combined.set(key, decisionRecord(record));
    return combined;
  }
  async function lookup(signals) {
    const requested = [...new Set(signals.filter(key => typeof key === 'string' && key))];
    const started = mutation;
    try {
      if (!requested.length) await request('/lookup', { method: 'POST', body: { signals: [] } });
      for (let index = 0; index < requested.length; index += 10) {
        const batch = requested.slice(index, index + 10);
        const data = await request('/lookup', { method: 'POST', body: { signals: batch } });
        if (!Array.isArray(data.items)) throw new Error('Malformed decision response.');
        const received = new Map(data.items.map(record => [record.signal, record]));
        for (const key of batch) {
          const record = received.get(key), existing = records.get(key);
          if (mutation !== started && (existing?.revision || 0) > (record?.revision || 0)) continue;
          if (record) records.set(key, record); else records.delete(key);
        }
      }
      phase = 'ready'; cache(); return values();
    } catch (error) { phase = 'offline'; throw error; }
  }
  async function save(signal, decision, baseRevision, requestId) {
    try {
      const result = await request('', { method: 'PUT', body: { signal, decision, baseRevision, requestId } });
      if (!result.record?.revision) throw new Error('The save could not be confirmed. Retry to check the same save.');
      mutation++; records.set(signal, result.record); phase = 'ready'; cache(); notify();
      return result;
    } catch (error) {
      if (error.current) { mutation++; records.set(signal, error.current); cache(); }
      if (!error.status || error.status >= 500) phase = 'offline';
      throw error;
    }
  }
  async function importRecords(input) {
    if (!Array.isArray(input)) throw new Error('Expected a JSON array of exported decisions.');
    const results = [];
    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const offset = results.length;
      const data = await request('/import', { method: 'POST', body: { records: batch } });
      for (const result of data.results || []) {
        results.push({ ...result, index: offset + result.index, importedRecord: batch[result.index] });
        if (result.current) records.set(result.signal, result.current);
      }
      mutation++; cache(); notify(); batch = []; bytes = 0;
    };
    for (const record of input) {
      const size = new TextEncoder().encode(JSON.stringify(record)).length;
      if (size > 4_000_000) throw new Error('A decision exceeds the 4 MB import limit; the remaining records were not sent.');
      if (batch.length >= 25 || bytes + size > 3_900_000) await flush();
      batch.push(record); bytes += size;
    }
    await flush(); phase = 'ready';
    return { results, imported: results.filter(item => item.status === 'imported').length,
      unchanged: results.filter(item => item.status === 'unchanged').length, conflicts: results.filter(item => item.status === 'conflict').length,
      invalid: results.filter(item => ['invalid', 'limit'].includes(item.status)).length };
  }
  return { lookup, save, importRecords, values, get phase() { return phase; },
    list: (after = '') => request(`?limit=100&after=${encodeURIComponent(after)}`),
    history: (id, before = 0) => request(`/${encodeURIComponent(id)}/history?before=${before}`),
    legacyRecords: () => [...readDecisions(storage)].map(([signal, decision]) => ({ signal, decision })) };
}

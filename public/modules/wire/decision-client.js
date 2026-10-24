import { normalizeDecision, readDecisions } from './wire-workspace.js';

export const DECISION_CACHE_KEY = 'wire.server-decisions.v1';
export const DECISION_DRAFT_KEY = 'wire.decision-drafts.v1';
export const DECISION_CHANGED_KEY = 'wire.decisions.changed';
export const decisionRecord = record => ({ ...normalizeDecision(record.decision), revision: record.revision, serverId: record.id, updatedAt: record.updatedAt });
export const newDecisionRequestId = () => globalThis.crypto?.randomUUID?.() || `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const metadataForTests = new WeakMap();
export const decisionClientMetadataForTests = client => metadataForTests.get(client)?.();

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
  const issued = new Map(), observed = new Map();
  const operations = new Map(), inFlight = new Map();
  const responseGenerations = new WeakMap();
  let sequence = 0, phaseSequence = 0;
  let serverEpoch = '', epochGeneration = 0, epochRequest = 0, requestSequence = 0;
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
  const begin = signals => {
    const operation = ++sequence;
    const keys = new Set(signals.filter(signal => typeof signal === 'string' && signal));
    operations.set(operation, keys);
    for (const signal of keys) {
      issued.set(signal, operation);
      if (!inFlight.has(signal)) inFlight.set(signal, new Set());
      inFlight.get(signal).add(operation);
    }
    return operation;
  };
  const settle = operation => {
    for (const signal of operations.get(operation) || []) {
      const active = inFlight.get(signal);
      active?.delete(operation);
      if (!active?.size) {
        inFlight.delete(signal); issued.delete(signal);
        // Tombstones are only needed while an older request can resurrect a
        // missing record. Rotating feed URLs must not accumulate absent keys.
        if (!records.has(signal)) observed.delete(signal);
      }
    }
    operations.delete(operation);
  };
  const setPhase = (value, operation) => {
    // A slow older failure cannot make a newer successful read look offline.
    if (operation >= phaseSequence) { phase = value; phaseSequence = operation; }
  };
  const epochChanged = () => Object.assign(new Error('The decision server restarted. Check its latest saved decision before retrying; your draft is retained.'),
    { code: 'E_DECISION_EPOCH_CHANGED', staleResponse: true });
  const acceptEpoch = (candidate, ticket) => {
    if (!candidate) return !serverEpoch;
    if (candidate === serverEpoch) return true;
    // A request issued before learning about a restart may finish after a
    // newer request, even with a higher request number. Its captured generation
    // prevents it from switching this client back to the retired server.
    if (ticket.generation !== epochGeneration || ticket.number < epochRequest) return false;
    // Initial binding also retires concurrently issued unbound requests; an
    // old server must not become authoritative merely by replying last.
    epochGeneration++;
    phaseSequence = 0;
    records.clear(); observed.clear(); issued.clear();
    cache();
    serverEpoch = candidate; epochRequest = ticket.number;
    return true;
  };
  const checkResponse = value => {
    const generation = value && typeof value === 'object' ? responseGenerations.get(value) : undefined;
    if (generation !== undefined && generation !== epochGeneration) throw epochChanged();
    return value;
  };
  const rememberResponse = value => { responseGenerations.set(value, epochGeneration); return value; };
  const identity = record => JSON.stringify([record.id, record.createdAt || null]);
  function merge(signal, record, operation) {
    const existing = records.get(signal), previous = observed.get(signal);
    if (!record) {
      // Absence has no revision. Only the newest issued lookup may remove a
      // cached record, and its tombstone must also reject older late responses.
      if (operation < (issued.get(signal) || 0) || operation < (previous?.operation || 0)) return existing;
      records.delete(signal); observed.set(signal, { operation, absent: true });
      return undefined;
    }
    if (record.signal !== signal || typeof record.id !== 'string' || !record.id
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !record.decision || typeof record.decision !== 'object' || Array.isArray(record.decision)) {
      throw new Error('Malformed decision response.');
    }
    const sameHistory = existing && identity(existing) === identity(record);
    // A first live response revalidates disk cache after a server restore. A
    // changed record ID/creation time is also a new history, not a revision
    // regression. Older requests cannot switch back to the prior identity.
    if (((!previous && existing) || (previous && !sameHistory)) && operation < (issued.get(signal) || 0)) return existing;
    if (operation < (previous?.operation || 0) && (!sameHistory || previous.absent)) return existing;
    if (sameHistory && previous && record.revision < existing.revision) return existing;
    if (sameHistory && previous && record.revision === existing.revision && operation < previous.operation) return existing;
    records.set(signal, record);
    observed.set(signal, { operation: Math.max(operation, previous?.operation || 0), absent: false });
    return record;
  }
  async function request(path, { method = 'GET', body } = {}) {
    const ticket = { number: ++requestSequence, generation: epochGeneration };
    let response, data;
    try {
      response = await fetchImpl(`/api/decisions${path}`, { method, cache: 'no-store', signal: AbortSignal.timeout(15_000),
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const parsed = await response.json().catch(() => ({}));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (ticket.generation !== epochGeneration) throw epochChanged();
      throw rememberResponse(error && typeof error === 'object' ? error : new Error(String(error)));
    }
    const candidate = typeof data.serverEpoch === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.serverEpoch) ? data.serverEpoch : '';
    const accepted = acceptEpoch(candidate, ticket);
    if (!accepted) {
      // Authentication/proxy failures may occur before the decision router can
      // stamp its epoch. They cannot authorize records, but retain their useful
      // status/message when this request belongs to the current generation.
      if (!response.ok && !candidate && !data.current && ticket.generation === epochGeneration) {
        throw rememberResponse(Object.assign(new Error(data.error || `Decision request failed (${response.status}).`), { status: response.status, code: data.code }));
      }
      throw epochChanged();
    }
    if (!response.ok) throw rememberResponse(Object.assign(new Error(data.error || `Decision request failed (${response.status}).`), { status: response.status, code: data.code, current: data.current }));
    return rememberResponse(data);
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
    const operation = begin(requested);
    let generation = epochGeneration, restarted = false;
    try {
      if (!requested.length) checkResponse(await request('/lookup', { method: 'POST', body: { signals: [] } }));
      for (let index = 0; index < requested.length; index += 10) {
        const batch = requested.slice(index, index + 10);
        const data = checkResponse(await request('/lookup', { method: 'POST', body: { signals: batch } }));
        if (generation !== epochGeneration) {
          generation = epochGeneration;
          // Re-fetch earlier batches from the restored server, rather than
          // announcing a ready lookup whose first batch belongs to old history.
          if (index > 0) {
            if (restarted) throw epochChanged();
            restarted = true; index = -10; continue;
          }
        }
        if (!Array.isArray(data.items)) throw new Error('Malformed decision response.');
        const received = new Map(data.items.map(record => [record.signal, record]));
        for (const key of batch) {
          merge(key, received.get(key), operation);
        }
        cache();
      }
      setPhase('ready', operation); cache(); return values();
    } catch (error) { checkResponse(error); if (!error.staleResponse) setPhase('offline', operation); throw error; }
    finally { settle(operation); }
  }
  async function save(signal, decision, baseRevision, requestId) {
    const operation = begin([signal]);
    try {
      const result = checkResponse(await request('', { method: 'PUT', body: { signal, decision, baseRevision, requestId } }));
      if (!result.record?.revision) throw new Error('The save could not be confirmed. Retry to check the same save.');
      const current = merge(signal, result.record, operation);
      setPhase('ready', operation); cache(); notify();
      return { ...result, record: current || result.record };
    } catch (error) {
      checkResponse(error);
      if (error.current) { error.current = merge(signal, error.current, operation); cache(); setPhase('ready', operation); }
      if (!error.staleResponse && (!error.status || error.status >= 500)) setPhase('offline', operation);
      throw error;
    } finally { settle(operation); }
  }
  async function importRecords(input) {
    if (!Array.isArray(input)) throw new Error('Expected a JSON array of exported decisions.');
    const operation = begin(input.map(record => record?.signal));
    const results = [];
    let resultsGeneration = epochGeneration;
    const checkImportGeneration = () => { if (results.length && resultsGeneration !== epochGeneration) throw epochChanged(); };
    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      checkImportGeneration();
      const offset = results.length;
      const data = await request('/import', { method: 'POST', body: { records: batch } }).catch(error => {
        checkResponse(error);
        if (!error.staleResponse && (!error.status || error.status >= 500)) setPhase('offline', operation);
        throw error;
      });
      checkResponse(data);
      // A multi-batch import must not report old-server acknowledgements as
      // successful writes in the restored history. The input remains available
      // for an explicit, idempotent retry against the current server.
      if (results.length && resultsGeneration !== epochGeneration) throw epochChanged();
      resultsGeneration = epochGeneration;
      for (const result of data.results || []) {
        if (result.current) result.current = merge(result.signal, result.current, operation);
        results.push({ ...result, index: offset + result.index, importedRecord: batch[result.index] });
      }
      cache(); notify(); batch = []; bytes = 0;
    };
    try {
      for (const record of input) {
        const size = new TextEncoder().encode(JSON.stringify(record)).length;
        if (size > 4_000_000) throw new Error('A decision exceeds the 4 MB import limit; the remaining records were not sent.');
        if (batch.length >= 25 || bytes + size > 3_900_000) { await flush(); checkImportGeneration(); }
        batch.push(record); bytes += size;
      }
      await flush(); checkImportGeneration(); setPhase('ready', operation);
      return { results, imported: results.filter(item => item.status === 'imported').length,
        unchanged: results.filter(item => item.status === 'unchanged').length, conflicts: results.filter(item => item.status === 'conflict').length,
        invalid: results.filter(item => ['invalid', 'limit'].includes(item.status)).length };
    } finally { settle(operation); }
  }
  const client = { lookup, save, importRecords, values, get phase() { return phase; },
    list: async (after = '') => checkResponse(await request(`?limit=100&after=${encodeURIComponent(after)}`)),
    history: async (id, before = 0) => checkResponse(await request(`/${encodeURIComponent(id)}/history?before=${before}`)),
    legacyRecords: () => [...readDecisions(storage)].map(([signal, decision]) => ({ signal, decision })) };
  metadataForTests.set(client, () => ({ issued: issued.size, observed: observed.size,
    operations: operations.size, inFlightSignals: inFlight.size, records: records.size }));
  return client;
}

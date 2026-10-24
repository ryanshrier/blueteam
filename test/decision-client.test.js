import { expect, jest, test } from '@jest/globals';
import { createDecisionClient, readDecisionDrafts, persistDecisionDrafts, DECISION_CACHE_KEY, decisionClientMetadataForTests } from '../public/modules/wire/decision-client.js';

const storage = () => { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) }; };
const record = (revision = 1, note = 'Saved') => ({ id: 'a'.repeat(64), signal: 'signal', revision, decision: { state: 'investigate', note }, updatedAt: '2026-10-09T00:00:00Z' });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const oldEpoch = '11111111-1111-4111-8111-111111111111';
const restoredEpoch = '22222222-2222-4222-8222-222222222222';
const inEpoch = (body, serverEpoch = oldEpoch, status = 200) => reply({ ...body, serverEpoch }, status);

test('the first bound epoch fences a concurrently issued higher-ticket reply from another server', async () => {
  const fresh = deferred(), old = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn().mockReturnValueOnce(fresh.promise).mockReturnValueOnce(old.promise) });
  const current = client.lookup(['signal']);
  const stale = client.lookup(['signal']).then(value => value, error => error);
  fresh.resolve(inEpoch({ items: [record(2, 'Restored baseline')] }, restoredEpoch)); await current;
  old.resolve(inEpoch({ items: [record(3, 'Retired server')] }));
  expect(await stale).toMatchObject({ code: 'E_DECISION_EPOCH_CHANGED' });
  expect(client.values().get('signal')).toMatchObject({ revision: 2, note: 'Restored baseline' });
  expect(client.phase).toBe('ready');
});

test('initial epoch binding invalidates cached revisions and old issued-order metadata together', async () => {
  const fresh = deferred(), old = deferred(), saved = storage();
  saved.setItem(DECISION_CACHE_KEY, JSON.stringify([record(7), { ...record(8), signal: 'offscreen' }]));
  const client = createDecisionClient({ storage: saved, fetchImpl: jest.fn().mockReturnValueOnce(fresh.promise).mockReturnValueOnce(old.promise) });
  const current = client.lookup(['signal']), stale = client.lookup(['signal']).catch(error => error);
  fresh.resolve(inEpoch({ items: [record(2)] }, restoredEpoch)); await current;
  old.resolve(inEpoch({ items: [record(3)] })); await stale;
  expect(client.values().get('signal').revision).toBe(2);
  expect(client.values().has('offscreen')).toBe(false);
  expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))).toHaveLength(1);
});

test.each(['lookup', 'save', 'conflict', 'import'])('a same-turn %s continuation rechecks its epoch before merging or acknowledging', async method => {
  const old = deferred(), fresh = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] })).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
  await client.lookup(['signal']);
  const stale = (method === 'save' || method === 'conflict' ? client.save('signal', {}, 3, 'in-flight')
    : method === 'import' ? client.importRecords([{ signal: 'signal', decision: {} }]) : client.lookup(['signal']))
    .then(value => value, error => error);
  const current = client.lookup(['signal']);
  // Both fetches and JSON bodies complete in the same turn. The old request
  // accepts its epoch before the new one, but its caller resumes after reset.
  old.resolve(method === 'save' ? inEpoch({ record: record(4), savedRevision: 4 })
    : method === 'conflict' ? inEpoch({ code: 'E_DECISION_CONFLICT', current: record(4) }, oldEpoch, 409)
      : method === 'import' ? inEpoch({ results: [{ index: 0, signal: 'signal', status: 'imported', current: record(4) }] })
        : inEpoch({ items: [record(3)] }));
  fresh.resolve(inEpoch({ items: [record(2, 'Restored baseline')] }, restoredEpoch));
  await current;
  expect(await stale).toMatchObject({ code: 'E_DECISION_EPOCH_CHANGED' });
  expect(client.values().get('signal')).toMatchObject({ revision: 2, note: 'Restored baseline' });
  expect(client.phase).toBe('ready');
});

test.each([null, false, 42, 'invalid', []])('an old malformed JSON response %j cannot downgrade a same-turn restored success', async body => {
  const fresh = deferred(), old = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] })).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(old.promise) });
  await client.lookup(['signal']);
  const current = client.lookup(['signal']), stale = client.lookup(['signal']).catch(error => error);
  old.resolve(reply(body));
  fresh.resolve(inEpoch({ items: [record(2)] }, restoredEpoch));
  await current; await stale;
  expect(client.values().get('signal').revision).toBe(2);
  expect(client.phase).toBe('ready');
});

test.each([401, 429, 413, 500])('an epoch-less HTTP%s failure before the router preserves its genuine status', async status => {
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] }))
    .mockResolvedValueOnce(reply({ error: 'Request rejected before decision routing', code: 'E_UPSTREAM' }, status)) });
  await client.lookup(['signal']);
  await expect(client.lookup(['signal'])).rejects.toMatchObject({ status, code: 'E_UPSTREAM', message: 'Request rejected before decision routing' });
  expect(client.values().get('signal').revision).toBe(3);
  expect(client.phase).toBe('offline');
});

test('epoch-less success cannot overwrite records after a server epoch is known', async () => {
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(2)] }, restoredEpoch))
    .mockResolvedValueOnce(reply({ items: [record(9)] })) });
  await client.lookup(['signal']);
  await expect(client.lookup(['signal'])).rejects.toMatchObject({ code: 'E_DECISION_EPOCH_CHANGED' });
  expect(client.values().get('signal').revision).toBe(2);
  expect(client.phase).toBe('ready');
});

test('an absent restored decision fences every outstanding old history without retaining metadata', async () => {
  const fresh = deferred(), old = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] })).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(old.promise) });
  await client.lookup(['signal']);
  const current = client.lookup(['signal']), stale = client.lookup(['signal']).catch(error => error);
  fresh.resolve(inEpoch({ items: [] }, restoredEpoch)); await current;
  old.resolve(inEpoch({ items: [record(4)] })); await stale;
  expect(client.values().has('signal')).toBe(false);
  expect(decisionClientMetadataForTests(client)).toEqual({ records: 0, issued: 0, observed: 0, operations: 0, inFlightSignals: 0 });
});

test('an open client revalidates restored revisions and saves again without losing unsaved draft bytes', async () => {
  const saved = storage(), tab = storage();
  const draft = { values: { note: 'Unsaved operator assessment' }, base: { revision: 3 }, request: { id: 'uncertain' } };
  persistDecisionDrafts(tab, new Map([['signal', draft]]));
  const bytes = tab.getItem('wire.decision-drafts.v1');
  const client = createDecisionClient({ storage: saved, fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3, 'Before restore')] }))
    .mockResolvedValueOnce(inEpoch({ items: [record(2, 'Restored state')] }, restoredEpoch))
    .mockResolvedValueOnce(inEpoch({ record: record(3, draft.values.note), savedRevision: 3 }, restoredEpoch)) });
  await client.lookup(['signal']);
  await client.lookup(['signal']);
  expect(client.values().get('signal')).toMatchObject({ revision: 2, note: 'Restored state' });
  expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))[0].revision).toBe(2);
  const result = await client.save('signal', draft.values, 2, 'fresh-request');
  expect(result.record).toMatchObject({ revision: 3, decision: { note: draft.values.note } });
  expect(tab.getItem('wire.decision-drafts.v1')).toBe(bytes);
});

test('a conflict can first reveal restoration and retains its authoritative lower baseline', async () => {
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] }))
    .mockResolvedValueOnce(inEpoch({ code: 'E_DECISION_CONFLICT', current: record(2, 'Restored baseline') }, restoredEpoch, 409))
    .mockResolvedValueOnce(inEpoch({ record: record(3, 'Merged assessment'), savedRevision: 3 }, restoredEpoch)) });
  await client.lookup(['signal']);
  await expect(client.save('signal', {}, 3, 'old-baseline')).rejects.toMatchObject({ current: { revision: 2 }, code: 'E_DECISION_CONFLICT' });
  expect(client.values().get('signal')).toMatchObject({ revision: 2, note: 'Restored baseline' });
  expect(client.phase).toBe('ready');
  expect((await client.save('signal', {}, 2, 'rebased-request')).record.revision).toBe(3);
});

test.each(['lookup', 'absence', 'save', 'conflict', 'import', 'failure'])('late old-epoch %s cannot reverse a restart observed by an earlier-numbered request', async method => {
  const fresh = deferred(), old = deferred(), saved = storage();
  const client = createDecisionClient({ storage: saved, fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] }))
    .mockReturnValueOnce(fresh.promise).mockReturnValueOnce(old.promise) });
  await client.lookup(['signal']);
  const current = client.lookup(['signal']);
  // This request number is greater than the one that will reveal restoration,
  // but it was dispatched while the client still observed the old epoch.
  const stale = (method === 'save' || method === 'conflict' ? client.save('signal', {}, 3, 'in-flight-request')
    : method === 'import' ? client.importRecords([{ signal: 'signal', decision: {} }]) : client.lookup(['signal']))
    .then(value => value, error => error);
  fresh.resolve(inEpoch({ items: [record(2, 'Restored baseline')] }, restoredEpoch)); await current;
  if (method === 'failure') old.reject(new Error('Old connection reset'));
  else old.resolve(method === 'save' ? inEpoch({ record: record(4), savedRevision: 4 })
    : method === 'conflict' ? inEpoch({ code: 'E_DECISION_CONFLICT', current: record(4) }, oldEpoch, 409)
      : method === 'import' ? inEpoch({ results: [{ index: 0, signal: 'signal', status: 'imported', current: record(4) }] })
        : inEpoch({ items: method === 'absence' ? [] : [record(4)] }));
  expect(await stale).toMatchObject({ code: 'E_DECISION_EPOCH_CHANGED' });
  expect(client.values().get('signal')).toMatchObject({ revision: 2, note: 'Restored baseline' });
  expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))[0].revision).toBe(2);
  expect(client.phase).toBe('ready');
  expect(decisionClientMetadataForTests(client)).toEqual({ records: 1, issued: 0, observed: 1, operations: 0, inFlightSignals: 0 });
});

test('overlapping requests that both reach the restored epoch keep its newest revision', async () => {
  const first = deferred(), second = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(8)] })).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
  await client.lookup(['signal']);
  const one = client.lookup(['signal']), two = client.lookup(['signal']);
  first.resolve(inEpoch({ items: [record(2)] }, restoredEpoch)); await one;
  second.resolve(inEpoch({ items: [record(3)] }, restoredEpoch)); await two;
  expect(client.values().get('signal').revision).toBe(3);
});

test('a restored-server success resets connection ordering inherited from the retired history', async () => {
  const fresh = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: [record(3)] })).mockReturnValueOnce(fresh.promise)
    .mockResolvedValueOnce(inEpoch({ error: 'Old server storage failed' }, oldEpoch, 503)) });
  await client.lookup(['signal']);
  const restored = client.lookup(['signal']);
  await expect(client.lookup(['signal'])).rejects.toMatchObject({ status: 503 });
  expect(client.phase).toBe('offline');
  fresh.resolve(inEpoch({ items: [record(2)] }, restoredEpoch)); await restored;
  expect(client.values().get('signal').revision).toBe(2);
  expect(client.phase).toBe('ready');
});

test('epoch changes cannot combine acknowledgements from different import histories', async () => {
  const input = Array.from({ length: 26 }, (_, index) => ({ signal: `signal-${index}`, decision: {} }));
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn()
    .mockResolvedValueOnce(inEpoch({ results: [{ index: 0, signal: 'signal-0', status: 'imported', current: { ...record(3), signal: 'signal-0' } }] }))
    .mockResolvedValueOnce(inEpoch({ results: [{ index: 0, signal: 'signal-25', status: 'imported', current: { ...record(1), signal: 'signal-25' } }] }, restoredEpoch)) });
  await expect(client.importRecords(input)).rejects.toMatchObject({ code: 'E_DECISION_EPOCH_CHANGED' });
  expect(client.values().size).toBe(0);
});

test('a restart during a batched lookup revalidates earlier batches in the new history', async () => {
  const signals = Array.from({ length: 11 }, (_, index) => `signal-${index}`);
  const item = (signal, revision) => ({ ...record(revision), signal });
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(inEpoch({ items: signals.slice(0, 10).map(signal => item(signal, 3)) }))
    .mockResolvedValueOnce(inEpoch({ items: [item(signals[10], 2)] }, restoredEpoch))
    .mockResolvedValueOnce(inEpoch({ items: signals.slice(0, 10).map(signal => item(signal, 2)) }, restoredEpoch))
    .mockResolvedValueOnce(inEpoch({ items: [item(signals[10], 2)] }, restoredEpoch));
  const client = createDecisionClient({ storage: storage(), fetchImpl });
  await client.lookup(signals);
  expect(client.values().size).toBe(11);
  expect([...client.values().values()].every(record => record.revision === 2)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

test('overlapping lookups keep the newest revision in memory and persistent cache in either response order', async () => {
  for (const newestFirst of [true, false]) {
    const saved = storage(), first = deferred(), second = deferred();
    const fetchImpl = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = createDecisionClient({ storage: saved, fetchImpl });
    const one = client.lookup(['signal']), two = client.lookup(['signal']);
    if (newestFirst) { second.resolve(reply({ items: [record(3, 'Newest')] })); await two; first.resolve(reply({ items: [record(2)] })); }
    else { first.resolve(reply({ items: [record(3, 'Newest')] })); await one; second.resolve(reply({ items: [record(2)] })); }
    await Promise.all([one, two]);
    expect(client.values().get('signal')).toMatchObject({ revision: 3, note: 'Newest' });
    expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))[0]).toMatchObject({ revision: 3, decision: { note: 'Newest' } });
  }
});

test('stale absence cannot erase a newer lookup and stale records cannot undo a newer confirmed absence', async () => {
  for (const newestHasRecord of [true, false]) {
    const saved = storage(), first = deferred(), second = deferred();
    const client = createDecisionClient({ storage: saved, fetchImpl: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
    const one = client.lookup(['signal']), two = client.lookup(['signal']);
    second.resolve(reply({ items: newestHasRecord ? [record(3)] : [] })); await two;
    first.resolve(reply({ items: newestHasRecord ? [] : [record(2)] })); await one;
    expect(client.values().has('signal')).toBe(newestHasRecord);
    expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))).toHaveLength(newestHasRecord ? 1 : 0);
  }
});

test('rotating missing feed signals release metadata after every lookup settles', async () => {
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn(async () => reply({ items: [] })) });
  for (let index = 0; index < 500; index++) await client.lookup([`retired-signal-${index}`]);
  expect(client.values().size).toBe(0);
  expect(decisionClientMetadataForTests(client)).toEqual({ records: 0, issued: 0, observed: 0, operations: 0, inFlightSignals: 0 });
});

test('an absence tombstone survives until every older overlapping request settles', async () => {
  const old = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(reply({ items: [] })) });
  const pending = client.lookup(['signal']);
  await client.lookup(['signal']);
  expect(decisionClientMetadataForTests(client)).toEqual({ records: 0, issued: 1, observed: 1, operations: 1, inFlightSignals: 1 });
  old.resolve(reply({ items: [record(2)] })); await pending;
  expect(client.values().has('signal')).toBe(false);
  expect(decisionClientMetadataForTests(client)).toEqual({ records: 0, issued: 0, observed: 0, operations: 0, inFlightSignals: 0 });
});

test.each(['lookup', 'save', 'import'])('a failed %s releases its absent-key operation metadata', async method => {
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn(async () => { throw new Error('offline'); }) });
  const request = method === 'lookup' ? client.lookup(['signal']) : method === 'save' ? client.save('signal', {}, 0, 'request')
    : client.importRecords([{ signal: 'signal', decision: {} }]);
  await expect(request).rejects.toThrow('offline');
  expect(decisionClientMetadataForTests(client)).toEqual({ records: 0, issued: 0, observed: 0, operations: 0, inFlightSignals: 0 });
});

test.each(['save', 'conflict', 'import'])('a delayed %s response cannot replace a newer observed revision', async operation => {
  const saved = storage(), delayed = deferred();
  const fetchImpl = jest.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(reply({ items: [record(3, 'Changed elsewhere')] }));
  const client = createDecisionClient({ storage: saved, fetchImpl });
  const mutation = operation === 'import' ? client.importRecords([{ signal: 'signal', decision: {} }])
    : client.save('signal', {}, 1, 'stable-request-id');
  // Attach the rejection before releasing the asynchronous conflict response.
  const outcome = mutation.then(value => value, error => error);
  await client.lookup(['signal']);
  delayed.resolve(operation === 'import' ? reply({ results: [{ index: 0, signal: 'signal', status: 'conflict', current: record(2) }] })
    : operation === 'conflict' ? reply({ code: 'E_DECISION_CONFLICT', current: record(2) }, 409)
      : reply({ record: record(2), savedRevision: 2 }));
  const result = await outcome;
  expect(client.values().get('signal')).toMatchObject({ revision: 3, note: 'Changed elsewhere' });
  expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))[0].revision).toBe(3);
  if (operation === 'save') expect(result).toMatchObject({ record: { revision: 3 }, savedRevision: 2 });
  else if (operation === 'conflict') expect(result.current.revision).toBe(3);
  else expect(result.results[0].current.revision).toBe(3);
});

test('a late lookup failure does not downgrade a newer successful connection state', async () => {
  const first = deferred();
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn().mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(reply({ items: [record(3)] })) });
  const old = client.lookup(['signal']).catch(error => error);
  await client.lookup(['signal']);
  first.reject(new Error('Old request timed out')); await old;
  expect(client.phase).toBe('ready');
  expect(client.values().get('signal').revision).toBe(3);
});

test('the first live lookup revalidates disk cache after restoration', async () => {
  const saved = storage(); saved.setItem(DECISION_CACHE_KEY, JSON.stringify([record(7, 'Pre-restore cache')]));
  const client = createDecisionClient({ storage: saved, fetchImpl: jest.fn(async () => reply({ items: [record(2, 'Restored server')] })) });
  await client.lookup(['signal']);
  expect(client.values().get('signal')).toMatchObject({ revision: 2, note: 'Restored server' });
  expect(JSON.parse(saved.getItem(DECISION_CACHE_KEY))[0].revision).toBe(2);
});

test('a changed server record history can replace a lower revision without being reverted by an old response', async () => {
  const first = deferred(), second = deferred();
  const initial = { ...record(8), createdAt: '2026-01-01T00:00:00Z' };
  const replacement = { ...record(1, 'New history'), createdAt: '2026-10-24T00:00:00Z' };
  const client = createDecisionClient({ storage: storage(), fetchImpl: jest.fn().mockResolvedValueOnce(reply({ items: [initial] }))
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
  await client.lookup(['signal']);
  const old = client.lookup(['signal']), fresh = client.lookup(['signal']);
  second.resolve(reply({ items: [replacement] })); await fresh;
  first.resolve(reply({ items: [{ ...initial, revision: 9 }] })); await old;
  expect(client.values().get('signal')).toMatchObject({ revision: 1, note: 'New history' });
});

test('browser migration keeps the original bytes and exposes divergent server records without replacing them', async () => {
  const saved = storage();
  const original = JSON.stringify({ signal: { state: 'affected', note: 'Old browser record' } });
  saved.setItem('wire.decisions.v1', original);
  const fetchImpl = jest.fn(async () => reply({ results: [{ index: 0, signal: 'signal', status: 'conflict', current: record() }] }));
  const client = createDecisionClient({ storage: saved, fetchImpl });
  expect(client.values().get('signal')).toMatchObject({ localOnly: true, revision: 0 });
  const result = await client.importRecords(client.legacyRecords());
  expect(result).toMatchObject({ conflicts: 1, imported: 0 });
  expect(result.results[0].importedRecord.decision.note).toBe('Old browser record');
  expect(client.values().get('signal')).toMatchObject({ revision: 1, note: 'Saved' });
  expect(saved.getItem('wire.decisions.v1')).toBe(original);
});

test('failed server saves never become successful local decisions and keep the same request body for retry', async () => {
  const saved = storage();
  const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply({ record: record(), savedRevision: 1, replayed: true }));
  const client = createDecisionClient({ storage: saved, fetchImpl });
  const decision = { state: 'affected', note: 'Retained unsaved draft', recordedAt: '' };
  await expect(client.save('signal', decision, 0, 'same-request-identifier')).rejects.toThrow('offline');
  expect(client.values().size).toBe(0);
  expect(client.phase).toBe('offline');
  await client.save('signal', decision, 0, 'same-request-identifier');
  expect(fetchImpl.mock.calls[0][1].body).toBe(fetchImpl.mock.calls[1][1].body);
  expect(client.phase).toBe('ready');
});

test('a delayed lookup cannot erase an acknowledged save and conflicts refresh only the saved record', async () => {
  let release;
  const fetchImpl = jest.fn().mockImplementationOnce(() => new Promise(done => { release = done; }))
    .mockResolvedValueOnce(reply({ record: record(2), savedRevision: 2 }))
    .mockResolvedValueOnce(reply({ code: 'E_DECISION_CONFLICT', current: record(3, 'Saved elsewhere') }, 409));
  const client = createDecisionClient({ storage: storage(), fetchImpl });
  const lookup = client.lookup(['signal']);
  await client.save('signal', {}, 1, 'save-request');
  release(reply({ items: [record(1)] })); await lookup;
  expect(client.values().get('signal').revision).toBe(2);
  await expect(client.save('signal', {}, 1, 'another-request')).rejects.toMatchObject({ code: 'E_DECISION_CONFLICT' });
  expect(client.values().get('signal')).toMatchObject({ revision: 3, note: 'Saved elsewhere' });
});

test('separate tab stores retain offline drafts and their revision/request baselines across reloads', () => {
  const tabA = storage(), tabB = storage();
  const draft = { values: { note: 'My offline work' }, base: { revision: 7 }, request: { id: 'uncertain-request', signature: 'fixed-content' } };
  expect(persistDecisionDrafts(tabA, new Map([['signal', draft]]))).toBe(true);
  persistDecisionDrafts(tabB, new Map([['signal', { ...draft, values: { note: 'Other tab work' } }]]));
  expect(readDecisionDrafts(tabA).get('signal')).toEqual(draft);
  expect(readDecisionDrafts(tabB).get('signal').values.note).toBe('Other tab work');
});

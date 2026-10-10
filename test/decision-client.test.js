import { expect, jest, test } from '@jest/globals';
import { createDecisionClient, readDecisionDrafts, persistDecisionDrafts } from '../public/modules/wire/decision-client.js';

const storage = () => { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) }; };
const record = (revision = 1, note = 'Saved') => ({ id: 'a'.repeat(64), signal: 'signal', revision, decision: { state: 'investigate', note }, updatedAt: '2026-10-09T00:00:00Z' });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

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

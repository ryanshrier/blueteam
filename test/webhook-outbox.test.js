import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
const fetchMock = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch: fetchMock, readCapped: async () => '' }));
const { initDB, closeDB, getDB, getMeta, setMeta } = await import('../lib/db.js');
const { dispatchAlerts, dispatchBriefWebhook, retryWebhookDeliveries, startWebhookDeliverySchedule, waitForWebhookDeliveryIdle } = await import('../lib/alerts.js');
const { WEBHOOK_OUTBOX_KEY, webhookDestinationKey, enqueueWebhookBatches, drainWebhookOutbox,
  getWebhookDeliveryStatus, listWebhookDeliveries, resolveWebhookDelivery, knownWebhookEventKeys,
  _resetWebhookDeliveryForTests } = await import('../lib/alert-delivery.js');
const config = (url = 'https://hooks.example.test/private-destination', events = 'both') => ({ analysisSettings: { webhook: { url, events, format: 'json' } } });
const item = { title: 'Synthetic vulnerability', link: 'https://example.test/report', alertMatched: true, score: 70, horizon: 1 };
const read = () => JSON.parse(getMeta(WEBHOOK_OUTBOX_KEY));
beforeEach(() => { initDB(':memory:'); _resetWebhookDeliveryForTests(); fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 }); });
afterEach(() => { closeDB(); jest.restoreAllMocks(); });

test('destination changes and new KEV evidence are distinct events; routine score decay is not', async () => {
  await dispatchAlerts([item], config());
  await dispatchAlerts([{ ...item, score: 65 }], config());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await dispatchAlerts([{ ...item, isKEV: true, kevCVE: 'CVE-2026-12345' }], config());
  await dispatchAlerts([item], config('https://hooks.example.test/new-destination'));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(read().receipts).toHaveLength(3);
});

test('transient failure retains exact payload for retry without depending on another pipeline selection', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  await dispatchAlerts([item], config());
  expect(getWebhookDeliveryStatus()).toMatchObject({ status: 'error', pending: 1, retrying: 1 });
  const first = fetchMock.mock.calls[0][1];
  expect(first.headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/);
  expect(fetchMock.mock.calls[0][2]).toEqual({ allowRedirects: false });
  expect(getMeta(WEBHOOK_OUTBOX_KEY)).not.toContain('private-destination');
  await retryWebhookDeliveries(config());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  await retryWebhookDeliveries(config());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1].body).toBe(first.body);
  expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  expect(read().jobs).toEqual([]);
  expect(read().receipts).toHaveLength(1);
});

test('legacy receipts seed a baseline without replaying old alerts on upgrade', async () => {
  setMeta('alert_sent_keys', JSON.stringify(['synthetic vulnerability']));
  await dispatchAlerts([item], config());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(read().receipts).toHaveLength(1);
  await dispatchAlerts([{ ...item, isKEV: true }], config());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('changing or disabling a destination pauses existing payloads instead of forwarding them elsewhere', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  await dispatchAlerts([item], config());
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  await retryWebhookDeliveries(config('https://hooks.example.test/replacement'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getWebhookDeliveryStatus()).toMatchObject({ status: 'paused', paused: 1 });
  await retryWebhookDeliveries(config(''));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await retryWebhookDeliveries(config());
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('an older pipeline config cannot send after the current destination is disabled', async () => {
  try {
    startWebhookDeliverySchedule({ getConfig: () => config('') });
    await dispatchAlerts([item], config());
    await waitForWebhookDeliveryIdle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getWebhookDeliveryStatus()).toMatchObject({ status: 'paused', paused: 1 });
  } finally {
    startWebhookDeliverySchedule(); // clear the test supplier and unref timer
  }
});

test('receipt-write failure after success becomes ambiguous instead of duplicating accepted work', async () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: { text: 'Synthetic' }, keys: ['event'] }], eventKeys: ['event'], now: 0 });
  const send = jest.fn(async () => {
    getDB().exec("CREATE TRIGGER block_receipt BEFORE INSERT ON meta WHEN new.key = 'webhook_outbox_v1' BEGIN SELECT RAISE(FAIL, 'synthetic storage failure'); END;");
    return { ok: true, status: 200 };
  });
  // Native SQLite errors can belong to a different Jest VM realm when several
  // suites share the addon. Match their data rather than Error identity.
  await expect(drainWebhookOutbox(config(), send, { now: 1 })).rejects.toMatchObject({ message: 'synthetic storage failure' });
  expect(read().jobs[0].state).toBe('sending');
  expect(getWebhookDeliveryStatus().status).toBe('error');
  getDB().exec('DROP TRIGGER block_receipt');
  await drainWebhookOutbox(config(), send, { now: 2 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(getWebhookDeliveryStatus()).toMatchObject({ status: 'error', ambiguous: 1 });
});

test.each(['UND_ERR_SOCKET', 'ETIMEDOUT', 'ABORT_ERR'])('ambiguous %s transport failure is retained without automatic replay', async code => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: {}, keys: ['event'] }], eventKeys: ['event'], now: 0 });
  const send = jest.fn(async () => { throw Object.assign(new Error('Synthetic transport failure'), { cause: { code } }); });
  await drainWebhookOutbox(config(), send, { now: 0 });
  await drainWebhookOutbox(config(), send, { now: 61_000 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(getWebhookDeliveryStatus()).toMatchObject({ status: 'error', ambiguous: 1, retrying: 0 });
});

test('a proven pre-connect failure retries the original payload', async () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: { text: 'Synthetic' }, keys: ['event'] }], eventKeys: ['event'], now: 0 });
  const send = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Synthetic refused connection'), { cause: { code: 'ECONNREFUSED' } })).mockResolvedValue({ ok: true, status: 200 });
  await drainWebhookOutbox(config(), send, { now: 0 });
  expect(getWebhookDeliveryStatus()).toMatchObject({ retrying: 1, ambiguous: 0 });
  await drainWebhookOutbox(config(), send, { now: 61_000 });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(read().receipts).toEqual(['event']);
});

test('raw enriched KEV deadline changes and overdue transitions create new events', async () => {
  const record = { cve: 'CVE-2026-12345', dueDate: '2026-10-10', overdue: false };
  const headline = { ...item, isKEV: true, kevCVE: record.cve, kevRecords: [record] };
  await dispatchAlerts([headline], config());
  await dispatchAlerts([{ ...headline, kevRecords: [{ ...record, dueDate: '2026-10-12' }] }], config());
  await dispatchAlerts([{ ...headline, kevRecords: [{ ...record, overdue: true }] }], config());
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).items[0]).toMatchObject({ kevOverdue: true, kevDeadlineScope: 'US federal civilian agencies' });
});

test('corrupt outbox data is preserved and prevents all sends', async () => {
  setMeta(WEBHOOK_OUTBOX_KEY, '{broken');
  await dispatchAlerts([item], config());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(getMeta(WEBHOOK_OUTBOX_KEY)).toBe('{broken');
  expect(getWebhookDeliveryStatus().status).toBe('error');
});

test('brief retry requires the same eligible reading copy and persists its original payload', async () => {
  const identity = { filename: 'brief-2026-10-09.md', contentSha256: 'a'.repeat(64) };
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  await dispatchBriefWebhook({ date: '2026-10-09', bluf: 'Synthetic summary', judgments: [], deliveryIdentity: identity }, config());
  const now = Date.now() + 61_000;
  const send = jest.fn(async () => ({ ok: true, status: 200 }));
  const validate = jest.fn(async received => received.contentSha256 === 'b'.repeat(64));
  await drainWebhookOutbox(config(), send, { now, validateBriefDelivery: validate });
  expect(send).not.toHaveBeenCalled();
  expect(validate).toHaveBeenCalledWith(identity);
  expect(getWebhookDeliveryStatus().paused).toBe(1);
  await drainWebhookOutbox(config(), send, { now, validateBriefDelivery: () => true });
  expect(send).toHaveBeenCalledTimes(1);
  expect(read().jobs).toEqual([]);
});

test('queue and retry attempts are bounded', async () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: {}, keys: ['event'] }], eventKeys: ['event'], now: 0 });
  const send = jest.fn(async () => ({ ok: false, status: 503 }));
  for (let attempt = 0; attempt < 9; attempt++) await drainWebhookOutbox(config(), send, { now: attempt * 3_600_000 });
  expect(send).toHaveBeenCalledTimes(8);
  expect(getWebhookDeliveryStatus()).toMatchObject({ failed: 1, status: 'error' });
  expect(() => enqueueWebhookBatches({ destination, kind: 'alerts', batches: Array.from({ length: 101 }, () => ({ body: {}, keys: [] })), eventKeys: ['new'] })).toThrow(/full/);
});

test('explicit reconciliation frees a saturated ambiguous outbox without automatically repeating delivery', async () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  for (let index = 0; index < 100; index++) {
    enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: { index }, keys: [`event-${index}`] }], eventKeys: [`event-${index}`], now: 0 });
  }
  const send = jest.fn(async () => { throw Object.assign(new Error('Uncertain outcome'), { code: 'ETIMEDOUT' }); });
  for (let index = 0; index < 20; index++) await drainWebhookOutbox(config(), send, { now: 0 });
  const later = 100 * 86_400_000;
  await drainWebhookOutbox(config(), send, { now: later });
  expect(send).toHaveBeenCalledTimes(100);
  expect(() => enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: {}, keys: ['new'] }], eventKeys: ['new'], now: later })).toThrow(/full/);
  const original = read().jobs[0];
  expect(resolveWebhookDelivery(original.id, { action: 'abandon' }, config(), { now: later })).toEqual({ resolved: true, action: 'abandon' });
  expect(knownWebhookEventKeys().has('event-0')).toBe(true);
  expect(read().resolutions).toEqual([{ id: original.id, action: 'abandon', resolvedAt: later }]);
  // Even a direct repeat of the exact original batch cannot recreate it.
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: { index: 0 }, keys: ['event-0'] }], eventKeys: ['event-0'], now: later });
  expect(read().jobs).toHaveLength(99);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: {}, keys: ['new'] }], eventKeys: ['new'], now: later });
  expect(read().jobs).toHaveLength(100);
  expect(send).toHaveBeenCalledTimes(100);
  expect(getWebhookDeliveryStatus()).not.toHaveProperty('errorCode');
});

test('deliberate retry requires acknowledgement and the same destination, keeps payload and key, and starts a bounded new window', async () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: { text: 'Original payload' }, keys: ['original'] }], eventKeys: ['original'], now: 0 });
  const uncertain = jest.fn(async () => { throw Object.assign(new Error('Uncertain'), { code: 'ETIMEDOUT' }); });
  await drainWebhookOutbox(config(), uncertain, { now: 0 });
  const original = read().jobs[0];
  expect(() => resolveWebhookDelivery(original.id, { action: 'retry' }, config())).toThrow(/Confirm/);
  expect(() => resolveWebhookDelivery(original.id, { action: 'retry', acknowledgeDuplicateRisk: true }, config('https://hooks.example.test/new'))).toThrow(/original destination/);
  const later = 100 * 86_400_000;
  resolveWebhookDelivery(original.id, { action: 'retry', acknowledgeDuplicateRisk: true }, config(), { now: later });
  expect(read().jobs[0]).toMatchObject({ id: original.id, body: original.body, createdAt: 0, retentionSince: later, attempts: 0, state: 'pending' });
  const send = jest.fn(async () => ({ ok: false, status: 503 }));
  for (let index = 0; index < 9; index++) await drainWebhookOutbox(config(), send, { now: later + index * 3_600_000 });
  expect(send).toHaveBeenCalledTimes(8);
  expect(send.mock.calls[0]).toEqual([config().analysisSettings.webhook.url, original.body, original.id]);
  expect(read().jobs[0].state).toBe('failed');
});

test('resolution receipts are bounded and repeated acknowledged resolutions are idempotent', () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  let last;
  for (let index = 0; index < 505; index++) {
    enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: {}, keys: [`key-${index}`] }], eventKeys: [`event-${index}`], now: index });
    last = read().jobs[0].id;
    resolveWebhookDelivery(last, { action: 'delivered' }, config(), { now: index });
  }
  expect(read().jobs).toEqual([]);
  expect(read().resolutions).toHaveLength(500);
  expect(read().receipts).toHaveLength(500);
  expect(resolveWebhookDelivery(last, { action: 'delivered' }, config())).toEqual({ resolved: true, action: 'delivered' });
  expect(() => resolveWebhookDelivery(last, { action: 'abandon' }, config())).toThrow(/no longer queued/);
});

test('review exposes safe metadata and does not reveal payloads or destinations', () => {
  const destination = webhookDestinationKey(config().analysisSettings.webhook.url);
  enqueueWebhookBatches({ destination, kind: 'alerts', batches: [{ body: { text: 'PRIVATE PAYLOAD' }, keys: ['private event'] }], eventKeys: ['private event'], now: 0 });
  const rows = listWebhookDeliveries(config());
  expect(rows).toEqual([{ id: read().jobs[0].id, kind: 'alerts', state: 'pending', attempts: 0,
    createdAt: '1970-01-01T00:00:00.000Z', errorCode: null, canRetry: true }]);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|private-destination|private event/);
  expect(listWebhookDeliveries(config(''))[0].canRetry).toBe(false);
});

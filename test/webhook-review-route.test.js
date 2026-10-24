import { afterEach, beforeEach, expect, test } from '@jest/globals';
import express from 'express';
import { createWebhookRouter } from '../routes/webhooks.js';
import { initDB, closeDB, getMeta } from '../lib/db.js';
import { enqueueWebhookBatches, drainWebhookOutbox, webhookDestinationKey, WEBHOOK_OUTBOX_KEY } from '../lib/alert-delivery.js';

const config = { analysisSettings: { webhook: { url: 'https://hooks.example.test/PRIVATE-DESTINATION', events: 'both' } } };
let server;
beforeEach(() => initDB(':memory:'));
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; } closeDB(); });
async function start({ authenticated = false, loopback = false } = {}) {
  const app = express(); app.use(express.json());
  if (authenticated) app.use((_req, res, next) => { res.locals.authenticated = true; next(); });
  app.use('/api', createWebhookRouter({ getConfig: () => config, loopback }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}/api/webhook-deliveries`;
}
function seed() {
  enqueueWebhookBatches({ destination: webhookDestinationKey(config.analysisSettings.webhook.url), kind: 'alerts',
    batches: [{ body: { text: 'PRIVATE-PAYLOAD' }, keys: ['event'] }], eventKeys: ['event'] });
  return JSON.parse(getMeta(WEBHOOK_OUTBOX_KEY)).jobs[0].id;
}
test('untrusted clients cannot inspect or reconcile delivery state', async () => {
  const id = seed(), url = await start();
  expect((await fetch(url)).status).toBe(403);
  expect((await fetch(`${url}/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"abandon"}' })).status).toBe(403);
  expect(JSON.parse(getMeta(WEBHOOK_OUTBOX_KEY)).jobs).toHaveLength(1);
});
test.each([{ authenticated: true }, { loopback: true }])('trusted operator can inspect safe metadata and free a queue slot: %j', async trust => {
  const id = seed(), url = await start(trust);
  const response = await fetch(url), text = await response.text();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(text).not.toMatch(/PRIVATE|event/);
  expect(JSON.parse(text).items[0]).toMatchObject({ id, kind: 'alerts', state: 'pending' });
  const resolved = await fetch(`${url}/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"abandon"}' });
  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toEqual({ resolved: true, action: 'abandon' });
  expect(JSON.parse(getMeta(WEBHOOK_OUTBOX_KEY)).jobs).toEqual([]);
});
test('retry is deliberate and does not start an outbound send inside the resolution request', async () => {
  const id = seed();
  await drainWebhookOutbox(config, async () => { throw Object.assign(new Error('Uncertain'), { code: 'ETIMEDOUT' }); });
  const url = await start({ authenticated: true });
  const request = body => fetch(`${url}/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await request({ action: 'retry' })).status).toBe(400);
  expect((await request({ action: 'retry', acknowledgeDuplicateRisk: true, destination: 'https://attacker.invalid' })).status).toBe(400);
  expect((await request({ action: 'retry', acknowledgeDuplicateRisk: true })).status).toBe(200);
  expect(JSON.parse(getMeta(WEBHOOK_OUTBOX_KEY)).jobs[0]).toMatchObject({ id, state: 'pending', attempts: 0 });
});

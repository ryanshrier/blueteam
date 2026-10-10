// Durable, bounded webhook delivery. Only newly enqueued events are replayed.
// URLs (which commonly contain credentials) are resolved from current config;
// the database retains only a destination fingerprint and the exact payload.
import { createHash } from 'node:crypto';
import { getMeta, setMeta } from './db.js';
import { recordStorageOutcome } from './storage-health.js';

export const WEBHOOK_OUTBOX_KEY = 'webhook_outbox_v1';
const MAX_JOBS = 100;
const MAX_RECEIPTS = 500;
const MAX_BODY_BYTES = 128_000;
const MAX_STATE_BYTES = 2_000_000;
const MAX_ATTEMPTS = 8;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
export const webhookDestinationKey = url => hash(String(url).trim());
let persistenceError = null;

const errorCode = error => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'DELIVERY_ERROR';
function storageFailed(error) {
  persistenceError = errorCode(error);
  recordStorageOutcome('webhook-outbox', error);
}
function emptyState() {
  // Migration is a baseline only: do not manufacture pending deliveries from
  // old sent titles. Their first observed current state is marked delivered.
  let legacyTitles = [];
  const raw = getMeta('alert_sent_keys');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Invalid legacy alert receipts');
    legacyTitles = parsed.filter(value => typeof value === 'string').slice(-MAX_RECEIPTS);
  }
  return { version: 1, jobs: [], receipts: [], legacyTitles };
}
function load() {
  try {
    const raw = getMeta(WEBHOOK_OUTBOX_KEY);
    if (!raw) return emptyState();
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error('Outbox exceeds size limit');
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !Array.isArray(state.jobs) || state.jobs.length > MAX_JOBS
      || !Array.isArray(state.receipts) || state.receipts.length > MAX_RECEIPTS
      || !Array.isArray(state.legacyTitles)) throw new Error('Invalid outbox state');
    if (state.receipts.some(key => typeof key !== 'string') || state.legacyTitles.some(key => typeof key !== 'string')) throw new Error('Invalid outbox receipts');
    for (const job of state.jobs) {
      if (!job || !/^[a-f0-9]{64}$/.test(job.id || '') || !/^[a-f0-9]{64}$/.test(job.destination || '')
        || !['alerts', 'brief'].includes(job.kind) || !['pending', 'sending', 'ambiguous', 'failed', 'paused'].includes(job.state)
        || typeof job.body !== 'string' || Buffer.byteLength(job.body) > MAX_BODY_BYTES
        || !Array.isArray(job.keys) || !Array.isArray(job.eventKeys) || [...job.keys, ...job.eventKeys].some(key => typeof key !== 'string')
        || !Number.isFinite(job.createdAt) || !Number.isFinite(job.nextAt) || !Number.isInteger(job.attempts) || job.attempts < 0) throw new Error('Invalid outbox job');
    }
    return state;
  } catch (error) { storageFailed(error); throw error; }
}
function save(state) {
  try {
    state.receipts = [...new Set(state.receipts)].slice(-MAX_RECEIPTS);
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw Object.assign(new Error('Webhook outbox is full'), { code: 'E_OUTBOX_FULL' });
    setMeta(WEBHOOK_OUTBOX_KEY, encoded);
    persistenceError = null;
    recordStorageOutcome('webhook-outbox');
  } catch (error) { storageFailed(error); throw error; }
}

export function knownWebhookEventKeys(events = []) {
  const state = load();
  const known = new Set([...state.receipts, ...state.jobs.flatMap(job => job.eventKeys)]);
  let migrated = false;
  for (const event of events) {
    if (state.legacyTitles.includes(event.title)) {
      state.receipts.push(event.key);
      known.add(event.key);
      state.legacyTitles = state.legacyTitles.filter(title => title !== event.title);
      migrated = true;
    }
  }
  if (migrated) save(state);
  return known;
}

export function enqueueWebhookBatches({ destination, kind, batches, eventKeys, deliveryIdentity = null, now = Date.now() }) {
  try {
    const state = load();
    // Failed jobs retain diagnostic/replay protection for seven days. Pending
    // jobs expire below rather than growing without bound during an outage.
    state.jobs = state.jobs.filter(job => !(job.state === 'failed' && now - job.createdAt > RETENTION_MS));
    const jobs = batches.map((batch, index) => {
      const body = JSON.stringify(batch.body);
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw Object.assign(new Error('Webhook payload exceeds the delivery limit'), { code: 'E_OUTBOX_PAYLOAD' });
      const id = hash(JSON.stringify([destination, kind, eventKeys, index]));
      return { id, destination, kind, body, keys: batch.keys, eventKeys, deliveryIdentity,
        state: 'pending', attempts: 0, createdAt: now, nextAt: now };
    }).filter(job => !state.jobs.some(existing => existing.id === job.id));
    if (state.jobs.length + jobs.length > MAX_JOBS) throw Object.assign(new Error('Webhook outbox is full'), { code: 'E_OUTBOX_FULL' });
    state.jobs.push(...jobs);
    save(state); // Always durable before the first outbound attempt.
  } catch (error) { storageFailed(error); throw error; }
}

export async function drainWebhookOutbox(config, send, { now = Date.now(), validateBriefDelivery, allowNewBriefKeys = [] } = {}) {
  const state = load();
  const webhook = config?.analysisSettings?.webhook;
  const url = typeof webhook?.url === 'string' ? webhook.url.trim() : '';
  const destination = webhookDestinationKey(url);
  const events = webhook?.events || 'alerts';
  let changed = false;
  for (const job of state.jobs) {
    if (job.state === 'sending') {
      // The process may have died after a recipient accepted the payload, or
      // receipt persistence failed. An automatic retry would risk duplicates.
      job.state = 'ambiguous'; job.errorCode = 'E_DELIVERY_UNKNOWN'; changed = true;
    }
    if (['ambiguous', 'failed'].includes(job.state)) continue;
    if (now - job.createdAt > RETENTION_MS) {
      job.state = 'failed'; job.errorCode = 'E_DELIVERY_EXPIRED'; changed = true; continue;
    }
    if (!url || job.destination !== destination || ![job.kind, 'both'].includes(events)) {
      if (job.state !== 'paused') { job.state = 'paused'; changed = true; }
      continue;
    }
    if (job.state === 'paused') { job.state = 'pending'; changed = true; }
  }
  if (changed) save(state);
  // Limit work per tick so outage recovery cannot monopolize shutdown or
  // refresh. Failed batches wait; later batches in that group wait with them.
  const blockedGroups = new Set();
  let attempted = 0;
  for (const job of [...state.jobs]) {
    const group = JSON.stringify([job.destination, job.kind, job.eventKeys]);
    if (job.state !== 'pending' || job.nextAt > now || blockedGroups.has(group)) { blockedGroups.add(group); continue; }
    if (attempted >= 5) break;
    if (job.kind === 'brief') {
      let valid = false;
      try {
        valid = typeof validateBriefDelivery === 'function'
          ? await validateBriefDelivery(job.deliveryIdentity) === true
          : job.attempts === 0 && job.keys.some(key => allowNewBriefKeys.includes(key));
      } catch { /* failed closed: publication state is unavailable */ }
      if (!valid) {
        job.state = 'paused'; job.errorCode = 'E_PUBLICATION_RECHECK'; save(state);
        blockedGroups.add(group); continue;
      }
    }
    job.state = 'sending'; job.attempts++; save(state);
    attempted++;
    try {
      const response = await send(url, job.body, job.id);
      if (!response.ok) throw Object.assign(new Error('Webhook rejected delivery'), { code: `HTTP_${response.status}`, status: response.status });
    } catch (error) {
      job.errorCode = errorCode(error);
      // A reset/timeout after request transmission can conceal acceptance.
      // Retry transport errors only when they prove connection setup failed;
      // receivers are not assumed to honor the stable Idempotency-Key header.
      const transportCode = error?.cause?.code || error?.code;
      const preConnectFailure = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(transportCode);
      const httpFailure = Number.isInteger(error?.status) && error.status >= 300 && error.status <= 599;
      const permanent = error?.code === 'E_WEBHOOK_REDIRECT'
        || (httpFailure && error.status < 500 && ![408, 429].includes(error.status));
      const ambiguous = !permanent && !httpFailure && !preConnectFailure;
      job.state = ambiguous ? 'ambiguous' : permanent || job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      if (ambiguous) job.errorCode = 'E_DELIVERY_UNKNOWN';
      job.nextAt = now + Math.min(60 * 60_000, 60_000 * 2 ** (job.attempts - 1));
      blockedGroups.add(group);
      save(state);
      continue;
    }
    state.receipts.push(...job.keys);
    state.jobs = state.jobs.filter(candidate => candidate.id !== job.id);
    // If this fails, durable state remains `sending`; the next drain marks it
    // ambiguous and does not blindly deliver again.
    save(state);
  }
}

export function getWebhookDeliveryStatus() {
  try {
    const state = load();
    const count = status => state.jobs.filter(job => job.state === status).length;
    const pending = count('pending'), paused = count('paused'), failed = count('failed'), ambiguous = count('ambiguous'), active = count('sending');
    const retrying = state.jobs.filter(job => job.state === 'pending' && job.attempts > 0).length;
    return { status: persistenceError || failed || ambiguous || retrying ? 'error' : paused ? 'paused' : 'ok',
      pending, retrying, paused, failed, ambiguous, active, ...(persistenceError ? { errorCode: persistenceError } : {}) };
  } catch { return { status: 'error', errorCode: persistenceError || 'E_OUTBOX_READ' }; }
}

export function _resetWebhookDeliveryForTests() { persistenceError = null; }

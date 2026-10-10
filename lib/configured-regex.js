import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

export const CONFIGURED_REGEX_LIMITS = Object.freeze({ timeoutMs: 2_000, syncTimeoutMs: 500,
  maxPending: 4, maxBytes: 24_000_000, maxItems: 20_000, maxOldGenerationSizeMb: 96,
  maxCacheBytes: 8 * 1024 * 1024, maxCacheEntryBytes: 64 * 1024 });
const workers = new Set();
let syncWorker = null, retiringSyncWorker = null, closed = false;
const failure = (message, code = 'E_CONFIGURED_REGEX') => Object.assign(new Error(message), { code });
function checkRequest(request) {
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > CONFIGURED_REGEX_LIMITS.maxBytes
    || (request.items?.length || 0) > CONFIGURED_REGEX_LIMITS.maxItems) throw failure('Configured regex input exceeds its limit');
}
function spawn(request, shared, persistentSync = false) {
  // One collection worker and at most one bounded synchronous config/helper
  // admission worker. No inherited environment secrets; the admission worker
  // is reused and unref'd, while collection workers exit after each batch.
  if (workers.size >= 2) throw failure('Configured regex worker capacity is full');
  const worker = new Worker(new URL('./configured-regex-worker.js', import.meta.url), {
    workerData: { request, shared, persistentSync }, env: {}, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: CONFIGURED_REGEX_LIMITS.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  workers.add(worker);
  worker.once('exit', () => {
    workers.delete(worker);
    if (syncWorker === worker) syncWorker = null;
    if (retiringSyncWorker === worker) retiringSyncWorker = null;
  });
  return worker;
}

export function createConfiguredRegexWorker({ timeoutMs = CONFIGURED_REGEX_LIMITS.timeoutMs, maxPending = CONFIGURED_REGEX_LIMITS.maxPending } = {}) {
  let pending = 0, tail = Promise.resolve();
  const shutdown = new AbortController();
  function run(request) {
    if (shutdown.signal.aborted) throw failure('Configured regex worker is closed');
    return new Promise((resolve, reject) => {
      const worker = spawn(request);
      let reply, error;
      const stop = message => { error = failure(message, 'E_CONFIGURED_REGEX_TIMEOUT'); void worker.terminate().catch(() => {}); };
      const onAbort = () => stop('Configured regex worker is closed');
      shutdown.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop('Configured regex evaluation timed out'), timeoutMs);
      worker.once('message', value => { reply = value; });
      worker.once('error', () => { error ||= failure('Configured regex worker failed'); });
      worker.once('exit', code => {
        clearTimeout(timer); shutdown.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (code !== 0 || reply?.ok !== true) reject(failure('Configured regex compilation or evaluation failed'));
        else resolve(reply.value);
      });
    });
  }
  return {
    evaluate(request) {
      try {
        if (shutdown.signal.aborted) throw failure('Configured regex worker is closed');
        checkRequest(request);
        if (pending >= maxPending) throw failure('Configured regex worker queue is full');
        const snapshot = structuredClone(request);
        pending++;
        const result = tail.then(() => run(snapshot)).finally(() => { pending--; });
        tail = result.catch(() => {});
        return result;
      } catch (error) { return Promise.reject(error); }
    },
    close() { shutdown.abort(); return tail; },
  };
}
const runtime = createConfiguredRegexWorker();
export const evaluateConfiguredRegex = request => runtime.evaluate(request);
export const configuredRegexFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function closeConfiguredRegexWorker() {
  closed = true;
  await runtime.close();
  await Promise.allSettled([...workers].map(worker => worker.terminate()));
}

// Compatibility for synchronous pure helpers and config syntax admission only.
// Production collection uses the async batch API; HTTP presentation consumes
// captured assessments and never enters this bridge. Timeout throws, not false.
const syncCache = new Map();
let syncCacheBytes = 0;
export function evaluateConfiguredRegexSync(request) {
  if (closed) throw failure('Configured regex worker is closed');
  checkRequest(request);
  const key = configuredRegexFingerprint(request);
  if (syncCache.has(key)) return structuredClone(syncCache.get(key).value);
  const shared = new SharedArrayBuffer(1_000_008);
  const status = new Int32Array(shared, 0, 2);
  if (retiringSyncWorker) throw failure('Configured regex admission worker is still stopping');
  if (!syncWorker) {
    syncWorker = spawn(undefined, undefined, true);
    syncWorker.on('error', () => {}); syncWorker.unref();
  }
  const worker = syncWorker;
  worker.postMessage({ request, shared });
  const outcome = Atomics.wait(status, 0, 0, CONFIGURED_REGEX_LIMITS.syncTimeoutMs);
  if (outcome === 'timed-out') {
    syncWorker = null; retiringSyncWorker = worker;
    void worker.terminate().catch(() => {});
    throw failure('Configured regex evaluation timed out', 'E_CONFIGURED_REGEX_TIMEOUT');
  }
  if (Atomics.load(status, 0) !== 1) throw failure('Configured regex result exceeds its limit');
  const reply = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 8, Atomics.load(status, 1))));
  if (reply?.ok !== true) throw failure('Configured regex compilation or evaluation failed');
  const bytes = Buffer.byteLength(JSON.stringify(reply.value), 'utf8');
  if (bytes <= CONFIGURED_REGEX_LIMITS.maxCacheEntryBytes) {
    while (syncCache.size >= 512 || syncCacheBytes + bytes > CONFIGURED_REGEX_LIMITS.maxCacheBytes) {
      const oldest = syncCache.keys().next().value;
      syncCacheBytes -= syncCache.get(oldest).bytes;
      syncCache.delete(oldest);
    }
    syncCache.set(key, { value: structuredClone(reply.value), bytes });
    syncCacheBytes += bytes;
  }
  return reply.value;
}

export function configuredPattern(source, flags = 'i') {
  if (!source) return null;
  return Object.freeze({ source, flags, configured: true,
    test: text => Boolean(evaluateConfiguredRegexSync({ operation: 'match', source, flags, text: String(text) })),
    [Symbol.match]: text => evaluateConfiguredRegexSync({ operation: 'match', source, flags, text: String(text) }),
  });
}

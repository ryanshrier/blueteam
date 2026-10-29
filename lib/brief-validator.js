import { Worker } from 'node:worker_threads';
import { assertBriefInput } from './brief-input-limits.js';
import { getBrief } from './domain.js';

export const BRIEF_VALIDATION_LIMITS = Object.freeze({ timeoutMs: 5_000, maxPending: 8, maxInputBytes: 32 * 1024 * 1024,
  // Preserve the old aggregate admission budget (eight 16-MiB requests) while
  // allowing a larger receipt to be processed without dropping its evidence.
  maxPendingInputBytes: 128 * 1024 * 1024,
  maxOldGenerationSizeMb: 192 });
const failure = (message, code = 'E_BRIEF_VALIDATION') => Object.assign(new Error(message), { code });

// One bounded worker at a time; no application environment or long-lived pool.
export function createBriefValidator({ timeoutMs = BRIEF_VALIDATION_LIMITS.timeoutMs,
  maxPending = BRIEF_VALIDATION_LIMITS.maxPending,
  maxPendingInputBytes = BRIEF_VALIDATION_LIMITS.maxPendingInputBytes } = {}) {
  let tail = Promise.resolve(), pending = 0, pendingInputBytes = 0;
  const shutdown = new AbortController();
  function run(request, deadline) {
    if (shutdown.signal.aborted) throw failure('Briefing validator is closed.');
    if (Date.now() >= deadline) throw failure('Briefing validation exceeded its time limit.', 'E_BRIEF_VALIDATION_TIMEOUT');
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./brief-validation-worker.js', import.meta.url), {
        workerData: request, env: {}, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: BRIEF_VALIDATION_LIMITS.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      let reply, error;
      const stop = (message, code) => { error = failure(message, code); void worker.terminate().catch(() => {}); };
      const onAbort = () => stop('Briefing validator is closed.');
      shutdown.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop('Briefing validation exceeded its time limit.', 'E_BRIEF_VALIDATION_TIMEOUT'), Math.max(1, deadline - Date.now()));
      worker.once('message', value => { reply = value; });
      worker.once('error', () => { error ||= failure('Briefing validator failed.'); });
      worker.once('exit', code => {
        clearTimeout(timer); shutdown.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (code !== 0 || reply?.ok !== true) reject(failure(reply?.message || 'Briefing validator failed.', reply?.code));
        else resolve(reply.value);
      });
    });
  }
  function processRequest(task, payload) {
    const deadline = Date.now() + timeoutMs;
    try {
      if (shutdown.signal.aborted) throw failure('Briefing validator is closed.');
      for (const text of [payload.text, payload.submitted, payload.artifact?.revisions?.at(-1)?.content]) {
        if (text !== undefined) assertBriefInput(text);
      }
      if (pending >= maxPending) throw failure('Briefing validation queue is full.');
      const request = { task, ...payload, briefDictionary: payload.source?.briefDictionary || getBrief() };
      // JSON is only a conservative admission budget; structuredClone keeps Sets.
      const inputBytes = Buffer.byteLength(JSON.stringify(request, (_key, value) => value instanceof Set ? [...value] : value), 'utf8');
      if (inputBytes > BRIEF_VALIDATION_LIMITS.maxInputBytes) {
        throw failure('Briefing validation inputs exceed their size limit.');
      }
      if (pendingInputBytes + inputBytes > maxPendingInputBytes) throw failure('Briefing validation queue is full.');
      const snapshot = structuredClone(request);
      pending++;
      pendingInputBytes += inputBytes;
      const result = tail.then(() => run(snapshot, deadline)).finally(() => { pending--; pendingInputBytes -= inputBytes; });
      tail = result.catch(() => {});
      return result;
    } catch (error) { return Promise.reject(error); }
  }
  return {
    validate(text, expectedDate, source = {}) {
      return processRequest('validate', { text, expectedDate, source });
    },
    prepareDraft(payload) { return processRequest('draft', payload); },
    prepare(text, expectedDate, source = {}, options = {}) { return processRequest('prepare', { text, expectedDate, source, options }); },
    retained(text, manifest) { return processRequest('retained', { text, manifest }); },
    delink(text, groundingManifest) { return processRequest('delink', { text, groundingManifest }); },
    actions(text, captured) { return processRequest('actions', { text, captured }); },
    close() { shutdown.abort(); return tail; },
  };
}
const validator = createBriefValidator();
export const validateBriefInWorker = (text, expectedDate, source) => validator.validate(text, expectedDate, source);
export const prepareDraftInWorker = payload => validator.prepareDraft(payload);
export const prepareBriefInWorker = (text, expectedDate, source, options) => validator.prepare(text, expectedDate, source, options);
export const validateRetainedBriefInWorker = (text, manifest) => validator.retained(text, manifest);
export const delinkBriefInWorker = (text, groundingManifest) => validator.delink(text, groundingManifest);
export const briefActionsInWorker = (text, captured) => validator.actions(text, captured);
export const closeBriefValidationWorker = () => validator.close();

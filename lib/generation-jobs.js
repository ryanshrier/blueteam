// Bounded durable accounting, not a worker queue. No prompts, article text, keys,
// or raw provider errors belong here. An interrupted paid request is never replayed.
import { randomUUID } from 'crypto';
import * as database from './db.js';
import { recordStorageOutcome } from './storage-health.js';

const KEY = 'brief_generation_jobs_v1';
const SESSION = randomUUID();
const LIMIT = 20;
const MAX_BYTES = 128 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
const safeText = value => typeof value === 'string' ? value.replace(/sk-ant-[\w-]+/g, '[REDACTED]').slice(0, 128) : null;
const tokenCount = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

export function createGenerationJobs({
  read = key => database.getMeta(key), write = (key, value) => database.setMeta(key, value),
  sessionId = SESSION, now = () => new Date().toISOString(), recoverPublished = () => null,
} = {}) {
  const active = new Set();
  let persistenceError = false;
  const storageError = cause => {
    persistenceError = true;
    recordStorageOutcome('generation-ledger', cause);
    return Object.assign(new Error('Generation accounting could not be saved. Paid work will not be retried automatically; check generation status and storage health.'), { code: 'E_GENERATION_LEDGER', cause });
  };
  const load = () => {
    try {
      const raw = read(KEY);
      if (!raw) return [];
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('Oversized generation ledger');
      const parsed = JSON.parse(raw);
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > LIMIT) throw new Error('Invalid generation ledger');
      for (const job of parsed.jobs) {
        if (!job || typeof job.id !== 'string' || typeof job.sessionId !== 'string'
          || !/^\d{4}-\d{2}-\d{2}$/.test(job.editionDate || '')
          || !['running', 'complete', 'failed'].includes(job.status)
          || !Array.isArray(job.attempts) || job.attempts.length > 4
          || job.attempts.some(attempt => !attempt || typeof attempt.model !== 'string'
            || !['running', 'complete', 'failed'].includes(attempt.status)
            || !Number.isFinite(attempt.usage?.inputTokens) || !Number.isFinite(attempt.usage?.outputTokens))) {
          throw new Error('Invalid generation record');
        }
      }
      // Persisted input is not a license to expose extra keys. Keep the same
      // bounded, metadata-only fields the writer owns even after file corruption.
      const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
      return parsed.jobs.map(job => ({
        ...pick(job, ['id', 'sessionId', 'editionDate', 'scheduledJobKey', 'status', 'startedAt', 'updatedAt', 'costUsd', 'filename', 'code', 'completedAt']),
        attempts: job.attempts.map(attempt => ({
          ...pick(attempt, ['attempt', 'model', 'responseModel', 'systemPromptSha256', 'messagesSha256', 'startedAt', 'status', 'usageComplete', 'costUsd', 'stopReason', 'completedAt']),
          usage: pick(attempt.usage, ['inputTokens', 'outputTokens']),
          pricing: attempt.pricing ? { asOf: safeText(attempt.pricing.asOf), perMillionTokens: attempt.pricing.perMillionTokens ? pick(attempt.pricing.perMillionTokens, ['input', 'output']) : null } : null,
        })),
      }));
    } catch (error) { throw storageError(error); }
  };
  const save = jobs => {
    try {
      const serialized = JSON.stringify({ schemaVersion: 1, jobs: jobs.slice(-LIMIT) });
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('Oversized generation ledger');
      write(KEY, serialized);
      persistenceError = false;
      recordStorageOutcome('generation-ledger');
    } catch (error) { throw storageError(error); }
  };
  const update = (id, mutate) => {
    const jobs = load();
    const job = jobs.find(item => item.id === id);
    if (!job) throw storageError(new Error('Generation accounting record is missing'));
    mutate(job);
    job.updatedAt = now();
    save(jobs);
    return copy(job);
  };
  const interpreted = job => {
    const billing = job.attempts.some(attempt => !attempt.usageComplete) ? 'unknown-final-usage'
      : job.attempts.length ? 'provider-usage-recorded' : 'no-provider-attempt-recorded';
    const snapshot = { ...copy(job), billing, attempts: job.attempts.map(attempt => ({ ...copy(attempt), billing: attempt.usageComplete ? 'provider-usage-recorded' : 'unknown-final-usage' })) };
    if (job.status !== 'running') return snapshot;
    // An active request owns its publication lifecycle. Health polling must not
    // scan archives or promote it between saveBrief and terminal accounting.
    if (job.sessionId === sessionId && active.has(job.id)) return snapshot;
    const publication = recoverPublished(job);
    if (publication) return { ...snapshot, status: 'complete', filename: publication.filename, completedAt: publication.generatedAt, costUsd: publication.costUsd ?? job.costUsd, recoveredFromArchive: true };
    return { ...snapshot, status: 'interrupted', billing: 'unknown-final-usage', automaticRetry: false };
  };
  return {
    start({ id, editionDate, scheduledJobKey = null }) {
      const jobs = load();
      if (scheduledJobKey && jobs.some(job => job.scheduledJobKey === scheduledJobKey && ['running', 'interrupted'].includes(interpreted(job).status))) {
        throw Object.assign(new Error('A prior paid attempt for this scheduled edition has an unknown outcome. Review generation status before requesting a new manual attempt.'), { code: 'E_GENERATION_AMBIGUOUS' });
      }
      const job = { id: safeText(id), sessionId, editionDate: safeText(editionDate), scheduledJobKey: safeText(scheduledJobKey), status: 'running', startedAt: now(), updatedAt: now(), attempts: [], costUsd: 0, filename: null };
      jobs.push(job);
      save(jobs);
      active.add(id);
      return copy(job);
    },
    startAttempt(id, attempt) {
      return update(id, job => {
        if (job.attempts.length >= 4) throw new Error('Attempt limit exceeded');
        job.attempts.push({ attempt: job.attempts.length + 1, model: safeText(attempt.model), systemPromptSha256: safeText(attempt.systemPromptSha256), messagesSha256: safeText(attempt.messagesSha256), pricing: attempt.pricing ? { asOf: safeText(attempt.pricing.asOf), perMillionTokens: attempt.pricing.perMillionTokens } : null, startedAt: now(), status: 'running', usage: { inputTokens: 0, outputTokens: 0 }, usageComplete: false, costUsd: null });
      });
    },
    usage(id, number, { inputTokens, outputTokens, responseModel, costUsd }) {
      return update(id, job => {
        const attempt = job.attempts[number - 1];
        if (!attempt) throw new Error('Attempt missing');
        attempt.usage = { inputTokens: tokenCount(inputTokens), outputTokens: tokenCount(outputTokens) };
        attempt.responseModel = safeText(responseModel);
        attempt.costUsd = Number.isFinite(costUsd) ? costUsd : null;
        job.costUsd = job.attempts.some(item => item.costUsd == null) ? null : job.attempts.reduce((total, item) => total + item.costUsd, 0);
      });
    },
    finishAttempt(id, number, { stopReason, failed, timedOut }) {
      return update(id, job => {
        const attempt = job.attempts[number - 1];
        attempt.status = failed || timedOut ? 'failed' : 'complete';
        attempt.stopReason = safeText(stopReason);
        attempt.completedAt = now();
        attempt.usageComplete = !failed && !timedOut;
      });
    },
    finish(id, { status, filename = null, code = null }) {
      const result = update(id, job => { job.status = status; job.filename = safeText(filename); job.code = safeText(code); job.completedAt = now(); });
      active.delete(id);
      return result;
    },
    release(id) { active.delete(id); },
    status() {
      try {
        const jobs = load().map(interpreted).map(({ sessionId: _sessionId, ...job }) => job).reverse();
        return { persistence: persistenceError ? 'error' : 'ok', active: jobs.some(job => job.status === 'running'), latest: jobs[0] || null, jobs };
      } catch { return { persistence: 'error', active: active.size > 0, latest: null, jobs: [], code: 'E_GENERATION_LEDGER' }; }
    },
  };
}

let currentJobs = null;
export function registerGenerationJobs(jobs) { currentJobs = jobs; }
export function getGenerationStatus() {
  return (currentJobs || createGenerationJobs()).status();
}

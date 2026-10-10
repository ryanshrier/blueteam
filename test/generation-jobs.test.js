import { describe, expect, jest, test } from '@jest/globals';
import { createGenerationJobs } from '../lib/generation-jobs.js';

function storage() {
  const values = new Map();
  return { read: key => values.get(key), write: jest.fn((key, value) => values.set(key, value)), values };
}
const start = jobs => jobs.start({ id: 'generation-1', editionDate: '2026-09-05', scheduledJobKey: 'daily-brief:2026-09-05' });
const attempt = { model: 'claude-sonnet-5', systemPromptSha256: 'a'.repeat(64), messagesSha256: 'b'.repeat(64), pricing: { asOf: '2026-09-05', perMillionTokens: { input: 2, output: 10 } }, system: 'private prompt sk-ant-secret', messages: [{ role: 'user', content: 'private sources' }] };

describe('durable generation accounting', () => {
  test('pre-provider work exposes its phase and a restart never invents unknown provider usage', () => {
    const db = storage();
    const first = createGenerationJobs({ ...db, sessionId: 'first' });
    first.start({ id: 'collecting-1', editionDate: '2026-09-05', scheduledJobKey: 'daily-brief:2026-09-05', phase: 'collecting' });
    expect(first.status()).toMatchObject({ active: true, latest: { phase: 'collecting', billing: 'no-provider-attempt-recorded' } });
    first.setPhase('collecting-1', 'preparing');
    const restarted = createGenerationJobs({ ...db, sessionId: 'second' });
    expect(restarted.status()).toMatchObject({ active: false, latest: { status: 'interrupted', phase: 'preparing',
      attempts: [], costUsd: 0, billing: 'no-provider-attempt-recorded' } });
    expect(() => restarted.start({ id: 'retry-collection', editionDate: '2026-09-05', scheduledJobKey: 'daily-brief:2026-09-05' })).not.toThrow();
    restarted.startAttempt('retry-collection', attempt);
    expect(restarted.status().latest).toMatchObject({ phase: 'generating', billing: 'unknown-final-usage' });
    expect(() => restarted.setPhase('retry-collection', 'private prompt sk-ant-secret')).toThrow('Invalid generation phase');
    expect(JSON.stringify(restarted.status())).not.toContain('private prompt');
  });

  test('a finished timeout blocks the same scheduled purchase after restart but allows an explicit manual run', () => {
    const db = storage();
    const first = createGenerationJobs({ ...db, sessionId: 'process-1' });
    start(first);
    first.startAttempt('generation-1', attempt);
    first.finishAttempt('generation-1', 1, { timedOut: true, failed: false });
    first.finish('generation-1', { status: 'failed', code: 'E_GENERATION_FAILED' });
    const restarted = createGenerationJobs({ ...db, sessionId: 'process-2' });
    expect(restarted.status().latest).toMatchObject({ status: 'failed', billing: 'unknown-final-usage',
      attempts: [{ timedOut: true, usageComplete: false }] });
    expect(() => restarted.start({ id: 'automatic-retry', editionDate: '2026-09-05',
      scheduledJobKey: 'daily-brief:2026-09-05' })).toThrow(/unknown outcome/);
    expect(() => restarted.start({ id: 'manual-retry', editionDate: '2026-09-05' })).not.toThrow();
    expect(() => restarted.start({ id: 'next-day', editionDate: '2026-09-06',
      scheduledJobKey: 'daily-brief:2026-09-06' })).not.toThrow();
  });

  test('restart exposes interrupted status and known usage, without replaying an ambiguous paid edition', () => {
    const db = storage();
    const firstProcess = createGenerationJobs({ ...db, sessionId: 'process-1' });
    start(firstProcess);
    firstProcess.startAttempt('generation-1', attempt);
    firstProcess.usage('generation-1', 1, { inputTokens: 1000, outputTokens: 120, costUsd: 0.0032 });
    expect(firstProcess.status()).toMatchObject({ active: true, latest: { status: 'running' } });

    const restarted = createGenerationJobs({ ...db, sessionId: 'process-2' });
    expect(restarted.status()).toMatchObject({ active: false, latest: { status: 'interrupted', billing: 'unknown-final-usage', automaticRetry: false, costUsd: 0.0032, attempts: [{ usage: { inputTokens: 1000, outputTokens: 120 }, usageComplete: false }] } });
    expect(() => restarted.start({ id: 'generation-2', editionDate: '2026-09-05', scheduledJobKey: 'daily-brief:2026-09-05' })).toThrow(/unknown outcome/);
    expect(JSON.stringify([...db.values.values()])).not.toMatch(/private prompt|private sources|sk-ant-secret/);
    expect(restarted.status().latest).not.toHaveProperty('sessionId');
  });

  test('verified publication resolves a crash between archive save and final status write', () => {
    const db = storage();
    const firstProcess = createGenerationJobs({ ...db, sessionId: 'process-1' });
    start(firstProcess);
    firstProcess.startAttempt('generation-1', attempt);
    const recoverPublished = jest.fn(job => job.id === 'generation-1'
      ? { filename: 'brief-2026-09-05-01.md', generatedAt: '2026-09-05T12:00:00Z', costUsd: 0.004 } : null);
    const restarted = createGenerationJobs({ ...db, sessionId: 'process-2', recoverPublished });
    expect(restarted.status().latest).toMatchObject({ status: 'complete', filename: 'brief-2026-09-05-01.md', costUsd: 0.004, recoveredFromArchive: true });
  });

  test('a complete outcome and per-attempt list rates survive restart', () => {
    const db = storage();
    const jobs = createGenerationJobs({ ...db, sessionId: 'process-1' });
    start(jobs);
    jobs.startAttempt('generation-1', attempt);
    jobs.usage('generation-1', 1, { inputTokens: 100, outputTokens: 100, costUsd: 0.0012 });
    jobs.finishAttempt('generation-1', 1, { stopReason: 'end_turn', failed: false, timedOut: false });
    jobs.finish('generation-1', { status: 'complete', filename: 'brief-2026-09-05-01.md' });
    expect(createGenerationJobs({ ...db, sessionId: 'process-2' }).status().latest).toMatchObject({ status: 'complete', costUsd: 0.0012, attempts: [{ usageComplete: true, pricing: attempt.pricing }] });
  });

  test('a failed job repaired before its ledger update recovers publication without resolving unknown billing', () => {
    const db = storage();
    const jobs = createGenerationJobs({ ...db, sessionId: 'original' });
    start(jobs); jobs.startAttempt('generation-1', attempt);
    jobs.usage('generation-1', 1, { inputTokens: 100, outputTokens: 40, costUsd: 0.0006 });
    jobs.finishAttempt('generation-1', 1, { failed: true });
    jobs.finish('generation-1', { status: 'failed', code: 'E_PROVIDER_INCOMPLETE' });
    const recoverPublished = () => ({ operatorRepaired: true, filename: 'brief-2026-09-05-02.md', generatedAt: '2026-09-06T12:00:00Z', costUsd: 99 });
    const restarted = createGenerationJobs({ ...db, recoverPublished });
    expect(restarted.status().latest).toMatchObject({ status: 'complete', code: 'OPERATOR_REPAIRED', filename: 'brief-2026-09-05-02.md',
      costUsd: 0.0006, billing: 'unknown-final-usage', attempts: [{ status: 'failed', usageComplete: false, usage: { inputTokens: 100, outputTokens: 40 } }] });
    expect(createGenerationJobs({ ...db, recoverPublished: () => ({ filename: 'brief-2026-09-05-01.md' }) }).status().latest.status).toBe('failed');
  });

  test('initial write failure rejects work and later failures never erase the last saved checkpoint', () => {
    const db = storage();
    const jobs = createGenerationJobs({ ...db, sessionId: 'process-1' });
    db.write.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => start(jobs)).toThrow(/accounting could not be saved/);
    expect(jobs.status()).toMatchObject({ persistence: 'error', active: false, latest: null });
    start(jobs);
    jobs.startAttempt('generation-1', attempt);
    jobs.usage('generation-1', 1, { inputTokens: 100, outputTokens: 10, costUsd: 0.0003 });
    db.write.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => jobs.usage('generation-1', 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.0007 })).toThrow(/accounting could not be saved/);
    jobs.release('generation-1');
    expect(jobs.status()).toMatchObject({ persistence: 'error', latest: { status: 'interrupted', attempts: [{ usage: { outputTokens: 10 } }] } });
  });

  test('retention is bounded to 20 jobs and unreadable accounting fails closed', () => {
    const db = storage();
    const jobs = createGenerationJobs(db);
    for (let i = 0; i < 25; i++) {
      jobs.start({ id: `generation-${i}`, editionDate: '2026-09-05' });
      jobs.finish(`generation-${i}`, { status: 'failed', code: 'E006' });
    }
    expect(jobs.status().jobs).toHaveLength(20);
    expect(jobs.status().latest.id).toBe('generation-24');
    const corrupt = createGenerationJobs({ read: () => '{corrupted', write: jest.fn() });
    expect(() => start(corrupt)).toThrow(/accounting/);
    expect(corrupt.status()).toMatchObject({ persistence: 'error', jobs: [] });
  });

  test('invalid persisted job shapes fail closed before overwriting accounting', () => {
    const write = jest.fn();
    const jobs = createGenerationJobs({ read: () => JSON.stringify({ schemaVersion: 1, jobs: [null] }), write });
    expect(() => start(jobs)).toThrow(/accounting/);
    expect(write).not.toHaveBeenCalled();
  });

  test('health polling does not scan archives during active work; failed usage is explicitly incomplete', () => {
    const db = storage();
    const recoverPublished = jest.fn();
    const jobs = createGenerationJobs({ ...db, recoverPublished });
    start(jobs);
    jobs.startAttempt('generation-1', attempt);
    jobs.status();
    expect(recoverPublished).not.toHaveBeenCalled();
    jobs.usage('generation-1', 1, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    jobs.finishAttempt('generation-1', 1, { failed: true, timedOut: false });
    jobs.finish('generation-1', { status: 'failed', code: 'E_GENERATION_FAILED' });
    expect(jobs.status().latest).toMatchObject({ billing: 'unknown-final-usage', attempts: [{ usageComplete: false, billing: 'unknown-final-usage' }] });
  });
});

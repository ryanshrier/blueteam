import { expect, jest, test } from '@jest/globals';
import { normalizeProviderCost, normalizeProviderContract } from '../lib/provider-accounting.js';
import { createGenerationJobs } from '../lib/generation-jobs.js';

const profileIdentity = { id: 'fixture-cli', version: 1, sha256: 'a'.repeat(64) };

test.each([
  { amount: -1, unit: 'credits' }, { amount: Infinity, unit: 'credits' },
  { amount: NaN, unit: 'credits' }, { amount: '1', unit: 'credits' },
  { amount: 1, unit: '' }, { amount: 1, unit: ' ' },
  { amount: 1, unit: 'x'.repeat(33) }, { amount: 1, unit: 'credits\nsecret' },
])('invalid reported provider cost is not retained: %j', value => {
  expect(normalizeProviderCost(value)).toBeNull();
});

test('cost and profile receipts copy bounded metadata without retaining launch details', () => {
  expect(normalizeProviderCost({ amount: 0, unit: 'credits', environment: 'private' }))
    .toEqual({ amount: 0, unit: 'credits' });
  const contract = normalizeProviderContract({ version: 1, profileIdentity: { ...profileIdentity, command: 'private' },
    capabilities: { cancellation: true, externalTools: false }, env: { SECRET: 'private' } });
  expect(contract).toMatchObject({ version: 1, profileIdentity,
    capabilities: { cancellation: true, externalTools: false, systemPrompt: null } });
  expect(JSON.stringify(contract)).not.toContain('private');
  expect(normalizeProviderContract({ profileIdentity: { ...profileIdentity, sha256: 'invalid' } }))
    .not.toHaveProperty('profileIdentity');
});

test('durable CLI cost checkpoints and profile identities survive restart without USD inference', () => {
  const values = new Map();
  const storage = { read: key => values.get(key), write: jest.fn((key, value) => values.set(key, value)) };
  const first = createGenerationJobs({ ...storage, sessionId: 'first' });
  first.start({ id: 'generation-1', editionDate: '2026-10-23', scheduledJobKey: 'daily-brief:2026-10-23' });
  first.startAttempt('generation-1', { model: 'gpt-5.3-codex', provider: 'cli',
    providerContract: { version: 1, profileIdentity, env: { SECRET: 'private' } } });
  first.usage('generation-1', 1, { inputTokens: 100, outputTokens: 20, costUsd: null,
    providerCost: { amount: 0.3, unit: 'credits', secret: 'private' } });
  first.usage('generation-1', 1, { inputTokens: 100, outputTokens: 30, costUsd: null,
    providerCost: { amount: -1, unit: 'credits' } });
  first.finishAttempt('generation-1', 1, { failed: true, completionUncertain: true });
  first.finish('generation-1', { status: 'failed', code: 'E_CLI_INCOMPLETE' });

  const restarted = createGenerationJobs({ ...storage, sessionId: 'restarted' });
  expect(restarted.status().latest).toMatchObject({ costUsd: null, billing: 'unknown-final-usage',
    attempts: [{ provider: 'cli', providerContract: { version: 1, profileIdentity }, costUsd: null,
      providerCost: { amount: 0.3, unit: 'credits' }, completionUncertain: true, usageComplete: false,
      usage: { inputTokens: 100, outputTokens: 30 } }] });
  expect(() => restarted.start({ id: 'automatic-retry', editionDate: '2026-10-23', scheduledJobKey: 'daily-brief:2026-10-23' }))
    .toThrow('unknown outcome');
  expect(() => restarted.start({ id: 'manual-retry', editionDate: '2026-10-23' })).not.toThrow();
  expect(JSON.stringify([...values.values()])).not.toContain('private');
});

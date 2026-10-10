import { expect, test } from '@jest/globals';
import { scheduledBriefDelivery } from '../lib/brief-delivery.js';

test.each([
  ['awaiting-review', 'awaiting-review'], ['failed', 'failed'], ['attempt-limit', 'failed'],
  ['waiting-for-key', 'failed'], ['skipped', 'missed'], ['reconcile-pending', 'reconciliation-pending'],
])('scheduled outcome %s needs operational attention without retrying', (outcome, status) => {
  expect(scheduledBriefDelivery({ enabled: true, outcome })).toMatchObject({ status, needsAttention: true });
});
test.each(['running', 'success', 'scheduled', 'catch-up-pending'])('normal schedule outcome %s stays distinct from failure', outcome => {
  expect(scheduledBriefDelivery({ enabled: true, outcome }).needsAttention).toBe(false);
});
test('disabled scheduling and unknown status do not claim missed publication', () => {
  expect(scheduledBriefDelivery({ enabled: false, outcome: 'failed' })).toMatchObject({ status: 'disabled', needsAttention: false });
  expect(scheduledBriefDelivery(null)).toMatchObject({ status: 'unknown', needsAttention: false });
});
test('an overdue scheduled attempt surfaces as missed while in-flight work stays running', () => {
  const schedule = { enabled: true, outcome: 'scheduled', nextAttemptAt: '2026-10-09T05:00:00Z' };
  const options = { now: Date.parse('2026-10-09T05:10:00Z') };
  expect(scheduledBriefDelivery(schedule, options)).toMatchObject({ status: 'missed', needsAttention: true });
  expect(scheduledBriefDelivery({ ...schedule, outcome: 'running' }, options)).toMatchObject({ status: 'running', needsAttention: false });
});

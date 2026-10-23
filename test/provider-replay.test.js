import { expect, test } from '@jest/globals';
import { parseProviderReplay, replayProviderEvents, MAX_PROVIDER_REPLAY_BYTES } from '../lib/provider-replay.js';

const captured = { schemaVersion: 1, model: 'custom-recorded', cases: [{ id: 'synthetic-case', attempts: [[
  { type: 'message_start', message: { model: 'returned-model', usage: { input_tokens: 12 } } },
  { type: 'content_block_delta', delta: { text: 'Threat — résumé\n<!-- briefing-metadata {} -->' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 34, cost_usd: 0.5 } },
  { type: 'message_stop' },
]] }] };

test('offline replay preserves final raw text, hidden comments, actual model and cumulative usage', async () => {
  const parsed = parseProviderReplay(JSON.stringify(captured));
  const events = await Array.fromAsync(replayProviderEvents(parsed, 'synthetic-case', 0));
  expect(events).toEqual(captured.cases[0].attempts[0]);
  events[0].message.model = 'changed-by-consumer';
  expect(parsed.cases[0].attempts[0][0].message.model).toBe('returned-model');
});

test('replay obeys cancellation and never invents a missing retry or completion', async () => {
  const controller = new AbortController();
  const iterator = replayProviderEvents(captured, 'synthetic-case', 0, { signal: controller.signal });
  await iterator.next();
  controller.abort(new Error('fixture cancelled'));
  await expect(iterator.next()).rejects.toThrow('fixture cancelled');
  await expect(Array.fromAsync(replayProviderEvents(captured, 'synthetic-case', 1))).rejects.toThrow('No recorded response');
  const incomplete = structuredClone(captured);
  incomplete.cases[0].attempts[0].pop();
  incomplete.cases[0].attempts[0].at(-1).delta.stop_reason = 'length';
  expect((await Array.fromAsync(replayProviderEvents(parseProviderReplay(JSON.stringify(incomplete)), 'synthetic-case', 0))).at(-1).delta.stop_reason).toBe('length');
});

test.each([
  { ...captured, schemaVersion: 2 },
  { ...captured, model: '../executable-module.js' },
  { ...captured, model: 123 },
  { ...captured, cases: [] },
  { ...captured, cases: [captured.cases[0], captured.cases[0]] },
  { ...captured, cases: [{ id: 'synthetic-case', attempts: [[{ type: 'tool_call', command: 'never-run' }]] }] },
  { ...captured, cases: [{ id: 'synthetic-case', attempts: [[{ type: 'content_block_delta', delta: { text: {} } }]] }] },
])('rejects invalid replay structure without executing anything: %j', value => {
  expect(() => parseProviderReplay(JSON.stringify(value))).toThrow();
});

test('bounds replay bytes before JSON parsing', () => {
  expect(() => parseProviderReplay('x'.repeat(MAX_PROVIDER_REPLAY_BYTES + 1))).toThrow('size bound');
});

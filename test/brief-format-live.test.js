import { test, expect } from '@jest/globals';
import { runFormatLive, reserveFormatRequest, FORMAT_MODEL, FORMAT_OUTPUT_TOKENS, usageCost } from '../scripts/lib/brief-format-live.mjs';

test('budget is reserved before a call and cached/uncached usage is counted once', () => {
  const params = { model: FORMAT_MODEL, max_tokens: FORMAT_OUTPUT_TOKENS, system: 'test', messages: [] };
  expect(reserveFormatRequest(params, 0, 2)).toBeGreaterThan(0.08);
  expect(() => reserveFormatRequest(params, 1.99, 2)).toThrow('budget exhausted');
  expect(() => reserveFormatRequest(params, 0, 3)).toThrow('bounds');
  expect(usageCost({ input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 500 } })).toBeCloseTo(0.00305);
  expect(usageCost({ input_tokens: 1000, output_tokens: 200, input_tokens_details: { cache_write_tokens: 1000 } })).toBeCloseTo(0.0045);
  expect(usageCost(null)).toBeNull();
});

test('live runner uses identical controls, counterbalanced order, no retries and explicit nonstorage', async () => {
  const requests = [], snapshots = [];
  const fetchImpl = async (url, options) => {
    requests.push(JSON.parse(options.body));
    expect(snapshots.at(-1).attempts.at(-1).status).toBe('reserved');
    const events = [
      { type: 'response.output_text.delta', delta: 'Synthetic answer' },
      { type: 'response.completed', response: { model: FORMAT_MODEL, usage: { input_tokens: 100, output_tokens: 200 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const report = await runFormatLive({ key: 'synthetic', prompts: { current: 'current', proposed: 'proposed' }, userPrompt: 'evidence', budget: 2,
    fetchImpl, onUpdate: state => snapshots.push(structuredClone(state)) });
  expect(report.finished).toBe(true);
  expect(requests.map(row => row.instructions)).toEqual(['current', 'proposed', 'proposed', 'current']);
  for (const row of requests) expect(row).toMatchObject({ model: FORMAT_MODEL, store: false, stream: true, service_tier: 'default', max_output_tokens: 8000,
    reasoning: { effort: 'low' }, input: [{ role: 'user', content: 'evidence' }] });
  expect(JSON.stringify(report)).not.toContain('Bearer');
  expect(report.conservativeReservationUsd).toBeLessThan(2);
});

test('uncertain completion stops further requests and retains a reservation without exposing remote errors', async () => {
  let calls = 0;
  const report = await runFormatLive({ key: 'synthetic', prompts: { current: 'current', proposed: 'proposed' }, userPrompt: 'evidence', budget: 2,
    fetchImpl: async () => { calls++; throw new Error('secret-bearing remote text'); } });
  expect(calls).toBe(1);
  expect(report.finished).toBe(false);
  expect(report.estimatedCostUsd).toBeNull();
  expect(report.conservativeReservationUsd).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain('secret-bearing');
});

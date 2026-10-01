import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const originalFetch = globalThis.fetch;
beforeEach(() => jest.resetModules());
afterEach(() => { globalThis.fetch = originalFetch; jest.useRealTimers(); });

test('fresh history bypasses a pending older read and its late result cannot poison the cache', async () => {
  const { fetchBriefs } = await import('../public/modules/core/api.js');
  let finishOld, finishFresh;
  globalThis.fetch = jest.fn()
    .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { finishFresh = resolve; }));
  const old = fetchBriefs();
  const fresh = fetchBriefs({ fresh: true });
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  finishFresh({ ok: true, json: async () => ['new edition'] });
  await expect(fresh).resolves.toEqual(['new edition']);
  finishOld({ ok: true, json: async () => ['old edition'] });
  await expect(old).resolves.toEqual(['old edition']);
  await expect(fetchBriefs()).resolves.toEqual(['new edition']);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

test('headers that never arrive time out with an unknown-outcome warning', async () => {
  jest.useFakeTimers();
  const { generateBrief } = await import('../public/modules/core/api.js');
  globalThis.fetch = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = generateBrief();
  const result = expect(pending).rejects.toMatchObject({ streamLost: true, message: expect.stringContaining('Check generation status') });
  await jest.advanceTimersByTimeAsync(15_000);
  await result;
});

test('the initial request timeout is removed once SSE response headers arrive', async () => {
  jest.useFakeTimers();
  const { generateBrief } = await import('../public/modules/core/api.js');
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  await generateBrief();
  const signal = globalThis.fetch.mock.calls[0][1].signal;
  await jest.advanceTimersByTimeAsync(90_000);
  expect(signal.aborted).toBe(false);
});

test('error headers with a stalled JSON body remain bounded and preserve the HTTP failure class', async () => {
  jest.useFakeTimers();
  const { generateBrief } = await import('../public/modules/core/api.js');
  globalThis.fetch = jest.fn(async (_url, { signal }) => ({ ok: false, status: 429, headers: { get: () => '15' },
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }));
  const pending = generateBrief();
  const result = expect(pending).rejects.toMatchObject({ code: 'E_RATE_LIMIT' });
  await jest.advanceTimersByTimeAsync(15_000);
  await result;
});

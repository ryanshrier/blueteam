import { afterEach, expect, jest, test } from '@jest/globals';
import { fetchGenerationStatus, generationStatusModel, mountGenerationStatus } from '../public/modules/briefing/generation-status.js';

const failed = () => ({ persistence: 'ok', active: false, latest: {
  status: 'failed', code: 'E006', editionDate: '2026-09-05',
  completedAt: '2026-09-05T16:30:00Z', costUsd: 0.377646, billing: 'provider-usage-recorded',
} });
const host = () => ({ hidden: true, dataset: {}, innerHTML: '',
  addEventListener: jest.fn(), removeEventListener: jest.fn() });
afterEach(() => jest.useRealTimers());

test('saved failed publication accounting presents the cost without publishing a draft', () => {
  const model = generationStatusModel(failed());
  expect(model).toMatchObject({ kind: 'failed', code: 'E006', filename: '', poll: false });
  expect(model.message).toContain('No edition was published');
  expect(model.billing).toContain('$0.3776');
});

test('unknown final usage never appears as a final complete cost or automatically retries', () => {
  const data = failed();
  data.latest.status = 'interrupted';
  data.latest.billing = 'unknown-final-usage';
  expect(generationStatusModel(data)).toMatchObject({
    kind: 'interrupted', poll: false, filename: '',
    billing: 'Recorded estimate $0.3776; final usage is unknown.',
  });
  data.latest.costUsd = null;
  expect(generationStatusModel(data).billing).not.toContain('$0');
});

test('remounting independently reloads and retains the failed attempt while repeated checks keep disclosure DOM intact', async () => {
  const load = jest.fn().mockResolvedValue(failed());
  const first = host();
  const ui = mountGenerationStatus(first, { load });
  await ui.refresh();
  expect(first.hidden).toBe(false);
  expect(first.innerHTML).toContain('Attempt details');
  expect(first.innerHTML).toContain('$0.3776');
  first.innerHTML += '<!-- open disclosure sentinel -->';
  await ui.refresh();
  expect(first.innerHTML).toContain('open disclosure sentinel');
  ui.stop();
  const second = host();
  const next = mountGenerationStatus(second, { load });
  await next.refresh();
  expect(second.innerHTML).toContain('No edition was published');
  expect(load).toHaveBeenCalledTimes(3);
  next.stop();
});

test('active status polls to completion and stopping prevents detached asynchronous paint', async () => {
  jest.useFakeTimers();
  const load = jest.fn().mockResolvedValueOnce({ persistence: 'ok', active: true, latest: { status: 'running' } })
    .mockResolvedValueOnce({ persistence: 'ok', active: false, latest: { status: 'complete', filename: 'brief-2026-09-05.md' } });
  const el = host();
  const ui = mountGenerationStatus(el, { load });
  await ui.refresh();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(el.innerHTML).toContain('/briefing/brief-2026-09-05.md');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(2);
  let finish;
  load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = ui.refresh();
  const before = el.innerHTML;
  ui.stop();
  finish(failed());
  await pending;
  expect(el.innerHTML).toBe(before);
});

test('newer refresh wins and failures replace old success with an honest retry affordance', async () => {
  let finish;
  const load = jest.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(failed()).mockRejectedValueOnce(new Error('offline'));
  const el = host();
  const ui = mountGenerationStatus(el, { load });
  const older = ui.refresh();
  await ui.refresh();
  finish({ persistence: 'ok', latest: null });
  await older;
  expect(el.innerHTML).toContain('$0.3776');
  await ui.refresh();
  expect(el.innerHTML).toContain('Retry status check');
  expect(el.innerHTML).not.toContain('$0.3776');
  ui.stop();
});

test('status fetch accepts structured accounting failure and rejects an unrelated 503', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ persistence: 'error' }) })
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'upstream' }) });
  try {
    await expect(fetchGenerationStatus()).resolves.toEqual({ persistence: 'error' });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/brief/status', expect.objectContaining({ cache: 'no-store' }));
    await expect(fetchGenerationStatus()).rejects.toThrow('Generation status unavailable');
  } finally { globalThis.fetch = original; }
});

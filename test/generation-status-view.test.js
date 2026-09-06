import { afterEach, expect, jest, test } from '@jest/globals';
import { fetchGenerationStatus, generationStatusModel, mountGenerationStatus } from '../public/modules/briefing/generation-status.js';

const failed = () => ({ persistence: 'ok', active: false, latest: {
  status: 'failed', code: 'E006', editionDate: '2026-09-05',
  completedAt: '2026-09-05T16:30:00Z', costUsd: 0.377646, billing: 'provider-usage-recorded',
} });
const host = () => {
  const button = { disabled: false, textContent: 'Retry status check' };
  return { hidden: true, dataset: {}, innerHTML: '', setAttribute: jest.fn(),
    querySelector(selector) { return selector === '[data-refresh-generation]' && this.innerHTML.includes('data-refresh-generation') ? button : null; },
    addEventListener: jest.fn(), removeEventListener: jest.fn() };
};
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
  expect(el.innerHTML).toContain('<details class="brief-attempt-complete">');
  expect(el.innerHTML).not.toContain('<details class="brief-attempt-complete" open');
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

test('a transient status failure recovers the completed outcome without another generation', async () => {
  jest.useFakeTimers();
  const load = jest.fn().mockRejectedValueOnce(new Error('connection reset'))
    .mockResolvedValueOnce(failed());
  const el = host();
  const ui = mountGenerationStatus(el, { load });
  await ui.refresh();
  expect(el.innerHTML).toContain('Checking again shortly');
  await jest.advanceTimersByTimeAsync(5_000);
  expect(el.innerHTML).toContain('No edition was published');
  expect(el.innerHTML).toContain('$0.3776');
  await jest.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(2);
  ui.stop();
});

test('active accounting polling resumes after a transient fetch failure', async () => {
  jest.useFakeTimers();
  const running = { persistence: 'ok', active: true, latest: { status: 'running' } };
  const load = jest.fn().mockResolvedValueOnce(running).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(running).mockResolvedValueOnce(failed());
  const el = host();
  const ui = mountGenerationStatus(el, { load });
  await ui.refresh();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(el.dataset.state).toBe('unavailable');
  await jest.advanceTimersByTimeAsync(5_000);
  expect(el.dataset.state).toBe('running');
  await jest.advanceTimersByTimeAsync(10_000);
  expect(el.dataset.state).toBe('failed');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(4);
  ui.stop();
});

test('status failure retries are bounded and manual retry shows checking until the request settles', async () => {
  jest.useFakeTimers();
  const load = jest.fn().mockRejectedValue(new Error('offline'));
  const el = host();
  const ui = mountGenerationStatus(el, { load });
  await ui.refresh();
  await jest.advanceTimersByTimeAsync(65_000);
  expect(load).toHaveBeenCalledTimes(3);
  expect(el.innerHTML).toContain('Retry the status check before starting another attempt');
  let resolve;
  load.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const button = el.querySelector('[data-refresh-generation]');
  const click = el.addEventListener.mock.calls.find(([type]) => type === 'click')[1];
  click({ target: { closest: () => button } });
  expect(button).toMatchObject({ disabled: true, textContent: 'Checking status…' });
  expect(el.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'true');
  click({ target: { closest: () => button } });
  expect(load).toHaveBeenCalledTimes(4);
  resolve(failed());
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(el.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'false');
  expect(el.innerHTML).toContain('$0.3776');
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

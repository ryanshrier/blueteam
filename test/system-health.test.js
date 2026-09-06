import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fetchDiagnostics } from '../public/modules/core/api.js';
import { createDiagnosticsController, sanitizeDiagnostics } from '../public/modules/settings/system-health.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const healthy = () => ({ status: 'ok', version: '1.0.3', uptime: 3600,
  pipeline: { lastRun: '2026-09-05T12:00:00Z', ageSeconds: 60, headlines: 12, stale: false },
  feeds: { ok: 2, total: 2, configured: 2, fresh: 2, health: { 'Publisher One': 'ok', 'Publisher Two': 'empty' } },
  configReloadError: null, database: { size_mb: 18.6, status: 'ok' },
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('readiness diagnostics API', () => {
  test('reads degraded 503 diagnostics and checks again without an API cache', async () => {
    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ ...healthy(), status: 'degraded' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => healthy() });
    expect((await fetchDiagnostics()).status).toBe('degraded');
    expect((await fetchDiagnostics()).status).toBe('ok');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/ready');
    expect(globalThis.fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(globalThis.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    [401, { status: 'ok' }], [502, { status: 'degraded' }],
    [503, { error: 'proxy credentials must not reach the page' }],
    [503, { status: 'ok' }], [200, { status: 'unknown' }],
  ])('treats HTTP %s without the readiness contract as unavailable', async (status, body) => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: status === 200, status, json: async () => body });
    await expect(fetchDiagnostics()).rejects.toThrow('Diagnostics unavailable');
  });
});

describe('sanitized diagnostics', () => {
  test('copies only typed operational fields and aggregates reasons without source identities or raw details', () => {
    const data = { ...healthy(), anthropicKey: 'secret-api-key', profile: 'PRIVATE PROFILE',
      version: '1.0.3-secret-api-key', uptimeHuman: 'secret-api-key',
      configReloadError: { message: 'https://user:secret@private.test/config', at: '2026-09-05T12:00:00Z' },
      pipeline: { ...healthy().pipeline, error: 'SECRET PIPELINE', endpoint: 'https://private.test' },
      feeds: { ...healthy().feeds, health: {
        'https://user:secret@private.test/feed': 'http-503',
        'Internal Source Name': 'parse-error',
        'Another private source': 'https://secret.test/error',
      } },
      database: { ...healthy().database, path: 'C:/private/database' },
      search: { url: 'https://private.test' }, config: { secret: 'SECRET CONFIG' },
    };
    const report = sanitizeDiagnostics(data);
    expect(report).toMatchObject({ status: 'ok', uptimeSeconds: 3600,
      configReloadRejected: true, database: { sizeMb: 18.6, status: 'ok' },
      feeds: { issueCounts: { 'http-503': 1, 'parse-error': 1, unknown: 1 } },
    });
    expect(report).not.toHaveProperty('version');
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/secret|private|profile|https:|Internal Source|Another private/i);
    expect(data.configReloadError.message).toContain('secret'); // no mutation of source payload
  });

  test('retains missing values as unknown and supports minimal unauthenticated readiness', () => {
    expect(sanitizeDiagnostics({ status: 'degraded' })).toEqual({ status: 'degraded' });
    expect(sanitizeDiagnostics({ status: 'ok', uptime: -2,
      pipeline: { lastRun: 'not a timestamp', ageSeconds: null, headlines: '4', stale: 'false' },
      database: { size_mb: Infinity, status: 'raw error details' },
    })).toEqual({ status: 'ok', pipeline: { lastRefreshAt: null, ageSeconds: null, headlines: null, stale: null }, database: { sizeMb: null, status: 'unknown' } });
  });
});

describe('System health request and clipboard lifecycle', () => {
  test('retains a dated last-good snapshot through failure and replaces it on recovery', async () => {
    const load = jest.fn().mockResolvedValueOnce({ ...healthy(), status: 'degraded' })
      .mockRejectedValueOnce(new Error('secret endpoint details'))
      .mockResolvedValueOnce(healthy());
    const changes = [];
    const clipboard = jest.fn().mockResolvedValue();
    const controller = createDiagnosticsController({ load, onChange: state => changes.push(state.phase),
      now: () => '2026-09-05T12:01:00Z', writeClipboard: clipboard });
    await controller.refresh();
    expect(controller.getState().phase).toBe('degraded');
    const previous = controller.getState().snapshot;
    await controller.refresh();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', snapshot: previous, checkedAt: '2026-09-05T12:01:00.000Z' });
    await controller.copy();
    expect(JSON.parse(clipboard.mock.calls[0][0])).toMatchObject({ diagnosticsState: 'unavailable', status: 'degraded', lastSuccessfulCheckAt: '2026-09-05T12:01:00.000Z' });
    expect(clipboard.mock.calls[0][0]).not.toContain('secret endpoint');
    await controller.refresh();
    expect(controller.getState().phase).toBe('healthy');
    expect(controller.getState().snapshot.status).toBe('ok');
    expect(changes).toEqual(['loading', 'degraded', 'loading', 'unavailable', 'unavailable', 'loading', 'healthy']);
    controller.dispose();
  });

  test('a slow superseded response cannot overwrite the latest health result', async () => {
    const first = deferred();
    const second = deferred();
    const load = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const controller = createDiagnosticsController({ load });
    const oldRequest = controller.refresh();
    const newRequest = controller.refresh();
    expect(load.mock.calls[0][0].signal.aborted).toBe(true);
    second.resolve({ ...healthy(), status: 'degraded' });
    await newRequest;
    first.resolve(healthy());
    await oldRequest;
    expect(controller.getState().phase).toBe('degraded');
    controller.dispose();
  });

  test('unmount aborts the request and ignores subsequent resolution or refresh', async () => {
    const pending = deferred();
    const load = jest.fn().mockReturnValue(pending.promise);
    const onChange = jest.fn();
    const controller = createDiagnosticsController({ load, onChange });
    const request = controller.refresh();
    controller.dispose();
    expect(load.mock.calls[0][0].signal.aborted).toBe(true);
    pending.resolve(healthy());
    await request;
    await controller.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(controller.getState().snapshot).toBeNull();
  });

  test('clipboard failure exposes only the safe report and supports a successful retry', async () => {
    const writeClipboard = jest.fn().mockRejectedValueOnce(new Error('SECRET CLIPBOARD CONTEXT')).mockResolvedValueOnce();
    const controller = createDiagnosticsController({ load: async () => healthy(), writeClipboard });
    await controller.refresh();
    const fallback = await controller.copy();
    expect(JSON.parse(fallback).status).toBe('ok');
    expect(controller.getState().feedback).toBe('Clipboard unavailable. Select and copy the sanitized report below.');
    expect(controller.getState().feedback).not.toContain('SECRET');
    await controller.copy();
    expect(controller.getState().feedback).toBe('Sanitized diagnostics copied.');
    controller.dispose();
  });

  test('clipboard completion after unmount cannot publish feedback', async () => {
    const pending = deferred();
    const onChange = jest.fn();
    const controller = createDiagnosticsController({ load: async () => healthy(), writeClipboard: () => pending.promise, onChange });
    await controller.refresh();
    const copy = controller.copy();
    controller.dispose();
    pending.resolve();
    await copy;
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(controller.getState().feedback).toBe('');
  });

  test('a superseded copy cannot replace the current fallback report after refresh', async () => {
    const oldCopy = deferred();
    const load = jest.fn().mockResolvedValueOnce(healthy()).mockResolvedValueOnce({ ...healthy(), version: '1.0.4' });
    const writeClipboard = jest.fn().mockReturnValueOnce(oldCopy.promise).mockRejectedValueOnce(new Error('denied'));
    const controller = createDiagnosticsController({ load, writeClipboard });
    await controller.refresh();
    const pending = controller.copy();
    await controller.refresh();
    const currentReport = await controller.copy();
    expect(JSON.parse(currentReport).version).toBe('1.0.4');
    oldCopy.resolve();
    expect(await pending).toBeUndefined();
    expect(controller.getState().feedback).toMatch(/^Clipboard unavailable/);
    controller.dispose();
  });
});

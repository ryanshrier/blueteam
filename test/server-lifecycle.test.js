import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createShutdownCoordinator } from '../lib/server-lifecycle.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const safeFetch = jest.fn();
const readCapped = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch, readCapped }));
jest.unstable_mockModule('../lib/logger.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let db;
beforeEach(async () => {
  jest.resetModules();
  safeFetch.mockReset();
  readCapped.mockReset();
  db = await import('../lib/db.js');
  db.initDB(':memory:');
});
afterEach(() => {
  db.closeDB();
  jest.useRealTimers();
});

describe('server shutdown ordering', () => {
  test.each(['download', 'cache fallback'])('drains real KEV %s before a single outbound/storage close', async mode => {
    const { refreshKEV } = await import('../lib/enrichment.js');
    const response = deferred();
    safeFetch.mockReturnValue(response.promise);
    const cachedCve = 'CVE-2026-10001';
    const freshCve = 'CVE-2026-10002';
    db.bulkInsertKEV([{ cveID: cachedCve, dateAdded: '2026-09-01' }]);
    readCapped.mockResolvedValue(JSON.stringify({ vulnerabilities: [{ cveID: freshCve, dateAdded: '2026-09-05' }] }));
    const bootWarmup = refreshKEV();
    const resources = [];
    const stopped = jest.fn();
    const drained = deferred();
    const closeOutbound = jest.fn(() => {
      resources.push('outbound');
      expect(db.getKEVSet().has(mode === 'download' ? freshCve : cachedCve)).toBe(true);
    });
    const closeStorage = jest.fn(() => { resources.push('storage'); db.closeDB(); });
    const shutdown = createShutdownCoordinator({
      stopWork: [stopped],
      requestDrains: [() => Promise.resolve()],
      backgroundDrains: [() => { drained.resolve(); return bootWarmup; }],
      closeOutbound, closeStorage, onTimeout: jest.fn(),
    });
    const completion = shutdown(30_000);
    expect(shutdown(30_000)).toBe(completion);
    await drained.promise;
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(resources).toEqual([]);
    if (mode === 'download') response.resolve({ ok: true });
    else response.reject(new Error('catalog download failed'));
    await expect(bootWarmup).resolves.toContain(mode === 'download' ? freshCve : cachedCve);
    await expect(completion).resolves.toEqual({ forced: false });
    expect(resources).toEqual(['outbound', 'storage']);
    expect(closeOutbound).toHaveBeenCalledTimes(1);
    expect(closeStorage).toHaveBeenCalledTimes(1);
  });

  test('a rejected drain cannot close storage while another task or outbound cleanup is pending', async () => {
    const work = deferred();
    const outbound = deferred();
    const reachedDrain = deferred();
    const reachedOutbound = deferred();
    const onError = jest.fn();
    const closeStorage = jest.fn();
    const failure = new Error('background task failed');
    const shutdown = createShutdownCoordinator({
      backgroundDrains: [
        () => Promise.reject(failure),
        () => { reachedDrain.resolve(); return work.promise; },
      ],
      closeOutbound: () => { reachedOutbound.resolve(); return outbound.promise; },
      closeStorage, onError, onTimeout: jest.fn(),
    });
    const completion = shutdown(30_000);
    await reachedDrain.promise;
    expect(closeStorage).not.toHaveBeenCalled();
    work.resolve();
    await reachedOutbound.promise;
    expect(onError).toHaveBeenCalledWith(failure);
    expect(closeStorage).not.toHaveBeenCalled();
    outbound.resolve();
    await completion;
    expect(closeStorage).toHaveBeenCalledTimes(1);
  });

  test('captures background work begun by an already accepted request after shutdown starts', async () => {
    const request = deferred();
    const background = deferred();
    const reachedDrain = deferred();
    let currentWork = null;
    const closeStorage = jest.fn();
    const shutdown = createShutdownCoordinator({
      requestDrains: [() => request.promise.then(() => { currentWork = background.promise; })],
      backgroundDrains: [() => { reachedDrain.resolve(); return currentWork; }],
      closeOutbound: jest.fn(), closeStorage, onTimeout: jest.fn(),
    });
    const completion = shutdown(30_000);
    request.resolve();
    await reachedDrain.promise;
    expect(currentWork).toBe(background.promise);
    expect(closeStorage).not.toHaveBeenCalled();
    background.resolve();
    await completion;
    expect(closeStorage).toHaveBeenCalledTimes(1);
  });

  test('a stuck drain reaches the hard-exit deadline without closing resources under live work', async () => {
    jest.useFakeTimers();
    const work = deferred();
    const onTimeout = jest.fn();
    const closeOutbound = jest.fn();
    const closeStorage = jest.fn();
    const shutdown = createShutdownCoordinator({
      backgroundDrains: [() => work.promise],
      closeOutbound, closeStorage, onTimeout,
    });
    const completion = shutdown(100);
    await jest.advanceTimersByTimeAsync(100);
    await expect(completion).resolves.toEqual({ forced: true });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(100);
    expect(closeOutbound).not.toHaveBeenCalled();
    expect(closeStorage).not.toHaveBeenCalled();
    // The real callback exits the process. A returning test callback must not
    // allow late settlement to perform unsafe cleanup either.
    work.resolve();
    await jest.advanceTimersByTimeAsync(1);
    expect(shutdown(100)).toBe(completion);
    expect(closeStorage).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// BlueTeam.News — lib/refresher.js run-lifecycle + rehydration tests.
//
// This module decides whether the Wall shows live intel, honest stale intel,
// or a blank board — a regression here (double pipeline runs, or a crash loop
// on a corrupt boot snapshot) hits every deployment at the moment the
// operator is least able to debug: restart. See finding #107.
//
// lib/feeds.js's runIntelligencePipeline and lib/alerts.js's dispatchAlerts
// are mocked (jest.unstable_mockModule, the net-ssrf.test.js pattern) so the
// pipeline call count and timing are controllable; lib/db.js is real
// (initDB(':memory:')) so persistLatestRun/rehydrateLatestRun round-trip for
// real through the meta table.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// A controllable deferred so a test can hold the "pipeline" open and assert
// concurrent refreshNow() callers share the one in-flight run.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const runIntelligencePipelineMock = jest.fn();
const dispatchAlertsMock = jest.fn(() => Promise.resolve());
const getConfigMock = jest.fn(() => ({ analysisSettings: { refreshMinutes: 10, headlineArchiveDays: 14 } }));

jest.unstable_mockModule('../lib/feeds.js', () => ({
  runIntelligencePipeline: runIntelligencePipelineMock,
}));
jest.unstable_mockModule('../lib/alerts.js', () => ({
  dispatchAlerts: dispatchAlertsMock,
}));
jest.unstable_mockModule('../lib/config.js', () => ({
  getConfig: getConfigMock,
}));

const { initDB, closeDB, setMeta } = await import('../lib/db.js');
const refresher = await import('../lib/refresher.js');

describe('refresher — run lifecycle', () => {
  beforeEach(() => {
    initDB(':memory:');
    runIntelligencePipelineMock.mockReset();
    dispatchAlertsMock.mockReset().mockReturnValue(Promise.resolve());
    getConfigMock.mockReturnValue({ analysisSettings: { refreshMinutes: 10, headlineArchiveDays: 14 } });
    refresher.stopRefreshSchedule();
    refresher._resetForTests();
  });
  afterEach(() => {
    refresher.stopRefreshSchedule();
    closeDB();
  });

  test('concurrent refreshNow callers share one in-flight run (pipeline invoked once)', async () => {
    const d = deferred();
    runIntelligencePipelineMock.mockReturnValue(d.promise);

    const p1 = refresher.refreshNow('a');
    const p2 = refresher.refreshNow('b');
    expect(runIntelligencePipelineMock).toHaveBeenCalledTimes(1);

    d.resolve({ headlines: [{ title: 'x' }], stats: {} });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2); // same run object returned to both callers
    expect(runIntelligencePipelineMock).toHaveBeenCalledTimes(1);
  });

  test('a throwing pipeline clears refreshInFlight so the next call retries', async () => {
    runIntelligencePipelineMock.mockRejectedValueOnce(new Error('feed fetch exploded'));
    await expect(refresher.refreshNow('fails')).rejects.toThrow('feed fetch exploded');

    runIntelligencePipelineMock.mockResolvedValueOnce({ headlines: [{ title: 'y' }], stats: {} });
    const run = await refresher.refreshNow('retry');
    expect(run.headlines).toEqual([{ title: 'y' }]);
    expect(runIntelligencePipelineMock).toHaveBeenCalledTimes(2);
  });

  test('a successful run is exposed via getLatestRun/getRunAgeMs', async () => {
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'z' }], stats: {} });
    await refresher.refreshNow('ok');
    expect(refresher.getLatestRun().headlines).toEqual([{ title: 'z' }]);
    expect(refresher.getRunAgeMs()).toBeLessThan(5000);
  });

  test('an empty refresh preserves the last-good run instead of replacing it', async () => {
    runIntelligencePipelineMock.mockResolvedValueOnce({ headlines: [{ title: 'last good' }], stats: { rss: 12 } });
    const good = await refresher.refreshNow('seed');

    runIntelligencePipelineMock.mockResolvedValueOnce({ headlines: [], stats: { rss: 0 } });
    const retained = await refresher.refreshNow('scheduled');

    expect(retained).toBe(good);
    expect(refresher.getLatestRun().headlines).toEqual([{ title: 'last good' }]);
    expect(dispatchAlertsMock).toHaveBeenCalledTimes(1);
  });

  test('archive-write failure is non-blocking — refreshNow still resolves with the run', async () => {
    // A headline missing `title` violates headline_archive's NOT NULL column,
    // so archiveHeadlines throws inside refreshNow's inner try/catch. The
    // fix under test is that this is caught and logged (see the archive
    // write try/catch in refresher.js) rather than rejecting the whole run.
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'ok one' }, {}], stats: {} });
    const run = await refresher.refreshNow('archive');
    expect(run.headlines).toEqual([{ title: 'ok one' }, {}]);
  });

  test('dispatchAlerts is invoked with the run headlines and config, not awaited before returning', async () => {
    const alertsDeferred = deferred();
    dispatchAlertsMock.mockReturnValue(alertsDeferred.promise);
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'alert me', alertMatched: true }], stats: {} });

    const run = await refresher.refreshNow('alerts');
    expect(run).toBeTruthy(); // refreshNow resolved without waiting on the alert dispatch
    expect(dispatchAlertsMock).toHaveBeenCalledTimes(1);
    alertsDeferred.resolve(); // let it settle so the test doesn't leave a dangling promise
  });
});

describe('refresher — rehydration', () => {
  beforeEach(() => {
    initDB(':memory:');
    runIntelligencePipelineMock.mockReset();
    refresher.stopRefreshSchedule();
    refresher._resetForTests();
  });
  afterEach(() => {
    refresher.stopRefreshSchedule();
    closeDB();
  });

  test('rehydrateLatestRun restores a well-formed snapshot from the meta table', () => {
    const snapshot = { headlines: [{ title: 'restored' }], stats: {}, generatedAt: new Date().toISOString(), generatedAtMs: Date.now() - 60_000 };
    setMeta('latest_run', JSON.stringify(snapshot));
    refresher.rehydrateLatestRun();
    expect(refresher.getLatestRun().headlines).toEqual([{ title: 'restored' }]);
  });

  test('rehydrateLatestRun tolerates corrupt JSON in the meta table — logs and continues, no throw', () => {
    setMeta('latest_run', '{not valid json');
    expect(() => refresher.rehydrateLatestRun()).not.toThrow();
    expect(refresher.getLatestRun()).toBeNull();
  });

  test('rehydrateLatestRun tolerates a partial/malformed snapshot (missing generatedAtMs)', () => {
    setMeta('latest_run', JSON.stringify({ headlines: [{ title: 'x' }] })); // no generatedAtMs
    expect(() => refresher.rehydrateLatestRun()).not.toThrow();
    expect(refresher.getLatestRun()).toBeNull(); // rejected — not a valid run shape
  });

  test('rehydrateLatestRun is a no-op once a run is already in memory', async () => {
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'live' }], stats: {} });
    await refresher.refreshNow('live-run');
    setMeta('latest_run', JSON.stringify({ headlines: [{ title: 'stale-snapshot' }], stats: {}, generatedAt: new Date().toISOString(), generatedAtMs: Date.now() }));
    refresher.rehydrateLatestRun();
    expect(refresher.getLatestRun().headlines).toEqual([{ title: 'live' }]); // unchanged
  });
});

describe('refresher — getFreshRun staleness boundary', () => {
  beforeEach(() => {
    initDB(':memory:');
    runIntelligencePipelineMock.mockReset();
    refresher.stopRefreshSchedule();
    refresher._resetForTests();
  });
  afterEach(() => {
    refresher.stopRefreshSchedule();
    closeDB();
  });

  test('serves the cached run when its age is <= maxAgeMs', async () => {
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'fresh' }], stats: {} });
    await refresher.refreshNow('seed');
    runIntelligencePipelineMock.mockClear();

    const run = await refresher.getFreshRun(60_000); // just refreshed, well within a minute
    expect(run.headlines).toEqual([{ title: 'fresh' }]);
    expect(runIntelligencePipelineMock).not.toHaveBeenCalled();
  });

  test('triggers a refresh when the cached run is older than maxAgeMs', async () => {
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'first' }], stats: {} });
    await refresher.refreshNow('seed');
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'second' }], stats: {} });

    const run = await refresher.getFreshRun(-1); // any non-negative age exceeds a negative threshold
    expect(run.headlines).toEqual([{ title: 'second' }]);
    // One call to seed the cache, one more triggered by the stale check.
    expect(runIntelligencePipelineMock).toHaveBeenCalledTimes(2);
  });
});

describe('refresher — schedule lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    initDB(':memory:');
    runIntelligencePipelineMock.mockReset();
    refresher.stopRefreshSchedule();
    refresher._resetForTests();
  });
  afterEach(() => {
    refresher.stopRefreshSchedule();
    closeDB();
    jest.useRealTimers();
  });

  test('stop cancels the deferred startup refresh', async () => {
    runIntelligencePipelineMock.mockResolvedValue({ headlines: [{ title: 'late' }], stats: {} });
    refresher.startRefreshSchedule();
    refresher.stopRefreshSchedule();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(runIntelligencePipelineMock).not.toHaveBeenCalled();
  });
});

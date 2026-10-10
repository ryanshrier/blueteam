import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
const safeFetch = jest.fn();
const abortBenchmark = jest.fn();
let config;
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch, readCapped: async response => response.text() }));
jest.unstable_mockModule('../lib/config.js', () => ({ getConfig: () => config }));
jest.unstable_mockModule('../lib/ranking-benchmark.js', () => ({ beginRankingBenchmark: () => ({
  collection() {}, beforeEnrichment() {}, complete: () => ({ status: 'disabled' }), abort: abortBenchmark,
}) }));
const { initDB, closeDB, getMeta } = await import('../lib/db.js');
const { getDomainPack, setDomainPack, getEnrichers, setEnrichers } = await import('../lib/domain.js');
const { refreshNow, getLatestRun, waitForRefreshIdle, _resetForTests } = await import('../lib/refresher.js');
const originalPack = getDomainPack(), originalEnrichers = getEnrichers();
beforeEach(() => {
  initDB(':memory:'); _resetForTests();
  abortBenchmark.mockReset();
  setDomainPack({ ...originalPack, feeds: { searchQueries: [] } }); setEnrichers([]);
  config = { trustedFeeds: [{ source: 'Fixture', url: 'https://fixture.example/rss', horizon: 2 }] };
  safeFetch.mockReset().mockImplementation(async () => new Response(`<rss><channel><item><title>${'a'.repeat(60)}z</title><description>Vendor security advisory with mitigation details for affected deployments.</description><link>https://fixture.example/report</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`));
});
afterEach(async () => { await waitForRefreshIdle(); closeDB(); setDomainPack(originalPack); setEnrichers(originalEnrichers); });

test('a regex deadline fails refresh without replacing or relabeling the durable last-good collection', async () => {
  const good = await refreshNow('safe fixture');
  const fingerprint = good.headlines[0].regexAssessment.fingerprint;
  config = { ...config, alertRules: [{ pattern: '(a+)+$', boost: 5 }] };
  const refresh = refreshNow('hostile fixture');
  const outcome = refresh.then(() => 'unexpected success', error => error.code);
  expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('responsive'), 0))])).toBe('responsive');
  expect(await outcome).toBe('E_CONFIGURED_REGEX_TIMEOUT');
  expect(getLatestRun()).toBe(good);
  expect(getLatestRun().headlines[0].regexAssessment.fingerprint).toBe(fingerprint);
  expect(getLatestRun().lastCollectionAttempt).toMatchObject({ failed: true, retainedLastGood: true });
  const retained = JSON.parse(getMeta('latest_run'));
  expect(retained.headlines[0].regexAssessment.fingerprint).toBe(fingerprint);
  expect(retained.lastCollectionAttempt.failed).toBe(true);
  expect(abortBenchmark).toHaveBeenCalledWith('collection-failed');
}, 8_000);

test('a failure outside regex preparation also releases the benchmark capture', async () => {
  Object.defineProperty(config, 'trustedFeeds', { get() { throw new Error('synthetic collection setup failure'); } });
  await expect(refreshNow('invalid integration fixture')).rejects.toThrow('synthetic collection setup failure');
  expect(abortBenchmark).toHaveBeenCalledTimes(1);
  expect(abortBenchmark).toHaveBeenCalledWith('collection-failed');
});

// Actual collection/scoring hooks with synthetic RSS and local test enrichers.
// Network is intercepted; this never collects live data or invokes a provider.
import { jest, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
const safeFetch = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch, readCapped: async response => response.text() }));
const { runIntelligencePipeline } = await import('../lib/feeds.js');
const { setDomainPack, setEnrichers } = await import('../lib/domain.js');
const { cyberPack } = await import('../config/domains/cyber.js');
const { initDB, closeDB } = await import('../lib/db.js');
const { configureRankingBenchmark, readRankingCaptures } = await import('../lib/ranking-benchmark.js');
let directory;
afterAll(() => {
  configureRankingBenchmark(); closeDB();
  if (!directory) return;
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('bt-ranking-pipeline-')) throw new Error('Unsafe fixture cleanup');
  rmSync(target, { recursive: true, force: true });
});

test('full pipeline saves all candidates, including editorial and final-ranking exclusions, with both frozen clocks', async () => {
  directory = mkdtempSync(join(tmpdir(), 'bt-ranking-pipeline-'));
  configureRankingBenchmark({ directory });
  initDB(':memory:');
  setDomainPack({ ...cyberPack, feeds: { ...cyberPack.feeds, sources: [], searchQueries: [] } });
  setEnrichers([{ name: 'synthetic-local-evidence', stage: 'post', fn: headlines => {
    headlines[0].articleBody = 'Synthetic retained article: the vendor confirms a vulnerable management interface and recommends updating affected deployments.';
    headlines[0].articleRetrievedAt = new Date().toISOString();
    headlines[0].cvssSeverityText = 'CVSS 9.8 (CRITICAL)';
  } }]);
  const date = new Date().toUTCString();
  const items = Array.from({ length: 55 }, (_, index) => `<item><title>Gateway advisory CVE-2026-${50000 + index}</title><description>Vendor published an affected product advisory for CVE-2026-${50000 + index}; verify deployed versions before updating.</description><pubDate>${date}</pubDate><link>https://fixture.invalid/advisory/${index}</link></item>`);
  items.push(`<item><title>Friday Squid Blogging: synthetic example</title><description>Synthetic recurring feature.</description><pubDate>${date}</pubDate><link>https://www.schneier.com/blog/fixture</link></item>`);
  safeFetch.mockResolvedValue(new Response(`<rss><channel>${items.join('')}</channel></rss>`));
  const run = await runIntelligencePipeline({ trustedFeeds: [{ id: 'fixture', source: 'Synthetic Vendor', url: 'https://fixture.invalid/rss', category: 'vendor-advisory', horizon: 1, weight: 1 }],
    analysisSettings: { freshnessHours: 48, maxArticleExtractions: 0, maxCVEEnrichments: 0, maxEPSSLookups: 0 } });
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(run.stats.rankingBenchmark).toMatchObject({ status: 'captured', candidateCount: 56 });
  const [capture] = readRankingCaptures(directory);
  expect(capture.observations).toHaveLength(56);
  expect(capture.candidates.filter(item => item.finalSelected)).toHaveLength(50);
  expect(capture.candidates.filter(item => !item.finalSelected)).toHaveLength(6);
  expect(capture.candidates.filter(item => item.editoriallyExcluded)).toHaveLength(1);
  expect(Number.isFinite(Date.parse(capture.initialScoringClock))).toBe(true);
  expect(Date.parse(capture.finalScoringClock)).toBeGreaterThanOrEqual(Date.parse(capture.initialScoringClock));
  const enriched = capture.candidates.find(item => item.final.articleBody);
  expect(enriched.beforeEnrichment.articleBody).toBe('');
  expect(enriched.final.scoreComponents.severity).toBeCloseTo(0.98);
  expect(enriched.final.regexAssessment.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

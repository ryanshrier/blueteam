// Audit regressions: actual pipeline modules, synthetic upstream responses and
// an in-memory database. No live provider, operator data, or webhook calls.
import { jest, test, expect, beforeEach, afterAll } from '@jest/globals';
const safeFetch = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch, readCapped: async r => r.text() }));
const db = await import('../lib/db.js');
const feeds = await import('../lib/feeds.js');
const scoring = await import('../lib/scoring.js');
const enrichment = await import('../lib/enrichment.js');
const { setEnrichers } = await import('../lib/domain.js');
const { cyberEnrichers } = await import('../config/domains/cyber-enrichers.js');
setEnrichers(cyberEnrichers);
const { requireAdequateEvidence } = await import('../lib/refresher.js');
const { buildConvergenceClusters } = await import('../lib/landscape.js');
const { tagMitre } = await import('../lib/mitre.js');
const { recordStorageOutcome } = await import('../lib/storage-health.js');
const { summarizeEvidence } = await import('../lib/evidence-freshness.js');
const { buildGroundingManifest } = await import('../lib/grounding.js');
beforeEach(() => { db.closeDB(); db.initDB(':memory:'); safeFetch.mockReset(); });
afterAll(() => db.closeDB());

test('a sixth urgent item reaches scoring and survives conditional cache reuse', async () => {
  const xml = '<rss><channel>' + Array.from({ length: 6 }, (_, i) => `<item><title>${i === 5 ? 'CVE-2026-87654 actively exploited emergency advisory' : 'Routine update ' + i}</title><pubDate>${new Date().toUTCString()}</pubDate><link>https://example.com/${i}</link></item>`).join('') + '</channel></rss>';
  safeFetch.mockResolvedValueOnce(new Response(xml)).mockResolvedValueOnce(new Response(null, { status: 304 }));
  const config = [{ source: 'Cap source', url: 'https://example.com/rss', horizon: 1 }];
  for (let run = 0; run < 2; run++) {
    const out = await feeds.fetchNewsContext(config);
    expect(out).toHaveLength(6);
    expect(out.some(h => h.title.includes('87654'))).toBe(true);
  }
});

test('prototype property names in source titles have ordinary token similarity', () => {
  const out = feeds.deduplicateWithCorroboration([
    { title: 'Constructor constructor', source: 'A' },
    { title: 'Constructor constructor', source: 'B' },
    { title: 'Constructor unrelated logistics earnings report', source: 'C' },
  ]);
  expect(out).toHaveLength(2);
  expect(out.find(h => h.title === 'Constructor constructor').corroboration).toBe(2);
});

test('a restamped pipeline cannot sell 47-hour stale cache as current evidence', async () => {
  const url = 'https://example.com/cache';
  const retrievedAt = new Date(Date.now() - 47 * 3600_000).toISOString();
  db.setFeedCache(url, '', '', Array.from({ length: 5 }, (_, i) => ({ title: 'Cached report ' + i, date: retrievedAt, retrievedAt })));
  db.getDB().prepare("UPDATE feed_cache SET cached_at=datetime('now','-47 hours')").run();
  safeFetch.mockResolvedValue(new Response('', { status: 503 }));
  const headlines = await feeds.fetchNewsContext([{ source: 'Stale source', url, horizon: 1 }]);
  expect(headlines).toHaveLength(5);
  expect(headlines.every(h => h.retrievedAt === retrievedAt && h.collectionStale)).toBe(true);
  expect(() => requireAdequateEvidence({ headlines, generatedAtMs: Date.now() })).toThrow('No fresh substantive');
});

test('paid evidence gate rejects poor source coverage even with fresh headlines', () => {
  const run = { headlines: Array.from({ length: 5 }, () => ({ title: 'Vendor notice', description: 'Vendor version 2.5 fixes CVE-2026-12345.', retrievedAt: new Date().toISOString() })), generatedAtMs: Date.now(), stats: { collection: { configuredSources: 40, freshSources: 1 } } };
  expect(() => requireAdequateEvidence(run)).toThrow('Most configured sources');
  run.stats.collection.freshSources = 30;
  expect(requireAdequateEvidence(run)).toMatchObject({ ...run, briefingReadiness: { canGenerate: true, status: 'limited' } });
});

test('freshness gate and bounded prompt sources use the same fresh members', () => {
  const retrievedAt = new Date().toISOString();
  const headlines = Array.from({ length: 5 }, (_, i) => ({
    title: `Group ${i}`, source: 'primary', link: `https://primary.example/${i}`, collectionStale: true,
    sourceMembers: Array.from({ length: 6 }, (_, n) => ({
      title: `Source ${n}`, source: `source${n}`, link: `https://source${n}.example/${i}`,
      collectionStale: n !== 5, retrievedAt,
    })),
  }));
  expect(summarizeEvidence(headlines).freshHeadlines).toBe(5);
  const manifest = buildGroundingManifest({ headlines });
  expect(manifest.sources.every(group => group.members.some(member => member.label === 'source5'))).toBe(true);
});

test('KEV outage is recorded by the pipeline', async () => {
  safeFetch.mockResolvedValue(new Response('', { status: 503 }));
  const failures = [];
  await feeds.runEnricherStage('pre', [{ title: 'CVE-2026-76543 report', horizon: 1 }], {}, failures);
  expect(failures).toContain('KEV');
});

test('NVD transient failures are reported and retried rather than cached as absence', async () => {
  safeFetch.mockImplementation(async () => new Response('', { status: 503 }));
  for (let run = 0; run < 2; run++) {
    await expect(enrichment.enrichCVEs([{ title: 'CVE-2026-9876543 advisory' }])).rejects.toThrow('NVD unavailable');
  }
  expect(safeFetch).toHaveBeenCalledTimes(2);
});

test('post-selection article capture supplies body-only CVEs to the existing lookup budgets', async () => {
  const cve = 'CVE-2026-87021';
  const headline = { title: 'Gateway security update', source: 'Vendor', link: 'https://vendor.example/body-identity', horizon: 1,
    sourceMembers: [{ title: 'Gateway security update', description: 'The vendor has published a new advisory.' }] };
  const calls = [];
  safeFetch.mockImplementation(async url => {
    calls.push(url);
    if (url.includes('known_exploited_vulnerabilities.json')) return new Response(JSON.stringify({ vulnerabilities: [{ cveID: cve, dateAdded: '2026-10-09' }] }));
    if (url === headline.link) return new Response(`<article><p>Gateway security update. ${cve} affects Gateway version 1.2.3. The vendor recommends checking deployment before applying its update.</p><aside>CVE-2026-87022 is an unrelated sidebar.</aside></article>`);
    if (url.includes('services.nvd.nist.gov')) return new Response(JSON.stringify({ vulnerabilities: [{ cve: { id: cve, vulnStatus: 'Analyzed', metrics: { cvssMetricV31: [{ cvssData: { baseScore: 8.1 } }] } } }] }));
    if (url.includes('api.first.org')) return new Response(JSON.stringify({ data: [{ cve, epss: '0.42' }] }));
    throw new Error(`Unexpected test request: ${url}`);
  });
  const failures = [];
  await enrichment.enrichKEV([headline]);
  expect(headline.isKEV).toBe(false);
  calls.length = 0;
  await feeds.runEnricherStage('post', [headline], { maxArticleExtractions: 1, maxCVEEnrichments: 1, maxEPSSLookups: 1 }, failures);
  expect(failures).toEqual([]);
  expect(calls).toHaveLength(3);
  expect(calls[0]).toBe(headline.link);
  expect(calls[1]).toContain(`cveId=${cve}`);
  expect(calls[2]).toContain(cve);
  expect(calls.join(' ')).not.toContain('87022');
  expect(headline).toMatchObject({ isKEV: true, kevCVE: cve, kevDateAdded: '2026-10-09', cvssScore: 8.1, epss: 0.42, epssCVE: cve, articleRetrievalStatus: 'fetched' });
  expect(Number.isFinite(Date.parse(headline.articleRetrievedAt))).toBe(true);
});

test('KEV identity parsing expands source shorthand and excludes stale or contaminated article captures', () => {
  const kev = new Set(['CVE-2026-98761', 'CVE-2026-98762']);
  const headlines = [
    { title: 'Vendor fixed CVE-2026-98760/98761' },
    { title: 'Gateway update', articleBody: 'Gateway version 1.2 is affected by CVE-2026-98762. The vendor recommends applying the patch.' },
    { title: 'Gateway update', articleBody: 'Gateway version 1.2 is affected by CVE-2026-98762.', articleStale: true },
    { title: 'Gateway update', articleBody: 'Access denied. CVE-2026-98762.' },
  ];
  enrichment.tagKEVFromCatalog(headlines, kev);
  expect(headlines.map(h => h.isKEV)).toEqual([true, true, false, false]);
  expect(headlines[0].kevCVE).toBe('CVE-2026-98761');
  expect(safeFetch).not.toHaveBeenCalled();
});

test.each(['CVE-2026-87654 is not actively exploited', 'No evidence of active exploitation of CVE-2026-87654', 'Active exploitation of CVE-2026-87654 has not been observed', 'Is CVE-2026-87654 actively exploited?'])('denial does not promote urgency or tier: %s', title => {
  const h = { title, horizon: 2 };
  expect(scoring.classifyUrgency(h)).toBe('routine');
  scoring.applyHorizonOverrides([h]);
  expect(h.horizon).toBe(2);
});

test('an affirmative contrasting clause retains its urgency', () => {
  expect(scoring.classifyUrgency({ title: 'CVE-2026-11111 is not exploited, but CVE-2026-22222 is actively exploited' })).toBe('critical');
  expect(scoring.classifyUrgency({ title: 'Research on a hypothetical zero-day' })).toBe('elevated');
});

test('different reports converge across publishers, but one publisher repeating itself does not', () => {
  const headlines = ['a', 'b'].map(source => ({ title: source, source, publishers: [source + '.example'], corroboration: 1, actors: [{ name: 'APT28' }], score: 50 }));
  expect(buildConvergenceClusters(headlines)[0]).toMatchObject({ label: 'APT28', sourceCount: 2 });
  headlines[1].publishers = headlines[0].publishers;
  expect(buildConvergenceClusters(headlines)).toEqual([]);
});

test.each([['DDoS floods network links', 'T1498', 'T1489'], ['Kerberoasting targets service tickets', 'T1558.003', 'T1003'], ['Golden ticket forged', 'T1558.001', 'T1098'], ['Silver ticket forged', 'T1558.002', 'T1098']])('technique identity: %s', (title, expected, wrong) => {
  const h = { title }; tagMitre([h]);
  expect(h.mitre.map(t => t.id)).toContain(expected);
  expect(h.mitre.map(t => t.id)).not.toContain(wrong);
});

test('Medusa and MedusaLocker remain separate actor identities', () => {
  const h = { title: 'MedusaLocker ransomware incident' }; enrichment.tagEntities([h]);
  expect(h.actors.map(a => a.name)).toEqual(['MedusaLocker']);
});

test('later KEV knowledge cannot overwrite first-observed rank evidence', () => {
  const h = { title: 'CVE-2026-55555 report', horizon: 1, score: 20, isKEV: false };
  db.archiveHeadlines([h], { observedAt: '2026-09-01T00:00:00Z' });
  db.archiveHeadlines([{ ...h, score: 70, isKEV: true, kevCVE: 'CVE-2026-55555' }]);
  const row = db.getDB().prepare('SELECT score,is_kev,first_snapshot_json FROM headline_archive').get();
  expect(row.score).toBe(70);
  expect(JSON.parse(row.first_snapshot_json)).toMatchObject({ score: 20, isKEV: false, observedAt: '2026-09-01T00:00:00Z', rank: 1 });
});

test('storage readiness remembers failed persistence until that operation recovers', () => {
  recordStorageOutcome('evidence', Object.assign(new Error('private path must not escape'), { code: 'SQLITE_FULL' }));
  const health = db.getDatabaseHealth();
  expect(health).toMatchObject({ status: 'error', readable: true });
  expect(JSON.stringify(health)).not.toContain('private path');
  recordStorageOutcome('evidence');
  expect(db.getDatabaseHealth().status).toBe('ok');
});

// Collection-through-final-selection recall checks. All upstream responses are
// local fixtures; no provider, operator database or live network is used.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const safeFetch = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch, readCapped: async response => response.text() }));
const db = await import('../lib/db.js');
const { getDomainPack, setDomainPack, setEnrichers } = await import('../lib/domain.js');
const { cyberEnrichers } = await import('../config/domains/cyber-enrichers.js');
const { enrichArticleBodies, enrichEPSS, enrichCVEs } = await import('../lib/enrichment.js');
const { runIntelligencePipeline, fetchNewsContext, fetchSearchResults, buildSearchQueries } = await import('../lib/feeds.js');
const { observeSources } = await import('../lib/evidence.js');
const { revisedFeedAdmission } = await import('../lib/feed-revisions.js');
const { withinInvestigationBudget } = await import('../lib/investigation-budget.js');
const { assessUrgency } = await import('../lib/intelligence-context.js');
const { loadUserSettings, saveUserSettings } = await import('../lib/user-settings.js');
const originalPack = getDomainPack();
let directory;
beforeEach(() => {
  db.closeDB(); db.initDB(':memory:'); safeFetch.mockReset();
  directory = mkdtempSync(join(tmpdir(), 'collection-replay-')); loadUserSettings(directory);
  setDomainPack({ ...originalPack, feeds: { searchQueries: [] } }); setEnrichers([]);
});
afterEach(() => { db.closeDB(); setDomainPack(originalPack); setEnrichers(cyberEnrichers); rmSync(directory, { recursive: true, force: true }); jest.restoreAllMocks(); });

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const rss = items => `<rss><channel>${items.map(item => `<item><title>${escape(item.title)}</title><description>${escape(item.passage || '')}</description><link>${item.link}</link><pubDate>${item.date || new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

describe('bounded investigation before final selection', () => {
  test('retained StyleSmuggler exploitation survives selection without an identifier while the Patch Tuesday forecast stays planning context', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-06T18:00:00Z'));
    const retained = JSON.parse(readFileSync(new URL('./fixtures/retained-wire-2026-09-06.json', import.meta.url), 'utf8'));
    const rows = [16, 15].map(index => retained.selectedEvidence.find(item => item.index === index));
    const bodies = new Map();
    const trustedFeeds = rows.map((row, index) => {
      const member = row.groupMembers[0], url = `https://retained${index}.example/rss`;
      bodies.set(url, rss([{ title: member.title, passage: member.passage, link: member.url, date: member.publishedAt }]));
      return { url, source: member.source, horizon: row.horizon, weight: row.weight };
    });
    safeFetch.mockImplementation(async url => { if (!bodies.has(url)) throw new Error('Unexpected enrichment request'); return new Response(bodies.get(url)); });
    const run = await runIntelligencePipeline({ trustedFeeds });
    const exploited = run.headlines.find(item => item.link === rows[0].groupMembers[0].url);
    const forecast = run.headlines.find(item => item.link === rows[1].groupMembers[0].url);
    expect(exploited).toMatchObject({ urgency: 'critical', horizon: 1 });
    expect(exploited.title).not.toMatch(/CVE-/);
    expect(assessUrgency(forecast).exploitationStatus).toBe('not-established');
    expect(exploited.score).toBeGreaterThan(forecast.score);
    expect(run.stats.selection).toMatchObject({ candidateCount: 2, excludedCount: 0 });
  });
  test('a sparse relevant primary report is investigated and recovered despite a busy syndicated news cycle', async () => {
    const routine = Array.from({ length: 55 }, (_, index) => ({ title: `CVE-2026-${10000 + index} package advisory`,
      passage: `CVE-2026-${10000 + index} requires a vendor update after deployment review.`, link: `https://normal${Math.floor(index / 3)}.example/${index}` }));
    const target = { title: 'EdgeGate gateway advisory', passage: 'The vendor has published a new advisory.', link: 'https://vendor.example/edgegate' };
    const noise = { title: 'Business growth and innovation', passage: 'Attend our webinar and subscribe to our newsletter.', link: 'https://noise.example/offer' };
    const normalFeeds = Array.from({ length: 19 }, (_, index) => ({ url: `https://normal${index}.example/rss`,
      source: `Advisory desk ${index}`, category: 'vendor-advisory', horizon: 1, weight: 2 }));
    const sourceFeeds = [...normalFeeds,
      { url: 'https://vendor.example/rss', source: 'Vendor', category: 'vendor-advisory', horizon: 1, weight: 0.5 },
      { url: 'https://noise.example/rss', source: 'Promotions', category: 'general', horizon: 1, weight: 0.5 },
      { url: 'https://reprint.example/rss', source: 'Reprint', category: 'cyber-news', horizon: 1, weight: 1 },
    ];
    const bodies = new Map([...normalFeeds.map((feed, index) => [feed.url, rss(routine.slice(index * 3, index * 3 + 3))]),
      [sourceFeeds[19].url, rss([target])], [sourceFeeds[20].url, rss([noise])],
      [sourceFeeds[21].url, rss([{ ...routine[0], link: 'https://reprint.example/copy' }])]]);
    const extracted = [];
    safeFetch.mockImplementation(async url => {
      if (bodies.has(url)) return new Response(bodies.get(url));
      extracted.push(url);
      return new Response(`<article><p>${url === target.link
        ? 'Attackers are exploiting EdgeGate authentication to gain access to exposed gateways. The vendor recommends restricting external access and reviewing affected deployments.'
        : 'The vendor recommends reviewing deployed versions before applying the available update.'}</p></article>`);
    });
    setEnrichers([{ name: 'article', stage: 'post', fn: enrichArticleBodies, limitKey: 'maxArticleExtractions', limitDefault: 10 }]);
    const run = await runIntelligencePipeline({ trustedFeeds: sourceFeeds, watchProfile: { technologies: ['EdgeGate'], regions: ['US'] },
      analysisSettings: { maxArticleExtractions: 10 } });
    expect(run.headlines).toHaveLength(50);
    expect(run.headlines.some(item => item.link === target.link)).toBe(true);
    expect(extracted).toContain(target.link);
    expect(extracted).toHaveLength(10);
    expect(new Set(extracted).size).toBe(10);
    expect(extracted.filter(link => /^https:\/\/normal\d+\.example\//.test(link)).length).toBeGreaterThanOrEqual(8);
    expect(extracted).not.toContain(noise.link);
    expect(run.stats.selection).toMatchObject({ candidateCount: 57, investigationCount: 2, recoveredCount: 1,
      finalSelectedCount: 50, policy: { requestBudget: 'reserved-within-existing-limits' } });
    expect(run.stats.selection.investigations).toContainEqual(expect.objectContaining({
      reason: 'declared-interest-evidence-gap', selected: true, articleRetrieved: true }));
    const recovered = run.headlines.find(item => item.link === target.link);
    expect(assessUrgency(recovered)).toMatchObject({ level: 'critical', basis: 'article-excerpt', reportedAt: null, evidenceRefs: [] });
    expect(run.headlines.find(item => item.title === routine[0].title).corroboration).toBe(2);
  });

  test('investigation slots preserve the total budget and operational majority', () => {
    const ordinary = Array.from({ length: 20 }, (_, index) => ({ id: index }));
    const investigations = [{ id: 'a', selectionInvestigation: true }, { id: 'b', selectionInvestigation: true }];
    for (const [budget, reserved] of [[0, 0], [1, 0], [5, 1], [8, 1], [10, 2], [20, 2]]) {
      const selected = withinInvestigationBudget([...ordinary, ...investigations], budget);
      expect(selected).toHaveLength(budget);
      expect(selected.filter(item => item.selectionInvestigation)).toHaveLength(reserved);
    }
  });

  test('article screening retains independent provenance and excludes stale, historical and negative claims', () => {
    const base = { title: 'Gateway advisory', source: 'Vendor', date: new Date().toISOString(),
      articleRetrievedAt: new Date().toISOString(), sourceMembers: [{ title: 'Gateway advisory', passage: 'A vendor update is available.',
        date: new Date().toISOString(), evidence: [{ sourceId: 'feed-source', revisionId: 'feed-revision' }] }] };
    for (const change of [
      { articleStale: true, articleBody: 'Attackers are exploiting Gateway authentication to gain access to exposed appliances.' },
      { articleBody: 'In 2021 attackers were actively exploiting Gateway authentication to gain access to exposed appliances.' },
      { articleBody: 'Gateway authentication is not actively exploited. The vendor has published updated mitigation guidance for affected appliances.' },
    ]) expect(assessUrgency({ ...base, ...change }).exploitationStatus).toBe('not-established');
    const active = assessUrgency({ ...base, articleBody: 'Attackers are exploiting Gateway authentication to gain access to exposed appliances.' });
    expect(active).toMatchObject({ basis: 'article-excerpt', reportedAt: null, evidenceRefs: [] });
  });

  test('EPSS reservations stay inside the existing distinct-CVE batch limit', async () => {
    const headlines = Array.from({ length: 7 }, (_, index) => ({ title: `CVE-2026-${81000 + index} advisory`,
      ...(index === 6 ? { selectionInvestigation: true } : {}) }));
    safeFetch.mockImplementation(async url => {
      const ids = new URL(url).searchParams.get('cve').split(',');
      expect(ids).toHaveLength(5);
      expect(ids).toContain('CVE-2026-81006');
      expect(ids).toContain('CVE-2026-81000');
      return new Response(JSON.stringify({ data: ids.map(cve => ({ cve, epss: '0.12' })) }));
    });
    await enrichEPSS(headlines, 5);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(headlines[6].epss).toBe(0.12);
    expect(headlines[4].epss).toBeUndefined();
  });

  test('NVD reservations keep the live-attempt budget, including misses', async () => {
    // Cache-only preselection must never turn into a network request.
    await enrichCVEs([{ title: 'CVE-2026-89000 advisory' }], 0);
    expect(safeFetch).not.toHaveBeenCalled();
    const headlines = Array.from({ length: 7 }, (_, index) => ({ title: `CVE-2026-${82000 + index} advisory`,
      ...(index === 6 ? { selectionInvestigation: true } : {}) }));
    // Fast logical time satisfies the real pacing condition without sleeping.
    let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now += 7_000);
    const called = [];
    safeFetch.mockImplementation(async url => { called.push(new URL(url).searchParams.get('cveId')); return new Response(JSON.stringify({ vulnerabilities: [] })); });
    await enrichCVEs(headlines, 5);
    expect(called).toEqual(['CVE-2026-82000', 'CVE-2026-82001', 'CVE-2026-82002', 'CVE-2026-82003', 'CVE-2026-82006']);
  });
});

describe('search-question coverage', () => {
  test('rotates every declared question while keeping three queries per hourly window', () => {
    const questions = Array.from({ length: 100 }, (_, index) => `Question ${index}`);
    const config = { watchProfile: { intelligenceQuestions: questions } };
    const seen = new Set();
    for (let hour = 0; hour < 34; hour++) {
      const queries = buildSearchQueries(config, { now: hour * 3_600_000 });
      expect(queries).toHaveLength(3);
      queries.forEach(query => seen.add(query.q));
      expect(buildSearchQueries(config, { now: hour * 3_600_000 + 15 * 60_000 })).toEqual(queries);
    }
    expect(seen.size).toBe(100);
  });
  test('uses the saved effective profile and honors a captured profile during a run', () => {
    saveUserSettings(directory, { watchProfile: { intelligenceQuestions: ['Operator question'] } });
    const config = { watchProfile: { intelligenceQuestions: ['Server question'] } };
    expect(buildSearchQueries(config, { now: 0 })).toEqual([{ q: 'Operator question security', horizon: 2 }]);
    expect(buildSearchQueries(config, { now: 0, watchProfile: { intelligenceQuestions: ['Captured question'] } })).toEqual([{ q: 'Captured question security', horizon: 2 }]);
  });
  test('intermittent machines advance from the retained cursor instead of skipping question subsets', async () => {
    const questions = Array.from({ length: 7 }, (_, index) => `Research topic ${index}`);
    const queried = new Set();
    safeFetch.mockImplementation(async url => {
      queried.add(new URL(url).searchParams.get('q').replace(' security when:7d', ''));
      return new Response(rss([{ title: 'Research finding', passage: 'Researchers describe an affected system.', link: 'https://research.example/finding' }]));
    });
    const config = { watchProfile: { intelligenceQuestions: questions } };
    for (let day = 0; day < 3; day++) await fetchSearchResults(config, { now: day * 86400_000 });
    expect(queried).toEqual(new Set(questions));
    expect(safeFetch.mock.calls.length).toBe(7); // repeated slots use the same ordinary search cache
  });
});

describe('material revision candidates retain original publication identity', () => {
  const source = { source: 'Revision vendor', url: 'https://revision.example/feed', category: 'vendor-advisory', horizon: 1 };
  const oldDate = () => new Date(Date.now() - 14 * 86400_000).toISOString();
  const updated = () => new Date(Date.now() - 3600_000).toISOString();
  const passage = 'CVE-2026-83000 affects Gateway version 2.4. No active exploitation has been observed.';
  const changed = 'CVE-2026-83000 affects Gateway version 2.4. Active exploitation has now been confirmed.';
  const entry = body => ({ title: 'Gateway advisory', source: source.source, link: 'https://revision.example/advisory',
    feedUrl: source.url, sourceIdentifier: 'gateway', passage: body, date: oldDate(), retrievedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
  const atom = (body, update = updated()) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>gateway</id><title>Gateway advisory</title><link href="https://revision.example/advisory"/><published>${oldDate()}</published><updated>${update}</updated><content>${body}</content></entry></feed>`;
  test('admits a changed operational statement only against its retained baseline, including 304 reuse', async () => {
    const [baseline] = observeSources([entry(passage)]);
    safeFetch.mockResolvedValueOnce(new Response(atom(changed))).mockResolvedValueOnce(new Response(null, { status: 304 }));
    const first = await fetchNewsContext([source]);
    expect(first).toHaveLength(1);
    expect(Date.parse(first[0].date)).toBeLessThan(Date.now() - 13 * 86400_000);
    expect(first[0].revisionAdmission).toMatchObject({ basis: 'changed-operational-text', materiality: 'candidate-not-verified', previousRevisionId: baseline.revisionId });
    observeSources(first);
    const second = await fetchNewsContext([source]);
    expect(second[0].date).toBe(first[0].date);
    expect(second[0].revisionAdmission).toEqual(first[0].revisionAdmission);
  });
  test('an unchanged 200 retains the admission but a later timestamp bump cannot renew it', async () => {
    observeSources([entry(passage)]);
    const update = updated(), body = atom(changed, update);
    safeFetch.mockResolvedValue(new Response(body));
    const first = await fetchNewsContext([source]);
    observeSources(first);
    safeFetch.mockResolvedValue(new Response(body));
    const second = await fetchNewsContext([source]);
    expect(second[0].revisionAdmission).toEqual(first[0].revisionAdmission);
    safeFetch.mockResolvedValue(new Response(atom(changed, new Date().toISOString())));
    expect(await fetchNewsContext([source])).toEqual([]);
  });
  test.each([passage, passage.replace('Gateway', 'GATEWAY'), passage.replace('affects', 'afffects')])('rejects timestamp-only and cosmetic changes: %s', body => {
    const previous = { revisionId: `rev_${'a'.repeat(64)}`, passage, lastObservedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    expect(revisedFeedAdmission({ ...entry(body), sourceUpdatedAt: updated() }, previous, 96 * 3600_000)).toBeNull();
  });
  test('does not call a first sighting or truncated capture a known material revision', async () => {
    safeFetch.mockResolvedValue(new Response(atom(changed)));
    expect(await fetchNewsContext([source])).toEqual([]);
    const previous = { revisionId: `rev_${'a'.repeat(64)}`, passage, passageTruncated: true, lastObservedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    expect(revisedFeedAdmission({ ...entry(changed), sourceUpdatedAt: updated() }, previous, 96 * 3600_000)).toBeNull();
  });
  test('a different feed representation cannot serve as the revision baseline', async () => {
    observeSources([{ ...entry(passage), feedUrl: 'https://revision.example/other-feed' }]);
    safeFetch.mockResolvedValue(new Response(atom(changed)));
    expect(await fetchNewsContext([source])).toEqual([]);
  });
});

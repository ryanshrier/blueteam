import { describe, expect, test } from '@jest/globals';
import { briefingReadiness } from '../lib/evidence-freshness.js';

const now = Date.parse('2026-10-09T12:00:00Z');
const source = (patch = {}) => ({ title: 'Widget security notice', source: 'Vendor', link: 'https://vendor.test/notice',
  description: 'Widget version 2.5 fixes CVE-2026-12345. Administrators should update exposed deployments.',
  retrievedAt: new Date(now).toISOString(), ...patch });
const run = (headlines, collection = { configuredSources: 10, freshSources: 10 }) => ({ headlines,
  generatedAtMs: now, stats: { collection } });
const check = value => briefingReadiness(value, { now });

describe('shared briefing readiness', () => {
  test.each([1, 2, 3])('%s substantive notices on a successfully checked quiet day support a limited briefing', count => {
    expect(check(run(Array.from({ length: count }, (_, i) => source({ title: `Widget notice ${i}` })))))
      .toMatchObject({ status: 'limited', canGenerate: true, scope: 'limited', usableHeadlines: count,
        collection: { reachableSources: 10, outage: false } });
  });
  test('five fresh titles cannot masquerade as substantive evidence', () => {
    expect(check(run(Array.from({ length: 5 }, () => source({ description: '' })))))
      .toMatchObject({ canGenerate: false, code: 'no-usable-evidence', usableHeadlines: 0 });
  });
  test('zero stories is idle collection, not evidence for a no-threat briefing', () => {
    expect(check(run([]))).toMatchObject({ canGenerate: false, code: 'no-usable-evidence', collection: { outage: false } });
  });
  test('one successful publisher amid a widespread outage stays blocked', () => {
    expect(check(run([source()], { configuredSources: 10, freshSources: 1 })))
      .toMatchObject({ canGenerate: false, code: 'collection-outage', usableHeadlines: 1 });
  });
  test('partial collection above the outage threshold permits honestly limited coverage', () => {
    expect(check(run([source()], { configuredSources: 10, freshSources: 6 })))
      .toMatchObject({ canGenerate: true, scope: 'limited' });
  });
  test.each([
    source({ retrievedAt: '2026-10-09T10:00:00Z' }),
    source({ collectionStale: true }),
    source({ description: 'Please enable JavaScript to continue.' }),
    source({ id: 'CISA-KEV', passageKind: 'catalog-membership-only' }),
  ])('retained, contaminated, and catalog-only evidence cannot unlock paid generation', headline => {
    expect(check(run([headline])).canGenerate).toBe(false);
  });
  test('a fresh substantive article retains its own freshness despite a stale feed wrapper', () => {
    expect(check(run([source({ collectionStale: true, retrievedAt: '2026-10-09T10:00:00Z',
      articleBody: 'Widget version 2.5 fixes CVE-2026-12345.', articleRetrievedAt: new Date(now).toISOString(),
      articleRetrievalStatus: 'fetched' })]))).toMatchObject({ canGenerate: true, usableHeadlines: 1 });
  });
  test.each([now - 60 * 60_000, now + 5 * 60_000])('an old or future run clock cannot unlock generation', generatedAtMs => {
    expect(check({ ...run([source()]), generatedAtMs })).toMatchObject({ canGenerate: false, code: 'stale' });
  });
  test('multiple current substantive publishers with checked coverage support standard scope', () => {
    expect(check(run(Array.from({ length: 5 }, (_, i) => source({ source: `Publisher ${i}` })))))
      .toMatchObject({ status: 'ready', usableHeadlines: 5, substantiveSources: 5 });
  });
});

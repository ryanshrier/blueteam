import { describe, test, expect, afterAll } from '@jest/globals';
import { runEnricherStage } from '../lib/feeds.js';
import { setEnrichers } from '../lib/domain.js';
import { cyberEnrichers } from '../config/domains/cyber-enrichers.js';

// The pipeline iterates the active edition's enricher list by
// stage instead of calling KEV/CVE/MITRE by name. These guard that the cyber
// sequence makes captured article identities available to lookups, preserves
// limits, and that the stage runner's mechanics match the old code:
// in-order, by-stage, awaited, failures recorded only when a failureKey is set.

afterAll(() => setEnrichers(cyberEnrichers));   // restore the default for later suites

describe('cyber enricher manifest', () => {
  test('captures article identities before the bounded CVE and EPSS lookups', () => {
    // Article evidence is available to lookups and MITRE. IOC extraction remains
    // last because it consumes that same article body.
    expect(cyberEnrichers.map(e => e.name)).toEqual(['kev', 'entities', 'cached-cve', 'cached-epss', 'article', 'article-kev', 'cve', 'epss', 'mitre', 'iocs']);
    expect(cyberEnrichers.filter(e => e.stage === 'pre').map(e => e.name)).toEqual(['kev', 'entities', 'cached-cve', 'cached-epss']);
    expect(cyberEnrichers.filter(e => e.stage === 'post').map(e => e.name)).toEqual(['article', 'article-kev', 'cve', 'epss', 'mitre', 'iocs']);
  });

  test('preserves failure-keys and limits (KEV/CVE/article reported; entities/mitre/epss/iocs silent)', () => {
    const by = Object.fromEntries(cyberEnrichers.map(e => [e.name, e]));
    expect(by.kev.failureKey).toBe('KEV');
    expect(by.entities.failureKey).toBeUndefined();
    expect(by.mitre.failureKey).toBeUndefined();
    expect(by.cve).toMatchObject({ failureKey: 'CVE', limitKey: 'maxCVEEnrichments', limitDefault: 8 });
    expect(by.epss.failureKey).toBe('EPSS');
    expect(by.epss).toMatchObject({ limitKey: 'maxEPSSLookups', limitDefault: 20 });
    expect(by.article).toMatchObject({ failureKey: 'article', limitKey: 'maxArticleExtractions', limitDefault: 10 });
    expect(by.iocs.failureKey).toBeUndefined();
    expect(cyberEnrichers.every(e => typeof e.fn === 'function')).toBe(true);
  });
});

describe('runEnricherStage', () => {
  test('runs only its stage, in order, awaiting each, recording keyed failures', async () => {
    const calls = [];
    setEnrichers([
      { name: 'a', stage: 'pre', fn: (h, l) => { calls.push(['a', l]); } },
      { name: 'b', stage: 'pre', fn: async (h, l) => { calls.push(['b', l]); throw new Error('boom'); }, failureKey: 'B' },
      { name: 'silent', stage: 'pre', fn: () => { throw new Error('quiet'); } },   // no failureKey
      { name: 'c', stage: 'post', fn: (h, l) => { calls.push(['c', l]); } },
    ]);
    const failures = [];
    await runEnricherStage('pre', [], {}, failures);
    expect(calls).toEqual([['a', undefined], ['b', undefined]]);   // 'c' is post-stage, not run
    expect(failures).toEqual(['B']);                               // 'b' keyed; 'silent' not recorded
  });

  test('resolves a per-enricher limit from config, else the default', async () => {
    const seen = [];
    setEnrichers([{ name: 'c', stage: 'post', fn: (h, l) => seen.push(l), limitKey: 'maxX', limitDefault: 7 }]);
    await runEnricherStage('post', [], { maxX: 3 }, []);   // config provides it
    await runEnricherStage('post', [], {}, []);            // config omits → default
    expect(seen).toEqual([3, 7]);
  });

  test('passes the headlines array through to each enricher', async () => {
    const hs = [{ title: 'x' }];
    let received = null;
    setEnrichers([{ name: 'tag', stage: 'pre', fn: (h) => { received = h; } }]);
    await runEnricherStage('pre', hs, {}, []);
    expect(received).toBe(hs);
  });
});

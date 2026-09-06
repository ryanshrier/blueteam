import { describe, expect, test } from '@jest/globals';
import { filterSignals, parseWireQuery, serializeWireUrl, signalUrl } from '../public/modules/wire/wire-format.js';

const a = { title: 'Gateway report', link: 'https://example.test/a?rev=2', source: 'Distinct Publisher', horizon: 1,
  vendors: [{ name: 'Acme Networks' }], actors: [{ name: 'Example Actor' }], kevCVE: 'CVE-2026-12345',
  applicability: { state: 'declared-match' }, evidence: [{ changed: true }], alertMatched: true };
const b = { title: 'Another report', link: 'https://example.test/b', source: 'Elsewhere', horizon: 2,
  vendors: ['Other Vendor'], actors: [], evidence: [] };

describe('Wire investigation filters', () => {
  test.each(['Acme Networks', 'Example Actor', 'Distinct Publisher', 'CVE-2026-12345'])('search includes metadata-only value %s', q => {
    expect(filterSignals([a, b], { q })).toEqual([a]);
  });

  test('new relevance filters compose and survive a shared URL', () => {
    const url = serializeWireUrl({ watch: true, changed: true, alert: true, q: 'Acme' }, 'newest');
    const restored = parseWireQuery(url.slice(url.indexOf('?')));
    expect(restored).toMatchObject({ watch: true, changed: true, alert: true, q: 'Acme', sort: 'newest' });
    expect(filterSignals([a, b], restored, restored.sort)).toEqual([a]);
  });

  test('cluster destinations match structured membership instead of loose text', () => {
    expect(filterSignals([a, { ...b, title: 'Mentions Acme Networks' }], { cluster: 'vendor:Acme Networks' })).toEqual([a]);
    expect(filterSignals([a, b], { cluster: 'actor:Example Actor' })).toEqual([a]);
    expect(parseWireQuery('?cluster=vendor%3AAcme%20Networks').cluster).toBe('vendor:Acme Networks');
  });

  test('internal signal links preserve complete identity and resolve hidden local records', () => {
    const url = signalUrl(a, 'https://desk.example');
    const parsed = parseWireQuery(new URL(url).search);
    expect(parsed.signal).toBe(a.link);
    expect(filterSignals([a, b], { ...parsed, dismissedKeys: new Set([a.link]) })).toEqual([a]);
    expect(filterSignals([b], parsed)).toEqual([]);
    expect(new URL(signalUrl({ title: 'Title with + # & / characters' }, 'https://desk.example')).searchParams.get('signal'))
      .toBe('Title with + # & / characters');
  });
});

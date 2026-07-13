import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { renderKevSection, renderKevRecent } from '../public/modules/wall/wall-kev.js';
import { FIXTURE_CASES, buildFixtureData } from './visual/fixture-cases.js';

describe('visual fixture manifest', () => {
  test('covers sparse KEV plus loading, error, empty, and stale states', () => {
    const ids = FIXTURE_CASES.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'kev-one', 'kev-missing', 'wall-loading', 'wall-stale',
      'wire-loading', 'brief-error', 'brief-empty',
    ]));
  });
});

describe('KEV visual renderer', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-12T12:00:00-05:00'));
  });

  afterAll(() => jest.useRealTimers());

  test('renders the deterministic one-row composition with worst-case content', () => {
    const fixture = buildFixtureData(new Date('2026-07-12T12:00:00-05:00'))['kev-one'];
    const html = renderKevSection(fixture);
    expect(html).toContain('row-count-1');
    expect((html.match(/class="nb-led-row"/g) || [])).toHaveLength(1);
    expect(html).toContain('CVE-2026-123456');
    expect(html).toContain('Remote Operations Management');
    expect(html).toContain('today');
    expect(html).not.toContain('Known exploited');
  });

  test('renders explicit fallbacks for every missing record field', () => {
    const fixture = buildFixtureData(new Date('2026-07-12T12:00:00-05:00'))['kev-missing'];
    const html = renderKevSection(fixture);
    expect(html).toContain('Latest catalog additions');
    expect(html).toContain('CVE not listed');
    expect(html).toContain('Vendor not listed');
    expect(html).toContain('Product not listed');
    expect(html).toContain('Date not listed');
    expect(html).not.toContain('added today');
  });

  test('escapes untrusted KEV fields and caps the live page at six rows', () => {
    const unsafe = { cve: '<script>x</script>', vendor: '<b>V</b>', product: '<img>', name: '<em>N</em>' };
    const row = renderKevRecent(unsafe);
    expect(row).not.toContain('<script>');
    expect(row).not.toContain('<img>');
    expect(row).toContain('&lt;script&gt;');

    const html = renderKevSection({ recent: Array.from({ length: 7 }, (_, i) => ({ cve: `CVE-2026-${1000 + i}` })) });
    expect((html.match(/class="nb-led-row"/g) || [])).toHaveLength(6);
    expect(html).toContain('row-count-6');
  });
});

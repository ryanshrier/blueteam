import { describe, test, expect } from '@jest/globals';
import {
  parseCveData, csvCell, toCsv, CSV_COLUMNS,
  parseWireQuery, serializeWireUrl, filterSignals, dateMs, sigKey,
} from '../public/modules/wire/wire-format.js';

describe('parseCveData', () => {
  test('extracts cve, cvss, severity, exploit, affects from a full string', () => {
    const p = parseCveData('CVE-2026-1234 · CVSS 9.8 (Critical) · exploit references exist · Affects: Acme Server 1.0');
    expect(p.cve).toBe('CVE-2026-1234');
    expect(p.cvss).toBe('9.8');
    expect(p.sev).toBe('Critical');
    expect(p.exploit).toBe(true);
    expect(p.affects).toBe('Acme Server 1.0');
  });

  test('strips a secondary "· CVE-…: CVSS …" that bleeds into the affects capture', () => {
    const p = parseCveData('Affects: Widget 2 · CVE-2026-9999: CVSS 7.1');
    expect(p.affects).toBe('Widget 2');
  });

  test('missing fields yield empty strings / false, never throw', () => {
    const p = parseCveData('some prose with no structured fields');
    expect(p).toMatchObject({ cve: '', cvss: '', sev: '', exploit: false, affects: '' });
  });

  test('is type-guarded — a non-string field can never throw', () => {
    for (const bad of [null, undefined, 42, { foo: 'bar' }, ['CVE-2026-1'], NaN, true]) {
      expect(() => parseCveData(bad)).not.toThrow();
      expect(parseCveData(bad).cve).toBe('');
    }
  });

  test('is case-insensitive on cve / cvss / exploit', () => {
    const p = parseCveData('cve-2026-0007 · cvss 5.5 · EXPLOIT REFERENCES EXIST');
    expect(p.cve).toBe('cve-2026-0007');
    expect(p.cvss).toBe('5.5');
    expect(p.exploit).toBe(true);
  });
});

describe('csvCell — RFC-4180 + injection defense', () => {
  test('null / undefined become empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  test('neutralizes leading formula characters =,+,-,@ and control-prefix variants', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\t=SUM(A1)')).toBe("'\t=SUM(A1)");
    expect(csvCell('\r=SUM(A1)')).toBe(`"'\r=SUM(A1)"`);
  });

  test('quotes cells containing a comma, quote, or newline and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  test('a formula char that also needs quoting gets both treatments', () => {
    // leading '=' is prefixed, then the comma forces quoting of the now-prefixed string
    expect(csvCell('=1,2')).toBe('"\'=1,2"');
  });

  test('objects serialize as JSON, never "[object Object]"', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  test('plain values pass through', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(88)).toBe('88');
    expect(csvCell(false)).toBe('false');
  });
});

describe('toCsv', () => {
  test('emits a header row then one CRLF-delimited row per item', () => {
    const csv = toCsv([{ score: 88, title: 'X' }], ['score', 'title']);
    expect(csv).toBe('score,title\r\n88,X');
  });

  test('joins array cells with "; "', () => {
    const csv = toCsv([{ sources: ['A', 'B'] }], ['sources']);
    expect(csv).toBe('sources\r\nA; B');
  });

  // vendors/actors are arrays of {name} objects, not plain strings; the join
  // must pull .name rather than stringify each element (which would emit
  // "[object Object]" per entry).
  test('joins array-of-object cells by .name, not "[object Object]"', () => {
    const csv = toCsv([{ vendors: [{ name: 'Fortinet' }, { name: 'Ivanti' }] }], ['vendors']);
    expect(csv).toBe('vendors\r\nFortinet; Ivanti');
  });

  test('CSV_COLUMNS carries the vulnerability-detail fields an analyst needs for a ticket', () => {
    expect(CSV_COLUMNS).toEqual(expect.arrayContaining([
      'cveData', 'kevDueDate', 'kevOverdue', 'vendors', 'actors', 'description',
    ]));
    const row = {
      score: 91, title: 'Ivanti Connect Secure RCE', description: 'Actively exploited auth bypass',
      cveData: 'CVE-2026-0002 · CVSS 9.1 (Critical)', kevDueDate: '2026-07-10', kevOverdue: false,
      vendors: [{ name: 'Ivanti' }], actors: [{ name: 'APT-X', basis: 'title' }],
    };
    const csv = toCsv([row], CSV_COLUMNS);
    const [, dataLine] = csv.split('\r\n');
    expect(dataLine).toContain('CVE-2026-0002');
    expect(dataLine).toContain('2026-07-10');
    expect(dataLine).toContain('Ivanti');
    expect(dataLine).toContain('APT-X');
    expect(dataLine).not.toContain('[object Object]');
  });

  test('defends injection inside a row', () => {
    const csv = toCsv([{ title: '=HYPERLINK(1)' }], ['title']);
    expect(csv).toBe("title\r\n'=HYPERLINK(1)");
  });

  test('empty / non-array input yields just the header', () => {
    expect(toCsv([], ['score'])).toBe('score');
    expect(toCsv(null, ['score'])).toBe('score');
  });

  test('default columns are the documented evidence set', () => {
    expect(CSV_COLUMNS).toContain('corroboration');
    expect(CSV_COLUMNS).toContain('score');
  });
});

describe('parseWireQuery / serializeWireUrl', () => {
  test('no query → all defaults', () => {
    expect(parseWireQuery('')).toEqual({ horizon: 'all', critical: false, kev: false, unread: false, sort: 'relevance', q: '' });
  });

  test('valid params are read', () => {
    expect(parseWireQuery('?h=1&critical=1&kev=1&sort=newest'))
      .toEqual({ horizon: '1', critical: true, kev: true, unread: false, sort: 'newest', q: '' });
  });

  // The Unread toggle is deep-linkable, same as critical/kev.
  test('unread param is read', () => {
    expect(parseWireQuery('?unread=1'))
      .toEqual({ horizon: 'all', critical: false, kev: false, unread: true, sort: 'relevance', q: '' });
  });

  test('unknown / malformed params fall back to defaults, never throw', () => {
    expect(parseWireQuery('?h=9&sort=banana')).toEqual({ horizon: 'all', critical: false, kev: false, unread: false, sort: 'relevance', q: '' });
    expect(() => parseWireQuery(null)).not.toThrow();
    expect(() => parseWireQuery(42)).not.toThrow();
  });

  test('free-text q is read, trimmed, and capped at 100 chars', () => {
    expect(parseWireQuery('?q=Fortinet').q).toBe('Fortinet');
    expect(parseWireQuery('?q=%20%20spaced%20%20').q).toBe('spaced'); // trimmed
    expect(parseWireQuery(`?q=${encodeURIComponent('a'.repeat(200))}`).q).toHaveLength(100);
    expect(parseWireQuery('?q=CVE-2026-1234&h=2'))
      .toEqual({ horizon: '2', critical: false, kev: false, unread: false, sort: 'relevance', q: 'CVE-2026-1234' });
  });

  test('serialize omits defaults', () => {
    expect(serializeWireUrl({ horizon: 'all', critical: false, kev: false }, 'relevance')).toBe('/wire');
    expect(serializeWireUrl({ horizon: '2', critical: true }, 'newest')).toBe('/wire?h=2&critical=1&sort=newest');
  });

  test('serialize writes unread=1 only when set', () => {
    expect(serializeWireUrl({ horizon: 'all', unread: false }, 'relevance')).toBe('/wire');
    expect(serializeWireUrl({ horizon: 'all', unread: true }, 'relevance')).toBe('/wire?unread=1');
  });

  test('serialize writes q= only when non-empty, trimmed', () => {
    expect(serializeWireUrl({ horizon: 'all', q: '' }, 'relevance')).toBe('/wire');
    expect(serializeWireUrl({ horizon: 'all', q: '   ' }, 'relevance')).toBe('/wire'); // whitespace-only omitted
    expect(serializeWireUrl({ horizon: 'all', q: '  Ivanti  ' }, 'relevance')).toBe('/wire?q=Ivanti');
    expect(serializeWireUrl({ horizon: '1', kev: true, q: 'CVE-2026-1234' }, 'newest'))
      .toBe('/wire?h=1&kev=1&sort=newest&q=CVE-2026-1234');
  });

  test('round-trip: serialize(parse(x)) is stable for valid states', () => {
    for (const query of ['', '?h=1', '?h=3&kev=1', '?critical=1&sort=newest', '?h=2&critical=1&kev=1&sort=newest', '?q=Fortinet', '?h=2&q=CVE-2026-1234&sort=newest', '?unread=1&kev=1']) {
      const state = parseWireQuery(query);
      const round = parseWireQuery(serializeWireUrl(state, state.sort).split('?')[1] || '');
      expect(round).toEqual(state);
    }
  });
});

describe('filterSignals', () => {
  const data = [
    { horizon: 1, urgency: 'critical', isKEV: true, date: '2026-06-20' },
    { horizon: 2, urgency: 'routine', isKEV: false, date: '2026-06-25' },
    { horizon: 3, urgency: 'critical', isKEV: false, date: '2026-06-10' },
  ];

  test('horizon filter (string-coerced)', () => {
    expect(filterSignals(data, { horizon: '1' }, 'relevance')).toHaveLength(1);
    expect(filterSignals(data, { horizon: 'all' }, 'relevance')).toHaveLength(3);
  });

  test('critical and kev toggles compose', () => {
    expect(filterSignals(data, { critical: true }, 'relevance')).toHaveLength(2);
    expect(filterSignals(data, { kev: true }, 'relevance')).toHaveLength(1);
    expect(filterSignals(data, { critical: true, kev: true }, 'relevance')).toHaveLength(1);
  });

  test('newest sort orders by date descending without mutating input', () => {
    const out = filterSignals(data, {}, 'newest');
    expect(out.map(h => h.date)).toEqual(['2026-06-25', '2026-06-20', '2026-06-10']);
    expect(data[0].date).toBe('2026-06-20'); // original untouched
  });

  test('non-array input is handled gracefully', () => {
    expect(filterSignals(null, {}, 'relevance')).toEqual([]);
    expect(filterSignals(undefined, { kev: true }, 'newest')).toEqual([]);
  });

  test('free-text q matches title/description/cveData, case-insensitively', () => {
    const items = [
      { title: 'Fortinet FortiOS RCE', description: 'auth bypass', cveData: 'CVE-2026-0001 · CVSS 9.8' },
      { title: 'Ivanti Connect Secure', description: 'exploited in the wild', cveData: 'CVE-2026-0002 · CVSS 8.1' },
      { title: 'Routine patch Tuesday', description: 'monthly rollup', cveData: '' },
    ];
    expect(filterSignals(items, { q: 'fortinet' }, 'relevance').map(h => h.title)).toEqual(['Fortinet FortiOS RCE']);
    expect(filterSignals(items, { q: 'EXPLOITED' }, 'relevance').map(h => h.title)).toEqual(['Ivanti Connect Secure']); // description
    expect(filterSignals(items, { q: 'CVE-2026-0001' }, 'relevance').map(h => h.title)).toEqual(['Fortinet FortiOS RCE']); // cveData
    expect(filterSignals(items, { q: 'nomatch' }, 'relevance')).toEqual([]);
    expect(filterSignals(items, { q: '' }, 'relevance')).toHaveLength(3); // empty q is a no-op
  });

  test('q guards non-string fields and composes with other filters', () => {
    const items = [
      { title: 'Alpha', description: 42, cveData: null, isKEV: true },   // non-string desc/cveData must not throw
      { title: 'Alpha beta', description: 'x', cveData: 'y', isKEV: false },
    ];
    expect(() => filterSignals(items, { q: 'alpha' }, 'relevance')).not.toThrow();
    expect(filterSignals(items, { q: 'alpha' }, 'relevance')).toHaveLength(2);
    expect(filterSignals(items, { q: 'alpha', kev: true }, 'relevance')).toHaveLength(1); // composes with kev
  });

  // mark-read/dismiss: dismissedKeys always applies; readKeys only narrows
  // the result when filters.unread is truthy.
  test('dismissedKeys hides signals regardless of the unread toggle', () => {
    const items = [
      { title: 'Alpha', link: 'https://a.example/1' },
      { title: 'Beta', link: 'https://a.example/2' },
    ];
    const dismissedKeys = new Set([sigKey(items[0])]);
    expect(filterSignals(items, { dismissedKeys }, 'relevance').map(h => h.title)).toEqual(['Beta']);
    expect(filterSignals(items, { dismissedKeys, unread: true, readKeys: new Set() }, 'relevance').map(h => h.title)).toEqual(['Beta']);
  });

  test('unread=true hides signals in readKeys, but only when the toggle is on', () => {
    const items = [
      { title: 'Alpha', link: 'https://a.example/1' },
      { title: 'Beta', link: 'https://a.example/2' },
    ];
    const readKeys = new Set([sigKey(items[0])]);
    expect(filterSignals(items, { unread: true, readKeys }, 'relevance').map(h => h.title)).toEqual(['Beta']);
    expect(filterSignals(items, { unread: false, readKeys }, 'relevance')).toHaveLength(2); // toggle off — readKeys ignored
  });

  test('dismissedKeys/readKeys default to a no-op when absent', () => {
    const items = [{ title: 'Alpha', link: 'https://a.example/1' }];
    expect(() => filterSignals(items, {}, 'relevance')).not.toThrow();
    expect(filterSignals(items, {}, 'relevance')).toHaveLength(1);
    expect(filterSignals(items, { unread: true }, 'relevance')).toHaveLength(1); // no readKeys Set — no-op
  });
});

describe('sigKey', () => {
  test('prefers link, falls back to title, empty string when both absent', () => {
    expect(sigKey({ link: 'https://a.example/1', title: 'X' })).toBe('https://a.example/1');
    expect(sigKey({ title: 'X' })).toBe('X');
    expect(sigKey({})).toBe('');
    expect(sigKey(null)).toBe('');
  });
});

describe('dateMs', () => {
  test('parses a date to epoch ms, 0 for absent/unparseable', () => {
    expect(dateMs('2026-06-20T00:00:00Z')).toBe(Date.parse('2026-06-20T00:00:00Z'));
    expect(dateMs('')).toBe(0);
    expect(dateMs(null)).toBe(0);
    expect(dateMs('not a date')).toBe(0);
  });
});

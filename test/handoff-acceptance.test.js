import { describe, expect, test } from '@jest/globals';
import { inspectPdfBounds, inspectPdfText, parseCsv } from '../scripts/handoff-acceptance.mjs';
import { buildAppFixture } from './visual/app-fixtures.js';

describe('independent handoff acceptance readers', () => {
  test('CSV reader preserves quoted newlines, quotes, empty cells and formula guards', () => {
    const rows = parseCsv('title,description,read,empty\r\n"\'=SUM(1,2)","First line\nSecond ""quoted"" line",true,\r\nPlain,\'@text,false,""');
    expect(rows).toEqual([
      { title: "'=SUM(1,2)", description: 'First line\nSecond "quoted" line', read: 'true', empty: '' },
      { title: 'Plain', description: "'@text", read: 'false', empty: '' },
    ]);
  });

  test.each(['a,b\r\n"lost,b', 'a,b\r\n"a"junk,b', 'a,b\r\na,b,c', 'a,a\r\na,b'])('malformed CSV cannot count as a completed export: %s', text => {
    expect(() => parseCsv(text)).toThrow();
  });

  const footer = 'Verify every CVE ID, vendor name, date, and link before acting.';
  const text = `A complete synthetic assessment crosses the page\nBlueTeam.News · Print edition\nPage 1 of 2\fboundary without losing its final action or retained source evidence.\n${footer}\nBlueTeam.News · Print edition\nPage 2 of 2\f`;
  const passage = 'A complete synthetic assessment crosses the page boundary without losing its final action or retained source evidence.';
  test('PDF reader accepts a paragraph across pages with running folios', () => {
    expect(inspectPdfText(text, [passage, footer])).toMatchObject({ pageCount: 2, checkedPassages: 2 });
  });
  test('PDF reader rejects a lost final action, blank page, or omitted verification footer', () => {
    expect(() => inspectPdfText(text.replace('retained source evidence', 'nothing'), [passage])).toThrow(/lost text/);
    expect(() => inspectPdfText(text + 'BlueTeam.News · Print edition\nPage 3 of 3\f', [])).toThrow(/body content/);
    expect(() => inspectPdfText(text.replace(footer, ''), [])).toThrow(/verification colophon/);
  });
  test('PDF reader checks physical text coordinates independently of text presence', () => {
    const bbox = '<html><body><doc><page width="612" height="792"><word xMin="40" yMin="50" xMax="300" yMax="65">Synthetic</word></page></doc></body></html>';
    expect(inspectPdfBounds(bbox)).toEqual([{ width: 612, height: 792, words: 1 }]);
    expect(() => inspectPdfBounds(bbox.replace('xMax="300"', 'xMax="640"'))).toThrow(/exceeds page/);
    expect(() => inspectPdfBounds(bbox.replace('yMin="50"', 'yMin="-5"'))).toThrow(/exceeds page/);
  });
  test('handoff fixture includes all horizons, adverse CSV cells, and persisted edition warnings', () => {
    const fixture = buildAppFixture('handoff');
    expect(fixture.headlines.headlines.map(row => row.horizon)).toEqual([1, 1, 2, 3]);
    expect(fixture.headlines.headlines[0].title).toBe('=SUM(1,2) — synthetic, "gateway" test');
    expect(fixture.headlines.headlines[0].description).toContain('\n');
    expect(fixture.headlines.headlines[1].description).toMatch(/^\t/);
    expect(fixture.brief.meta.warnings).toHaveLength(2);
    expect(fixture.briefs[0].filename).not.toBe(buildAppFixture('long').briefs[0].filename);
    expect(fixture.brief.content).toContain('retain the decision record for workstream 7');
    expect(fixture.brief.content).toContain('neither has been approved yet');
  });
});

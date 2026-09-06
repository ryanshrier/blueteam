import { describe, expect, test } from '@jest/globals';
import { inspectPdfBounds, inspectPdfText, matchPdfPassages, parseCsv, pdfTextRegions } from '../scripts/handoff-acceptance.mjs';
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
  const line = (text, x, y) => `<line xMin="${x}" yMin="${y}">${text.split(' ').map((word, i) => `<word xMin="${x + i}" yMin="${y}">${word}</word>`).join('')}</line>`;
  const pdf = (...pages) => `<doc>${pages.map(lines => `<page width="612" height="792">${lines}</page>`).join('')}</doc>`;
  test('PDF regions join a complete paragraph across pages without sidebar text', () => {
    const bounds = pdf(line('One coherent paragraph continues', 40, 710) + line('A separate deadline sidebar', 400, 710),
      line('after the page break with retained evidence', 40, 50));
    expect(matchPdfPassages(pdfTextRegions(bounds), ['One coherent paragraph continues after the page break with retained evidence'])).toMatchObject({ checkedPassages: 1, matchedByRegion: 1, passagePositions: [{ index: 0, pages: [1, 2], left: 40, top: 710 }] });
    expect(() => matchPdfPassages(pdfTextRegions(bounds.replace('>retained<', '>lost<')), ['One coherent paragraph continues after the page break with retained evidence'])).toThrow(/lost text/);
  });
  test('PDF acceptance cannot borrow missing words from another column', () => {
    const bounds = pdf(line('The first part', 40, 50) + line('the missing ending', 400, 50));
    // Add an intervening line so the global physical stream is not itself the
    // requested sentence; isolated columns cannot be stitched as a subsequence.
    const interrupted = bounds.replace('</line><line', '</line>' + line('Unrelated intervening label', 40, 60) + '<line');
    expect(() => matchPdfPassages(pdfTextRegions(interrupted), ['The first part the missing ending'])).toThrow(/lost text/);
  });
  test('PDF repeated paragraphs require distinct physical occurrences', () => {
    const once = pdf(line('Identical retained paragraph', 40, 50));
    expect(() => matchPdfPassages(pdfTextRegions(once), ['Identical retained paragraph', 'Identical retained paragraph'])).toThrow(/repeated occurrence/);
    const twice = pdf(line('Identical retained paragraph', 40, 50) + line('Identical retained paragraph', 40, 100));
    expect(matchPdfPassages(pdfTextRegions(twice), ['Identical retained paragraph', 'Identical retained paragraph']).distinctWordsChecked).toBe(6);
  });
  test('PDF repeated passage locations use the earlier split column before a later ordinary paragraph', () => {
    const bounds = pdf(line('Repeated retained', 40, 710) + line('Separate sidebar', 400, 710),
      line('paragraph ending', 40, 50) + line('Repeated retained paragraph ending', 40, 200));
    const result = matchPdfPassages(pdfTextRegions(bounds), ['Repeated retained paragraph ending', 'Repeated retained paragraph ending']);
    expect(result.passagePositions.map(position => position.pages)).toEqual([[1, 2], [2]]);
  });
  test('PDF paragraphs retain their order within the same text column', () => {
    const reversed = pdf(line('Second complete paragraph', 40, 50) + line('First complete paragraph', 40, 100));
    expect(() => matchPdfPassages(pdfTextRegions(reversed), ['First complete paragraph', 'Second complete paragraph'])).toThrow(/changed order/);
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

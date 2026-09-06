import { describe, expect, test } from '@jest/globals';
import { archiveLocation, archiveRoute, archiveListHtml } from '../public/modules/briefing/brief-archive.js';
import { inputReceiptHtml, safeSourceUrl } from '../public/modules/briefing/brief-inputs.js';

describe('shareable archive navigation', () => {
  test('round trips queries with punctuation and a non-default page', () => {
    const url = archiveLocation('CVE-2026-1234 & vendor', 3);
    expect(archiveRoute(url.slice(url.indexOf('?')))).toEqual({ active: true, query: 'CVE-2026-1234 & vendor', page: 3, sort: 'relevance' });
    expect(archiveRoute(archiveLocation('SonicWall', 1, 'newest').split('?')[1]).sort).toBe('newest');
    expect(archiveRoute('?archive=1&page=-3').page).toBe(1);
    expect(archiveRoute('?archive=1&page=Infinity').page).toBe(1);
  });

  test('archive results expose actual links, summaries and continuation without raw HTML', () => {
    const html = archiveListHtml({ items: [{ filename: 'brief-2026-09-05-02.md', bluf: '**Assess** <script>bad</script>', wordCount: 660 }], total: 35, page: 2, pageSize: 12 });
    expect(html).toContain('href="/briefing/brief-2026-09-05-02.md"');
    expect(html).toContain('Assess &lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('Page 2 of 3');
    expect(html).toContain('archive=1&amp;');
  });
  test('long archive excerpts disclose the complete saved summary', () => {
    const bluf = 'A long edition assessment with qualifications. '.repeat(15) + 'Only act after applicability is established.';
    const html = archiveListHtml({ items: [{ filename: 'brief-2026-09-06-02.md', bluf }], total: 1, page: 1, pageSize: 12 });
    expect(html).toContain('Full edition summary');
    expect(html).toContain(bluf);
    expect(html).toContain('…</span>');
  });
});

describe('readable saved inputs', () => {
  test('source search and passages precede the complete capture accounting', () => {
    const html = inputReceiptHtml({ selectedEvidence: [{ title: 'Captured advisory', source: 'Vendor', passage: 'Complete retained source text.' }] });
    expect(html.indexOf('data-input-search')).toBeLessThan(html.indexOf('class="brief-input-sources"'));
    expect(html.indexOf('class="brief-input-sources"')).toBeLessThan(html.indexOf('Capture details and edition context'));
    expect(html).toContain('Complete retained source text.');
    expect(html).toContain('Inclusion alone does not establish support or independent confirmation.');
  });
  test('retains authored source title, publisher, time, excerpt and watch context safely', () => {
    const html = inputReceiptHtml({ capturedAt: '2026-09-05T15:00:00Z', modelUsed: 'Recorded model', promptWatchProfile: { technologies: ['Gateway'] }, selectedEvidence: [
      { title: 'Vendor <advisory>', source: 'Vendor', url: 'https://example.test/advisory', publishedAt: '2026-09-04T12:00:00Z', passage: { text: '<img src=x onerror=bad> Retained evidence.' } },
      { title: 'Unsafe link remains plain text', url: 'javascript:alert(1)' },
      { title: 'Credential-bearing URL remains plain text', url: 'https://reader:secret@example.test/report' },
    ] });
    expect(html).toContain('Vendor &lt;advisory&gt;');
    expect(html).toContain('Gateway');
    expect(html).toContain('Sep 5, 2026, 15:00 UTC');
    expect(html).toContain('Retained passage and capture');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('reader:secret');
    expect(safeSourceUrl('//example.test')).toBe('');
    expect(safeSourceUrl('https://reader@example.test/report')).toBe('');
    expect(safeSourceUrl('https://example.test/report')).toBe('https://example.test/report');
  });

  test('keeps original citation bindings but routes a moved judgment to its reviewed follow-up', () => {
    const html = inputReceiptHtml({ filename: 'brief-2026-09-05-02.md', grounding: { sources: [{ id: 'src-retained', title: 'Retained report', evidenceText: 'Reported claim.' }] },
      judgmentEvidence: [{ signal: 6, sourceIds: ['src-retained'] }, { signal: '<img>', sourceIds: ['src-retained'] }],
      review: { notes: [{ original: '### Signal 6 — AI claim', replacement: '', anchor: 'section-2-developing-situations' }] } });
    expect(html).toContain('Original judgment 6 (moved to Developing)');
    expect(html).toContain('/briefing/brief-2026-09-05-02.md#section-2-developing-situations');
    expect(html).not.toContain('#judgment-6');
    expect(html).not.toContain('<img>');
  });

  test('distinguishes unchanged retained inputs from a newly published threat development', () => {
    const html = inputReceiptHtml({ inputDelta: { kind: 'unchanged-inputs', added: 0, changed: 0, removed: 0, unchanged: 75,
      explanation: 'Counts compare retained publisher passages. Retrieval or text changes do not by themselves establish a new threat development.' } });
    expect(html).toContain('Unchanged retained source inputs');
    expect(html).toContain('75 unchanged');
    expect(html).toContain('do not by themselves establish a new threat development');
    expect(inputReceiptHtml({})).toContain('This legacy receipt does not record an input comparison');
  });
});

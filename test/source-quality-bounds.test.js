import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { classifySourceEvidence, selectOperationalExcerpt, SOURCE_EVIDENCE_LIMITS } from '../lib/evidence-quality.js';
import { closeFeedXmlParser } from '../lib/feed-xml.js';

const safeFetch = jest.fn(), readCapped = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({ safeFetch, readCapped }));
jest.unstable_mockModule('../lib/db.js', () => ({ getFeedCache: () => null, setFeedCache: jest.fn(),
  logFeedHealth: jest.fn(), getExternalCache: () => null, setExternalCache: jest.fn() }));
const { fetchNewsContext } = await import('../lib/feeds.js');
afterAll(async () => { await closeFeedXmlParser(); });

describe('bounded source quality work', () => {
  test.each([
    ['Gateway — patch', 'Gateway: patch. Gateway — patch!'],
    ['CAFÉ gateway', 'Cafe\u0301 gateway. CAFÉ gateway.'],
    ['Office gateway', 'O\ufb03ce gateway. Office gateway.'],
    ['Ａｃｍｅ gateway', 'Acme gateway. Ａｃｍｅ gateway.'],
  ])('repeated %s headings remain title-only across punctuation and Unicode forms', (title, passage) => {
    expect(classifySourceEvidence({ title, passage })).toMatchObject({ status: 'title-only', substantive: false });
  });

  test('removes only complete heading copies and preserves reporting after a partial copy', () => {
    expect(classifySourceEvidence({ title: 'Acme Gateway',
      passage: 'Acme Gateway. Acme Gateway: Acme released patch 2.4 for CVE-2026-12345.' })).toMatchObject({ substantive: true });
    expect(classifySourceEvidence({ title: 'Acme Gateway', passage: 'Acme Gateways require patch 2.4.' })).toMatchObject({ substantive: true });
    expect(classifySourceEvidence({ title: 'Acme Gateway', passage: 'Acme Gateway. Sign in to continue.' })).toMatchObject({ status: 'contaminated' });
    const original = 'Acme Gateway. Acme released patch 2.4 for CVE-2026-12345.';
    expect(selectOperationalExcerpt(original)).toBe(original);
  });

  test('oversized, overnormalized and overstructured evidence never becomes a substantive truncated sample', () => {
    const limited = { status: 'limited', substantive: false, reasons: ['source-computation-limit'] };
    expect(classifySourceEvidence({ passage: 'x'.repeat(SOURCE_EVIDENCE_LIMITS.maxCharacters + 1) })).toMatchObject(limited);
    expect(classifySourceEvidence({ title: 'x'.repeat(SOURCE_EVIDENCE_LIMITS.maxTitleCharacters + 1), passage: 'Fixed in 2.4.' })).toMatchObject(limited);
    expect(classifySourceEvidence({ passage: '\ufdfa'.repeat(150_000) })).toMatchObject(limited);
    expect(classifySourceEvidence({ passage: '<b>x</b>'.repeat(SOURCE_EVIDENCE_LIMITS.maxHtmlRegions) })).toMatchObject(limited);
  });

  test('the former two-MB heading and unmatched-markup attacks complete within a bounded child process', () => {
    const module = new URL('../lib/evidence-quality.js', import.meta.url).href;
    const script = `import assert from 'node:assert/strict';
      import { classifySourceEvidence } from ${JSON.stringify(module)};
      assert.equal(classifySourceEvidence({title:'Acme', passage:'Acme '.repeat(400000)}).substantive, false);
      assert.equal(classifySourceEvidence({title:'Acme', passage:'<'.repeat(2000000)}).status, 'title-only');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 16_384,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|path|temp|tmp)$/i.test(key))),
    });
    expect({ code: child.status, error: child.error?.code, stderr: child.stderr }).toEqual({ code: 0, error: undefined, stderr: '' });
  });

  test('the RSS front door processes repeated-title fields without starving parent timers', async () => {
    const passage = 'Acme '.repeat(1638);
    const xml = '<rss version="2.0"><channel>' + Array.from({ length: 10 }, (_, index) =>
      `<item><title>Acme</title><description>${passage}</description><link>https://example.test/quality-${index}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('') + '</channel></rss>';
    safeFetch.mockResolvedValue(new Response(xml, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }));
    readCapped.mockResolvedValue(xml);
    let previous = performance.now(), longestGap = 0;
    const timer = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - previous); previous = now; }, 10);
    try {
      const headlines = await fetchNewsContext([{ url: 'https://example.test/quality-feed.xml', source: 'Synthetic quality bounds', horizon: 1 }]);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(headlines).toHaveLength(10);
      expect(headlines.every(headline => headline.passage === passage.trim())).toBe(true);
      // Previously this exact ten-item shape monopolized the event loop for
      // roughly1.8 seconds. The generous bound allows shared-runner scheduling.
      expect(longestGap).toBeLessThan(1000);
    } finally { clearInterval(timer); }
  });
});

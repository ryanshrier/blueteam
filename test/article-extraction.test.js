import { describe, expect, test } from '@jest/globals';
import { createArticleExtractor, extractArticleInWorker, ARTICLE_EXTRACTION_LIMITS } from '../lib/article-extraction.js';

const REPORT = 'The vendor confirmed that CVE-2026-12345 affects Gateway 2.3. Administrators must install release 2.4 and rotate compromised credentials.';
const HTML = `<article><p>${REPORT}</p></article>`;
const CONTEXT = { title: 'Gateway vulnerability advisory', url: 'https://example.test/advisory' };

describe('isolated article extraction', () => {
  test('retains actionable reporting and excludes hidden, related and executable regions', async () => {
    const html = `<main><p>${REPORT}</p><script>forged exploited vulnerability</script><div hidden><p>Hidden fabricated reporting.</p></div><div class="related-stories"><p>Unrelated reporting.</p></div></main>`;
    expect(await extractArticleInWorker(html, CONTEXT)).toBe(REPORT);
  });

  test('nested fallback paragraphs retain their prose once', async () => {
    const html = '<p><span>'.repeat(20) + REPORT + '</span></p>'.repeat(20);
    expect(await extractArticleInWorker(html, CONTEXT)).toBe(REPORT);
  });

  test('rejects the hostile nested article while the parent event loop stays responsive', async () => {
    // This is the audited fallback shape: previously 320 KB exceeded eight
    // seconds of synchronous work and copied the passage once per ancestor.
    const html = '<p><span>'.repeat(16_000) + REPORT + '</span></p>'.repeat(16_000);
    const result = extractArticleInWorker(html, CONTEXT).then(() => 'extracted', () => 'rejected');
    expect(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('responsive'), 0))])).toBe('responsive');
    expect(await result).toBe('rejected');
    expect(await extractArticleInWorker(HTML, CONTEXT)).toBe(REPORT);
  });

  test.each([
    ['node count', '<section>' + '<b>x</b>'.repeat(20_000) + '</section>'],
    ['paragraph count', `<section>${`<p>${REPORT}</p>`.repeat(2_001)}</section>`],
    ['attributes', `<article ${Array.from({ length: 129 }, (_, index) => `a${index}="value"`).join(' ')}>${REPORT}</article>`],
  ])('rejects excessive %s instead of sampling the page', async (_label, html) => {
    await expect(extractArticleInWorker(html, CONTEXT)).rejects.toThrow(/extraction limits/);
  });

  test('rejects HTML beyond the byte limit before worker admission', async () => {
    await expect(extractArticleInWorker('x'.repeat(ARTICLE_EXTRACTION_LIMITS.maxBytes + 1), CONTEXT)).rejects.toThrow(/size limit/);
  });

  test('keeps a bounded excerpt that includes mitigation after a long opening', async () => {
    const html = `<article>${'<p>This paragraph introduces the service and its background for readers.</p>'.repeat(65)}<p>${REPORT}</p></article>`;
    const result = await extractArticleInWorker(html, CONTEXT);
    expect(result.length).toBeLessThanOrEqual(ARTICLE_EXTRACTION_LIMITS.maxOutputCharacters);
    expect(result).toContain('install release 2.4');
    expect(result).toContain('[…]');
  });

  test('bounds queued work and restores capacity after completion', async () => {
    const extractor = createArticleExtractor({ maxPending: 2 });
    try {
      const first = extractor.extract(HTML, CONTEXT), second = extractor.extract(HTML, CONTEXT);
      await expect(extractor.extract(HTML, CONTEXT)).rejects.toThrow(/queue is full/);
      await expect(Promise.all([first, second])).resolves.toEqual([REPORT, REPORT]);
      await expect(extractor.extract(HTML, CONTEXT)).resolves.toBe(REPORT);
    } finally { await extractor.close(); }
  });

  test('hard deadline terminates active work and expires queued work', async () => {
    const extractor = createArticleExtractor({ timeoutMs: 1 });
    try {
      const results = await Promise.allSettled([extractor.extract(HTML, CONTEXT), extractor.extract(HTML, CONTEXT)]);
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(results.every(result => /timed out/.test(result.reason.message))).toBe(true);
    } finally { await extractor.close(); }
  });

  test('caller cancellation removes queued work and terminates active work', async () => {
    const extractor = createArticleExtractor();
    const firstController = new AbortController(), queuedController = new AbortController();
    try {
      const first = extractor.extract(HTML, CONTEXT, { signal: firstController.signal });
      const queued = extractor.extract(HTML, CONTEXT, { signal: queuedController.signal });
      const results = Promise.allSettled([first, queued]);
      queuedController.abort();
      firstController.abort();
      expect((await results).every(result => result.status === 'rejected' && /aborted/.test(result.reason.message))).toBe(true);
      await expect(extractor.extract(HTML, CONTEXT)).resolves.toBe(REPORT);
    } finally { await extractor.close(); }
  });

  test('shutdown drains terminated work and prevents new admission', async () => {
    const extractor = createArticleExtractor();
    const results = Promise.allSettled([extractor.extract(HTML, CONTEXT), extractor.extract(HTML, CONTEXT)]);
    await extractor.close();
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
    await expect(extractor.extract(HTML, CONTEXT)).rejects.toThrow(/closed/);
  });
});

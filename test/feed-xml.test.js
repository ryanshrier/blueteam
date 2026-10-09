import { describe, expect, test } from '@jest/globals';
import { createFeedXmlParser, parseFeedXml, FEED_XML_LIMITS } from '../lib/feed-xml.js';

const RSS = '<rss><channel><item><title>Security advisory</title><description><![CDATA[<p>Patch available.</p>]]></description><link>https://example.org/report</link></item></channel></rss>';

describe('isolated feed XML parser', () => {
  test('preserves RSS, Atom attributes, CDATA, and literal entities', async () => {
    const rss = await parseFeedXml(RSS);
    expect(rss.rss.channel.item[0].description).toBe('<p>Patch available.</p>');
    const atom = await parseFeedXml('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Patch &amp; review</title><link href="https://example.org/advisory"/></entry></feed>');
    expect(atom.feed.entry[0]).toEqual({ title: 'Patch &amp; review', link: { '@_href': 'https://example.org/advisory' } });
  });

  test('does not expand document-defined entities', async () => {
    const parsed = await parseFeedXml('<!DOCTYPE rss [<!ENTITY injected "expanded source text">]><rss><channel><item><title>&injected;</title></item></channel></rss>');
    expect(parsed.rss.channel.item[0].title).toBe('&injected;');
  });

  test('accepts a full-content feed close to the Project Zero 16 MB body cap', async () => {
    const content = '<p>Research evidence and mitigation details.</p>'.repeat(320_000);
    const xml = `<rss><channel><item><title>Full research article</title><description><![CDATA[${content}]]></description></item></channel></rss>`;
    expect(Buffer.byteLength(xml)).toBeGreaterThan(14_000_000);
    expect(Buffer.byteLength(xml)).toBeLessThan(FEED_XML_LIMITS.maxBytes);
    const parsed = await parseFeedXml(xml);
    expect(parsed.rss.channel.item[0].description).toBe(content);
  }, 10_000);

  test('accepts large escaped Atom content without allocating an XML text rope', async () => {
    const content = '&lt;p&gt;Research evidence.&lt;/p&gt;'.repeat(390_000);
    const xml = `<feed><entry><title>Research article</title><content type="html">${content}</content></entry></feed>`;
    expect(Buffer.byteLength(xml)).toBeGreaterThan(14_000_000);
    const parsed = await parseFeedXml(xml);
    expect(parsed.feed.entry[0].content).toEqual({ '#text': content, '@_type': 'html' });
  }, 10_000);

  test('rejects dense small-node XML while the main event loop remains available', async () => {
    const parsing = parseFeedXml(`<rss><channel>${'<x/>'.repeat(975_000)}</channel></rss>`);
    const outcome = parsing.then(() => 'parsed', () => 'rejected');
    // A timer scheduled after parse() must run before hostile XML completes.
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('responsive'), 0))])).toBe('responsive');
    expect(await outcome).toBe('rejected');
    // A rejected document must not poison the queue or parser for later feeds.
    expect((await parseFeedXml(RSS)).rss.channel.item[0].title).toBe('Security advisory');
  });

  test.each([
    ['deep nesting', `<rss><channel>${'<nested>'.repeat(80)}text${'</nested>'.repeat(80)}</channel></rss>`],
    ['attribute amplification', `<rss><channel><item ${Array.from({ length: 129 }, (_, i) => `a${i}="value"`).join(' ')}/></channel></rss>`],
  ])('rejects %s', async (_label, xml) => {
    await expect(parseFeedXml(xml)).rejects.toThrow(/parser limits/);
  });

  test('rejects input beyond the absolute byte cap before starting a worker', async () => {
    await expect(parseFeedXml('x'.repeat(FEED_XML_LIMITS.maxBytes + 1))).rejects.toThrow(/size limit/);
  });

  test('bounds the queue and recovers capacity after completion', async () => {
    const parser = createFeedXmlParser({ maxPending: 2 });
    try {
      const first = parser.parse(RSS);
      const second = parser.parse(RSS);
      await expect(parser.parse(RSS)).rejects.toThrow(/queue is full/);
      await Promise.all([first, second]);
      await expect(parser.parse(RSS)).resolves.toHaveProperty('rss.channel.item');
    } finally { await parser.close(); }
  });

  test('terminates a worker when its deadline expires', async () => {
    const parser = createFeedXmlParser({ timeoutMs: 1 });
    try {
      await expect(parser.parse(RSS)).rejects.toThrow(/timed out/);
    } finally { await parser.close(); }
  });

  test('shutdown terminates active work, rejects queued work, and disallows new work', async () => {
    const parser = createFeedXmlParser();
    const first = parser.parse(RSS);
    const second = parser.parse(RSS);
    const results = Promise.allSettled([first, second]);
    // Let the first queued job create its worker before closing the parser.
    await Promise.resolve();
    await parser.close();
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    await expect(parser.parse(RSS)).rejects.toThrow(/closed/);
  });
});

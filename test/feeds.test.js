import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// #44 — fetchNewsContext talks to the network (lib/net.js) and the cache/health
// tables (lib/db.js). Mock both so the ingest-front-door tests below are
// hermetic (no real network, no real SQLite) and deterministic. Must be
// registered before the dynamic import of the module under test.
const safeFetchMock = jest.fn();
const readCappedMock = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({
  safeFetch: safeFetchMock,
  readCapped: readCappedMock,
}));

const getFeedCacheMock = jest.fn();
const setFeedCacheMock = jest.fn();
const logFeedHealthMock = jest.fn();
jest.unstable_mockModule('../lib/db.js', () => ({
  getFeedCache: getFeedCacheMock,
  setFeedCache: setFeedCacheMock,
  logFeedHealth: logFeedHealthMock,
}));

const {
  deduplicateWithCorroboration, stripHtml, publisherKey,
  resolveGoogleNewsLink, parseRetryAfter, fetchNewsContext, fetchSearchResults,
  getFeedHealth, feedUserAgent, FEED_FIELD_LIMITS,
} = await import('../lib/feeds.js');
const { getDomainPack, setDomainPack } = await import('../lib/domain.js');

describe('feedUserAgent', () => {
  test('identifies BlueTeam.News instead of impersonating a browser', () => {
    const value = feedUserAgent({});
    expect(value).toMatch(/^BlueTeam\.News\/\d/);
    expect(value).toContain('https://blueteam.news');
    expect(value).not.toContain('Mozilla/5.0');
  });

  test('accepts an operator-supplied contact identity', () => {
    expect(feedUserAgent({ BLUETEAM_USER_AGENT: '  BlueTeam.News/operator@example.org  ' }))
      .toBe('BlueTeam.News/operator@example.org');
  });
});

// A minimal Response-shaped fake — fetchNewsContext only touches .status,
// .ok, and .headers.get(); the body is consumed by the mocked readCapped
// (which ignores the actual Response), so it never touches res.body.
function fakeResponse({ status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

describe('stripHtml', () => {
  test('decodes entity-encoded markup from feeds with entity processing off', () => {
    const raw = '&lt;p&gt;CISA has added one new vulnerability to its &lt;a href="https://example.com"&gt;KEV catalog&lt;/a&gt;.&lt;/p&gt;';
    expect(stripHtml(raw)).toBe('CISA has added one new vulnerability to its KEV catalog.');
  });

  test('handles double-encoded ampersand chains and numeric entities', () => {
    expect(stripHtml('Patch &amp;amp; pray &#8212; again&#x2026;')).toBe('Patch & pray — again…');
  });

  test('strips real tags and collapses whitespace', () => {
    expect(stripHtml('<div>  spaced   <b>out</b>\n text </div>')).toBe('spaced out text');
  });

  test('passes plain text through', () => {
    expect(stripHtml('No markup here')).toBe('No markup here');
  });
});

describe('deduplicateWithCorroboration', () => {
  test('merges near-duplicate headlines and tracks distinct publisher identities', () => {
    const headlines = [
      { title: 'Critical VPN zero-day exploited by ransomware group', source: 'A', corroboration: 1 },
      { title: 'Ransomware group exploits critical VPN zero-day vulnerability', source: 'B', corroboration: 1 },
      { title: 'Quarterly cloud spending report released', source: 'C', corroboration: 1 },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(2);
    const merged = result.find(h => /VPN/.test(h.title));
    expect(merged.corroboration).toBe(2);
  });

  test('keeps the richer description and link on the survivor', () => {
    const headlines = [
      { title: 'Major breach at logistics firm disrupts shipping', description: 'short', link: '', corroboration: 1 },
      { title: 'Logistics firm breach disrupts major shipping operations', description: 'a much longer and more detailed description of the incident', link: 'https://example.com/a', corroboration: 1 },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
    expect(result[0].link).toBe('https://example.com/a');
    expect(result[0].description.length).toBeGreaterThan(10);
  });

  test('distinct stories survive', () => {
    const headlines = [
      { title: 'Phishing campaign targets healthcare payroll systems', corroboration: 1 },
      { title: 'New post-quantum cryptography standard finalized', corroboration: 1 },
    ];
    expect(deduplicateWithCorroboration(headlines, 0.5).length).toBe(2);
  });

  test('empty input returns empty output', () => {
    expect(deduplicateWithCorroboration([])).toEqual([]);
  });

  // Source identity: the stored count uses distinct publishers, not feed copies.
  test('one publisher echoed across feeds counts as a SINGLE source', () => {
    const headlines = [
      { title: 'Critical VPN zero-day exploited in the wild', source: 'BleepingComputer', link: 'https://www.bleepingcomputer.com/news/a' },
      { title: 'Critical VPN zero-day actively exploited in the wild now', source: 'BleepingComputer', link: 'https://www.bleepingcomputer.com/amp/news/a' },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
    expect(result[0].corroboration).toBe(1);
  });

  test('two distinct publisher identities raise the count to 2', () => {
    const headlines = [
      { title: 'Critical VPN zero-day exploited in the wild', source: 'BleepingComputer', link: 'https://bleepingcomputer.com/a' },
      { title: 'Critical VPN zero-day actively exploited in the wild now', source: 'The Hacker News', link: 'https://thehackernews.com/b' },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
    expect(result[0].corroboration).toBe(2);
  });

  // Documents the KNOWN, ACCEPTED order-dependence of the greedy single-pass
  // algorithm (see the design note above deduplicateWithCorroboration). A
  // "bridge" headline is ≥threshold-similar to BOTH ends, but the two ends are
  // NOT similar to each other (a non-transitive A~B~D / A≁D triple). Greedy
  // merges into the FIRST matching survivor, so the result depends on input
  // order. This is a regression guard, not a bug report: the pipeline's input
  // order is stable (RSS feeds in config order, then search), so the chosen
  // ordering — and thus the output — is deterministic in production. If this
  // test ever changes, the dedup contract has changed.
  test('greedy dedup is order-dependent for a non-transitive bridge (by design)', () => {
    // Fresh copies per call: dedup mutates headlines in place.
    const bridge = () => ({ title: 'Zero day vulnerability actively exploited', source: 'Bridge', link: 'https://bridge.example/x' });
    const end1   = () => ({ title: 'Zero day vuln actively exploited',          source: 'End1',   link: 'https://end1.example/x' });
    const end2   = () => ({ title: 'Zero day vulnerability exploited in wild',  source: 'End2',   link: 'https://end2.example/x' });

    // Sanity-check the fixture's non-transitive shape: bridge merges with each
    // end pairwise, but the two ends do NOT merge with each other.
    expect(deduplicateWithCorroboration([bridge(), end1()], 0.5).length).toBe(1);
    expect(deduplicateWithCorroboration([bridge(), end2()], 0.5).length).toBe(1);
    expect(deduplicateWithCorroboration([end1(), end2()], 0.5).length).toBe(2);

    // Bridge first: both ends collapse into it → ONE survivor, corroboration 3.
    const bridgeFirst = deduplicateWithCorroboration([bridge(), end1(), end2()], 0.5);
    expect(bridgeFirst.length).toBe(1);
    expect(bridgeFirst[0].corroboration).toBe(3);

    // Ends first, bridge last: end1 and end2 don't merge; the bridge joins only
    // the first match (end1) → TWO survivors, max corroboration 2.
    const bridgeLast = deduplicateWithCorroboration([end1(), end2(), bridge()], 0.5);
    expect(bridgeLast.length).toBe(2);
    expect(Math.max(...bridgeLast.map(h => h.corroboration))).toBe(2);

    // The two orderings disagree on BOTH survivor count and corroboration —
    // that disagreement IS the order-dependence.
    expect(bridgeFirst.length).not.toBe(bridgeLast.length);
    expect(bridgeFirst[0].corroboration).not.toBe(Math.max(...bridgeLast.map(h => h.corroboration)));
  });

  // #95 — the shipped default is 0.55 (not the 0.5 every other test in this file
  // pins explicitly). A TF-IDF tweak that shifts similarity by a few points could
  // flip merge decisions at the REAL production threshold while every 0.5-pinned
  // test above stays green. This pair's cosine similarity sits between 0.50 and
  // 0.55 — it merges when called with the old 0.5 but must NOT merge at the
  // shipped default.
  test('a near-boundary pair (similarity between 0.50 and 0.55) does not merge at the default threshold', () => {
    const headlines = () => [
      { title: 'Critical Windows flaw actively exploited by attackers' },
      { title: 'Windows flaw now actively exploited in attacks' },
    ];
    // Sanity-check the fixture actually straddles the boundary as intended.
    expect(deduplicateWithCorroboration(headlines(), 0.5).length).toBe(1);
    expect(deduplicateWithCorroboration(headlines(), 0.55).length).toBe(2);
    // No threshold argument — exercises the shipped default (0.55), not 0.5.
    expect(deduplicateWithCorroboration(headlines()).length).toBe(2);
  });

  test('a pair just above the default threshold still merges at the default', () => {
    const headlines = () => [
      { title: 'Major ransomware attack hits hospital network systems' },
      { title: 'Ransomware attack hits major hospital network' },
    ];
    expect(deduplicateWithCorroboration(headlines(), 0.55).length).toBe(1);
    // No threshold argument — exercises the shipped default (0.55).
    expect(deduplicateWithCorroboration(headlines()).length).toBe(1);
  });

  // #42 — templated vendor-advisory titles can clear the cosine threshold while
  // naming two DISTINCT CVEs; the merge must be refused so the second
  // vulnerability isn't hidden from the run and cross-source credit isn't fabricated.
  test('refuses to merge headlines citing different, disjoint CVE IDs', () => {
    const headlines = [
      { title: 'Fortinet patches CVE-2026-1111 exploited in the wild', source: 'A' },
      { title: 'Fortinet patches CVE-2026-2222 exploited in the wild', source: 'B' },
    ];
    // Sanity-check the fixture actually clears the merge threshold on tokens alone.
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(2);
  });

  test('still merges near-duplicates that cite the SAME CVE ID', () => {
    const headlines = [
      { title: 'Fortinet patches CVE-2026-1111 exploited in the wild', source: 'A' },
      { title: 'Fortinet fixes CVE-2026-1111 actively exploited in the wild', source: 'B' },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
  });

  test('still merges near-duplicates when neither side cites a CVE', () => {
    const headlines = [
      { title: 'Critical VPN zero-day exploited by ransomware group', source: 'A' },
      { title: 'Ransomware group exploits critical VPN zero-day vulnerability', source: 'B' },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
  });

  // #85 — a survivor with no parseable date should adopt a merged duplicate's
  // real date rather than stay pinned at the recency prior; cross-reported
  // stories are exactly the ones that most need an accurate freshness score.
  test('merge adopts the duplicate\'s date when the survivor has none', () => {
    const headlines = [
      { title: 'Major breach at logistics firm disrupts shipping', date: '', dateUnknown: true },
      { title: 'Logistics firm breach disrupts major shipping operations', date: '2026-06-30T12:00:00Z', dateUnknown: false },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
    expect(result[0].dateUnknown).toBe(false);
    expect(result[0].date).toBe('2026-06-30T12:00:00Z');
  });

  test('merge does not overwrite the survivor\'s own valid date', () => {
    const headlines = [
      { title: 'Major breach at logistics firm disrupts shipping', date: '2026-06-01T00:00:00Z', dateUnknown: false },
      { title: 'Logistics firm breach disrupts major shipping operations', date: '2026-06-30T12:00:00Z', dateUnknown: false },
    ];
    const result = deduplicateWithCorroboration(headlines, 0.5);
    expect(result.length).toBe(1);
    expect(result[0].date).toBe('2026-06-01T00:00:00Z');
  });
});

describe('resolveGoogleNewsLink', () => {
  test('passes through a non-Google-News link untouched', () => {
    expect(resolveGoogleNewsLink('https://example.com/article')).toBe('https://example.com/article');
  });

  test('decodes a publisher href embedded in the description anchor', () => {
    const link = 'https://news.google.com/rss/articles/CBMabc123?oc=5';
    const desc = 'Read more <a href="https://www.bleepingcomputer.com/news/security/x">here</a> for details.';
    expect(resolveGoogleNewsLink(link, desc)).toBe('https://www.bleepingcomputer.com/news/security/x');
  });

  test('ignores a description anchor that is itself a Google News link', () => {
    const link = 'https://news.google.com/rss/articles/CBMabc123?oc=5';
    const desc = '<a href="https://news.google.com/rss/articles/other">mirror</a>';
    expect(resolveGoogleNewsLink(link, desc)).toBe('');
  });

  test('drops an undecodable Google News link rather than guessing', () => {
    const link = 'https://news.google.com/rss/articles/opaque-protobuf-garbage';
    expect(resolveGoogleNewsLink(link, '')).toBe('');
  });

  test('drops the link when neither description nor path yields a publisher URL', () => {
    expect(resolveGoogleNewsLink('https://news.google.com/rss/articles/xyz', undefined)).toBe('');
  });

  test('drops credentials embedded in direct and description-derived publisher URLs', () => {
    expect(resolveGoogleNewsLink('https://user:secret@example.com/private')).toBe('');
    const googleLink = 'https://news.google.com/rss/articles/opaque-id';
    const desc = '<a href="https://user:secret@publisher.example/private">publisher</a>';
    expect(resolveGoogleNewsLink(googleLink, desc)).toBe('');
  });
});

describe('parseRetryAfter', () => {
  test('parses a numeric seconds value', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  test('parses an HTTP date into a millisecond delta', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    // Allow slack for test execution time between building `future` and parsing it.
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThan(65_000);
  });

  test('returns 0 for a missing header', () => {
    expect(parseRetryAfter('')).toBe(0);
    expect(parseRetryAfter(undefined)).toBe(0);
  });

  test('returns 0 for an unparseable value', () => {
    expect(parseRetryAfter('not-a-number-or-date')).toBe(0);
  });

  test('never returns negative for a past HTTP date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

// #44 — the untested network-facing half of the pipeline: RSS vs Atom shapes,
// malformed XML, missing dates, per-feed failure isolation, and the health
// status strings each path reports. safeFetch/readCapped are mocked (see the
// module-mock block at the top of this file) so these tests hit no network.
describe('fetchNewsContext — feed ingest front door', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    readCappedMock.mockReset();
    getFeedCacheMock.mockReset().mockReturnValue(undefined);
    setFeedCacheMock.mockReset();
    logFeedHealthMock.mockReset();
  });

  const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Critical flaw patched in widely used library</title>
    <description>A short summary of the issue.</description>
    <link>https://example.com/news/a</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
  </item>
</channel></rss>`;

  const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>New research on supply-chain attacks published</title>
    <summary>Researchers detail a new technique.</summary>
    <link href="https://example.com/blog/b" />
    <published>${new Date().toISOString()}</published>
  </entry>
</feed>`;

  test('parses an RSS 2.0 feed into headline records', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(RSS_FIXTURE);
    const feeds = [{ url: 'https://example.com/rss', source: 'Example RSS', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Critical flaw patched in widely used library');
    expect(results[0].link).toBe('https://example.com/news/a');
    expect(results[0].source).toBe('Example RSS');
    expect(getFeedHealth().feeds['Example RSS']).toBe('ok');
  });

  test('parses an Atom feed (entry/summary/published) into headline records', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(ATOM_FIXTURE);
    const feeds = [{ url: 'https://example.com/atom', source: 'Example Atom', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('New research on supply-chain attacks published');
    expect(results[0].link).toBe('https://example.com/blog/b');
  });

  test('malformed XML on one feed reports a parse-error status and does not sink other feeds', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    // readCapped resolves per-URL: the "bad" feed gets truncated/invalid XML,
    // the "good" feed gets a valid fixture. fetchNewsContext calls readCapped
    // with the Response, not the URL, so key the fixture off safeFetch's call
    // order instead — pooledMap processes feeds in array order at concurrency
    // 8, and with only 2 feeds both start before either resolves, so pairing
    // by call count on safeFetch (which happens first, per feed) is reliable.
    let call = 0;
    readCappedMock.mockImplementation(async () => {
      call++;
      return call === 1 ? '<rss><channel><item><title>Unclosed<' : RSS_FIXTURE;
    });
    const feeds = [
      { url: 'https://bad.example.com/rss', source: 'Bad Feed', horizon: 1 },
      { url: 'https://good.example.com/rss', source: 'Good Feed', horizon: 1 },
    ];
    const results = await fetchNewsContext(feeds, {});
    const health = getFeedHealth().feeds;
    // Malformed XML must not throw fast-xml-parser to the point of stopping the
    // whole pipeline, and the good feed's items must still make it through.
    expect(results.some(h => h.source === 'Good Feed')).toBe(true);
    expect(['parse-error', 'ok', 'empty']).toContain(health['Bad Feed']);
  });

  test('an item with no title is skipped', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(`<rss><channel><item><description>no title here</description></item></channel></rss>`);
    const feeds = [{ url: 'https://example.com/rss', source: 'No Title Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(0);
    expect(getFeedHealth().feeds['No Title Feed']).toBe('empty');
  });

  test('an item with a missing/unparseable date is admitted and tagged dateUnknown', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(`<rss><channel><item><title>Undated item about a breach</title></item></channel></rss>`);
    const feeds = [{ url: 'https://example.com/rss', source: 'Undated Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
    expect(results[0].dateUnknown).toBe(true);
  });

  test('an item older than the freshness window is dropped', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    const staleDate = new Date(Date.now() - 365 * 24 * 3600_000).toUTCString(); // 1 year old
    readCappedMock.mockResolvedValue(`<rss><channel><item><title>Ancient news item</title><pubDate>${staleDate}</pubDate></item></channel></rss>`);
    const feeds = [{ url: 'https://example.com/rss', source: 'Stale Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(0);
  });

  test('entity-encoded titles are decoded and stripped', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(`<rss><channel><item><title>CISA &amp;amp; partners warn of new threat</title><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
    const feeds = [{ url: 'https://example.com/rss', source: 'Entity Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results[0].title).toBe('CISA & partners warn of new threat');
  });

  test('bounds oversized RSS fields before publishing or caching them', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    const hugeTitle = `Critical feed field limit regression ${'T'.repeat(200_000)}`;
    const hugeDescription = `Summary ${'D'.repeat(200_000)}`;
    const hugeDate = `not-a-date-${'9'.repeat(10_000)}`;
    readCappedMock.mockResolvedValue(`<rss><channel><item>
      <title>${hugeTitle}</title>
      <description>${hugeDescription}</description>
      <link>https://user:feed-secret@example.com/private</link>
      <pubDate>${hugeDate}</pubDate>
    </item></channel></rss>`);

    const feeds = [{ url: 'https://example.com/rss', source: 'Oversized Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});

    expect(results).toHaveLength(1);
    expect(results[0].title.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.title);
    expect(results[0].description.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.description);
    expect(results[0].date.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.dateRaw);
    expect(results[0].dateUnknown).toBe(true);
    expect(results[0].link).toBe('');

    const cachedItems = setFeedCacheMock.mock.calls.at(-1)[3];
    expect(cachedItems[0].title.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.title);
    expect(cachedItems[0].description.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.description);
    expect(cachedItems[0].link).toBe('');
  });

  test('an HTTP error status is reported and does not affect other feeds', async () => {
    safeFetchMock.mockImplementation(async (url) => {
      if (url.includes('down')) return fakeResponse({ status: 503 });
      return fakeResponse();
    });
    readCappedMock.mockResolvedValue(RSS_FIXTURE);
    const feeds = [
      { url: 'https://down.example.com/rss', source: 'Down Feed', horizon: 1 },
      { url: 'https://up.example.com/rss', source: 'Up Feed', horizon: 1 },
    ];
    const results = await fetchNewsContext(feeds, {});
    const health = getFeedHealth().feeds;
    expect(health['Down Feed']).toBe('http-503');
    expect(results.some(h => h.source === 'Up Feed')).toBe(true);
  });

  // #124 — every terminal status (not just success) must write a health-log
  // row, so feed_health_log can actually answer "which feed has been flaky".
  test('a failure status writes a feed_health_log row, not just success', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 503 }));
    const feeds = [{ url: 'https://down.example.com/rss', source: 'Down Feed', horizon: 1 }];
    await fetchNewsContext(feeds, {});
    expect(logFeedHealthMock).toHaveBeenCalledWith('Down Feed', 'http-503', 0);
  });

  test('an XML parse error writes a feed_health_log row', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue('<rss><channel><item><title>Unclosed<');
    const feeds = [{ url: 'https://bad.example.com/rss', source: 'Bad XML Feed', horizon: 1 }];
    await fetchNewsContext(feeds, {});
    expect(logFeedHealthMock).toHaveBeenCalledWith('Bad XML Feed', 'parse-error', 0);
  });

  test('a network-level failure (rejected safeFetch) writes a feed_health_log row', async () => {
    safeFetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const feeds = [{ url: 'https://unreachable.example.com/rss', source: 'Unreachable Feed', horizon: 1 }];
    await fetchNewsContext(feeds, {});
    expect(logFeedHealthMock).toHaveBeenCalledWith('Unreachable Feed', 'failed', 0);
  });

  // #103 — a relative Atom href must resolve against the feed's own URL, not
  // pass through untouched (which would render as a Wire link that navigates
  // inside the app instead of to the publisher).
  test('resolves a relative Atom link against the feed URL', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(`<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Self-hosted post with a relative link</title>
    <link href="/2026/06/post.html" />
    <published>${new Date().toISOString()}</published>
  </entry>
</feed>`);
    const feeds = [{ url: 'https://blog.example.com/atom.xml', source: 'Relative Link Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
    expect(results[0].link).toBe('https://blog.example.com/2026/06/post.html');
  });

  test('drops a non-http(s) link (e.g. a bare guid) rather than store it verbatim', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(`<rss><channel><item>
      <title>Item with only a non-URL guid</title>
      <guid>urn:uuid:12345</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item></channel></rss>`);
    const feeds = [{ url: 'https://example.com/rss', source: 'Urn Guid Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
    expect(results[0].link).toBe('');
  });

  // #80 — an unbounded Retry-After must not be honored verbatim: a feed server
  // (misconfigured or hostile) sending a far-future value must not be able to
  // silence a feed for the life of the process. retryAfterUntil is module-
  // private, so we assert the clamp indirectly: fake-advance the clock past
  // where an HONORED (unclamped) 1-year cooldown would still be active, but
  // past where the 6h ceiling has expired, and confirm the feed is no longer
  // reported rate-limited — i.e. the cooldown that was actually set was bounded.
  test('a 429 with an extreme Retry-After does not lock the feed out indefinitely', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      safeFetchMock.mockResolvedValue(fakeResponse({ status: 429, headers: { 'retry-after': String(365 * 24 * 3600) } })); // 1 year
      const feeds = [{ url: 'https://example.com/rss', source: 'Extreme Retry Feed', horizon: 1 }];
      await fetchNewsContext(feeds, {});
      expect(getFeedHealth().feeds['Extreme Retry Feed']).toBe('http-429');

      // Advance 7 hours (past the 6h ceiling, nowhere near the 1-year request).
      jest.advanceTimersByTime(7 * 3600_000);

      safeFetchMock.mockResolvedValue(fakeResponse()); // host recovered
      readCappedMock.mockResolvedValue(RSS_FIXTURE);
      await fetchNewsContext(feeds, {});
      // If the 1-year value had been honored verbatim, this would still read
      // 'rate-limited' (serveStale has no cache to fall back to, so it would
      // stay 'rate-limited'). The clamp lets the pipeline retry the host.
      expect(getFeedHealth().feeds['Extreme Retry Feed']).not.toBe('rate-limited');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a 304 with no cached items falls through to the http-error path', async () => {
    getFeedCacheMock.mockReturnValue(undefined); // no cache on file
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const feeds = [{ url: 'https://example.com/rss', source: '304 No Cache Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    // With no cached items, the 304 branch doesn't fire (it requires
    // cached?.items_json); falls through to !res.ok (304 is not "ok") and
    // reports an http-304 status.
    expect(results.length).toBe(0);
    expect(getFeedHealth().feeds['304 No Cache Feed']).toBe('http-304');
  });

  test('a 304 with cached items reuses them and re-stamps current routing', async () => {
    getFeedCacheMock.mockReturnValue({
      etag: 'W/"abc"',
      last_modified: null,
      items_json: JSON.stringify([
        { title: 'Cached item', link: 'https://example.com/c', source: 'Cached Feed', horizon: 2, weight: 1.0, date: new Date().toUTCString(), dateUnknown: false, corroboration: 1 },
      ]),
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const feeds = [{ url: 'https://example.com/rss', source: 'Cached Feed', horizon: 1, weight: 2.0 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
    // Routing (horizon/weight) is re-stamped from the CURRENT feed config, even
    // though the cached item was stored with the old horizon/weight.
    expect(results[0].horizon).toBe(1);
    expect(results[0].weight).toBe(2.0);
    expect(getFeedHealth().feeds['Cached Feed']).toBe('ok (cached)');
  });

  test('a configured zero feed weight survives live and cached routing', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(RSS_FIXTURE);
    const feeds = [{ url: 'https://example.com/rss', source: 'Zero Weight Feed', horizon: 1, weight: 0 }];
    const live = await fetchNewsContext(feeds, {});
    expect(live[0].weight).toBe(0);

    getFeedCacheMock.mockReturnValue({
      etag: 'W/"zero"',
      items_json: JSON.stringify([{ ...live[0], date: new Date().toUTCString(), dateUnknown: false }]),
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const cached = await fetchNewsContext(feeds, {});
    expect(cached[0].weight).toBe(0);
  });

  // #35 — freshness must be re-checked on every 304, not just at original cache
  // time: a dormant feed that keeps answering 304 would otherwise re-inject
  // stale items into every run forever.
  test('a 304 drops cached items that have since aged out of the freshness window', async () => {
    const ancientDate = new Date(Date.now() - 365 * 24 * 3600_000).toUTCString(); // 1 year old
    getFeedCacheMock.mockReturnValue({
      etag: 'W/"abc"',
      last_modified: null,
      items_json: JSON.stringify([
        { title: 'Ancient cached item', link: 'https://example.com/c', source: 'Dormant Feed', horizon: 1, weight: 1.0, date: ancientDate, dateUnknown: false, corroboration: 1 },
      ]),
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const feeds = [{ url: 'https://example.com/rss', source: 'Dormant Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(0);
    expect(getFeedHealth().feeds['Dormant Feed']).toBe('empty');
  });

  test('a corrupt 304 cache reports parse-error instead of ok (cached)', async () => {
    getFeedCacheMock.mockReturnValue({
      etag: 'W/"bad"', items_json: '{not json',
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    await fetchNewsContext([{ url: 'https://example.com/rss', source: 'Corrupt Cache Feed', horizon: 1 }], {});
    expect(getFeedHealth().feeds['Corrupt Cache Feed']).toBe('parse-error');
    expect(setFeedCacheMock).toHaveBeenCalledWith('https://example.com/rss', '', '', []);
  });

  test('a 304 keeps a dateUnknown cached item (still admitted, matching the live-fetch path)', async () => {
    getFeedCacheMock.mockReturnValue({
      etag: 'W/"abc"',
      last_modified: null,
      items_json: JSON.stringify([
        { title: 'Undated cached item', link: 'https://example.com/c', source: 'Undated Cache Feed', horizon: 1, weight: 1.0, date: '', dateUnknown: true, corroboration: 1 },
      ]),
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const feeds = [{ url: 'https://example.com/rss', source: 'Undated Cache Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});
    expect(results.length).toBe(1);
  });

  test('revalidates and bounds legacy cached fields before a 304 republishes them', async () => {
    getFeedCacheMock.mockReturnValue({
      etag: 'W/"legacy"',
      last_modified: null,
      items_json: JSON.stringify([{
        title: `Cached security update ${'T'.repeat(10_000)}`,
        description: `Cached summary ${'D'.repeat(20_000)}`,
        link: 'https://user:cached-secret@example.com/private',
        source: `Old source ${'S'.repeat(10_000)}`,
        date: '',
        dateUnknown: true,
      }]),
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const feeds = [{ url: 'https://example.com/rss', source: 'Bounded Cache Feed', horizon: 1 }];
    const results = await fetchNewsContext(feeds, {});

    expect(results).toHaveLength(1);
    expect(results[0].title.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.title);
    expect(results[0].description.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.description);
    expect(results[0].source).toBe('Bounded Cache Feed');
    expect(results[0].link).toBe('');
  });

  test('a 304 with still-fresh cached items bumps cached_at via setFeedCache', async () => {
    getFeedCacheMock.mockReturnValue({
      etag: 'W/"abc"',
      last_modified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      items_json: JSON.stringify([
        { title: 'Fresh cached item', link: 'https://example.com/c', source: 'Fresh Cache Feed', horizon: 1, weight: 1.0, date: new Date().toUTCString(), dateUnknown: false, corroboration: 1 },
      ]),
      cached_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304 }));
    const feeds = [{ url: 'https://example.com/rss', source: 'Fresh Cache Feed', horizon: 1 }];
    await fetchNewsContext(feeds, {});
    // setFeedCache re-writes the row so cached_at (SQLite datetime('now')) refreshes,
    // extending the serve-last-good window from a confirmed-current response.
    expect(setFeedCacheMock).toHaveBeenCalledWith('https://example.com/rss', 'W/"abc"', 'Wed, 01 Jan 2026 00:00:00 GMT', expect.any(Array));
  });
});

describe('publisherKey — source identity', () => {
  test('registrable domain from a link (strips www and path)', () => {
    expect(publisherKey({ link: 'https://www.bleepingcomputer.com/news/x' })).toBe('bleepingcomputer.com');
  });
  test('handles a multi-part TLD', () => {
    expect(publisherKey({ link: 'https://www.theregister.co.uk/2026/01/x' })).toBe('theregister.co.uk');
  });
  test('an unresolved google.com link falls back to the source name', () => {
    expect(publisherKey({ link: 'https://news.google.com/articles/abc', source: 'The Hacker News' })).toBe('hackernews');
  });
  test('a generic aggregator source defers to the domain', () => {
    expect(publisherKey({ link: 'https://thehackernews.com/x', source: 'News Search' })).toBe('thehackernews.com');
  });
  test('no link and no real source falls back to a title slug', () => {
    expect(publisherKey({ title: 'Some headline' }).startsWith('untitled:')).toBe(true);
  });
  test('handles a regional multi-part TLD (com.tw)', () => {
    expect(publisherKey({ link: 'https://news.example.com.tw/x' })).toBe('example.com.tw');
  });
  test('strips any leading subdomain (m./app./news.) to one publisher key', () => {
    expect(publisherKey({ link: 'https://m.bleepingcomputer.com/x' })).toBe('bleepingcomputer.com');
    expect(publisherKey({ link: 'https://news.bleepingcomputer.com/y' })).toBe('bleepingcomputer.com');
  });
  test('a regional Google host falls back to the source name', () => {
    expect(publisherKey({ link: 'https://news.google.co.uk/articles/x', source: 'BBC News' })).toBe('bbcnews');
  });
  test('a non-http link carries no publisher identity (defers to source)', () => {
    expect(publisherKey({ link: 'ftp://example.com/x', source: 'Foo Wire' })).toBe('foowire');
  });
});

describe('fetchSearchResults — bounded Google News ingress', () => {
  test('bounds title/source/date fields and drops credential-bearing publisher links', async () => {
    const originalPack = getDomainPack();
    try {
      setDomainPack({
        id: 'feed-limit-test',
        label: 'Feed limit test',
        feeds: { searchQueries: [{ q: 'security test', horizon: 2 }] },
      });
      safeFetchMock.mockReset().mockResolvedValue(fakeResponse());
      readCappedMock.mockReset().mockResolvedValue(`<rss><channel><item>
        <title>Search security update ${'T'.repeat(100_000)}</title>
        <description><a href="https://user:search-secret@publisher.example/private">story</a></description>
        <link>https://news.google.com/rss/articles/opaque-id</link>
        <source>Publisher ${'S'.repeat(20_000)}</source>
        <pubDate>not-a-date-${'9'.repeat(5_000)}</pubDate>
      </item></channel></rss>`);

      const results = await fetchSearchResults({});
      expect(results).toHaveLength(1);
      expect(results[0].title.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.title);
      expect(results[0].source.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.source);
      expect(results[0].date.length).toBeLessThanOrEqual(FEED_FIELD_LIMITS.dateRaw);
      expect(results[0].link).toBe('');
    } finally {
      setDomainPack(originalPack);
    }
  });
});

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// enrichCVEs and enrichEPSS talk
// to the network (lib/net.js) and, transitively, lib/db.js / lib/domain.js.
// Mock all three so these are hermetic (no real NVD/FIRST calls) and
// deterministic. Must be registered before the dynamic import of the module
// under test — see test/feeds.test.js for the same convention.
const safeFetchMock = jest.fn();
const readCappedMock = jest.fn();
const getExternalCacheMock = jest.fn(() => null);
const setExternalCacheMock = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({
  safeFetch: safeFetchMock,
  readCapped: readCappedMock,
}));

jest.unstable_mockModule('../lib/db.js', () => ({
  getKEVSet: jest.fn(() => new Set()),
  bulkInsertKEV: jest.fn(),
  getKEVAge: jest.fn(() => Infinity),
  getKEVDatesAdded: jest.fn(() => ({})),
  getKEVRecords: jest.fn(() => ({})),
  getExternalCache: getExternalCacheMock,
  setExternalCache: setExternalCacheMock,
}));

jest.unstable_mockModule('../lib/domain.js', () => ({
  getDomainPack: jest.fn(() => ({ id: 'test', entities: { actors: [], vendors: [] } })),
}));

// Set a fake key so multi-CVE tests use the keyed ~700ms pace instead of the
// unauthenticated ~6.5s pace. Production reads it lazily so dotenv values loaded
// after ESM dependency evaluation still take effect.
process.env.NVD_API_KEY = 'test-key';

const { enrichCVEs, enrichEPSS, extractArticleBody, refreshKEV, nvdCveEvidence } = await import('../lib/enrichment.js');

// A minimal Response-shaped fake matching the convention in test/feeds.test.js
// — enrichCVEs/enrichEPSS only touch .status/.ok; the body is consumed by the
// mocked readCapped.
function fakeResponse({ status = 200, cancel = jest.fn() } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: { cancel },
  };
}

function nvdBody(cveId, { baseScore, baseSeverity, version = '31', vulnStatus = 'Analyzed' } = {}) {
  const metricKey = `cvssMetricV${version}`;
  return {
    vulnerabilities: [{
      cve: {
        vulnStatus,
        metrics: baseScore != null ? { [metricKey]: [{ cvssData: { baseScore, baseSeverity } }] } : {},
        configurations: [], references: [],
      },
    }],
  };
}

beforeEach(() => {
  safeFetchMock.mockReset();
  readCappedMock.mockReset();
  getExternalCacheMock.mockReset().mockReturnValue(null);
  setExternalCacheMock.mockReset();
});

describe('enrichCVEs — CVSS version-label parse', () => {
  test('a v4.0-only CVE retains its version separately from the ranking score', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0001', { baseScore: 9.3, baseSeverity: 'CRITICAL', version: '40' })));

    const h = { title: 'CVE-2025-0001 patched', description: '' };
    await enrichCVEs([h], 5);

    expect(h.cveData).toBe('CVE-2025-0001: CVSS v4.0 9.3 (CRITICAL)');
    expect(h.cvssMetrics).toEqual([expect.objectContaining({ cve: 'CVE-2025-0001', score: 9.3, version: '4.0', selected: true, provisional: false })]);
    // The severity axis's dedicated parse source carries ONLY the number, with
    // no version label in front of it — CVSS\s+([\d.]+) must capture 9.3, not 4.0.
    expect(h.cvssSeverityText).toBe('CVSS 9.3 (CRITICAL)');
    expect(h.cvssSeverityText.match(/CVSS\s+([\d.]+)/)[1]).toBe('9.3');
    expect(h.cvssScore).toBe(9.3);
  });

  test('a v2.0-only CVE scores correctly too', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0002', { baseScore: 7.5, baseSeverity: 'HIGH', version: '2' })));

    const h = { title: 'CVE-2025-0002 disclosed', description: '' };
    await enrichCVEs([h], 5);

    expect(h.cvssSeverityText.match(/CVSS\s+([\d.]+)/)[1]).toBe('7.5');
    expect(h.cveData).toContain('CVSS v2.0 7.5');
  });

  test('a multi-CVE roundup scores on the MAX across CVEs, not the first match', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock
      .mockResolvedValueOnce(JSON.stringify(nvdBody('CVE-2025-0003', { baseScore: 5.3, baseSeverity: 'MEDIUM' })))
      .mockResolvedValueOnce(JSON.stringify(nvdBody('CVE-2025-0004', { baseScore: 9.8, baseSeverity: 'CRITICAL' })));

    const h = { title: 'Vendor patches CVE-2025-0003 and CVE-2025-0004', description: '' };
    await enrichCVEs([h], 5);

    expect(h.cvssScore).toBe(9.8);
    expect(h.cvssSeverityText.match(/CVSS\s+([\d.]+)/)[1]).toBe('9.8');
  });

  test('reads NVD_API_KEY lazily after the module has already loaded', async () => {
    const prior = process.env.NVD_API_KEY;
    process.env.NVD_API_KEY = 'late-loaded-key';
    try {
      safeFetchMock.mockResolvedValue(fakeResponse());
      readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0010', { baseScore: 4.0, baseSeverity: 'MEDIUM' })));
      await enrichCVEs([{ title: 'CVE-2025-0010 disclosed', description: '' }], 5);
      const [, opts] = safeFetchMock.mock.calls.at(-1);
      expect(opts.headers).toMatchObject({
        apiKey: 'late-loaded-key',
        'User-Agent': expect.stringMatching(/^BlueTeam\.News\/\d+\.\d+\.\d+/),
      });
    } finally {
      process.env.NVD_API_KEY = prior;
    }
  });
});

describe('NVD retained assessments and applicability', () => {
  const cve = 'CVE-2026-90210';
  const assessment = (score, source, type) => ({ source, type, cvssData: { baseScore: score, baseSeverity: score >= 9 ? 'CRITICAL' : 'MEDIUM' } });
  test('primary selection is independent of order and never substitutes the highest score', () => {
    const primary = assessment(5, 'nvd@nist.gov', 'Primary');
    const secondary = assessment(9.8, 'vendor.example', 'Secondary');
    for (const metrics of [[secondary, primary], [primary, secondary]]) {
      const result = nvdCveEvidence(cve, { vulnStatus: 'Awaiting Analysis', metrics: { cvssMetricV31: metrics } });
      expect(result.score).toBe(5);
      expect(result.metrics).toEqual([
        expect.objectContaining({ cve, version: '3.1', score: 5, source: 'nvd@nist.gov', type: 'Primary', selected: true, provisional: true }),
        expect.objectContaining({ cve, version: '3.1', score: 9.8, source: 'vendor.example', type: 'Secondary', selected: false, provisional: true }),
      ]);
      expect(result.text).toContain('CVSS v3.1 5');
      expect(result.text).toContain('CVSS v3.1 9.8');
      expect(result.text.match(/provisional/g)).toHaveLength(2);
    }
  });
  test('retains distinct 3.0 and 4.0 assessments and abstains on same-provenance conflicts', () => {
    const result = nvdCveEvidence(cve, { metrics: { cvssMetricV30: [assessment(5, 'a', 'Primary')], cvssMetricV40: [assessment(9.3, 'b', 'Secondary')] } });
    expect(result.metrics.map(metric => metric.version)).toEqual(['3.0', '4.0']);
    expect(result.text).toContain('CVSS v3.0 5');
    const ambiguous = nvdCveEvidence(cve, { metrics: { cvssMetricV31: [assessment(5, 'a', 'Primary'), assessment(9.8, 'a', 'Primary')] } });
    expect(ambiguous.score).toBeNull();
    expect(ambiguous.metrics.every(metric => !metric.selected)).toBe(true);
    expect(nvdCveEvidence(cve, { vulnStatus: 'Rejected', metrics: { cvssMetricV31: [assessment(9.8, 'a', 'Primary')] } }).metrics).toEqual([]);
  });
  test('walks all configurations while retaining AND, negation, prerequisites and version limits', () => {
    const match = (name, vulnerable, extra = {}) => ({ criteria: `cpe:2.3:a:fixture:${name}:*:*:*:*:*:*:*:*`, vulnerable, ...extra });
    const result = nvdCveEvidence(cve, { configurations: [{ operator: 'AND', nodes: [
      { operator: 'OR', cpeMatch: [match('prerequisite_os', false)] },
      { operator: 'OR', children: [{ cpeMatch: [match('affected_app', true, { versionEndExcluding: '2.5' })] }] },
      { operator: 'OR', negate: true, cpeMatch: [match('excluded_app', true)] },
    ] }, { nodes: [{ cpeMatch: [match('second_app', true)] }] }] });
    expect(result.text).toContain('Fixture Affected-APP');
    expect(result.text).toContain('Fixture Second-APP');
    expect(result.text).not.toMatch(/Prerequisite|Excluded/);
    expect(result.text).toContain('conditions and version limits apply');
    expect(result.configurations[0]).toMatchObject({ operator: 'AND', nodes: [
      { cpeMatch: [{ vulnerable: false }] },
      { nodes: [{ cpeMatch: [{ vulnerable: true, versionEndExcluding: '2.5' }] }] },
      { negate: true },
    ] });
  });
});

test('article selection retains later mitigation and excludes script/style text', async () => {
  safeFetchMock.mockResolvedValue(fakeResponse());
  readCappedMock.mockResolvedValue(`<article><p>Vendor published an advisory.</p><script>SecretScript actively exploited</script><style>SecretStyle malware</style>${'<p>This paragraph introduces the service and its background for readers.</p>'.repeat(65)}<p>Mitigation requires re-imaging the appliance and resetting passwords and TOTP credentials.</p></article>`);
  const body = await extractArticleBody('https://example.test/long-advisory');
  expect(body).toContain('Mitigation requires re-imaging');
  expect(body).not.toMatch(/SecretScript|SecretStyle/);
  expect(body.length).toBeLessThanOrEqual(4000);
  expect(body).toContain('[…]');
});

describe('enrichCVEs — live request budget', () => {
  test('null NVD misses consume maxLookups instead of issuing an unbounded request per headline', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify({ vulnerabilities: [] }));
    const hs = [20, 21, 22, 23].map(n => ({ title: `CVE-2025-${String(n).padStart(4, '0')} disclosed`, description: '' }));
    await enrichCVEs(hs, 2);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(hs.every(h => h.cveData === undefined)).toBe(true);
  });
});

describe('extractArticleBody — whole-response deadline', () => {
  test('keeps the timeout armed while the response body is being drained', async () => {
    jest.useFakeTimers();
    let signal;
    let releaseBody;
    try {
      safeFetchMock.mockImplementation(async (_url, opts) => {
        signal = opts.signal;
        return fakeResponse();
      });
      readCappedMock.mockImplementation(() => new Promise(resolve => { releaseBody = resolve; }));
      const pending = extractArticleBody('https://example.com/story', 3000);
      await Promise.resolve();
      await Promise.resolve();
      expect(readCappedMock).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(3000);
      expect(signal.aborted).toBe(true);
      releaseBody(`<article>${'substantive reporting '.repeat(20)}</article>`);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('refreshKEV — concurrent startup calls', () => {
  test('shares one in-flight catalog download', async () => {
    let releaseCatalog;
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockImplementation(() => new Promise(resolve => { releaseCatalog = resolve; }));
    const first = refreshKEV();
    const second = refreshKEV();
    await Promise.resolve();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0][1].headers).toMatchObject({
      'User-Agent': expect.stringMatching(/^BlueTeam\.News\/\d+\.\d+\.\d+/),
    });
    releaseCatalog(JSON.stringify({ vulnerabilities: [{ cveID: 'CVE-2026-9999' }] }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.has('CVE-2026-9999')).toBe(true);
  });
});

describe('enrichCVEs — in-process CVE cache', () => {
  test('a CVE looked up once is served from cache on a second call, no re-fetch', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0011', { baseScore: 8.1, baseSeverity: 'HIGH' })));

    const h1 = { title: 'CVE-2025-0011 first mention', description: '' };
    await enrichCVEs([h1], 5);
    const callsAfterFirst = safeFetchMock.mock.calls.length;

    const h2 = { title: 'CVE-2025-0011 mentioned again in a follow-up', description: '' };
    await enrichCVEs([h2], 5);

    expect(safeFetchMock.mock.calls.length).toBe(callsAfterFirst); // no new network call
    expect(h2.cvssScore).toBe(8.1);
  });
});

describe('enrichCVEs — NVD throttling', () => {
  test('a 429 response is recorded as a throttle, not a silent miss', async () => {
    const cancel = jest.fn();
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 429, cancel }));
    const hs = [5, 50, 51].map(n => ({ title: `CVE-2025-${String(n).padStart(4, '0')} reported`, description: '' }));
    await expect(enrichCVEs(hs, 5)).rejects.toThrow(/rate-limited/i);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(hs.every(h => h.cveData === undefined)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('a clean run (no throttling) does not throw', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0006', { baseScore: 6.1, baseSeverity: 'MEDIUM' })));
    const h = { title: 'CVE-2025-0006 patched', description: '' };
    await expect(enrichCVEs([h], 5)).resolves.toBeUndefined();
  });
});

describe('extractArticleBody — persistent cache', () => {
  test('serves a fresh extraction without another network request', async () => {
    getExternalCacheMock.mockReturnValue({
      body: 'cached substantive article body',
      expired: false,
      fetched_at: new Date().toISOString(),
    });
    await expect(extractArticleBody('https://example.com/story?secret=hidden'))
      .resolves.toBe('cached substantive article body');
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('revalidates an expired extraction and refreshes its TTL on 304', async () => {
    getExternalCacheMock.mockReturnValue({
      body: 'cached substantive article body',
      expired: true,
      etag: '"article-v1"',
      last_modified: 'Tue, 28 Jul 2026 12:00:00 GMT',
      fetched_at: new Date().toISOString(),
    });
    const cancel = jest.fn();
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 304, cancel }));
    await expect(extractArticleBody('https://example.com/story'))
      .resolves.toBe('cached substantive article body');
    expect(safeFetchMock.mock.calls[0][1].headers).toMatchObject({
      'If-None-Match': '"article-v1"',
      'If-Modified-Since': 'Tue, 28 Jul 2026 12:00:00 GMT',
    });
    expect(setExternalCacheMock).toHaveBeenCalledWith(
      expect.stringMatching(/^article:/),
      'cached substantive article body',
      expect.objectContaining({ etag: '"article-v1"' }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('cancels an error response before returning stale or null content', async () => {
    const cancel = jest.fn();
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 503, cancel }));
    await expect(extractArticleBody('https://example.com/unavailable')).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('enrichEPSS — exploitation-likelihood signal', () => {
  test('tags h.epss as the max score across a headline\'s CVEs, distinct from CVSS/KEV', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify({
      data: [
        { cve: 'CVE-2025-0007', epss: '0.04' },
        { cve: 'CVE-2025-0008', epss: '0.92' },
      ],
    }));

    const h = { title: 'CVE-2025-0007 and CVE-2025-0008 disclosed', description: '' };
    await enrichEPSS([h], 20);

    expect(safeFetchMock.mock.calls[0][1].headers).toMatchObject({
      'User-Agent': expect.stringMatching(/^BlueTeam\.News\/\d+\.\d+\.\d+/),
    });
    expect(h.epss).toBeCloseTo(0.92);
    expect(h.epssCVE).toBe('CVE-2025-0008');
  });

  test('a failed EPSS fetch is reported to the nonfatal stage runner', async () => {
    const cancel = jest.fn();
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 500, cancel }));
    const h = { title: 'CVE-2025-0009 disclosed', description: '' };
    await expect(enrichEPSS([h], 20)).rejects.toThrow('EPSS unavailable');
    expect(h.epss).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('skips headlines with no CVE reference entirely', async () => {
    const h = { title: 'Quarterly earnings report released', description: '' };
    await enrichEPSS([h], 20);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(h.epss).toBeUndefined();
  });
});

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// enrichCVEs and enrichEPSS talk
// to the network (lib/net.js) and, transitively, lib/db.js / lib/domain.js.
// Mock all three so these are hermetic (no real NVD/FIRST calls) and
// deterministic. Must be registered before the dynamic import of the module
// under test — see test/feeds.test.js for the same convention.
const safeFetchMock = jest.fn();
const readCappedMock = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({
  safeFetch: safeFetchMock,
  readCapped: readCappedMock,
}));

jest.unstable_mockModule('../lib/db.js', () => ({
  getKEVSet: jest.fn(() => new Set()),
  bulkInsertKEV: jest.fn(),
  getKEVAge: jest.fn(() => Infinity),
  getKEVDatesAdded: jest.fn(() => ({})),
}));

jest.unstable_mockModule('../lib/domain.js', () => ({
  getDomainPack: jest.fn(() => ({ id: 'test', entities: { actors: [], vendors: [] } })),
}));

// Set a fake key so multi-CVE tests use the keyed ~700ms pace instead of the
// unauthenticated ~6.5s pace. Production reads it lazily so dotenv values loaded
// after ESM dependency evaluation still take effect.
process.env.NVD_API_KEY = 'test-key';

const { enrichCVEs, enrichEPSS, extractArticleBody, refreshKEV } = await import('../lib/enrichment.js');

// A minimal Response-shaped fake matching the convention in test/feeds.test.js
// — enrichCVEs/enrichEPSS only touch .status/.ok; the body is consumed by the
// mocked readCapped.
function fakeResponse({ status = 200 } = {}) {
  return { status, ok: status >= 200 && status < 300 };
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
});

describe('enrichCVEs — CVSS version-label parse', () => {
  test('a v4.0-only CVE renders the version AFTER the score, not between "CVSS" and the number', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0001', { baseScore: 9.3, baseSeverity: 'CRITICAL', version: '40' })));

    const h = { title: 'CVE-2025-0001 patched', description: '' };
    await enrichCVEs([h], 5);

    expect(h.cveData).toBe('CVE-2025-0001: CVSS 9.3 (CRITICAL) (v4.0)');
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
    expect(h.cveData).toContain('(v2.0)');
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
      expect(opts.headers).toMatchObject({ apiKey: 'late-loaded-key' });
    } finally {
      process.env.NVD_API_KEY = prior;
    }
  });
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
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 429 }));
    const hs = [5, 50, 51].map(n => ({ title: `CVE-2025-${String(n).padStart(4, '0')} reported`, description: '' }));
    await expect(enrichCVEs(hs, 5)).rejects.toThrow(/rate-limited/i);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(hs.every(h => h.cveData === undefined)).toBe(true);
  });

  test('a clean run (no throttling) does not throw', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse());
    readCappedMock.mockResolvedValue(JSON.stringify(nvdBody('CVE-2025-0006', { baseScore: 6.1, baseSeverity: 'MEDIUM' })));
    const h = { title: 'CVE-2025-0006 patched', description: '' };
    await expect(enrichCVEs([h], 5)).resolves.toBeUndefined();
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

    expect(h.epss).toBeCloseTo(0.92);
    expect(h.epssCVE).toBe('CVE-2025-0008');
  });

  test('a failed EPSS fetch degrades silently (no h.epss, no throw)', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse({ status: 500 }));
    const h = { title: 'CVE-2025-0009 disclosed', description: '' };
    await expect(enrichEPSS([h], 20)).resolves.toBeUndefined();
    expect(h.epss).toBeUndefined();
  });

  test('skips headlines with no CVE reference entirely', async () => {
    const h = { title: 'Quarterly earnings report released', description: '' };
    await enrichEPSS([h], 20);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(h.epss).toBeUndefined();
  });
});

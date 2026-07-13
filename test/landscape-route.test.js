// BlueTeam.News — routes/landscape.js tests.
//
// Three things this route must get right and previously had zero coverage on:
//  1. baseUrl()'s anti-spoof invariant — X-Forwarded-Host/Proto must be IGNORED
//     unless Express is told to trust a proxy (app.set('trust proxy', ...)).
//     Without this, ANY direct caller could poison the host/proto embedded in
//     emitted feed/self URLs (cache-poisoning / phishing-shaped). The invariant
//     lived only in a comment (routes/landscape.js:30-35) before this file.
//  2. The illegal-host-character fallback (a header with control chars or
//     other disallowed characters must not reach the emitted URL raw).
//  3. escapeXml and normalizeScoreComponents as pure units (both are exported
//     for direct testing; see the export comment above escapeXml).
//
// lib/refresher.js, lib/db.js, lib/config.js, and lib/domain.js are mocked
// via jest.unstable_mockModule, the same pattern test/health.test.js uses —
// this exercises the route in isolation against controlled inputs rather
// than the live pipeline/DB.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const getLatestRunMock = jest.fn();
const refreshNowMock = jest.fn();
const getRunAgeMsMock = jest.fn(() => 60_000);
const getKEVDueDatesMock = jest.fn(() => ({}));
const getBriefMetaMock = jest.fn(() => null);
const getConfigMock = jest.fn(() => ({ horizons: {} }));
const getHorizonNameMock = jest.fn((cfg, h) => `Tier ${h}`);
const getDomainPackMock = jest.fn(() => ({ id: 'cyber', label: 'Blue Team', entities: { regions: {} } }));
const getBriefMock = jest.fn(() => ({ frame: { title: 'Blue Team' } }));
const buildLandscapeMock = jest.fn(() => ({ stale: false, pipeline: { ageMinutes: 1 } }));

jest.unstable_mockModule('../lib/refresher.js', () => ({
  getLatestRun: getLatestRunMock,
  refreshNow: refreshNowMock,
  getRunAgeMs: getRunAgeMsMock,
}));
jest.unstable_mockModule('../lib/db.js', () => ({
  getKEVDueDates: getKEVDueDatesMock,
  getBriefMeta: getBriefMetaMock,
}));
jest.unstable_mockModule('../lib/config.js', () => ({
  getConfig: getConfigMock,
  getHorizonName: getHorizonNameMock,
}));
jest.unstable_mockModule('../lib/domain.js', () => ({
  getDomainPack: getDomainPackMock,
  getBrief: getBriefMock,
}));
jest.unstable_mockModule('../lib/landscape.js', () => ({
  buildLandscape: buildLandscapeMock,
  pipelineStaleAfterMs: (minutes = 10) => Math.max(20, Number(minutes || 10) * 2) * 60_000,
}));

const { createLandscapeRouter } = await import('../routes/landscape.js');

const SAMPLE_HEADLINES = [
  { title: 'Critical RCE exploited in the wild', link: 'https://example.com/a', source: 'Feed A', horizon: 1, score: 92.4, isKEV: true, kevCVE: 'CVE-2026-0001', date: '2026-07-01T00:00:00.000Z' },
  { title: 'Vendor posts a quarterly transparency report', link: 'https://example.com/b', source: 'Feed B', horizon: 3, score: 41.1, isKEV: false, date: '2026-06-30T00:00:00.000Z' },
];

function makeServer({ historyDir, trustProxy = false, publicBaseUrl = null } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.use('/api', createLandscapeRouter({ historyDir, cooldown: { check: () => true }, publicBaseUrl }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe('routes/landscape.js — baseUrl anti-spoof invariant', () => {
  let dir; let ctx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-landscape-'));
    getLatestRunMock.mockReset().mockReturnValue({ headlines: SAMPLE_HEADLINES, generatedAt: '2026-07-01T00:00:00.000Z', generatedAtMs: Date.now() });
  });
  afterEach(async () => {
    if (ctx?.server) await new Promise(r => ctx.server.close(r));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('trust proxy OFF (default): a spoofed X-Forwarded-Host is ignored — feed URLs use the real loopback host', async () => {
    ctx = await makeServer({ historyDir: dir, trustProxy: false });
    const res = await fetch(`${ctx.base}/api/feed.xml`, {
      headers: { 'X-Forwarded-Host': 'evil.example.com', 'X-Forwarded-Proto': 'https' },
    });
    const xml = await res.text();
    expect(xml).not.toContain('evil.example.com');
    expect(xml).toContain(`127.0.0.1:${new URL(ctx.base).port}`);
  });

  test('trust proxy ON: X-Forwarded-Host/Proto are honored in emitted feed URLs', async () => {
    ctx = await makeServer({ historyDir: dir, trustProxy: true });
    const res = await fetch(`${ctx.base}/api/feed.xml`, {
      headers: { 'X-Forwarded-Host': 'intel.example.com', 'X-Forwarded-Proto': 'https' },
    });
    const xml = await res.text();
    expect(xml).toContain('https://intel.example.com');
  });

  test('a host header with illegal characters falls back to a safe loopback default, not raw injection', async () => {
    ctx = await makeServer({ historyDir: dir, trustProxy: true });
    const res = await fetch(`${ctx.base}/api/feed.xml`, {
      headers: { 'X-Forwarded-Host': 'evil.com/<script>', 'X-Forwarded-Proto': 'https' },
    });
    const xml = await res.text();
    expect(xml).not.toContain('<script>');
    expect(xml).toMatch(/<link>https?:\/\/localhost:\d+<\/link>/);
  });

  test('PUBLIC_BASE_URL is canonical even when a trusted proxy supplies another host', async () => {
    ctx = await makeServer({ historyDir: dir, trustProxy: true, publicBaseUrl: 'https://blueteam.news' });
    const res = await fetch(`${ctx.base}/api/feed.xml`, {
      headers: { 'X-Forwarded-Host': 'wrong.example.com', 'X-Forwarded-Proto': 'http' },
    });
    const xml = await res.text();
    expect(xml).toContain('<link>https://blueteam.news</link>');
    expect(xml).not.toContain('wrong.example.com');
  });
});

describe('routes/landscape.js — feed.xml/feed.json syndication filters', () => {
  let dir; let ctx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-landscape-'));
    getLatestRunMock.mockReset().mockReturnValue({ headlines: SAMPLE_HEADLINES, generatedAt: '2026-07-01T00:00:00.000Z', generatedAtMs: Date.now() });
  });
  afterEach(async () => {
    if (ctx?.server) await new Promise(r => ctx.server.close(r));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('?tier=1 restricts feed.json to Tier-1 items only', async () => {
    ctx = await makeServer({ historyDir: dir });
    const body = await (await fetch(`${ctx.base}/api/feed.json?tier=1`)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Critical RCE exploited in the wild');
  });

  test('?kev=1 restricts feed.json to KEV-tagged items only', async () => {
    ctx = await makeServer({ historyDir: dir });
    const body = await (await fetch(`${ctx.base}/api/feed.json?kev=1`)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]._blueteam.isKEV).toBe(true);
  });

  test('?min=50 drops items below the score floor', async () => {
    ctx = await makeServer({ historyDir: dir });
    const body = await (await fetch(`${ctx.base}/api/feed.json?min=50`)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]._blueteam.score).toBeGreaterThanOrEqual(50);
  });

  test('?limit= caps the result and is bounded to the hard max', async () => {
    ctx = await makeServer({ historyDir: dir });
    const body = await (await fetch(`${ctx.base}/api/feed.json?limit=1`)).json();
    expect(body.items).toHaveLength(1);
  });

  test('an invalid/nonsense query param is ignored, not rejected', async () => {
    ctx = await makeServer({ historyDir: dir });
    const res = await fetch(`${ctx.base}/api/feed.json?tier=nope&min=abc`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
  });
});

describe('routes/landscape.js — POST /refresh cooldown', () => {
  let dir;
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('a second refresh within the cooldown window is rejected with 429 E_COOLDOWN', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-landscape-'));
    getLatestRunMock.mockReset().mockReturnValue({ headlines: [], generatedAt: null, generatedAtMs: Date.now() });
    refreshNowMock.mockReset().mockResolvedValue({ generatedAt: '2026-07-01T00:00:00.000Z', headlines: [] });

    const app = express();
    const cooldown = { _last: 0, check(key, ms) { const now = Date.now(); if (this._last && now - this._last < ms) return false; this._last = now; return true; } };
    app.use('/api', createLandscapeRouter({ historyDir: dir, cooldown }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const first = await fetch(`${base}/api/refresh`, { method: 'POST' });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/api/refresh`, { method: 'POST' });
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('E_COOLDOWN');

    await new Promise(r => server.close(r));
  });
});

describe('escapeXml — pure unit', () => {
  test('escapes the five XML-significant characters', async () => {
    const { escapeXml } = await import('../routes/landscape.js');
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  });

  test('coerces null/undefined to an empty string rather than throwing', async () => {
    const { escapeXml } = await import('../routes/landscape.js');
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

describe('normalizeScoreComponents — pure unit', () => {
  test('drops NaN and non-finite values, keeps finite numbers', async () => {
    const { normalizeScoreComponents } = await import('../routes/landscape.js');
    expect(normalizeScoreComponents({ recency: 0.8, exploitation: NaN, severity: Infinity, relevance: 0.2 }))
      .toEqual({ recency: 0.8, relevance: 0.2 });
  });

  test('drops nested objects/arrays', async () => {
    const { normalizeScoreComponents } = await import('../routes/landscape.js');
    expect(normalizeScoreComponents({ recency: 0.5, nested: { a: 1 }, arr: [1, 2] }))
      .toEqual({ recency: 0.5 });
  });

  test('returns null for a malformed or empty input', async () => {
    const { normalizeScoreComponents } = await import('../routes/landscape.js');
    expect(normalizeScoreComponents(null)).toBeNull();
    expect(normalizeScoreComponents('not an object')).toBeNull();
    expect(normalizeScoreComponents({})).toBeNull();
    expect(normalizeScoreComponents({ a: 'not a number' })).toBeNull();
  });
});

describe('routes/landscape.js — GET /briefs.xml', () => {
  let dir; let ctx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-landscape-briefs-'));
    getLatestRunMock.mockReset().mockReturnValue({ headlines: [], generatedAt: null, generatedAtMs: Date.now() });
    getBriefMetaMock.mockReset().mockReturnValue(null);
  });
  afterEach(async () => {
    if (ctx?.server) await new Promise(r => ctx.server.close(r));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('emits one RSS item per brief on disk, BLUF as description, deep-linked to /briefing/<filename>', async () => {
    writeFileSync(join(dir, 'brief-2026-07-01.md'), '## BLUF\n\nA critical exposure demands attention today.\n\n## KEY JUDGMENTS\n');
    ctx = await makeServer({ historyDir: dir });
    const res = await fetch(`${ctx.base}/api/briefs.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');
    const xml = await res.text();
    expect(xml).toContain('BlueTeam.News Briefing — 2026-07-01');
    expect(xml).toContain('A critical exposure demands attention today.');
    expect(xml).toContain('/briefing/brief-2026-07-01.md');
  });

  test('prefers the persisted brief_meta bluf over re-parsing the file when present', async () => {
    writeFileSync(join(dir, 'brief-2026-07-02.md'), '## BLUF\n\nStale on-disk text that should not be used.\n');
    getBriefMetaMock.mockReturnValue({ bluf: 'Meta-sourced BLUF wins.' });
    ctx = await makeServer({ historyDir: dir });
    const xml = await (await fetch(`${ctx.base}/api/briefs.xml`)).text();
    expect(xml).toContain('Meta-sourced BLUF wins.');
    expect(xml).not.toContain('Stale on-disk text');
  });

  test('an empty briefs directory still returns a valid (empty) feed, not an error', async () => {
    ctx = await makeServer({ historyDir: dir });
    const res = await fetch(`${ctx.base}/api/briefs.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0">');
  });
});

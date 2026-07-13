// BlueTeam.News — /api/health tests.
//
// Two things this endpoint must get right and previously didn't:
//  1. The feed-health status-string CONTRACT (lib/feeds.js produces prose
//     strings like 'ok (stale)'; this file's REACHABLE set consumes them by
//     exact match). We can't pin the contract at the source in this file, so
//     instead we drive getFeedHealth through mocked fetch outcomes and assert
//     the ok/fresh counts land where an operator would expect.
//  2. `status` must reflect reality (degraded on a stale pipeline, a feed
//     outage, or a broken DB) instead of hardcoded 'ok'.
//
// lib/feeds.js, lib/refresher.js, and lib/config.js are mocked so
// healthHandler is exercised in isolation against controlled inputs, the
// same jest.unstable_mockModule pattern net-ssrf.test.js uses.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const getFeedHealthMock = jest.fn();
const getConfigMock = jest.fn();
const getConfigVersionMock = jest.fn(() => 1);
const getLastReloadErrorMock = jest.fn(() => null);
const getLatestRunMock = jest.fn();
const getRunAgeMsMock = jest.fn();
const getKEVAgeMock = jest.fn(() => 2.5);

jest.unstable_mockModule('../lib/feeds.js', () => ({
  FRESH_FEED_STATUSES: ['ok', 'ok (cached)'],
  REACHABLE_FEED_STATUSES: ['ok', 'ok (cached)', 'ok (stale)', 'empty'],
  getFeedHealth: getFeedHealthMock,
}));
jest.unstable_mockModule('../lib/config.js', () => ({
  getConfig: getConfigMock,
  getConfigVersion: getConfigVersionMock,
  getLastReloadError: getLastReloadErrorMock,
}));
jest.unstable_mockModule('../lib/refresher.js', () => ({
  getLatestRun: getLatestRunMock,
  getRunAgeMs: getRunAgeMsMock,
}));
jest.unstable_mockModule('../lib/db.js', () => ({
  getKEVAge: getKEVAgeMock,
}));

const { healthHandler } = await import('../lib/health.js');

const DEFAULT_CONFIG = { analysisSettings: { refreshMinutes: 10 }, trustedFeeds: [{ url: 'https://a' }, { url: 'https://b' }] };

function makeServer({ dataDir, loopback = true, authed = false }) {
  const app = express();
  if (authed) app.use((_req, res, next) => { res.locals.authenticated = true; next(); });
  app.get('/api/health', healthHandler({
    bootTime: Date.now() - 60_000,
    version: '9.9.9',
    dataDir,
    getAiStatus: () => ({ enabled: false, source: null, masked: null }),
    loopback,
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe('healthHandler', () => {
  let dir; let ctx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-health-'));
    getFeedHealthMock.mockReset();
    getConfigMock.mockReset().mockReturnValue(DEFAULT_CONFIG);
    getLastReloadErrorMock.mockReset().mockReturnValue(null);
    getLatestRunMock.mockReset().mockReturnValue({ generatedAt: new Date().toISOString(), headlines: [{}, {}] });
    getRunAgeMsMock.mockReset().mockReturnValue(60_000); // 1 minute — fresh
  });
  afterEach(async () => {
    if (ctx?.server) await new Promise(r => ctx.server.close(r));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── feed-health status-string contract ──
  test('classifies ok/cached/stale/empty as reachable, and fresh as ok/cached only', async () => {
    getFeedHealthMock.mockReturnValue({
      feeds: {
        a: 'ok', b: 'ok (cached)', c: 'ok (stale)', d: 'empty',
        e: 'http-500', f: 'parse-error', g: 'failed', h: 'circuit-open', i: 'rate-limited',
      },
      search: {},
    });
    ctx = await makeServer({ dataDir: dir });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body.feeds.total).toBe(9);
    expect(body.feeds.ok).toBe(4);    // ok, ok (cached), ok (stale), empty
    expect(body.feeds.fresh).toBe(2); // ok, ok (cached) only
  });

  // ── configured count reflects the resolved active feed list ──
  test('reports configured feed count from trustedFeeds when no domain-pack sources are active', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok' }, search: {} });
    ctx = await makeServer({ dataDir: dir });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body.feeds.configured).toBe(2); // DEFAULT_CONFIG.trustedFeeds.length — cyber pack declares no sources
  });

  // ── degraded status ──
  test('status is ok when pipeline is fresh, feeds mostly reachable, DB fine', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok', b: 'ok' }, search: {} });
    writeFileSync(join(dir, 'watchfloor.db'), 'x');
    ctx = await makeServer({ dataDir: dir });
    const res = await fetch(`${ctx.base}/api/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  test('status is degraded (503) when the pipeline run is more than 3x refreshMinutes stale', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok', b: 'ok' }, search: {} });
    getRunAgeMsMock.mockReturnValue(31 * 60_000); // 31 min, refreshMinutes=10 → threshold 30
    writeFileSync(join(dir, 'watchfloor.db'), 'x');
    ctx = await makeServer({ dataDir: dir });
    const res = await fetch(`${ctx.base}/api/health`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.pipeline.stale).toBe(true);
  });

  test('status is degraded when fewer than half of configured feeds are reachable', async () => {
    getFeedHealthMock.mockReturnValue({
      feeds: { a: 'ok', b: 'failed', c: 'failed', d: 'http-500' },
      search: {},
    });
    writeFileSync(join(dir, 'watchfloor.db'), 'x');
    ctx = await makeServer({ dataDir: dir });
    const res = await fetch(`${ctx.base}/api/health`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
  });

  test('status is degraded when the database is missing', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok' }, search: {} });
    // dataDir has no watchfloor.db written into it → getDatabaseStats reports 'missing'
    ctx = await makeServer({ dataDir: dir });
    const res = await fetch(`${ctx.base}/api/health`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.database.status).toBe('missing');
  });

  test('status is ok when the database file exists and is small', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok' }, search: {} });
    writeFileSync(join(dir, 'watchfloor.db'), 'x');
    ctx = await makeServer({ dataDir: dir });
    const res = await fetch(`${ctx.base}/api/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.database.status).toBe('ok');
  });

  // ── untrusted callers get a minimal payload ──
  test('untrusted (non-loopback, unauthed) caller gets only status', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok' }, search: {} });
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: false });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body).toEqual({ status: expect.any(String) });
  });

  test('authed caller (even non-loopback) gets the full payload', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: { a: 'ok' }, search: {} });
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: true });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body).toHaveProperty('feeds');
    expect(body).toHaveProperty('memory');
    expect(body).toHaveProperty('kev');
  });

  // ── pipeline age null before first run, headline count ──
  test('pipeline.ageSeconds and lastRun are null before the first run', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: {}, search: {} });
    getLatestRunMock.mockReturnValue(null);
    getRunAgeMsMock.mockReturnValue(Infinity);
    ctx = await makeServer({ dataDir: dir });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body.pipeline.lastRun).toBeNull();
    expect(body.pipeline.ageSeconds).toBeNull();
    expect(body.pipeline.headlines).toBe(0);
  });

  test('kev.ageHours surfaces getKEVAge, rounded to one decimal', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: {}, search: {} });
    ctx = await makeServer({ dataDir: dir });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body.kev.ageHours).toBe(2.5);
  });

  // ── rejected config reload surfaces on /api/health ──
  test('configReloadError surfaces the last rejected hot-reload', async () => {
    getFeedHealthMock.mockReturnValue({ feeds: {}, search: {} });
    getLastReloadErrorMock.mockReturnValue({ at: '2026-01-01T00:00:00.000Z', message: 'Validation failed' });
    ctx = await makeServer({ dataDir: dir });
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    expect(body.configReloadError).toEqual({ at: '2026-01-01T00:00:00.000Z', message: 'Validation failed' });
  });
});

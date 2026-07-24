// BlueTeam.News — routes/brief.js tests.
//
// The 369-line core AI briefing route had zero tests before this file: SSE event
// framing, model fallback on 401/403/404/529, degenerate-output rejection, the
// timeout→partial flag, the in-flight generation lock, the corrective
// hard-fail retry, the /brief/:filename traversal guard, and the /search
// FTS5 sanitizer are all exercised here.
//
// lib/config.js, lib/refresher.js, lib/history.js, lib/db.js, and lib/logger.js
// are mocked (filesystem/DB side effects we don't want in a unit test) via
// jest.unstable_mockModule — the same pattern test/landscape-route.test.js
// uses for the sibling route. lib/validation.js and lib/prompts.js are left
// REAL: this is the one place that exercises the actual hardFail/warnings
// contract end to end, not a re-mock of our own sibling modules.
//
// The Anthropic client is supplied through the route's existing `getAnthropic`
// DI point with a fake `messages.stream` returning a scripted async-iterable —
// no real network call is ever made.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CISA_KEV_CATALOG_URL } from '../lib/grounding.js';
import { BRIEF_GROUNDING_REGRESSION } from './fixtures/brief-grounding-regression.js';

const getConfigMock = jest.fn();
const getFreshRunMock = jest.fn();
const loadRecentBriefsMock = jest.fn(() => []);
const extractContinuityContextMock = jest.fn(() => '');
const saveBriefMock = jest.fn(() => 'brief-2026-07-02.md');
const extractBlufMock = jest.fn(() => 'A test BLUF.');
const saveBriefMetaMock = jest.fn();
const getBriefMetaMock = jest.fn(() => null);
const indexBriefMock = jest.fn();
const searchBriefsMock = jest.fn(() => []);
const countKEVAddedTodayMock = jest.fn(() => 0);
const getRecentKEVMock = jest.fn(() => []);
const getKEVSetMock = jest.fn(() => new Set());
const getKEVDueDatesMock = jest.fn(() => ({}));
const dispatchBriefWebhookMock = jest.fn(() => Promise.resolve());

jest.unstable_mockModule('../lib/config.js', () => ({
  getConfig: getConfigMock,
  getHorizonName: (config, horizon) => config?.horizons?.[String(horizon)]?.name || `Tier ${horizon}`,
}));
jest.unstable_mockModule('../lib/refresher.js', () => ({
  getFreshRun: getFreshRunMock,
}));
jest.unstable_mockModule('../lib/history.js', () => ({
  saveBrief: saveBriefMock,
  loadRecentBriefs: loadRecentBriefsMock,
  extractContinuityContext: extractContinuityContextMock,
  extractBluf: extractBlufMock,
  localDateISO: (d = new Date()) => new Date(d).toISOString().slice(0, 10),
  // Real implementation (not a jest.fn mock): a pure regex helper, cheap and
  // safe to exercise for real rather than re-mock.
  briefDateFromFilename: (filename) => {
    const m = /^brief-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/.exec(filename);
    return m ? m[1] : null;
  },
}));
jest.unstable_mockModule('../lib/db.js', () => ({
  saveBriefMeta: saveBriefMetaMock,
  getBriefMeta: getBriefMetaMock,
  indexBrief: indexBriefMock,
  searchBriefs: searchBriefsMock,
  countKEVAddedToday: countKEVAddedTodayMock,
  getRecentKEV: getRecentKEVMock,
  getKEVSet: getKEVSetMock,
  getKEVDueDates: getKEVDueDatesMock,
}));
jest.unstable_mockModule('../lib/alerts.js', () => ({
  dispatchBriefWebhook: dispatchBriefWebhookMock,
}));
jest.unstable_mockModule('../lib/logger.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { createBriefRouter, streamWithRecovery, safeErrorMsg, estimateCostUsd, supportsAdaptiveThinking, applyThinking, buildGroundTruth } = await import('../routes/brief.js');

// A well-formed brief long enough to clear the 2,000-char structural floor and
// carry every section the Wall/validator expect — reused as the "happy path"
// scripted model output.
const GOOD_BRIEF = `# THREAT LANDSCAPE BRIEFING
### Threat Landscape Briefing · 2026-07-02 · Thursday

## BLUF

One sharp judgment about today's landscape that fits comfortably under budget.

---

## EXECUTIVE SUMMARY

- A high-level bullet for leadership.

## KEY JUDGMENTS

### Signal 1 — [Horizon 1] Something happened
**Assessment:** It matters to the floor today.
**Confidence:** Likely (55-80%) — reported by one source.
**The line:** A sharp line a manager can repeat verbatim.
**Decision window:** This week.

### Signal 2 — [Horizon 2] Something else happened
**Assessment:** It matters operationally.
**Confidence:** Likely (55-80%) — reported by one source.
**The line:** Another sharp line.
**Decision window:** Next 30 days.

---

## CONVERGENCE

### Two things intersect
**The intersection:** Where they meet, named in plain prose.
**The move:** Observe the trend for another cycle.

---

## WATCHLIST — NEXT 72 HOURS

- Observable thing one.
- Observable thing two.
` + 'Padding sentence to clear the structural length floor. '.repeat(40);

// Build a fake Anthropic client whose messages.stream() yields a scripted
// sequence of SSE-shaped events — the exact shape streamWithRecovery consumes
// (content_block_delta / message_start / message_delta), so no real network
// call is made and the fallback/timeout/error branches are fully controllable.
function fakeAnthropic(scriptFn) {
  return { messages: { stream: scriptFn } };
}

function textStream(text, { usage = { input_tokens: 100, output_tokens: 200 } } = {}) {
  return async () => ({
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } };
      yield { type: 'content_block_delta', delta: { text } };
      yield { type: 'message_delta', usage: { output_tokens: usage.output_tokens } };
    },
  });
}

// Like textStream, but yields the body only after a real event-loop delay —
// long enough for the request's own lifecycle events ('close' after the body
// is consumed) to fire before any SSE event is written, the way a genuine
// 150-second generation behaves. The instant textStream above flushes every
// event in microtasks and can never catch a premature-disconnect regression.
function delayedTextStream(text, delayMs, { usage = { input_tokens: 100, output_tokens: 200 } } = {}) {
  return async () => ({
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } };
      await new Promise(r => setTimeout(r, delayMs));
      yield { type: 'content_block_delta', delta: { text } };
      yield { type: 'message_delta', usage: { output_tokens: usage.output_tokens } };
    },
  });
}

function erroringStream(status, message) {
  return async () => {
    const err = new Error(message);
    err.status = status;
    throw err;
  };
}

function refusalStream(text = 'I cannot assist with this request. '.repeat(10)) {
  return async () => ({
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } };
      yield { type: 'content_block_delta', delta: { text } };
      yield { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 40 } };
    },
  });
}

function makeServer({ getAnthropic, rotateKey, cooldownCheck = () => true, historyDir = '/fake/history', publicBaseUrl = null, localPort = 3000 } = {}) {
  const app = express();
  app.use(express.json());
  const cooldown = { check: cooldownCheck };
  app.use('/api', createBriefRouter({ getAnthropic, rotateKey, historyDir, cooldown, publicBaseUrl, localPort }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function readSSE(res) {
  const text = await res.text();
  return text.split('\n\n')
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.startsWith('data: ') && chunk !== 'data: [DONE]')
    .map(chunk => JSON.parse(chunk.slice(6)));
}

beforeEach(() => {
  getConfigMock.mockReset().mockReturnValue({ analysisSettings: {}, horizons: {}, organization: {} });
  getFreshRunMock.mockReset().mockResolvedValue({ headlines: [{ title: 'A headline', horizon: 1, source: 'Feed A' }], stats: { enriched: 1 } });
  saveBriefMock.mockReset().mockReturnValue('brief-2026-07-02.md');
  saveBriefMetaMock.mockReset();
  indexBriefMock.mockReset();
  getKEVSetMock.mockReset().mockReturnValue(new Set());
  getKEVDueDatesMock.mockReset().mockReturnValue({});
  dispatchBriefWebhookMock.mockReset().mockResolvedValue();
});

describe('POST /api/brief — happy path SSE framing', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('emits progress events then a briefComplete payload with the full brief', async () => {
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(textStream(GOOD_BRIEF)) });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const events = await readSSE(res);

    const progressEvents = events.filter(e => e.progress);
    expect(progressEvents.length).toBeGreaterThan(0);

    const complete = events.find(e => e.briefComplete);
    expect(complete).toBeTruthy();
    expect(complete.model).toBe('claude-sonnet-5');
    expect(complete.text).toContain('THREAT LANDSCAPE BRIEFING');
    expect(complete.filename).toBe('brief-2026-07-02.md');
    expect(complete.partial).toBe(false);
    expect(complete.tokens).toBe(300);
    expect(saveBriefMock).toHaveBeenCalled();
    expect(indexBriefMock).toHaveBeenCalled();
  });

  test('uses PUBLIC_BASE_URL for the completed-Briefing webhook deep link', async () => {
    ctx = await makeServer({
      getAnthropic: () => fakeAnthropic(textStream(GOOD_BRIEF)),
      publicBaseUrl: 'https://blueteam.news',
    });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    await readSSE(res);

    expect(dispatchBriefWebhookMock).toHaveBeenCalledTimes(1);
    expect(dispatchBriefWebhookMock.mock.calls[0][0].link)
      .toBe('https://blueteam.news/briefing/brief-2026-07-02.md');
  });

  test('uses localhost rather than the request Host when PUBLIC_BASE_URL is unset', async () => {
    ctx = await makeServer({
      getAnthropic: () => fakeAnthropic(textStream(GOOD_BRIEF)),
      localPort: 4317,
    });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    await readSSE(res);

    const link = dispatchBriefWebhookMock.mock.calls[0][0].link;
    expect(link).toBe('http://localhost:4317/briefing/brief-2026-07-02.md');
    expect(link).not.toContain(new URL(ctx.base).host);
  });

  test('SSE events reach a client whose POST carried a JSON body (res-close regression)', async () => {
    // The real UI posts body '{}' (the Content-Type CSRF gate requires it). In
    // modern Node, the request message emits 'close' the moment that body is
    // consumed — ~1ms in, client still connected — so disconnect detection must
    // watch the RESPONSE. Guarding on req-close muted every event of a real
    // generation: the brief saved server-side while the client saw only
    // keepalives and the response never ended. The delayed stream gives the
    // event loop time to fire the request-lifecycle events first.
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(delayedTextStream(GOOD_BRIEF, 30)) });
    const res = await fetch(`${ctx.base}/api/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const events = await readSSE(res);
    const complete = events.find(e => e.briefComplete);
    expect(complete).toBeTruthy();
    expect(complete.text).toContain('THREAT LANDSCAPE BRIEFING');
  });
});

describe('POST /api/brief — model fallback', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('a 529 on the preferred model falls back to the configured fallback model and still completes', async () => {
    getConfigMock.mockReturnValue({
      analysisSettings: { preferredModel: 'claude-sonnet-5', model: 'claude-haiku-4-5' },
      horizons: {}, organization: {},
    });
    let calls = 0;
    const anthropic = {
      messages: {
        stream: async (params) => {
          calls++;
          if (params.model === 'claude-sonnet-5') return erroringStream(529, 'Overloaded')();
          return textStream(GOOD_BRIEF)();
        },
      },
    };
    ctx = await makeServer({ getAnthropic: () => anthropic });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    const events = await readSSE(res);
    const complete = events.find(e => e.briefComplete);
    expect(complete).toBeTruthy();
    expect(complete.model).toBe('claude-haiku-4-5');
    expect(calls).toBe(2);
  });

  test('a non-fallback-triggering error (e.g. 400) does NOT retry — it fails the generation', async () => {
    getConfigMock.mockReturnValue({
      analysisSettings: { preferredModel: 'claude-sonnet-5', model: 'claude-haiku-4-5' },
      horizons: {}, organization: {},
    });
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(erroringStream(400, 'Bad request')) });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    const events = await readSSE(res);
    expect(events.some(e => e.error)).toBe(true);
    expect(events.some(e => e.briefComplete)).toBe(false);
  });
});

describe('POST /api/brief — secondary-key rotation on auth failure', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('rotates to the secondary key and retries the SAME model when the primary is rejected (401)', async () => {
    // The real failover path: generation streams (messages.stream), so a 401 must
    // rotate the KEY and retry — not swap the model on the same dead key. Proven
    // by the completed brief still carrying the preferred model, not the fallback.
    getConfigMock.mockReturnValue({
      analysisSettings: { preferredModel: 'claude-sonnet-5', model: 'claude-haiku-4-5' },
      horizons: {}, organization: {},
    });
    const deadKeyClient = fakeAnthropic(erroringStream(401, 'authentication_error'));
    const secondaryClient = fakeAnthropic(textStream(GOOD_BRIEF));
    let rotateCalls = 0;
    ctx = await makeServer({
      getAnthropic: () => deadKeyClient,
      rotateKey: () => { rotateCalls++; return secondaryClient; },
    });
    const res = await fetch(`${ctx.base}/api/brief`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const events = await readSSE(res);
    const complete = events.find(e => e.briefComplete);
    expect(rotateCalls).toBe(1);
    expect(complete).toBeTruthy();
    expect(complete.model).toBe('claude-sonnet-5'); // same model, new key
    expect(complete.text).toContain('THREAT LANDSCAPE BRIEFING');
  });

  test('a 401 with no secondary key (rotateKey returns null) falls through to model fallback', async () => {
    getConfigMock.mockReturnValue({
      analysisSettings: { preferredModel: 'claude-sonnet-5', model: 'claude-haiku-4-5' },
      horizons: {}, organization: {},
    });
    let calls = 0;
    const anthropic = {
      messages: {
        stream: async (params) => {
          calls++;
          if (params.model === 'claude-sonnet-5') return erroringStream(401, 'auth')();
          return textStream(GOOD_BRIEF)();
        },
      },
    };
    ctx = await makeServer({ getAnthropic: () => anthropic, rotateKey: () => null });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    const events = await readSSE(res);
    const complete = events.find(e => e.briefComplete);
    expect(complete).toBeTruthy();
    expect(complete.model).toBe('claude-haiku-4-5'); // rotation had nothing to give → model fallback
  });
});

describe('POST /api/brief — degenerate output rejected', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('output under 100 chars is treated as a failure, not saved', async () => {
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(textStream('too short')) });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    const events = await readSSE(res);
    expect(events.some(e => e.error)).toBe(true);
    expect(saveBriefMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/brief — corrective retry recovery', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('keeps the complete first draft when the structural retry is interrupted, while counting retry usage', async () => {
    const firstDraft = GOOD_BRIEF.replace('## BLUF', '## OVERVIEW');
    let calls = 0;
    const anthropic = {
      messages: {
        stream: async () => {
          calls++;
          if (calls === 1) return textStream(firstDraft)();
          return {
            controller: { abort() {} },
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } };
              yield { type: 'content_block_delta', delta: { text: 'Interrupted replacement draft. '.repeat(8) } };
              yield { type: 'message_delta', usage: { output_tokens: 40 } };
              throw new Error('socket hang up');
            },
          };
        },
      },
    };

    ctx = await makeServer({ getAnthropic: () => anthropic });
    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    const complete = events.find(e => e.briefComplete);

    expect(calls).toBe(2);
    expect(complete).toBeTruthy();
    expect(complete.text).toBe(firstDraft);
    expect(complete.tokens).toBe(370);
    expect(saveBriefMock).toHaveBeenCalledWith('/fake/history', firstDraft);
  });
});

describe('POST /api/brief — grounding publication gate', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('retries an ungrounded CVE once, publishes the corrected draft, and accounts for both calls', async () => {
    const firstDraft = GOOD_BRIEF + '\n\nCVE-2099-99999 requires immediate remediation.';
    let calls = 0;
    const anthropic = fakeAnthropic(async () => {
      calls++;
      return textStream(calls === 1 ? firstDraft : GOOD_BRIEF)();
    });
    ctx = await makeServer({ getAnthropic: () => anthropic });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    const complete = events.find(event => event.briefComplete);
    expect(calls).toBe(2);
    expect(complete).toBeTruthy();
    expect(complete.tokens).toBe(600);
    expect(saveBriefMock).toHaveBeenCalledWith('/fake/history', GOOD_BRIEF);
  });

  test('returns an actionable SSE error and never saves or promotes a persistently ungrounded draft', async () => {
    const badDraft = GOOD_BRIEF + '\n\nCVE-2099-99999 requires immediate remediation.';
    let calls = 0;
    const anthropic = fakeAnthropic(async () => {
      calls++;
      return textStream(badDraft)();
    });
    ctx = await makeServer({ getAnthropic: () => anthropic });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    const blocked = events.find(event => event.code === 'E006');
    expect(calls).toBe(2);
    expect(blocked).toBeTruthy();
    expect(blocked.error).toMatch(/not published.*source verification/i);
    expect(blocked.validation.trustFail).toBe(true);
    expect(blocked.tokens).toBe(600);
    expect(events.some(event => event.briefComplete)).toBe(false);
    expect(saveBriefMock).not.toHaveBeenCalled();
    expect(indexBriefMock).not.toHaveBeenCalled();
    expect(saveBriefMetaMock).not.toHaveBeenCalled();
    expect(dispatchBriefWebhookMock).not.toHaveBeenCalled();
  });

  test('de-links the blank-link ColdFusion citation without spending a retry', async () => {
    const f = BRIEF_GROUNDING_REGRESSION;
    getFreshRunMock.mockResolvedValue({ headlines: [f.coldFusionHeadline], stats: { enriched: 1 } });
    const linkedDraft = GOOD_BRIEF + `\n\n[Help Net Security, July 7](${f.inventedColdFusionUrl})`;
    let calls = 0;
    const anthropic = fakeAnthropic(async () => {
      calls++;
      return textStream(linkedDraft)();
    });
    ctx = await makeServer({ getAnthropic: () => anthropic });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    const complete = events.find(event => event.briefComplete);
    expect(calls).toBe(1);
    expect(complete).toBeTruthy();
    expect(complete.text).toContain('[Help Net Security, July 7]');
    expect(complete.text).not.toContain(f.inventedColdFusionUrl);
    expect(saveBriefMock.mock.calls[0][1]).not.toContain(f.inventedColdFusionUrl);
  });

  test('keeps the system-shown CISA KEV catalog citation live', async () => {
    getFreshRunMock.mockResolvedValue({
      headlines: [{
        source: 'Vendor', title: 'Known exploited issue', horizon: 1,
        isKEV: true, kevCVE: 'CVE-2026-10520', cveData: 'CVE-2026-10520',
      }],
      stats: { enriched: 1 },
    });
    getKEVSetMock.mockReturnValue(new Set(['CVE-2026-10520']));
    const draft = GOOD_BRIEF + `\n\n[CISA KEV catalog](${CISA_KEV_CATALOG_URL})`;
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(textStream(draft)) });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    expect(events.find(event => event.briefComplete)?.text).toContain(`](${CISA_KEV_CATALOG_URL})`);
    expect(saveBriefMock.mock.calls[0][1]).toContain(`](${CISA_KEV_CATALOG_URL})`);
  });

  test('fails closed on an affirmative KEV claim when the runtime catalog is empty', async () => {
    const cve = 'CVE-2026-4555';
    getFreshRunMock.mockResolvedValue({
      headlines: [{ source: 'Vendor', title: `Vendor advisory ${cve}`, horizon: 1 }],
      stats: { enriched: 1 },
    });
    getKEVSetMock.mockReturnValue(new Set());
    const draft = GOOD_BRIEF.replace(
      '**The line:** A sharp line a manager can repeat verbatim.',
      `**What happened:** CISA added ${cve} to KEV.\n**The line:** A sharp line a manager can repeat verbatim.`
    );
    let calls = 0;
    const anthropic = fakeAnthropic(async () => {
      calls++;
      return textStream(draft)();
    });
    ctx = await makeServer({ getAnthropic: () => anthropic });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    const blocked = events.find(event => event.code === 'E006');
    expect(calls).toBe(2);
    expect(blocked?.error).toMatch(/KEV catalog unavailable/);
    expect(saveBriefMock).not.toHaveBeenCalled();
    expect(indexBriefMock).not.toHaveBeenCalled();
    expect(saveBriefMetaMock).not.toHaveBeenCalled();
    expect(dispatchBriefWebhookMock).not.toHaveBeenCalled();
  });

  test('strips raw HTML anchors without corrupting their visible labels or spending a retry', async () => {
    getFreshRunMock.mockResolvedValue({
      headlines: [{ source: 'Feed', title: 'Source story', horizon: 1, link: 'https://example.com/allowed' }],
      stats: { enriched: 1 },
    });
    const draft = GOOD_BRIEF + '\n\n<a href="https://example.com/allowed">Allowed source label</a>';
    let calls = 0;
    const anthropic = fakeAnthropic(async () => {
      calls++;
      return textStream(draft)();
    });
    ctx = await makeServer({ getAnthropic: () => anthropic });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    const complete = events.find(event => event.briefComplete);
    expect(calls).toBe(1);
    expect(complete?.text).toContain('Allowed source label');
    expect(complete?.text).not.toMatch(/<\/?a\b|href=/i);
    expect(saveBriefMock.mock.calls[0][1]).toContain('Allowed source label');
  });

  test('publishes a grounded future KEV Watchlist condition when the CVE is absent from a loaded catalog', async () => {
    const cve = 'CVE-2026-4555';
    getFreshRunMock.mockResolvedValue({
      headlines: [{ source: 'Vendor', title: `Vendor advisory ${cve}`, horizon: 1 }],
      stats: { enriched: 1 },
    });
    getKEVSetMock.mockReturnValue(new Set(['CVE-2026-9999']));
    const draft = GOOD_BRIEF + `\n- CISA adds ${cve} to KEV.`;
    let calls = 0;
    const anthropic = fakeAnthropic(async () => {
      calls++;
      return textStream(draft)();
    });
    ctx = await makeServer({ getAnthropic: () => anthropic });

    const events = await readSSE(await fetch(`${ctx.base}/api/brief`, { method: 'POST' }));
    expect(calls).toBe(1);
    expect(events.find(event => event.briefComplete)?.text).toContain(`CISA adds ${cve} to KEV`);
    expect(events.some(event => event.code === 'E006')).toBe(false);
    expect(saveBriefMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/brief — Sonnet 5 refusal handling', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('a 200/refusal response is never saved as a briefing', async () => {
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(refusalStream()) });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    const events = await readSSE(res);
    expect(events.some(e => /refused/i.test(e.error || ''))).toBe(true);
    expect(events.some(e => e.briefComplete)).toBe(false);
    expect(saveBriefMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/brief — no API key / cooldown / in-flight lock', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('no configured Anthropic client returns 503 E002', async () => {
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('E002');
  });

  test('cooldown rejection returns 429 E001', async () => {
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(textStream(GOOD_BRIEF)), cooldownCheck: () => false });
    const res = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('E001');
  });

  // A real in-flight lock, not just the 15s cooldown timestamp gate: a
  // second POST that arrives WHILE a generation is still streaming must be
  // rejected even though the cooldown object itself would allow it (fresh check).
  test('a second POST while a generation is in flight is rejected with 429, independent of the cooldown', async () => {
    let releaseFirst;
    const slowStream = async () => ({
      controller: { abort() {} },
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };
        yield { type: 'content_block_delta', delta: { text: GOOD_BRIEF } };
        await new Promise(r => { releaseFirst = r; });
      },
    });
    ctx = await makeServer({ getAnthropic: () => fakeAnthropic(slowStream), cooldownCheck: () => true });

    const firstReq = fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    // Give the first request a tick to enter the handler and set the in-flight flag.
    await new Promise(r => setTimeout(r, 50));

    const second = await fetch(`${ctx.base}/api/brief`, { method: 'POST' });
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('E001');

    releaseFirst();
    await firstReq;
  });
});

describe('GET /api/brief/:filename — traversal guard', () => {
  let ctx;
  let historyDir;
  afterEach(async () => {
    if (ctx?.server) await new Promise(r => ctx.server.close(r));
    if (historyDir) rmSync(historyDir, { recursive: true, force: true });
  });

  test('an archived brief carries an exact freshness timestamp for the app and export', async () => {
    historyDir = mkdtempSync(join(tmpdir(), 'wf-brief-route-'));
    const filename = 'brief-2026-07-12.md';
    writeFileSync(join(historyDir, filename), GOOD_BRIEF, 'utf8');
    ctx = await makeServer({ getAnthropic: () => null, historyDir });

    const res = await fetch(`${ctx.base}/api/brief/${filename}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  test('a well-formed filename that does not exist on disk 404s cleanly', async () => {
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/brief/brief-2026-01-01.md`);
    expect(res.status).toBe(404);
  });

  test('a path-traversal filename is rejected with 400, never reaching the filesystem', async () => {
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/brief/${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(400);
  });

  test('a filename with a null-byte-style suffix is rejected with 400', async () => {
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/brief/${encodeURIComponent('brief-2026-01-01.md%00.txt')}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/search — FTS5 sanitizer', () => {
  let ctx;
  afterEach(async () => { if (ctx?.server) await new Promise(r => ctx.server.close(r)); });

  test('a CVE-ID query is tokenized and quoted, not passed raw to MATCH', async () => {
    searchBriefsMock.mockReset().mockReturnValue([{ filename: 'brief-2026-07-01.md', snippet: 'CVE-2026-1234' }]);
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/search?q=CVE-2026-1234`);
    expect(res.status).toBe(200);
    expect(searchBriefsMock).toHaveBeenCalledWith('"CVE-2026-1234"', 20);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  test('a bare boolean-operator query does not 500 — it is quoted into a literal token', async () => {
    searchBriefsMock.mockReset().mockReturnValue([]);
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/search?q=${encodeURIComponent('ransomware OR NOT')}`);
    expect(res.status).toBe(200);
    expect(searchBriefsMock).toHaveBeenCalledWith('"ransomware" "OR" "NOT"', 20);
  });

  test('an FTS5 error from a malformed query is swallowed into an empty array, not a 500', async () => {
    searchBriefsMock.mockReset().mockImplementation(() => { throw new Error('fts5: syntax error'); });
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/search?q=whatever`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('a query shorter than 2 chars is rejected with 400 E005', async () => {
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/search?q=a`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E005');
  });

  test('an oversized query is rejected before it reaches FTS5', async () => {
    searchBriefsMock.mockReset();
    ctx = await makeServer({ getAnthropic: () => null });
    const res = await fetch(`${ctx.base}/api/search?q=${'a'.repeat(201)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E005');
    expect(searchBriefsMock).not.toHaveBeenCalled();
  });
});

describe('streamWithRecovery — pure unit', () => {
  test('assembles content_block_delta text and captures usage from message_start/message_delta', async () => {
    const result = await streamWithRecovery(fakeAnthropic(textStream('Hello world', { usage: { input_tokens: 12, output_tokens: 34 } })), {}, {});
    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test('a mid-stream throw is captured as result.error, not swallowed', async () => {
    const midStreamThrow = async () => ({
      controller: { abort() {} },
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { text: 'partial content before the drop' } };
        throw new Error('socket hang up');
      },
    });
    const result = await streamWithRecovery(fakeAnthropic(midStreamThrow), {}, {});
    expect(result.text).toBe('partial content before the drop');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('socket hang up');
    expect(result.timedOut).toBe(false);
  });

  test('an immediate stream() rejection is captured as result.error with empty text', async () => {
    const result = await streamWithRecovery(fakeAnthropic(erroringStream(401, 'unauthorized')), {}, {});
    expect(result.text).toBe('');
    expect(result.error.status).toBe(401);
  });

  test('exceeding timeoutMs sets timedOut and aborts the controller', async () => {
    let aborted = false;
    // Mirrors the real Anthropic SDK stream: calling controller.abort() is what
    // makes the in-flight `for await` loop stop — a fake that ignored abort()
    // would hang the harness's setTimeout-driven abort forever.
    let stopIteration;
    const abortSignal = new Promise((resolve) => { stopIteration = resolve; });
    const neverEnds = async () => ({
      controller: { abort() { aborted = true; stopIteration(); } },
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { text: 'still going' } };
        await abortSignal;
      },
    });
    const result = await streamWithRecovery(fakeAnthropic(neverEnds), {}, { timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(aborted).toBe(true);
  }, 10_000);
});

describe('safeErrorMsg — redaction', () => {
  test('known operational error shapes pass through (truncated)', () => {
    expect(safeErrorMsg(new Error('rate limit exceeded'))).toBe('rate limit exceeded');
  });

  test('an unrecognized error message is truncated to 200 chars and not leaked verbatim if huge', () => {
    const huge = 'x'.repeat(500);
    expect(safeErrorMsg(new Error(huge)).length).toBeLessThanOrEqual(200);
  });

  test('an empty message falls back to a generic string, never blank', () => {
    expect(safeErrorMsg(new Error(''))).toBe('Internal server error');
  });

  test('redacts an Anthropic credential if an upstream diagnostic echoes it', () => {
    expect(safeErrorMsg(new Error('API key sk-ant-test-key was rejected')))
      .toBe('API key [REDACTED] was rejected');
  });
});

describe('estimateCostUsd / supportsAdaptiveThinking — pure units', () => {
  test('date-gates Sonnet 5 introductory pricing and uses exact current Haiku pricing', () => {
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 1_000_000, new Date('2026-08-31T12:00:00Z'))).toBeCloseTo(12);
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 1_000_000, new Date('2026-09-01T00:00:00Z'))).toBeCloseTo(18);
    expect(estimateCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(6);
  });

  test('returns null for an unrecognized model rather than a misleading $0', () => {
    expect(estimateCostUsd('some-future-model-9000', 1000, 1000)).toBeNull();
  });

  test('adaptive thinking is only offered to the models that accept the param', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
  });

  test('Sonnet 5 effort is explicit, including a real disabled mode', () => {
    const params = {};
    applyThinking(params, 'claude-sonnet-5', 'medium');
    expect(params).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });

    applyThinking(params, 'claude-sonnet-5', 'off');
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.output_config?.effort).toBeUndefined();

    applyThinking(params, 'claude-haiku-4-5', 'medium');
    expect(params.thinking).toBeUndefined();
    expect(params.output_config?.effort).toBeUndefined();
  });
});

// buildGroundTruth is the one place the system tells the model "never
// contradict this." Pinned here against a mocked lib/db.js so a wording
// regression (or a boundary flip in what counts as "new") is caught on the
// consuming side. The underlying date-comparison correctness of
// countKEVAddedSince/getKEVSet/getRecentKEV themselves lives in lib/db.js,
// so it is NOT covered here (see the returned notes).
describe('buildGroundTruth — KEV ground-truth facts', () => {
  beforeEach(() => {
    countKEVAddedTodayMock.mockReset();
    getRecentKEVMock.mockReset().mockReturnValue([]);
    getKEVSetMock.mockReset();
    getKEVDueDatesMock.mockReset().mockReturnValue({});
  });

  test('an unloaded catalog (empty KEV set) is reported as unknown, never as zero', () => {
    getKEVSetMock.mockReturnValue(new Set());
    const gt = buildGroundTruth({});
    expect(gt).toMatch(/not yet loaded this run/);
    expect(gt).not.toMatch(/no new entries/);
  });

  test('zero new entries today is stated plainly', () => {
    getKEVSetMock.mockReturnValue(new Set(['CVE-2026-0001']));
    countKEVAddedTodayMock.mockReturnValue(0);
    const gt = buildGroundTruth({});
    expect(gt).toMatch(/no new entries added today/);
  });

  test('new entries are counted and named from getRecentKEV', () => {
    getKEVSetMock.mockReturnValue(new Set(['CVE-2026-0001', 'CVE-2026-0002']));
    countKEVAddedTodayMock.mockReturnValue(2);
    // buildGroundTruth names getRecentKEV(count) — the N most-recently-added, which
    // ARE today's entries; day-window filtering is the DB query's job, not the caller's.
    getRecentKEVMock.mockReturnValue([
      { cve_id: 'CVE-2026-0002', date_added: '2026-07-02' },
      { cve_id: 'CVE-2026-0001', date_added: '2026-07-02' },
    ]);
    const gt = buildGroundTruth({});
    expect(gt).toMatch(/2 new entries added today/);
    expect(gt).toContain('CVE-2026-0002');
    expect(gt).toContain('CVE-2026-0001');
  });

  test('adds date-only FCEB KEV timing for every CVE visible in current-source headlines', () => {
    getKEVSetMock.mockReturnValue(new Set(['CVE-2008-4128', 'CVE-2026-48939']));
    countKEVAddedTodayMock.mockReturnValue(0);
    getKEVDueDatesMock.mockReturnValue({
      'CVE-2008-4128': { date_added: '2026-07-13', due_date: '2026-07-16', overdue: false },
      'CVE-2026-48939': { date_added: '2026-07-10', due_date: '2026-07-13', overdue: false },
    });

    const gt = buildGroundTruth({
      headlines: [
        { title: 'CISA adds CVE-2008-4128 to KEV' },
        { title: 'Joomla extensions exploited', articleBody: 'CISA lists CVE-2026-48939.' },
      ],
    });

    expect(getKEVDueDatesMock).toHaveBeenCalledWith(expect.arrayContaining([
      'CVE-2008-4128', 'CVE-2026-48939',
    ]));
    expect(gt).toContain('CVE-2008-4128 — catalog added 2026-07-13; FCEB remediation due 2026-07-16');
    expect(gt).toContain('CVE-2026-48939 — catalog added 2026-07-10; FCEB remediation due 2026-07-13');
    expect(gt).toMatch(/date-only; FCEB scope/);
    expect(gt).toMatch(/Do not add a clock time or timezone/);
    expect(gt).not.toMatch(/\b\d{1,2}:\d{2}\b|\bCT\b/);
  });

  test('an enrichment failure this run is surfaced as a hedge instruction, not silence', () => {
    getKEVSetMock.mockReturnValue(new Set(['CVE-2026-0001']));
    countKEVAddedTodayMock.mockReturnValue(0);
    const gt = buildGroundTruth({ stats: { enrichmentFailures: ['CVSS', 'KEV'] } });
    expect(gt).toMatch(/Enrichment note: CVSS and KEV enrichment was unavailable/);
    expect(gt).toMatch(/never as "not severe" or "no vulnerability/);
  });

  test('a getKEVSet throw degrades to no ground-truth block rather than crashing generation', () => {
    getKEVSetMock.mockImplementation(() => { throw new Error('db locked'); });
    expect(() => buildGroundTruth({})).not.toThrow();
  });
});

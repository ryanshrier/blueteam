// BlueTeam.News — dispatchAlerts (lib/alerts.js) tests.
//
// This is the "wake someone up about the zero-day" path, and its two failure
// modes are both silent: alerts stop firing (missed incident) or the retry
// semantics break and every run re-spams the channel (operators disable the
// webhook). See finding #101.
//
// lib/net.js's safeFetch is mocked (jest.unstable_mockModule, the exact
// pattern net-ssrf.test.js already uses) so no real network call is ever
// made; lib/db.js's meta table is real (initDB(':memory:')) so the
// persist/dedupe round-trip is exercised for real.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const safeFetchMock = jest.fn();
const readCappedMock = jest.fn();
jest.unstable_mockModule('../lib/net.js', () => ({
  safeFetch: safeFetchMock,
  readCapped: readCappedMock,
}));

const { initDB, closeDB, getMeta } = await import('../lib/db.js');
const { dispatchAlerts, dispatchBriefWebhook } = await import('../lib/alerts.js');

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status };
}

function headline(overrides = {}) {
  return {
    title: 'Critical VPN zero-day exploited in the wild',
    link: 'https://example.com/a',
    source: 'BleepingComputer',
    horizon: 1,
    score: 9.2,
    alertMatched: true,
    ...overrides,
  };
}

function configWithWebhook(overrides = {}) {
  return { analysisSettings: { webhook: { url: 'https://hooks.example.com/x', format: 'slack', ...overrides } } };
}

describe('dispatchAlerts', () => {
  beforeEach(() => {
    initDB(':memory:');
    safeFetchMock.mockReset();
    readCappedMock.mockReset().mockResolvedValue('');
  });
  afterEach(() => closeDB());

  test('no-op when the webhook url is empty (disabled by default)', async () => {
    await dispatchAlerts([headline()], { analysisSettings: { webhook: { url: '' } } });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('no-op when no headlines match an alert rule', async () => {
    await dispatchAlerts([headline({ alertMatched: false })], configWithWebhook());
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('first delivery POSTs and persists the sent key', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], configWithWebhook());
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = safeFetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/x');
    expect(opts.method).toBe('POST');
    const stored = JSON.parse(getMeta('alert_sent_keys'));
    expect(stored.length).toBe(1);
  });

  test('second run skips already-sent keys (title-key dedup across runs)', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], configWithWebhook());
    safeFetchMock.mockClear();
    await dispatchAlerts([headline()], configWithWebhook()); // same title again
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('overlapping dispatches serialize the sent-key check and do not double-post', async () => {
    let releaseFirst;
    safeFetchMock.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }));

    const first = dispatchAlerts([headline()], configWithWebhook());
    await Promise.resolve();
    await Promise.resolve();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);

    const overlapping = dispatchAlerts([headline()], configWithWebhook());
    await Promise.resolve();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);

    releaseFirst(okResponse(200));
    await Promise.all([first, overlapping]);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  test('intra-run duplicates (two matched items, same title) are sent once', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline(), headline({ link: 'https://example.com/b' })], configWithWebhook());
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.blocks[1].text.text.split('\n').length).toBe(1); // one line, one item
  });

  test('distinct Unicode-only titles do not collapse into one alert key', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([
      headline({ title: '重大漏洞' }),
      headline({ title: '緊急更新', link: 'https://example.com/b' }),
    ], configWithWebhook());
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.blocks[1].text.text.split('\n')).toHaveLength(2);
    expect(JSON.parse(getMeta('alert_sent_keys'))).toHaveLength(2);
  });

  test('a non-2xx response leaves the key UNPERSISTED so a transient failure retries', async () => {
    safeFetchMock.mockResolvedValue(okResponse(500));
    await dispatchAlerts([headline()], configWithWebhook());
    expect(getMeta('alert_sent_keys')).toBeNull();

    // Next run, same title, now succeeds — must actually retry (not think it already sent).
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], configWithWebhook());
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    const stored = JSON.parse(getMeta('alert_sent_keys'));
    expect(stored.length).toBe(1);
  });

  test('caps persisted keys at 500, keeping the newest', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    // Seed 500 pre-existing keys directly via repeated dispatch of unique titles.
    for (let i = 0; i < 501; i++) {
      await dispatchAlerts([headline({ title: `Unique alert story number ${i}`, link: `https://example.com/${i}` })], configWithWebhook());
    }
    const stored = JSON.parse(getMeta('alert_sent_keys'));
    expect(stored.length).toBe(500);
    // The oldest key (story 0) should have been evicted; the newest (story 500) survives.
    expect(stored).not.toContain('unique alert story number 0');
    expect(stored).toContain('unique alert story number 500');
  });

  test('slack format builds a mrkdwn body; json format builds a structured body', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], configWithWebhook({ format: 'json' }));
    const jsonBody = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(jsonBody.source).toBe('blueteam');
    expect(jsonBody.items[0].title).toBe(headline().title);

    safeFetchMock.mockClear();
    await dispatchAlerts([headline({ title: 'A different story to avoid dedup' })], configWithWebhook({ format: 'slack' }));
    const slackBody = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(slackBody.text).toMatch(/rotating_light/);
    expect(slackBody.blocks).toBeInstanceOf(Array);
  });

  test('a thrown fetch never propagates out of dispatchAlerts', async () => {
    safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(dispatchAlerts([headline()], configWithWebhook())).resolves.toBeUndefined();
    expect(getMeta('alert_sent_keys')).toBeNull();
  });

  test('the webhook timeout stays armed until the response body is drained', async () => {
    jest.useFakeTimers();
    let releaseDrain;
    let signal;
    try {
      safeFetchMock.mockImplementation(async (_url, opts) => {
        signal = opts.signal;
        return okResponse(200);
      });
      readCappedMock.mockImplementation(() => new Promise(resolve => { releaseDrain = resolve; }));

      const pending = dispatchAlerts([headline()], configWithWebhook());
      await Promise.resolve();
      await Promise.resolve();
      expect(readCappedMock).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(8000);
      expect(signal.aborted).toBe(true);
      releaseDrain('');
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  // ── #6 — Slack mrkdwn injection guard ──
  test('escapes &, <, > in the title so feed content cannot inject mrkdwn', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline({ title: 'Vendor <X> & "urgent" *patch* now' })], configWithWebhook());
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.text).not.toContain('<X>');
    expect(body.text).toContain('&lt;X&gt;');
    expect(body.text).toContain('&amp;');
  });

  test('drops a link containing | or > rather than embedding a broken/injecting mrkdwn link token', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    const maliciousLink = 'http://x.example/a>*urgent*<https://evil.example|CLICK';
    await dispatchAlerts([headline({ link: maliciousLink })], configWithWebhook());
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.text).not.toContain(maliciousLink);
    expect(body.text).not.toContain('|CLICK');
  });

  test('keeps a clean https link as a normal Slack link token', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline({ link: 'https://example.com/clean' })], configWithWebhook());
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('<https://example.com/clean|link>');
  });

  // ── #128 — webhook.events gate ──
  test('defaults to firing on alerts when events is unset', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], { analysisSettings: { webhook: { url: 'https://hooks.example.com/x' } } });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not fire when events is "brief" only', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], configWithWebhook({ events: 'brief' }));
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('fires when events is "both"', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchAlerts([headline()], configWithWebhook({ events: 'both' }));
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchBriefWebhook', () => {
  beforeEach(() => {
    initDB(':memory:');
    safeFetchMock.mockReset();
    readCappedMock.mockReset().mockResolvedValue('');
  });
  afterEach(() => closeDB());

  function brief(overrides = {}) {
    return {
      date: '2026-07-02',
      bluf: 'A critical VPN zero-day is under active exploitation.',
      judgments: [{ title: 'Patch VPN gateways now', tier: 'Tactical', confidence: 'high' }],
      link: 'https://blueteam.local/briefing/2026-07-02.md',
      ...overrides,
    };
  }

  test('no-op when the webhook url is empty', async () => {
    await dispatchBriefWebhook(brief(), { analysisSettings: { webhook: { url: '', events: 'brief' } } });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('no-op when events is "alerts" only (the default)', async () => {
    await dispatchBriefWebhook(brief(), { analysisSettings: { webhook: { url: 'https://hooks.example.com/x' } } });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  test('POSTs the compact brief payload when events is "brief"', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchBriefWebhook(brief(), { analysisSettings: { webhook: { url: 'https://hooks.example.com/x', events: 'brief' } } });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('2026-07-02');
    expect(body.text).toContain('VPN zero-day');
    expect(body.text).toContain('Patch VPN gateways now');
  });

  test('POSTs when events is "both"', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchBriefWebhook(brief(), { analysisSettings: { webhook: { url: 'https://hooks.example.com/x', events: 'both' } } });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  test('builds a structured json body when format is json', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchBriefWebhook(brief(), { analysisSettings: { webhook: { url: 'https://hooks.example.com/x', events: 'brief', format: 'json' } } });
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('brief');
    expect(body.date).toBe('2026-07-02');
    expect(body.judgments[0].title).toBe('Patch VPN gateways now');
  });

  test('escapes mrkdwn in the BLUF and judgment titles', async () => {
    safeFetchMock.mockResolvedValue(okResponse(200));
    await dispatchBriefWebhook(
      brief({ bluf: 'Vendor <X> & "urgent" patch', judgments: [{ title: '<script>alert(1)</script>', tier: 'H1' }] }),
      { analysisSettings: { webhook: { url: 'https://hooks.example.com/x', events: 'brief' } } },
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.text).not.toContain('<X>');
    expect(body.text).not.toContain('<script>');
  });

  test('a thrown fetch never propagates', async () => {
    safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(dispatchBriefWebhook(brief(), { analysisSettings: { webhook: { url: 'https://hooks.example.com/x', events: 'brief' } } })).resolves.toBeUndefined();
  });
});

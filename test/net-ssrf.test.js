// SSRF guard (lib/net.js) — the most security-critical untested surface. Covers
// the IP blocklist (IPv4 + IPv6, mapped-v4, metadata, fail-closed), URL scheme
// gating, and the DNS-resolution path (mocked, so the suite is hermetic — no real
// network). Redirect-hop revalidation is exercised by assertPublicUrl per hop,
// and safeFetch's own hop loop + readCapped's byte cap are exercised below
// against a mocked global fetch (safeFetch's IP-pinning dispatcher wraps
// node:http(s) directly, so mocking fetch() itself is what lets us drive the
// hop loop deterministically without a real socket).
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';

// Mock DNS so the hostname path is deterministic. Must be registered before the
// dynamic import of the module under test.
const lookupMock = jest.fn();
jest.unstable_mockModule('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));

const { isBlockedIP, assertPublicUrl, safeFetch, readCapped } = await import('../lib/net.js');

// Build a minimal fetch Response for the safeFetch hop-loop tests below.
// safeFetch only touches .status, .headers.get(), and .body(.cancel()).
function fakeResponse({ status, location, body = null }) {
  const headers = new Map();
  if (location !== undefined) headers.set('location', location);
  return {
    status,
    headers: { get: (k) => (headers.has(k.toLowerCase()) ? headers.get(k.toLowerCase()) : null) },
    body: body ? { cancel: jest.fn().mockResolvedValue(undefined) } : null,
  };
}

describe('isBlockedIP — blocks private, loopback, link-local, metadata, malformed', () => {
  const blocked = [
    // IPv4
    '0.0.0.0', '127.0.0.1', '127.5.99.1', '10.0.0.5', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '169.254.169.254', '169.254.0.1', '224.0.0.1', '240.0.0.1',
    // IPv6
    '::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fec0::1', 'ff02::1',
    // IPv4-transition ranges can otherwise translate/tunnel to private IPv4.
    '64:ff9b::c0a8:1', '64:ff9b:1::c0a8:1', '2002:c0a8:101::1',
    // IPv4-mapped IPv6 (the classic bypass)
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    // not an IP literal → fail closed
    'not-an-ip', '', 'localhost', 'example.com',
  ];
  test.each(blocked)('blocks %s', (ip) => expect(isBlockedIP(ip)).toBe(true));
});

describe('isBlockedIP — allows genuine public addresses', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'];
  test.each(allowed)('allows %s', (ip) => expect(isBlockedIP(ip)).toBe(false));
});

describe('assertPublicUrl — IPv4 literals + schemes (no DNS)', () => {
  test.each(['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.0.1/'])(
    'rejects private literal %s',
    async (url) => { await expect(assertPublicUrl(url)).rejects.toThrow(/blocked: private/); },
  );

  test.each(['ftp://example.com/', 'file:///etc/passwd', 'gopher://x/9', 'data:text/plain,hi'])(
    'rejects non-http scheme %s',
    async (url) => { await expect(assertPublicUrl(url)).rejects.toThrow(/blocked: scheme/); },
  );

  test('rejects an unparseable URL', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/blocked: invalid URL/);
  });

  test.each([
    'https://user:supersecret@93.184.216.34/private',
    'https://user@93.184.216.34/private',
  ])('rejects URL credentials without echoing the credential-bearing input: %s', async (url) => {
    lookupMock.mockReset();
    const error = await assertPublicUrl(url).catch(err => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('blocked: URL credentials are not allowed');
    expect(error.message).not.toContain('supersecret');
    expect(error.message).not.toContain('user');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test.each(['http://8.8.8.8/', 'https://1.1.1.1/path?q=1'])('allows public literal %s', async (url) => {
    const u = await assertPublicUrl(url);
    expect(u).toBeInstanceOf(URL);
  });

  test('allows a direct public IPv6 literal without sending its brackets to DNS', async () => {
    lookupMock.mockReset();
    const u = await assertPublicUrl('https://[2606:4700:4700::1111]/dns-query');
    expect(u.hostname).toBe('[2606:4700:4700::1111]');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('assertPublicUrl — DNS resolution path (mocked)', () => {
  beforeEach(() => lookupMock.mockReset());

  test('blocks a hostname resolving to a private IPv4', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertPublicUrl('http://internal.example.com/')).rejects.toThrow(/private 10\.0\.0\.5/);
  });

  test('blocks if ANY resolved address is private (rebind-style multi-record)', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(assertPublicUrl('http://rebind.example.com/')).rejects.toThrow(/blocked: .* private/);
  });

  test('blocks a hostname resolving to IPv6 loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);
    await expect(assertPublicUrl('http://v6.example.com/')).rejects.toThrow(/private ::1/);
  });

  test('allows a hostname resolving only to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const u = await assertPublicUrl('http://example.com/path');
    expect(u).toBeInstanceOf(URL);
  });

  test('fails closed when DNS returns no records', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(assertPublicUrl('http://nodns.example.com/')).rejects.toThrow(/no DNS records/);
  });

  test('fails closed when DNS lookup rejects or times out', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('http://broken.example.com/')).rejects.toThrow(/DNS lookup failed/);
  });
});

describe('safeFetch — redirect hop loop (mocked global fetch)', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); // public, every hostname resolves here
  });
  afterEach(() => { global.fetch = realFetch; });

  test('a 302 hop to a private literal is rejected before a second fetch happens', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse({ status: 302, location: 'http://169.254.169.254/latest/meta-data/', body: true }));
    global.fetch = fetchMock;
    await expect(safeFetch('http://public.example.com/')).rejects.toThrow(/blocked: private/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second hop must never be fetched
  });

  test('a redirect to credential-bearing URL is rejected without fetching or disclosing it', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse({
      status: 302,
      location: 'https://user:redirect-secret@other.example.net/private',
      body: true,
    }));
    global.fetch = fetchMock;
    const error = await safeFetch('http://public.example.com/').catch(err => err);
    expect(error.message).toBe('blocked: URL credentials are not allowed');
    expect(error.message).not.toContain('redirect-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a relative Location resolves against the current hop origin, not the original URL', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(fakeResponse({ status: 302, location: '/next', body: true }))
      .mockResolvedValueOnce(fakeResponse({ status: 200 }));
    global.fetch = fetchMock;
    await safeFetch('http://public.example.com/start');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('http://public.example.com/next');
  });

  test('a redirect status with no Location header returns that response as-is', async () => {
    const res = fakeResponse({ status: 302 }); // no location set
    const fetchMock = jest.fn().mockResolvedValue(res);
    global.fetch = fetchMock;
    const out = await safeFetch('http://public.example.com/');
    expect(out).toBe(res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('exhausting maxRedirects throws "too many redirects"', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse({ status: 302, location: 'http://public.example.com/loop', body: true }));
    global.fetch = fetchMock;
    await expect(safeFetch('http://public.example.com/', {}, { maxRedirects: 3 })).rejects.toThrow(/too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // hop 0..3 inclusive
  });

  test('each redirect hop cancels the prior hop\'s unread body', async () => {
    const firstBody = { cancel: jest.fn().mockResolvedValue(undefined) };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ status: 302, headers: { get: () => 'http://public.example.com/next' }, body: firstBody })
      .mockResolvedValueOnce(fakeResponse({ status: 200 }));
    global.fetch = fetchMock;
    await safeFetch('http://public.example.com/');
    expect(firstBody.cancel).toHaveBeenCalledTimes(1);
  });

  test('a non-redirect response is returned directly on the first hop', async () => {
    const res = fakeResponse({ status: 200 });
    const fetchMock = jest.fn().mockResolvedValue(res);
    global.fetch = fetchMock;
    const out = await safeFetch('http://public.example.com/');
    expect(out).toBe(res);
  });

  test('a 302 rewrites POST to GET and removes its body headers', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(fakeResponse({ status: 302, location: '/accepted', body: true }))
      .mockResolvedValueOnce(fakeResponse({ status: 200 }));
    global.fetch = fetchMock;

    await safeFetch('http://public.example.com/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'keep-me' },
      body: '{"alert":true}',
    });

    const second = fetchMock.mock.calls[1][1];
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    expect(second.headers.get('content-type')).toBeNull();
    expect(second.headers.get('x-trace')).toBe('keep-me');
  });

  test('a cross-origin redirect strips credentials including NVD apiKey', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(fakeResponse({ status: 307, location: 'https://other.example.net/next', body: true }))
      .mockResolvedValueOnce(fakeResponse({ status: 200 }));
    global.fetch = fetchMock;

    await safeFetch('https://public.example.com/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        apiKey: 'nvd-secret',
        'X-API-Key': 'other-secret',
        'X-Trace': 'keep-me',
      },
      body: 'payload',
    });

    const second = fetchMock.mock.calls[1][1];
    expect(second.method).toBe('POST'); // 307 preserves method + body
    expect(second.body).toBe('payload');
    expect(second.headers.get('authorization')).toBeNull();
    expect(second.headers.get('cookie')).toBeNull();
    expect(second.headers.get('apikey')).toBeNull();
    expect(second.headers.get('x-api-key')).toBeNull();
    expect(second.headers.get('x-trace')).toBe('keep-me');
  });

  test('a same-origin redirect retains credentials', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(fakeResponse({ status: 307, location: '/next', body: true }))
      .mockResolvedValueOnce(fakeResponse({ status: 200 }));
    global.fetch = fetchMock;

    await safeFetch('https://public.example.com/start', {
      headers: { apiKey: 'nvd-secret' },
    });

    expect(fetchMock.mock.calls[1][1].headers.get('apikey')).toBe('nvd-secret');
  });
});

describe('safeFetch - pinned dispatcher request body integration', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = realFetch;
  });

  afterEach(() => { global.fetch = realFetch; });

  test('writes the async-iterable body Node fetch gives the dispatcher', async () => {
    const received = [];
    const requestSpy = jest.spyOn(http, 'request').mockImplementation((_options, onResponse) => {
      const req = new Writable({
        write(chunk, _encoding, callback) {
          received.push(Buffer.from(chunk));
          callback();
        },
      });
      req.once('finish', () => {
        const res = Readable.from([Buffer.from('ok')]);
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'text/plain; charset=utf-8' };
        onResponse(res);
      });
      return req;
    });

    try {
      const payload = JSON.stringify({ source: 'blueteam', alert: true });
      const res = await safeFetch('http://public.example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      await expect(readCapped(res, 100)).resolves.toBe('ok');
      expect(Buffer.concat(received).toString('utf8')).toBe(payload);
    } finally {
      requestSpy.mockRestore();
    }
  });
});

describe('safeFetch - pinned dispatcher handler compatibility', () => {
  const realFetch = global.fetch;
  let requestSpy;

  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    requestSpy = jest.spyOn(http, 'request').mockImplementation((_options, onResponse) => {
      const req = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
      });
      req.once('finish', () => {
        const res = Readable.from([Buffer.from('first'), Buffer.from('second')]);
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'text/plain', 'x-test': 'handler-bridge' };
        res.rawHeaders = [
          'Content-Type', 'text/plain',
          'X-Test', 'handler-bridge',
        ];
        res.trailers = { 'x-trailer': 'done' };
        res.rawTrailers = ['X-Trailer', 'done'];
        onResponse(res);
      });
      return req;
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
    requestSpy.mockRestore();
  });

  async function captureDispatcher() {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse({ status: 200 }));
    global.fetch = fetchMock;
    await safeFetch('http://public.example.com/');
    return fetchMock.mock.calls[0][1].dispatcher;
  }

  test('supports legacy callbacks and honors their pause/resume return contract', async () => {
    const dispatcher = await captureDispatcher();
    const events = [];
    let resume;
    let dataCalls = 0;
    let headersResumed = false;
    let dataResumed = false;

    await new Promise((resolve, reject) => {
      expect(dispatcher.dispatch({
        origin: 'http://public.example.com',
        path: '/legacy',
        method: 'GET',
      }, {
        // Undici 7's legacy fetch handler exposes this controller-era method
        // even though its normal response callbacks still use the old family.
        onRequestUpgrade() {
          throw new Error('unexpected upgrade');
        },
        onConnect(abort) {
          events.push('connect');
          expect(abort).toEqual(expect.any(Function));
        },
        onHeaders(statusCode, rawHeaders, resumeResponse, statusMessage) {
          events.push('headers');
          expect(statusCode).toBe(200);
          expect(rawHeaders).toEqual([
            'Content-Type', 'text/plain',
            'X-Test', 'handler-bridge',
          ]);
          expect(statusMessage).toBe('OK');
          resume = resumeResponse;
          setImmediate(() => {
            headersResumed = true;
            resumeResponse();
          });
          return false;
        },
        onData(chunk) {
          dataCalls++;
          events.push(`data:${chunk}`);
          if (dataCalls === 1) {
            expect(headersResumed).toBe(true);
            setImmediate(() => {
              dataResumed = true;
              resume();
            });
            return false;
          }
          expect(dataResumed).toBe(true);
          return true;
        },
        onComplete(rawTrailers) {
          events.push('complete');
          expect(rawTrailers).toEqual(['X-Trailer', 'done']);
          resolve();
        },
        onError: reject,
      })).toBe(true);
    });

    expect(events).toEqual([
      'connect',
      'headers',
      'data:first',
      'data:second',
      'complete',
    ]);
  });

  test('does not fall back to legacy methods when optional controller callbacks are absent', async () => {
    const dispatcher = await captureDispatcher();
    let requestController;

    await new Promise((resolve, reject) => {
      dispatcher.dispatch({
        origin: 'http://public.example.com',
        path: '/controller-minimal',
        method: 'GET',
      }, {
        onRequestStart(controller) {
          requestController = controller;
        },
        onResponseEnd(controller) {
          expect(controller).toBe(requestController);
          resolve();
        },
        onResponseError(_controller, error) {
          reject(error);
        },
      });
    });
  });

  test('supports Node 26 controller callbacks with one stable controller', async () => {
    const dispatcher = await captureDispatcher();
    const events = [];
    let requestController;

    await new Promise((resolve, reject) => {
      expect(dispatcher.dispatch({
        origin: 'http://public.example.com',
        path: '/controller',
        method: 'GET',
      }, {
        onRequestStart(controller, context) {
          requestController = controller;
          events.push('request-start');
          expect(context).toEqual({});
          expect(controller.aborted).toBe(false);
          expect(controller.rawHeaders).toBeNull();
        },
        onResponseStarted() {
          events.push('response-started');
        },
        onResponseStart(controller, statusCode, headers, statusMessage) {
          events.push('response-start');
          expect(controller).toBe(requestController);
          expect(controller.rawHeaders).toEqual([
            'Content-Type', 'text/plain',
            'X-Test', 'handler-bridge',
          ]);
          expect(statusCode).toBe(200);
          expect(headers).toMatchObject({ 'x-test': 'handler-bridge' });
          expect(statusMessage).toBe('OK');
        },
        onResponseData(controller, chunk) {
          events.push(`response-data:${chunk}`);
          expect(controller).toBe(requestController);
        },
        onResponseEnd(controller, trailers) {
          events.push('response-end');
          expect(controller).toBe(requestController);
          expect(controller.rawTrailers).toEqual(['X-Trailer', 'done']);
          expect(trailers).toEqual({ 'x-trailer': 'done' });
          resolve();
        },
        onResponseError(_controller, error) {
          reject(error);
        },
      })).toBe(true);
    });

    expect(events).toEqual([
      'request-start',
      'response-started',
      'response-start',
      'response-data:first',
      'response-data:second',
      'response-end',
    ]);
  });
});

describe('readCapped — byte cap enforcement', () => {
  function streamOf(chunks) {
    let i = 0;
    return {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: jest.fn().mockResolvedValue(undefined),
      }),
    };
  }

  test('throws and cancels the reader once accumulated bytes exceed maxBytes', async () => {
    const chunk = Buffer.alloc(1000, 'x');
    const body = streamOf([chunk, chunk, chunk]); // 3000 bytes total
    const reader = body.getReader();
    const res = { headers: { get: () => null }, body: { getReader: () => reader } };
    await expect(readCapped(res, 1500)).rejects.toThrow(/response too large/);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  test('a body within the cap decodes normally', async () => {
    const chunk = Buffer.from('hello world');
    const res = { headers: { get: () => null }, body: streamOf([chunk]) };
    await expect(readCapped(res, 1_000_000)).resolves.toBe('hello world');
  });

  test('falls back to res.text() when there is no readable body', async () => {
    const res = { headers: { get: () => null }, body: null, text: async () => 'plain text body' };
    await expect(readCapped(res)).resolves.toBe('plain text body');
  });
});

describe('readCapped — charset resolution', () => {
  function streamOf(chunks) {
    let i = 0;
    return {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: jest.fn().mockResolvedValue(undefined),
      }),
    };
  }

  test('honors a Content-Type charset param over the UTF-8 default', async () => {
    // 'ü' in windows-1252 is the single byte 0xFC — decoding it as UTF-8
    // would produce a replacement character instead.
    const body = Buffer.concat([Buffer.from('Sicherheitsl', 'ascii'), Buffer.from([0xfc]), Buffer.from('cke', 'ascii')]);
    const res = { headers: { get: (k) => (k === 'content-type' ? 'text/xml; charset=windows-1252' : null) }, body: streamOf([body]) };
    await expect(readCapped(res, 1000)).resolves.toBe('Sicherheitslücke');
  });

  test('sniffs the XML prolog encoding when Content-Type has no charset', async () => {
    const body = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><title>Sicherheitsl'),
      Buffer.from([0xfc]),
      Buffer.from('cke</title>'),
    ]);
    const res = { headers: { get: () => 'text/xml' }, body: streamOf([body]) };
    const decoded = await readCapped(res, 1000);
    expect(decoded).toContain('Sicherheitslücke');
  });

  test('defaults to UTF-8 when neither Content-Type nor prolog declare a charset', async () => {
    const res = { headers: { get: () => 'application/json' }, body: streamOf([Buffer.from('{"a":1}')]) };
    await expect(readCapped(res, 1000)).resolves.toBe('{"a":1}');
  });

  test('an unsupported/garbled charset label fails soft to UTF-8 instead of throwing', async () => {
    const res = { headers: { get: () => 'text/xml; charset=not-a-real-charset' }, body: streamOf([Buffer.from('hello')]) };
    await expect(readCapped(res, 1000)).resolves.toBe('hello');
  });
});

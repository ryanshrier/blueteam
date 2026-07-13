import { describe, test, expect } from '@jest/globals';
import { localhostBaseUrl, normalizePublicBaseUrl, requestBaseUrl } from '../lib/public-url.js';

describe('public URL validation', () => {
  test('normalizes a configured HTTP(S) origin', () => {
    expect(normalizePublicBaseUrl('  HTTPS://BlueTeam.News:443/  ')).toBe('https://blueteam.news');
    expect(normalizePublicBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizePublicBaseUrl('')).toBeNull();
  });

  test.each([
    'javascript:alert(1)',
    'ftp://blueteam.news',
    'https://user:secret@blueteam.news',
    'https://blueteam.news/app',
    'https://blueteam.news?source=wrong',
    'https://blueteam.news#fragment',
    'not a url',
  ])('rejects a non-origin PUBLIC_BASE_URL: %s', (value) => {
    expect(() => normalizePublicBaseUrl(value)).toThrow(/PUBLIC_BASE_URL/);
  });

  test('uses a safe, bounded localhost fallback port', () => {
    expect(localhostBaseUrl(4317)).toBe('http://localhost:4317');
    expect(localhostBaseUrl('not-a-port')).toBe('http://localhost:3000');
    expect(localhostBaseUrl(70000)).toBe('http://localhost:3000');
  });
});

describe('requestBaseUrl', () => {
  const fakeRequest = ({ trustProxy = false, host = '127.0.0.1:3000', forwardedHost, forwardedProto } = {}) => ({
    app: { get: () => trustProxy },
    protocol: 'http',
    headers: {
      ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}),
      ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
    },
    get: (name) => name === 'host' ? host : undefined,
  });

  test('a configured canonical origin wins over request and forwarded hosts', () => {
    const req = fakeRequest({ trustProxy: true, host: 'request.example', forwardedHost: 'spoofed.example', forwardedProto: 'http' });
    expect(requestBaseUrl(req, 'https://blueteam.news')).toBe('https://blueteam.news');
  });

  test('unset configuration preserves trusted-proxy behavior', () => {
    const req = fakeRequest({ trustProxy: true, forwardedHost: 'intel.example.com', forwardedProto: 'https' });
    expect(requestBaseUrl(req)).toBe('https://intel.example.com');
  });

  test('an invalid request host falls back to localhost', () => {
    expect(requestBaseUrl(fakeRequest({ host: 'evil.example/path' }))).toBe('http://localhost:3000');
  });
});

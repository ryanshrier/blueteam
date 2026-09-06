import { describe, test, expect } from '@jest/globals';
import express from 'express';
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
  const fakeRequest = ({ trustProxy = false, peer = '127.0.0.1', host = '127.0.0.1:3000', forwardedHost, forwardedProto } = {}) => ({
    app: express().set('trust proxy', trustProxy),
    socket: { remoteAddress: peer },
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

  test.each(['10.0.0.0/8', 0, false])('ignores spoofed forwarded headers when policy %j does not trust this peer', trustProxy => {
    const req = fakeRequest({ trustProxy, peer: '192.0.2.10', forwardedHost: 'spoofed.example', forwardedProto: 'https' });
    expect(requestBaseUrl(req)).toBe('http://127.0.0.1:3000');
  });

  test.each(['10.0.0.0/8', 1, true])('accepts forwarded headers when policy %j trusts the immediate peer', trustProxy => {
    const req = fakeRequest({ trustProxy, peer: '10.1.2.3', forwardedHost: 'intel.example.com', forwardedProto: 'https' });
    expect(requestBaseUrl(req)).toBe('https://intel.example.com');
  });

  test('an invalid request host falls back to localhost', () => {
    expect(requestBaseUrl(fakeRequest({ host: 'evil.example/path' }))).toBe('http://localhost:3000');
  });
});

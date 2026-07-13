import { describe, test, expect } from '@jest/globals';
import { shouldCompressResponse } from '../lib/compression.js';

function mockReq(headers = {}) {
  return { headers, method: 'GET' };
}

function mockRes(contentType) {
  return {
    getHeader: (name) => (name === 'Content-Type' ? contentType : undefined),
  };
}

describe('shouldCompressResponse', () => {
  test('never compresses SSE responses (by content type)', () => {
    const req = mockReq({ 'accept-encoding': 'gzip' });
    const res = mockRes('text/event-stream');
    expect(shouldCompressResponse(req, res)).toBe(false);
  });

  test('never compresses when client asks for an event stream', () => {
    const req = mockReq({ accept: 'text/event-stream', 'accept-encoding': 'gzip' });
    const res = mockRes('application/json');
    expect(shouldCompressResponse(req, res)).toBe(false);
  });

  test('honors the x-no-compression escape hatch', () => {
    const req = mockReq({ 'x-no-compression': '1', 'accept-encoding': 'gzip' });
    const res = mockRes('application/json');
    expect(shouldCompressResponse(req, res)).toBe(false);
  });

  test('compresses normal JSON responses', () => {
    const req = mockReq({ 'accept-encoding': 'gzip' });
    const res = mockRes('application/json; charset=utf-8');
    expect(shouldCompressResponse(req, res)).toBe(true);
  });
});

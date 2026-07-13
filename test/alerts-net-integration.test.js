// Integration seam: alerts.js must be able to deliver its JSON body through
// net.js's SSRF-pinned dispatcher. Unit tests mock safeFetch and therefore cannot
// catch a dispatcher that drops the Request body's async iterable.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';

const lookupMock = jest.fn();
jest.unstable_mockModule('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));

const { initDB, closeDB, getMeta } = await import('../lib/db.js');
const { dispatchAlerts } = await import('../lib/alerts.js');

describe('alert delivery through the pinned network dispatcher', () => {
  beforeEach(() => {
    initDB(':memory:');
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => closeDB());

  test('POSTs a complete webhook body and records the delivered alert', async () => {
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
      await dispatchAlerts([
        {
          title: 'Critical VPN flaw exploited',
          source: 'Vendor PSIRT',
          horizon: 1,
          score: 92,
          alertMatched: true,
        },
      ], {
        analysisSettings: {
          webhook: {
            url: 'http://public.example.com/webhook',
            format: 'json',
            events: 'alerts',
          },
        },
      });

      const body = JSON.parse(Buffer.concat(received).toString('utf8'));
      expect(body.count).toBe(1);
      expect(body.items[0].title).toBe('Critical VPN flaw exploited');
      expect(JSON.parse(getMeta('alert_sent_keys'))).toHaveLength(1);
    } finally {
      requestSpy.mockRestore();
    }
  });
});

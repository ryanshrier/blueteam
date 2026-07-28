// Integration seam: alerts.js must deliver its JSON body through net.js's
// SSRF validation and supported Undici dispatcher without losing payload data.
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const lookupMock = jest.fn();
jest.unstable_mockModule('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));

const { initDB, closeDB, getMeta } = await import('../lib/db.js');
const { _setTransportFetchForTests, closeOutboundDispatchers } = await import('../lib/net.js');
const { dispatchAlerts } = await import('../lib/alerts.js');

describe('alert delivery through the pinned network dispatcher', () => {
  beforeEach(() => {
    initDB(':memory:');
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(async () => {
    _setTransportFetchForTests();
    await closeOutboundDispatchers();
    closeDB();
  });

  test('POSTs a complete webhook body and records the delivered alert', async () => {
    const responseBytes = [Buffer.from('ok')];
    let cursor = 0;
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'text/plain; charset=utf-8' },
      body: {
        getReader: () => ({
          read: async () => cursor < responseBytes.length
            ? { done: false, value: responseBytes[cursor++] }
            : { done: true, value: undefined },
          cancel: jest.fn(),
        }),
      },
    });
    _setTransportFetchForTests(fetchMock);

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

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.count).toBe(1);
    expect(body.items[0].title).toBe('Critical VPN flaw exploited');
    expect(fetchMock.mock.calls[0][1].dispatcher).toEqual(expect.objectContaining({
      dispatch: expect.any(Function),
    }));
    expect(JSON.parse(getMeta('alert_sent_keys'))).toHaveLength(1);
  });
});

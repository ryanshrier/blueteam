import { describe, expect, it, jest } from '@jest/globals';
import { createFixtureRequestGuard } from '../scripts/fixture-request-guard.mjs';

const origin = 'http://127.0.0.1:43210';
const invalidId = 'Fetch.continueRequest: Invalid InterceptionId.';

function fixture(message = invalidId) {
  const listeners = new Map();
  const errors = [];
  const connection = {
    on: (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    call: jest.fn(async method => {
      if (method.startsWith('Fetch.') && method !== 'Fetch.enable' && message) throw new Error(message);
    }),
  };
  const guard = createFixtureRequestGuard(connection, { origin, errors, cancellationTimeoutMs: 15 });
  const emit = (name, event) => listeners.get(name)?.(event);
  const pause = (url = `${origin}/fonts/inter.woff2`, networkId = 'network-1') => emit('Fetch.requestPaused', {
    requestId: 'fetch-1', networkId, request: { url },
  });
  const cancel = (requestId = 'network-1', canceled = true) => emit('Network.loadingFailed', { requestId, canceled });
  return { connection, guard, errors, pause, cancel, listeners };
}

describe('fixture request cancellation guard', () => {
  it('enables cancellation observation before intercepting fixture requests', async () => {
    const f = fixture();
    await f.guard.enable();
    expect(f.connection.call.mock.calls.map(([method]) => method)).toEqual(['Network.enable', 'Fetch.enable']);
    f.guard.dispose();
  });

  it('continues an ordinary local asset without requiring cancellation', async () => {
    const f = fixture(null);
    f.pause();
    await f.guard.settle();
    expect(f.errors).toEqual([]);
    expect(f.connection.call).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'fetch-1' });
    f.guard.dispose();
  });

  it.each(['before', 'after'])('accepts an invalid interception only with matching observed cancellation %s the error', async order => {
    const f = fixture();
    if (order === 'before') f.cancel();
    f.pause();
    if (order === 'after') {
      await new Promise(resolve => setTimeout(resolve, 1));
      f.cancel();
    }
    await f.guard.settle();
    expect(f.errors).toEqual([]);
    f.guard.dispose();
  });

  it.each(['missing', 'different request', 'not canceled', 'missing network id'])('retains invalid-interception failure when cancellation evidence is %s', async condition => {
    const f = fixture();
    if (condition === 'different request') f.cancel('other-network');
    if (condition === 'not canceled') f.cancel('network-1', false);
    if (condition === 'missing network id') f.cancel();
    f.pause(undefined, condition === 'missing network id' ? null : 'network-1');
    await f.guard.settle();
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toContain(invalidId);
    f.guard.dispose();
  });

  it('does not suppress other protocol failures even for a canceled local request', async () => {
    const f = fixture('Fetch.continueRequest: browser connection closed');
    f.cancel(); f.pause();
    await f.guard.settle();
    expect(f.errors[0]).toContain('browser connection closed');
    f.guard.dispose();
  });

  it.each([`${origin}/api/current`, `${origin}/api`, `${origin}/%61pi/current`, 'http://user@127.0.0.1:43210/font.woff2', 'https://publisher.invalid/advisory'])('blocks and reports forbidden destination %s even if canceled', async url => {
    const f = fixture(null);
    f.cancel(); f.pause(url);
    await f.guard.settle();
    expect(f.errors).toEqual([`Unexpected request: ${url}`]);
    expect(f.connection.call).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'fetch-1', errorReason: 'BlockedByClient' });
    f.guard.dispose();
  });

  it('keeps the rejection error for a canceled forbidden request', async () => {
    const f = fixture('Fetch.failRequest: Invalid InterceptionId.');
    f.cancel(); f.pause('https://publisher.invalid/advisory');
    await f.guard.settle();
    expect(f.errors).toHaveLength(2);
    expect(f.errors[1]).toContain('Fetch.failRequest: Invalid InterceptionId.');
    f.guard.dispose();
  });

  it('disposal settles pending cancellation checks as unconfirmed', async () => {
    const f = fixture();
    f.pause();
    await Promise.resolve();
    f.guard.dispose();
    await f.guard.settle();
    expect(f.errors).toHaveLength(1);
    expect(f.listeners.size).toBe(0);
  });
});

import { expect, test } from '@jest/globals';
import { createObservationCache } from '../lib/observation-cache.js';

test('new observations evict expired identities even when those identities are never read again', () => {
  let clock = 100;
  const cache = createObservationCache({ ttlMs: 20, now: () => clock });
  cache.set('old', { cachedAt: clock, data: 'old evidence' });
  clock = 115;
  expect(cache.get('old').cachedAt).toBe(100);
  clock = 120;
  cache.set('new', { cachedAt: clock, data: 'new evidence' });
  expect(cache.size).toBe(1);
  expect(cache.get('old')).toBeUndefined();
});

test('count and byte limits bound unique captures while preserving recently used observations', () => {
  const cache = createObservationCache({ ttlMs: 100, maxEntries: 2, maxBytes: 200, now: () => 10 });
  for (const key of ['one', 'two']) cache.set(key, { cachedAt: 10, data: key });
  expect(cache.get('one').data).toBe('one');
  cache.set('three', { cachedAt: 10, data: 'three' });
  expect(cache.size).toBe(2);
  expect(cache.get('two')).toBeUndefined();
  expect(cache.byteLength).toBeLessThanOrEqual(200);
  cache.set('oversized', { cachedAt: 10, data: 'x'.repeat(1000) });
  expect(cache.get('oversized')).toBeUndefined();
  expect(cache.get('one').data).toBe('one');
});

test('reads reject expired and impossible future clocks without extending their age', () => {
  let clock = 100;
  const cache = createObservationCache({ ttlMs: 10, now: () => clock });
  cache.set('future', { cachedAt: 101 });
  cache.set('current', { cachedAt: 100 });
  expect(cache.get('future')).toBeUndefined();
  clock = 110;
  expect(cache.get('current')).toBeUndefined();
  expect(cache.size).toBe(0);
  expect(cache.byteLength).toBe(0);
});

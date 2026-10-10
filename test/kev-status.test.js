import { describe, expect, test } from '@jest/globals';
import { captureKevCatalogStatus, kevCatalogIsFresh, KEV_MAX_AGE_HOURS } from '../lib/kev-status.js';
import { validationSourceFromManifest } from '../lib/brief-drafts.js';

const now = Date.parse('2026-10-09T12:00:00Z');
const captured = (hoursAgo, extra = {}) => captureKevCatalogStatus({ loaded: true,
  retrievedAt: new Date(now - hoursAgo * 3600_000).toISOString(), now, ...extra });

describe('captured KEV freshness', () => {
  test('the exact refresh-age boundary is stale and retained observations stay dated', () => {
    expect(captured(KEV_MAX_AGE_HOURS - 0.01).status).toBe('fresh');
    expect(captured(KEV_MAX_AGE_HOURS)).toMatchObject({ status: 'stale', retrievedAt: '2026-10-09T00:00:00.000Z', checkedAt: '2026-10-09T12:00:00.000Z' });
  });
  test('a failed refresh does not upgrade recently retained data', () => {
    expect(captured(1, { refreshFailed: true })).toMatchObject({ status: 'stale', refreshOutcome: 'failed' });
  });
  test.each([null, '', 'invalid', '2027-01-01T00:00:00Z'])('missing or impossible timestamp %s stays unknown', retrievedAt => {
    expect(captureKevCatalogStatus({ loaded: true, retrievedAt, now })).toMatchObject({ status: 'unknown', retrievedAt: null });
  });
  test('a timestamp without catalog data cannot verify membership', () => {
    const status = captured(1, { loaded: false });
    expect(status.status).toBe('unavailable');
    expect(kevCatalogIsFresh(status, false)).toBe(false);
  });
  test('revalidation preserves the saved freshness, membership and date rather than consulting a new clock', () => {
    const status = captured(1);
    const manifest = { grounding: { sources: [], cves: [], urls: [] },
      verification: { kevCatalogLoaded: true, kevCatalogStatus: status, selectedKevCves: ['CVE-2026-12345'] } };
    const source = validationSourceFromManifest(JSON.parse(JSON.stringify(manifest)));
    expect(source.kevCatalogStatus).toEqual(status);
    expect(kevCatalogIsFresh(source.kevCatalogStatus, source.kevCatalogLoaded)).toBe(true);
    expect([...source.kevSet]).toEqual(['CVE-2026-12345']);
    expect(validationSourceFromManifest({ ...manifest, verification: { ...manifest.verification, kevCatalogStatus: captured(24) } }).kevCatalogStatus.status).toBe('stale');
  });
  test('legacy immutable receipts preserve the contract they originally captured', () => {
    expect(kevCatalogIsFresh(undefined, true)).toBe(true);
    expect(kevCatalogIsFresh(undefined, false)).toBe(false);
  });
});

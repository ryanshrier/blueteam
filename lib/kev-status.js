// Snapshot freshness is separate from captured catalog membership. Replay
// uses the saved status, never the current time or a newly refreshed catalog.
export const KEV_MAX_AGE_HOURS = 12;

export function captureKevCatalogStatus({ loaded = false, retrievedAt = null, refreshFailed = false, now = Date.now() } = {}) {
  const observed = Date.parse(retrievedAt || '');
  const validTime = Number.isFinite(observed) && observed <= now + 60_000;
  const status = !loaded ? 'unavailable' : !validTime ? 'unknown'
    : refreshFailed || now - observed >= KEV_MAX_AGE_HOURS * 3600_000 ? 'stale' : 'fresh';
  return Object.freeze({ status, retrievedAt: validTime ? new Date(observed).toISOString() : null,
    checkedAt: new Date(now).toISOString(), refreshOutcome: refreshFailed ? 'failed' : 'not-reported-failed',
    maxAgeHours: KEV_MAX_AGE_HOURS });
}

export function kevCatalogIsFresh(status, loaded) {
  // Old immutable receipts did not capture freshness. Preserve their original
  // verification contract rather than silently substituting today's status.
  return Boolean(loaded && (status == null || status.status === 'fresh'));
}

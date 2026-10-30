// BlueTeam.News — process-local lifecycle tracking for paid Briefing work.
//
// An HTTP client can disconnect while the route intentionally keeps generating
// and publishes the finished artifact. Node's server.close() only tracks the
// socket, so shutdown must also wait for this explicit application-level work.

import { DEFAULT_GENERATION_TIMEOUT_SEC, MIN_GENERATION_TIMEOUT_SEC, MAX_GENERATION_TIMEOUT_SEC } from './generation-limits.js';

export const DEFAULT_SHUTDOWN_GUARD_MS = 30_000;
export const BRIEF_COLLECTION_TIMEOUT_MS = 3 * 60_000;
export const BRIEF_PUBLICATION_CLEANUP_MS = 3 * 60_000;

/** The scheduler must outlast collection, the shared model budget, and cleanup. */
export function briefRequestTimeoutMs(generationTimeoutSec = DEFAULT_GENERATION_TIMEOUT_SEC, {
  cleanupMs = BRIEF_PUBLICATION_CLEANUP_MS,
} = {}) {
  const requested = Number(generationTimeoutSec);
  const generationMs = Math.min(MAX_GENERATION_TIMEOUT_SEC, Math.max(MIN_GENERATION_TIMEOUT_SEC,
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_GENERATION_TIMEOUT_SEC)) * 1000;
  return generationMs + Math.min(generationMs, BRIEF_COLLECTION_TIMEOUT_MS)
    + Math.max(0, Number(cleanupMs) || 0);
}

export function createBriefGenerationTracker() {
  let activeCount = 0;
  const idleWaiters = new Set();

  const resolveIdle = () => {
    if (activeCount !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  return {
    begin() {
      activeCount += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        activeCount = Math.max(0, activeCount - 1);
        resolveIdle();
      };
    },

    get activeCount() {
      return activeCount;
    },

    waitForIdle() {
      if (activeCount === 0) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },
  };
}

/**
 * Keep the ordinary shutdown safeguard short, but when paid Briefing work is
 * active let the route consume its collection and largest generation budgets,
 * plus a bounded preflight/publication cleanup margin. The tracker normally lets
 * shutdown finish much sooner; this value is only the hard-stop ceiling.
 */
export function shutdownGuardMs({
  activeBriefings = 0,
  maxGenerationTimeoutSec = MAX_GENERATION_TIMEOUT_SEC,
  startupSmoke = false,
  cleanupMs = BRIEF_PUBLICATION_CLEANUP_MS,
} = {}) {
  if (startupSmoke || activeBriefings <= 0) return DEFAULT_SHUTDOWN_GUARD_MS;
  return briefRequestTimeoutMs(maxGenerationTimeoutSec, { cleanupMs });
}

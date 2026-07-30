// BlueTeam.News — process-local lifecycle tracking for paid Briefing work.
//
// An HTTP client can disconnect while the route intentionally keeps generating
// and publishes the finished artifact. Node's server.close() only tracks the
// socket, so shutdown must also wait for this explicit application-level work.

export const DEFAULT_SHUTDOWN_GUARD_MS = 30_000;
export const BRIEF_PUBLICATION_CLEANUP_MS = 3 * 60_000;

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
 * active let the route consume the largest configured generation budget plus a
 * bounded publication/index/webhook cleanup margin. The tracker normally lets
 * shutdown finish much sooner; this value is only the hard-stop ceiling.
 */
export function shutdownGuardMs({
  activeBriefings = 0,
  maxGenerationTimeoutSec = 600,
  startupSmoke = false,
  cleanupMs = BRIEF_PUBLICATION_CLEANUP_MS,
} = {}) {
  if (startupSmoke || activeBriefings <= 0) return DEFAULT_SHUTDOWN_GUARD_MS;
  const generationMs = Math.max(1, Number(maxGenerationTimeoutSec) || 1) * 1000;
  return generationMs + Math.max(0, Number(cleanupMs) || 0);
}

import { describe, expect, jest, test } from '@jest/globals';
import {
  BRIEF_PUBLICATION_CLEANUP_MS,
  DEFAULT_SHUTDOWN_GUARD_MS,
  createBriefGenerationTracker,
  shutdownGuardMs,
} from '../lib/brief-lifecycle.js';

describe('Briefing generation lifecycle', () => {
  test('waits for every active route even after its HTTP socket is gone', async () => {
    const tracker = createBriefGenerationTracker();
    const finishFirst = tracker.begin();
    const finishSecond = tracker.begin();
    const idle = jest.fn();
    tracker.waitForIdle().then(idle);

    finishFirst();
    finishFirst(); // completion callbacks are idempotent
    await Promise.resolve();
    expect(tracker.activeCount).toBe(1);
    expect(idle).not.toHaveBeenCalled();

    finishSecond();
    await tracker.waitForIdle();
    expect(tracker.activeCount).toBe(0);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  test('uses the supported generation maximum plus bounded cleanup only for active work', () => {
    expect(shutdownGuardMs({
      activeBriefings: 1,
      maxGenerationTimeoutSec: 600,
    })).toBe(600_000 + BRIEF_PUBLICATION_CLEANUP_MS);
    expect(shutdownGuardMs({
      activeBriefings: 0,
      maxGenerationTimeoutSec: 600,
    })).toBe(DEFAULT_SHUTDOWN_GUARD_MS);
    expect(shutdownGuardMs({
      activeBriefings: 1,
      maxGenerationTimeoutSec: 600,
      startupSmoke: true,
    })).toBe(DEFAULT_SHUTDOWN_GUARD_MS);
  });
});

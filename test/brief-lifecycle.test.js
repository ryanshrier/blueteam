import { describe, expect, jest, test } from '@jest/globals';
import {
  BRIEF_COLLECTION_TIMEOUT_MS,
  BRIEF_PUBLICATION_CLEANUP_MS,
  DEFAULT_SHUTDOWN_GUARD_MS,
  briefRequestTimeoutMs,
  createBriefGenerationTracker,
  shutdownGuardMs,
} from '../lib/brief-lifecycle.js';
import { DEFAULT_GENERATION_TIMEOUT_SEC, MAX_GENERATION_TIMEOUT_SEC } from '../lib/generation-limits.js';

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

  test.each([
    [120, 420_000],
    [300, 660_000],
    [1200, 1_560_000],
  ])('scheduler envelope for %ss includes separate collection and completion time', (seconds, expected) => {
    expect(briefRequestTimeoutMs(seconds)).toBe(expected);
  });

  test('scheduler envelope permits two full Bob calls without its former fifteen-minute cutoff', () => {
    const modelBudget = 1200;
    const completeWork = BRIEF_COLLECTION_TIMEOUT_MS + 580_000 + 40_000 + 580_000;
    expect(briefRequestTimeoutMs(modelBudget)).toBeGreaterThan(completeWork);
    expect(briefRequestTimeoutMs(modelBudget)).toBe(completeWork + BRIEF_PUBLICATION_CLEANUP_MS);
  });

  test('uses the shared default and supported maximum for bounded request envelopes', () => {
    expect(briefRequestTimeoutMs()).toBe(briefRequestTimeoutMs(DEFAULT_GENERATION_TIMEOUT_SEC));
    expect(briefRequestTimeoutMs(NaN)).toBe(briefRequestTimeoutMs(DEFAULT_GENERATION_TIMEOUT_SEC));
    expect(briefRequestTimeoutMs(MAX_GENERATION_TIMEOUT_SEC + 1)).toBe(briefRequestTimeoutMs(MAX_GENERATION_TIMEOUT_SEC));
  });

  test('uses collection, supported generation maximum and bounded cleanup only for active work', () => {
    expect(shutdownGuardMs({
      activeBriefings: 1,
      maxGenerationTimeoutSec: 600,
    })).toBe(600_000 + BRIEF_COLLECTION_TIMEOUT_MS + BRIEF_PUBLICATION_CLEANUP_MS);
    expect(shutdownGuardMs({ activeBriefings: 1 })).toBe(briefRequestTimeoutMs(MAX_GENERATION_TIMEOUT_SEC));
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

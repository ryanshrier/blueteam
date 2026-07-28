import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  _resetBriefScheduleForTests,
  dailyBriefDelay,
  getDailyBriefScheduleStatus,
  requestBriefGeneration,
  startDailyBriefSchedule,
  stopDailyBriefSchedule,
} from '../lib/brief-scheduler.js';

afterEach(() => _resetBriefScheduleForTests());

const ENABLED = {
  enabled: true,
  time: '05:00',
  timezone: 'local',
  missedRun: 'catch-up',
  retryMinutes: 15,
  maxAttempts: 3,
};

function stateHarness(initial = null) {
  let state = initial;
  return {
    getState: () => state,
    setState: next => { state = structuredClone(next); },
    get state() { return state; },
  };
}

describe('dailyBriefDelay', () => {
  test('waits until 05:00 when the server starts before the daily run', () => {
    const now = new Date(2026, 6, 12, 4, 30, 0, 0);
    expect(dailyBriefDelay(now, null)).toBe(30 * 60_000);
  });

  test('catches up shortly after boot when 05:00 was missed', () => {
    const now = new Date(2026, 6, 12, 8, 0, 0, 0);
    expect(dailyBriefDelay(now, '2026-07-11')).toBe(3_000);
  });

  test('a persisted success for today advances to tomorrow at 05:00', () => {
    const now = new Date(2026, 6, 12, 8, 0, 0, 0);
    expect(dailyBriefDelay(now, '2026-07-12')).toBe(21 * 60 * 60_000);
  });
});

describe('startDailyBriefSchedule', () => {
  test('is explicitly disabled by default and does not arm a timer', () => {
    const callbacks = [];
    const state = stateHarness();
    const generateBrief = jest.fn();
    const result = startDailyBriefSchedule({
      generateBrief,
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });
    expect(result.initialDelay).toBeNull();
    expect(callbacks).toHaveLength(0);
    expect(generateBrief).not.toHaveBeenCalled();
    expect(state.state.outcome).toBe('disabled');
    expect(getDailyBriefScheduleStatus().enabled).toBe(false);
  });

  test('schedules against an explicit IANA timezone rather than process-local time', () => {
    const callbacks = [];
    const state = stateHarness();
    startDailyBriefSchedule({
      generateBrief: jest.fn(),
      getScheduleConfig: () => ({
        ...ENABLED,
        time: '05:30',
        timezone: 'America/Chicago',
        missedRun: 'skip',
      }),
      now: () => new Date('2026-07-12T10:00:00.000Z'), // 05:00 CDT
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });
    expect(callbacks[0].ms).toBe(30 * 60_000);
  });

  test('the safe missed-run policy skips an initial past-due run', () => {
    const callbacks = [];
    const state = stateHarness({ lastSuccessDate: '2026-07-11' });
    const generateBrief = jest.fn();
    startDailyBriefSchedule({
      generateBrief,
      getScheduleConfig: () => ({ ...ENABLED, missedRun: 'skip' }),
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });
    expect(callbacks[0].ms).toBe(21 * 60 * 60_000);
    expect(state.state.outcome).toBe('skipped');
    expect(generateBrief).not.toHaveBeenCalled();
  });

  test('persists success and arms the next local-day run', async () => {
    const callbacks = [];
    const setTimeoutFn = jest.fn((fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; });
    const clearTimeoutFn = jest.fn();
    const generateBrief = jest.fn().mockResolvedValue({ filename: 'brief-2026-07-12-01.md' });
    const logger = { info: jest.fn(), error: jest.fn() };
    const state = stateHarness({ lastSuccessDate: '2026-07-11' });
    const setLegacyLastSuccessDate = jest.fn();

    startDailyBriefSchedule({
      generateBrief,
      getScheduleConfig: () => ENABLED,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => '2026-07-11',
      setLegacyLastSuccessDate,
      setTimeoutFn,
      clearTimeoutFn,
      logger,
    });

    expect(callbacks[0].ms).toBe(3_000);
    await callbacks[0].fn();
    expect(generateBrief).toHaveBeenCalledWith({
      jobKey: 'daily-brief:2026-07-12',
      editionDate: '2026-07-12',
      timezone: 'local',
    });
    expect(state.state.lastSuccessDate).toBe('2026-07-12');
    expect(state.state.outcome).toBe('success');
    expect(state.state.attempts).toBe(1);
    expect(setLegacyLastSuccessDate).toHaveBeenCalledWith('2026-07-12');
    expect(callbacks[1].ms).toBe(21 * 60 * 60_000);
    stopDailyBriefSchedule();
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  test('persists a failed attempt and retries on the configured cadence', async () => {
    const callbacks = [];
    const state = stateHarness({ lastSuccessDate: '2026-07-11' });
    const logger = { info: jest.fn(), error: jest.fn() };

    startDailyBriefSchedule({
      generateBrief: jest.fn().mockRejectedValue(new Error('upstream unavailable')),
      getScheduleConfig: () => ENABLED,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger,
    });

    await callbacks[0].fn();
    expect(state.state.outcome).toBe('failed');
    expect(state.state.attempts).toBe(1);
    expect(state.state.lastError).toBe('upstream unavailable');
    expect(callbacks[1].ms).toBe(15 * 60_000);
    expect(logger.error).toHaveBeenCalledWith('brief', expect.stringContaining('upstream unavailable'));
  });

  test('fails closed before provider spend when the attempt ledger cannot persist', async () => {
    const callbacks = [];
    const generateBrief = jest.fn();
    const logger = { info: jest.fn(), error: jest.fn() };
    const persisted = {
      scheduleDate: '2026-07-11',
      lastSuccessDate: '2026-07-11',
    };

    startDailyBriefSchedule({
      generateBrief,
      getScheduleConfig: () => ENABLED,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: () => persisted,
      setState: () => { throw new Error('database is read-only'); },
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger,
    });

    await callbacks[0].fn();
    expect(generateBrief).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(2);
    expect(callbacks[1].ms).toBe(15 * 60_000);
    expect(logger.error).toHaveBeenCalledWith(
      'brief',
      expect.stringContaining('attempt ledger could not be persisted'),
    );
  });

  test('stops retrying after the persistent maximum attempt count', async () => {
    const callbacks = [];
    const state = stateHarness({
      scheduleDate: '2026-07-12',
      attempts: 2,
      outcome: 'failed',
      nextAttemptAt: '2026-07-12T07:59:00.000Z',
      lastSuccessDate: '2026-07-11',
    });

    startDailyBriefSchedule({
      generateBrief: jest.fn().mockRejectedValue(new Error('still down')),
      getScheduleConfig: () => ENABLED,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });

    await callbacks[0].fn();
    expect(state.state.attempts).toBe(3);
    expect(state.state.outcome).toBe('attempt-limit');
    expect(callbacks[1].ms).toBe(21 * 60 * 60_000);
  });

  test('resumes a persisted failed attempt after restart even when initial missed runs are skipped', () => {
    const callbacks = [];
    const state = stateHarness({
      scheduleDate: '2026-07-12',
      attempts: 1,
      outcome: 'failed',
      nextAttemptAt: '2026-07-12T07:00:00.000Z',
      lastSuccessDate: '2026-07-11',
    });
    startDailyBriefSchedule({
      generateBrief: jest.fn(),
      getScheduleConfig: () => ({ ...ENABLED, missedRun: 'skip' }),
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });
    expect(callbacks[0].ms).toBe(3_000);
    expect(state.state.attempts).toBe(1);
    expect(state.state.outcome).toBe('retry-pending');
  });

  test('an enabled schedule without a key waits without spending an attempt', async () => {
    const callbacks = [];
    const state = stateHarness({ lastSuccessDate: '2026-07-11' });
    const generateBrief = jest.fn();

    startDailyBriefSchedule({
      generateBrief,
      getScheduleConfig: () => ENABLED,
      isReady: () => false,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });

    await callbacks[0].fn();
    expect(generateBrief).not.toHaveBeenCalled();
    expect(state.state.attempts).toBe(0);
    expect(state.state.outcome).toBe('waiting-for-key');
    expect(callbacks[1].ms).toBe(15 * 60_000);
  });

  test('stop during an in-flight generation prevents its completion from re-arming', async () => {
    const callbacks = [];
    const state = stateHarness({ lastSuccessDate: '2026-07-11' });
    let resolveBrief;
    const generation = new Promise(resolve => { resolveBrief = resolve; });

    startDailyBriefSchedule({
      generateBrief: () => generation,
      getScheduleConfig: () => ENABLED,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => null,
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });

    const run = callbacks[0].fn();
    stopDailyBriefSchedule();
    resolveBrief({ filename: 'brief-2026-07-12.md' });
    await run;
    expect(callbacks).toHaveLength(1);
  });

  test('a replacement scheduler reloads an old in-flight run success and does not duplicate it', async () => {
    const callbacks = [];
    const state = stateHarness({ lastSuccessDate: '2026-07-11' });
    let legacyDate = '2026-07-11';
    let resolveOldBrief;
    const oldGeneration = new Promise(resolve => { resolveOldBrief = resolve; });
    const newGenerateBrief = jest.fn();
    const common = {
      getScheduleConfig: () => ENABLED,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getState: state.getState,
      setState: state.setState,
      getLegacyLastSuccessDate: () => legacyDate,
      setLegacyLastSuccessDate: date => { legacyDate = date; },
      setTimeoutFn: (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; },
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    };

    startDailyBriefSchedule({ ...common, generateBrief: () => oldGeneration });
    const oldRun = callbacks[0].fn();
    expect(state.state.outcome).toBe('running');

    // Settings re-arm while the paid request is still running. The replacement
    // timer wakes once, sees the global in-flight lock, and schedules a retry.
    startDailyBriefSchedule({ ...common, generateBrief: newGenerateBrief });
    await callbacks[1].fn();
    expect(state.state.outcome).toBe('waiting-for-active-generation');

    // The old request then publishes successfully. The replacement scheduler's
    // closure still contains its earlier waiting state unless run() reloads DB.
    resolveOldBrief({ filename: 'brief-2026-07-12.md' });
    await oldRun;
    expect(state.state.lastSuccessDate).toBe('2026-07-12');

    await callbacks[2].fn();
    expect(newGenerateBrief).not.toHaveBeenCalled();
    expect(callbacks[3].ms).toBe(21 * 60 * 60_000);
  });
});

describe('requestBriefGeneration', () => {
  test('requires the explicit SSE completion event and returns its filename', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'data: {"progress":"Writing"}\n\ndata: {"briefComplete":true,"filename":"brief-2026-07-12-01.md"}\n\ndata: [DONE]\n\n',
    });
    const result = await requestBriefGeneration({ baseUrl: 'http://127.0.0.1:3000', apiSecret: 'secret', fetchImpl });
    expect(result.filename).toBe('brief-2026-07-12-01.md');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3000/api/brief', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      signal: expect.any(AbortSignal),
    }));
  });

  test('authenticates and serializes the immutable scheduled job context', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'data: {"briefComplete":true,"filename":"brief-2026-07-12-00.md"}\n\n',
    });
    const scheduledJob = {
      jobKey: 'daily-brief:2026-07-12',
      editionDate: '2026-07-12',
      timezone: 'America/Chicago',
    };
    await requestBriefGeneration({
      baseUrl: 'http://local',
      fetchImpl,
      scheduledJob,
      internalToken: 'internal-token',
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://local/api/brief', expect.objectContaining({
      headers: expect.objectContaining({
        'x-blueteam-scheduled-token': 'internal-token',
      }),
      body: JSON.stringify({ scheduledJob }),
    }));
  });

  test('surfaces streamed generation failures even when the SSE response is HTTP 200', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'data: {"error":"model unavailable"}\n\n',
    });
    await expect(requestBriefGeneration({ baseUrl: 'http://local', fetchImpl }))
      .rejects.toThrow('model unavailable');
  });

  test('bounds a fetch that never opens a response', async () => {
    const fetchImpl = jest.fn(() => new Promise(() => {}));
    await expect(requestBriefGeneration({ baseUrl: 'http://local', fetchImpl, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'E_SCHEDULE_TIMEOUT' });
  });
});

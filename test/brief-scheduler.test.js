import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  _resetBriefScheduleForTests,
  dailyBriefDelay,
  requestBriefGeneration,
  startDailyBriefSchedule,
  stopDailyBriefSchedule,
} from '../lib/brief-scheduler.js';

afterEach(() => _resetBriefScheduleForTests());

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
  test('persists success and arms the next local-day run', async () => {
    const callbacks = [];
    const setTimeoutFn = jest.fn((fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; });
    const clearTimeoutFn = jest.fn();
    const generateBrief = jest.fn().mockResolvedValue({ filename: 'brief-2026-07-12-01.md' });
    const logger = { info: jest.fn(), error: jest.fn() };
    let lastDate = '2026-07-11';

    startDailyBriefSchedule({
      generateBrief,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getLastSuccessDate: () => lastDate,
      setLastSuccessDate: value => { lastDate = value; },
      setTimeoutFn,
      clearTimeoutFn,
      logger,
    });

    expect(callbacks[0].ms).toBe(3_000);
    await callbacks[0].fn();
    expect(generateBrief).toHaveBeenCalledTimes(1);
    expect(lastDate).toBe('2026-07-12');
    expect(callbacks[1].ms).toBe(21 * 60 * 60_000);
    stopDailyBriefSchedule();
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  test('does not persist failure and retries in fifteen minutes', async () => {
    const callbacks = [];
    const setTimeoutFn = (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; };
    const logger = { info: jest.fn(), error: jest.fn() };
    const setLastSuccessDate = jest.fn();

    startDailyBriefSchedule({
      generateBrief: jest.fn().mockRejectedValue(new Error('upstream unavailable')),
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getLastSuccessDate: () => '2026-07-11',
      setLastSuccessDate,
      setTimeoutFn,
      clearTimeoutFn: () => {},
      logger,
    });

    await callbacks[0].fn();
    expect(setLastSuccessDate).not.toHaveBeenCalled();
    expect(callbacks[1].ms).toBe(15 * 60_000);
    expect(logger.error).toHaveBeenCalledWith('brief', expect.stringContaining('upstream unavailable'));
  });

  test('skips disabled AI without persisting success and rechecks for a runtime key', async () => {
    const callbacks = [];
    const setTimeoutFn = (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; };
    const logger = { info: jest.fn(), error: jest.fn() };
    const setLastSuccessDate = jest.fn();
    const generateBrief = jest.fn();

    startDailyBriefSchedule({
      generateBrief,
      isEnabled: () => false,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getLastSuccessDate: () => '2026-07-11',
      setLastSuccessDate,
      setTimeoutFn,
      clearTimeoutFn: () => {},
      logger,
    });

    expect(callbacks[0].ms).toBe(3_000);
    await callbacks[0].fn();
    expect(generateBrief).not.toHaveBeenCalled();
    expect(setLastSuccessDate).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('brief', expect.stringContaining('AI briefing is disabled'));
    expect(callbacks[1].ms).toBe(15 * 60_000);
  });

  test('stop during an in-flight generation prevents its completion from re-arming', async () => {
    const callbacks = [];
    const setTimeoutFn = (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; };
    let resolveBrief;
    const generation = new Promise(resolve => { resolveBrief = resolve; });

    startDailyBriefSchedule({
      generateBrief: () => generation,
      now: () => new Date(2026, 6, 12, 8, 0, 0, 0),
      getLastSuccessDate: () => '2026-07-11',
      setLastSuccessDate: () => {},
      setTimeoutFn,
      clearTimeoutFn: () => {},
      logger: { info: jest.fn(), error: jest.fn() },
    });

    const run = callbacks[0].fn();
    stopDailyBriefSchedule();
    resolveBrief({ filename: 'brief-2026-07-12.md' });
    await run;
    expect(callbacks).toHaveLength(1);
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
});

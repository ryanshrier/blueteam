// BlueTeam.News — unattended daily briefing schedule.
//
// The Wall is a kiosk surface, so its edition lifecycle belongs on the server:
// refresh the evidence and generate one new brief at 05:00 server-local time.
// Success is persisted in SQLite so a restart never spends twice for the same
// scheduled edition. A missed 05:00 run catches up after boot and failed runs
// retry without waiting for an operator.

import { getMeta, setMeta } from './db.js';
import { localDateISO } from './history.js';
import { log } from './logger.js';

export const DAILY_BRIEF_HOUR = 5;
export const DAILY_BRIEF_STATE_KEY = 'daily_brief_last_success_date';
export const DAILY_BRIEF_RETRY_MS = 15 * 60_000;
export const DAILY_BRIEF_CATCHUP_MS = 3_000;

let timer = null;
let clearTimer = clearTimeout;
let runningEpoch = null;
let scheduleActive = false;
let scheduleEpoch = 0;

/** Milliseconds until the next attempt, using the server's local calendar. */
export function dailyBriefDelay(now = new Date(), lastSuccessDate = null, {
  hour = DAILY_BRIEF_HOUR,
  catchupMs = DAILY_BRIEF_CATCHUP_MS,
} = {}) {
  const today = localDateISO(now);
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  if (lastSuccessDate === today) {
    target.setDate(target.getDate() + 1);
    return Math.max(0, target.getTime() - now.getTime());
  }
  if (now.getTime() < target.getTime()) {
    return target.getTime() - now.getTime();
  }
  return catchupMs;
}

/**
 * Consume the existing streaming generation endpoint and require its explicit
 * completion event. This keeps scheduled and manual briefs on one generation,
 * validation, persistence, indexing, and webhook path.
 */
export async function requestBriefGeneration({ baseUrl, apiSecret = '', fetchImpl = fetch }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiSecret) headers.Authorization = `Bearer ${apiSecret}`;

  const response = await fetchImpl(`${baseUrl}/api/brief`, {
    method: 'POST', headers, body: '{}',
  });
  const body = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = JSON.parse(body).error || message; } catch { /* keep status */ }
    throw new Error(`Scheduled briefing generation failed: ${message}`);
  }

  let completed = null;
  let streamedError = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6);
    if (!raw || raw === '[DONE]') continue;
    try {
      const event = JSON.parse(raw);
      if (event.error) streamedError = event.error;
      if (event.briefComplete) completed = event;
    } catch { /* ignore heartbeat/non-JSON fragments */ }
  }
  if (!completed) {
    throw new Error(`Scheduled briefing generation failed: ${streamedError || 'stream ended without a completion event'}`);
  }
  return completed;
}

export function startDailyBriefSchedule({
  generateBrief,
  isEnabled = () => true,
  hour = DAILY_BRIEF_HOUR,
  retryMs = DAILY_BRIEF_RETRY_MS,
  catchupMs = DAILY_BRIEF_CATCHUP_MS,
  now = () => new Date(),
  getLastSuccessDate = () => getMeta(DAILY_BRIEF_STATE_KEY),
  setLastSuccessDate = date => setMeta(DAILY_BRIEF_STATE_KEY, date),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = log,
} = {}) {
  if (typeof generateBrief !== 'function') throw new TypeError('generateBrief is required');
  stopDailyBriefSchedule();
  clearTimer = clearTimeoutFn;
  scheduleActive = true;
  const epoch = ++scheduleEpoch;
  const isCurrent = () => scheduleActive && scheduleEpoch === epoch;

  const arm = (delayMs) => {
    if (!isCurrent()) return;
    timer = setTimeoutFn(run, Math.max(0, delayMs));
  };

  const scheduleFromState = () => {
    const current = now();
    const lastDate = getLastSuccessDate() || null;
    const delay = dailyBriefDelay(current, lastDate, { hour, catchupMs });
    arm(delay);
    return delay;
  };

  async function run() {
    if (!isCurrent()) return;
    // A prior schedule generation may still be completing when a caller
    // restarts the scheduler. Do not overlap two paid briefing generations;
    // retry this generation after the normal retry interval instead.
    if (runningEpoch !== null) {
      arm(retryMs);
      return;
    }
    runningEpoch = epoch;
    timer = null;
    try {
      const current = now();
      const today = localDateISO(current);
      if (getLastSuccessDate() === today) {
        scheduleFromState();
        return;
      }
      if (!isEnabled()) {
        // Runtime settings can enable AI without a restart. Recheck on the
        // bounded retry cadence so adding a key at 05:05 still produces today's
        // missed edition instead of silently waiting until tomorrow.
        logger.info('brief', `Scheduled briefing skipped — AI briefing is disabled; rechecking in ${Math.round(retryMs / 60000)} min`);
        arm(retryMs);
        return;
      }
      logger.info('brief', `Scheduled ${String(hour).padStart(2, '0')}:00 briefing starting`);
      const result = await generateBrief();
      setLastSuccessDate(today);
      logger.info('brief', `Scheduled briefing complete${result?.filename ? ` — ${result.filename}` : ''}`);
      scheduleFromState();
    } catch (err) {
      logger.error('brief', `Scheduled briefing failed — retrying in ${Math.round(retryMs / 60000)} min: ${err.message}`);
      arm(retryMs);
    } finally {
      if (runningEpoch === epoch) runningEpoch = null;
    }
  }

  const initialDelay = scheduleFromState();
  logger.info('brief', `Daily briefing schedule armed for ${String(hour).padStart(2, '0')}:00 local time`);
  return { initialDelay };
}

export function stopDailyBriefSchedule() {
  scheduleActive = false;
  scheduleEpoch += 1;
  if (timer) {
    clearTimer(timer);
    timer = null;
  }
}

export function _resetBriefScheduleForTests() {
  stopDailyBriefSchedule();
  clearTimer = clearTimeout;
  runningEpoch = null;
}

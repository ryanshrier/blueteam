// BlueTeam.News — explicit, bounded unattended briefing schedule.
//
// The schedule is disabled unless the operator opts in through Settings.
// Schedule attempts and outcomes are persisted so restarts cannot reset retry
// limits or accidentally spend twice for one scheduled edition.

import { getMeta, setMeta } from './db.js';
import { localDateISO, scheduledBriefJobKey } from './history.js';
import { log } from './logger.js';
import { DEFAULT_BRIEF_SCHEDULE, getBriefScheduleSettings } from './user-settings.js';

export const DAILY_BRIEF_HOUR = 5;
export const DAILY_BRIEF_LEGACY_STATE_KEY = 'daily_brief_last_success_date';
export const DAILY_BRIEF_STATE_KEY = 'daily_brief_schedule_state';
export const DAILY_BRIEF_RETRY_MS = 15 * 60_000;
export const DAILY_BRIEF_CATCHUP_MS = 3_000;
export const SCHEDULED_BRIEF_TOKEN_HEADER = 'x-blueteam-scheduled-token';

let timer = null;
let clearTimer = clearTimeout;
let runningEpoch = null;
let scheduleActive = false;
let scheduleEpoch = 0;
let scheduleStatus = {
  enabled: false,
  outcome: 'disabled',
  attempts: 0,
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastSuccessDate: null,
  lastError: null,
  filename: null,
  jobKey: null,
};

function tomorrowDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function zonedParts(date, timezone) {
  if (timezone === 'local') {
    return {
      date: localDateISO(date),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = type => Number(parts.find(part => part.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour: value('hour'),
    minute: value('minute'),
  };
}

function scheduleInstant(dateKey, config) {
  const [targetHour, targetMinute] = config.time.split(':').map(Number);
  if (config.timezone === 'local') {
    const [year, month, day] = dateKey.split('-').map(Number);
    const target = new Date(year, month - 1, day, targetHour, targetMinute, 0, 0);
    // During a spring-forward transition, JavaScript advances a nonexistent
    // wall-clock time to the first valid instant, which is the least surprising
    // and avoids silently losing the day's scheduled run.
    return target;
  }

  // Find the matching wall-clock minute in the requested IANA zone. This
  // bounded search handles DST offsets without adding a date-time dependency.
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day) - 14 * 60 * 60_000;
  const end = start + 56 * 60 * 60_000;
  let firstValidAfter = null;
  for (let at = start; at <= end; at += 60_000) {
    const candidate = new Date(at);
    const parts = zonedParts(candidate, config.timezone);
    if (parts.date !== dateKey) continue;
    const minuteOfDay = parts.hour * 60 + parts.minute;
    const targetMinuteOfDay = targetHour * 60 + targetMinute;
    if (minuteOfDay === targetMinuteOfDay) return candidate;
    if (minuteOfDay > targetMinuteOfDay && firstValidAfter === null) {
      firstValidAfter = candidate;
    }
  }
  return firstValidAfter;
}

function parseState(raw, legacyLastSuccessDate = null) {
  let parsed = raw;
  if (typeof raw === 'string' && raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    scheduleDate: typeof source.scheduleDate === 'string' ? source.scheduleDate : null,
    attempts: Number.isInteger(source.attempts) && source.attempts >= 0 ? source.attempts : 0,
    outcome: typeof source.outcome === 'string' ? source.outcome : 'idle',
    nextAttemptAt: typeof source.nextAttemptAt === 'string' ? source.nextAttemptAt : null,
    lastAttemptAt: typeof source.lastAttemptAt === 'string' ? source.lastAttemptAt : null,
    lastSuccessAt: typeof source.lastSuccessAt === 'string' ? source.lastSuccessAt : null,
    lastSuccessDate: typeof source.lastSuccessDate === 'string'
      ? source.lastSuccessDate
      : (legacyLastSuccessDate || null),
    lastError: typeof source.lastError === 'string' ? source.lastError.slice(0, 300) : null,
    filename: typeof source.filename === 'string' ? source.filename : null,
    jobKey: typeof source.jobKey === 'string' ? source.jobKey : null,
  };
}

function publicStatus(config, state) {
  return {
    enabled: config.enabled,
    time: config.time,
    timezone: config.timezone,
    missedRun: config.missedRun,
    retryMinutes: config.retryMinutes,
    maxAttempts: config.maxAttempts,
    ...state,
  };
}

export function getDailyBriefScheduleStatus() {
  return { ...scheduleStatus };
}

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
  if (now.getTime() < target.getTime()) return target.getTime() - now.getTime();
  return catchupMs;
}

/**
 * Consume the existing streaming generation endpoint and require its explicit
 * completion event. The timeout covers connection setup and the whole SSE body.
 */
export async function requestBriefGeneration({
  baseUrl,
  apiSecret = '',
  fetchImpl = fetch,
  timeoutMs = 4 * 60_000,
  scheduledJob = null,
  internalToken = '',
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiSecret) headers.Authorization = `Bearer ${apiSecret}`;
  if (scheduledJob) {
    if (!internalToken) throw new TypeError('internalToken is required for a scheduled job');
    headers[SCHEDULED_BRIEF_TOKEN_HEADER] = internalToken;
  }
  const requestBody = scheduledJob ? JSON.stringify({ scheduledJob }) : '{}';

  const controller = new AbortController();
  let timeout;
  const timeoutError = new Error(`Scheduled briefing generation timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
  timeoutError.code = 'E_SCHEDULE_TIMEOUT';
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, Math.max(1, timeoutMs));
  });

  try {
    const response = await Promise.race([
      Promise.resolve(fetchImpl(`${baseUrl}/api/brief`, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      })),
      deadline,
    ]);
    const responseBody = await Promise.race([Promise.resolve(response.text()), deadline]);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = JSON.parse(responseBody).error || message; } catch { /* keep status */ }
      throw new Error(`Scheduled briefing generation failed: ${message}`);
    }

    let completed = null;
    let streamedError = null;
    for (const line of responseBody.split(/\r?\n/)) {
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
  } finally {
    clearTimeout(timeout);
  }
}

export function startDailyBriefSchedule({
  generateBrief,
  getScheduleConfig = () => DEFAULT_BRIEF_SCHEDULE,
  isReady = () => true,
  catchupMs = DAILY_BRIEF_CATCHUP_MS,
  now = () => new Date(),
  getState = () => getMeta(DAILY_BRIEF_STATE_KEY),
  setState = state => setMeta(DAILY_BRIEF_STATE_KEY, JSON.stringify(state)),
  getLegacyLastSuccessDate = () => getMeta(DAILY_BRIEF_LEGACY_STATE_KEY),
  setLegacyLastSuccessDate = date => setMeta(DAILY_BRIEF_LEGACY_STATE_KEY, date),
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
  const config = getBriefScheduleSettings({ briefSchedule: getScheduleConfig() });
  let state = parseState(getState(), getLegacyLastSuccessDate());

  const persist = (patch = {}, { required = false } = {}) => {
    const nextState = parseState({ ...state, ...patch }, state.lastSuccessDate);
    // A settings change can replace this schedule while an old paid request is
    // still finishing. Persist that attempt's result, but never let the stale
    // schedule repaint the live status of the newly armed/disabled schedule.
    try {
      setState(nextState);
    } catch (err) {
      logger.error('brief', `Persisting scheduled briefing status failed: ${err.message}`);
      if (required) {
        const ledgerError = new Error(`Scheduled briefing did not start because its attempt ledger could not be persisted: ${err.message}`);
        ledgerError.code = 'E_SCHEDULE_LEDGER';
        throw ledgerError;
      }
      return false;
    }
    state = nextState;
    if (isCurrent()) scheduleStatus = publicStatus(config, state);
    return true;
  };

  const armAt = (instant, patch = {}) => {
    if (!isCurrent() || !instant) return null;
    const delay = Math.max(0, instant.getTime() - now().getTime());
    persist({ ...patch, nextAttemptAt: instant.toISOString() });
    timer = setTimeoutFn(run, delay);
    return delay;
  };

  const armAfter = (delayMs, patch = {}) => {
    const instant = new Date(now().getTime() + Math.max(0, delayMs));
    return armAt(instant, patch);
  };

  const scheduleNext = () => {
    if (!isCurrent()) return null;
    const current = now();
    const today = zonedParts(current, config.timezone).date;
    const todayTarget = scheduleInstant(today, config);
    const attemptsToday = state.scheduleDate === today ? state.attempts : 0;

    if (state.lastSuccessDate === today || attemptsToday >= config.maxAttempts) {
      return armAt(scheduleInstant(tomorrowDateKey(today), config), {
        outcome: state.lastSuccessDate === today ? 'success' : 'attempt-limit',
      });
    }

    if (todayTarget && current.getTime() < todayTarget.getTime()) {
      return armAt(todayTarget, { outcome: 'scheduled' });
    }

    const resumableOutcome = ['failed', 'running', 'retry-pending', 'reconcile-pending', 'ledger-error', 'waiting-for-key', 'waiting-for-active-generation']
      .includes(state.outcome);
    if (state.scheduleDate === today && resumableOutcome) {
      const retryAt = new Date(state.nextAttemptAt || 0);
      if (Number.isFinite(retryAt.getTime()) && retryAt.getTime() > current.getTime()) return armAt(retryAt);
      // This is an already-started attempt chain, not an initial missed run.
      // Resume it after a restart even when the operator's initial missed-run
      // policy is "skip", while preserving the persisted attempt ceiling.
      return armAfter(catchupMs, { outcome: 'retry-pending' });
    }

    if (config.missedRun === 'catch-up') {
      return armAfter(catchupMs, { outcome: 'catch-up-pending' });
    }

    persist({
      scheduleDate: today,
      attempts: attemptsToday,
      outcome: 'skipped',
      nextAttemptAt: null,
      lastError: null,
    });
    return armAt(scheduleInstant(tomorrowDateKey(today), config));
  };

  async function run() {
    if (!isCurrent()) return;
    timer = null;
    // A settings save can replace the active scheduler while its prior
    // generation is still in flight. That old generation is allowed to finish
    // and persist success, so reload at every timer execution instead of
    // trusting this instance's start-time snapshot. Otherwise the replacement
    // scheduler can miss the success and generate a duplicate paid edition.
    try {
      state = parseState(getState(), getLegacyLastSuccessDate());
      scheduleStatus = publicStatus(config, state);
    } catch (err) {
      logger.error('brief', `Reloading scheduled briefing status failed; retaining last-known state: ${err.message}`);
    }
    if (runningEpoch !== null) {
      armAfter(config.retryMinutes * 60_000, { outcome: 'waiting-for-active-generation' });
      return;
    }

    const current = now();
    const today = zonedParts(current, config.timezone).date;
    const attempts = state.scheduleDate === today ? state.attempts : 0;
    const expectedJobKey = scheduledBriefJobKey(today);
    const jobKey = state.scheduleDate === today && state.jobKey === expectedJobKey
      ? state.jobKey
      : expectedJobKey;
    const scheduledJob = {
      jobKey,
      editionDate: today,
      timezone: config.timezone,
    };
    if (state.lastSuccessDate === today || attempts >= config.maxAttempts) {
      scheduleNext();
      return;
    }

    if (!isReady(scheduledJob)) {
      const retryMs = config.retryMinutes * 60_000;
      logger.info('brief', `Scheduled briefing is enabled but no AI key is available; rechecking in ${config.retryMinutes} min`);
      armAfter(retryMs, {
        scheduleDate: today,
        attempts,
        jobKey,
        outcome: 'waiting-for-key',
        lastError: 'No AI key is available.',
      });
      return;
    }

    const attempt = attempts + 1;
    try {
      // This write is the spend boundary. If SQLite cannot durably record the
      // attempt, do not call the provider under any circumstances.
      persist({
        scheduleDate: today,
        attempts: attempt,
        jobKey,
        outcome: 'running',
        nextAttemptAt: null,
        lastAttemptAt: current.toISOString(),
        lastError: null,
      }, { required: true });
    } catch (ledgerError) {
      const failure = String(ledgerError?.message || ledgerError).slice(0, 300);
      logger.error('brief', failure);
      armAfter(config.retryMinutes * 60_000, {
        scheduleDate: today,
        attempts,
        jobKey,
        outcome: 'ledger-error',
        lastError: failure,
      });
      return;
    }

    runningEpoch = epoch;
    try {
      logger.info('brief', `Scheduled ${config.time} briefing starting (attempt ${attempt}/${config.maxAttempts})`);
      const result = await generateBrief(scheduledJob);
      const completedAt = now();
      const successRecorded = persist({
        outcome: 'success',
        nextAttemptAt: null,
        lastSuccessAt: completedAt.toISOString(),
        lastSuccessDate: today,
        lastError: null,
        filename: result?.filename || null,
      });
      if (successRecorded) {
        try { setLegacyLastSuccessDate(today); } catch { /* v1 compatibility is best effort */ }
        scheduleNext();
      } else {
        logger.error('brief', `Scheduled briefing ${jobKey} was published but its scheduler success marker could not be persisted; the idempotent archive will be reconciled on retry`);
        armAfter(config.retryMinutes * 60_000, {
          outcome: 'reconcile-pending',
          lastError: 'Published archive is awaiting scheduler-state reconciliation.',
        });
      }
      logger.info('brief', `Scheduled briefing complete${result?.filename ? ` — ${result.filename}` : ''}`);
    } catch (err) {
      const failure = String(err?.message || err).slice(0, 300);
      if (attempt >= config.maxAttempts) {
        persist({ outcome: 'attempt-limit', nextAttemptAt: null, lastError: failure });
        logger.error('brief', `Scheduled briefing failed after ${attempt} attempts: ${failure}`);
        scheduleNext();
      } else {
        logger.error('brief', `Scheduled briefing failed — retrying in ${config.retryMinutes} min: ${failure}`);
        armAfter(config.retryMinutes * 60_000, {
          outcome: 'failed',
          lastError: failure,
        });
      }
    } finally {
      if (runningEpoch === epoch) runningEpoch = null;
    }
  }

  if (!config.enabled) {
    persist({ outcome: 'disabled', nextAttemptAt: null });
    logger.info('brief', 'Daily briefing schedule is disabled (explicit opt-in required)');
    return { initialDelay: null };
  }

  const initialDelay = scheduleNext();
  logger.info('brief', `Daily briefing schedule armed for ${config.time} (${config.timezone})`);
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
  scheduleStatus = {
    enabled: false,
    outcome: 'disabled',
    attempts: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSuccessDate: null,
    lastError: null,
    filename: null,
    jobKey: null,
  };
}

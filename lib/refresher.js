// BlueTeam.News — background pipeline refresher.
// Keeps the landscape current without any user action: runs the intelligence
// pipeline on an interval, archives results, and serves the latest run from
// memory. The wall and wire poll this; the briefing route reuses fresh runs.

import { runIntelligencePipeline } from './feeds.js';
import { archiveHeadlines, pruneHeadlineArchive, pruneFeedHealth, getMeta, setMeta } from './db.js';
import { dispatchAlerts } from './alerts.js';
import { getConfig } from './config.js';
import { log } from './logger.js';

let latestRun = null;        // { headlines, stats, generatedAt, generatedAtMs }
let refreshInFlight = null;  // Promise — dedupes concurrent refresh requests
let timer = null;
let startupTimer = null;
let scheduleActive = false;
let scheduleEpoch = 0;

// The run is otherwise memory-only, so a restart blanked every surface until the
// first new refresh landed (or forever, if the feeds were unreachable) — the
// system lying about being empty. We snapshot the latest run to the meta kv table
// and rehydrate it on boot, so the Wall/Wire/Briefing show real, honestly-aged
// intelligence the instant the server comes up. (A single 'primary' board today;
// the key is the seam for per-board snapshots later.)
const RUN_STATE_KEY = 'latest_run';

function persistLatestRun(run) {
  try {
    setMeta(RUN_STATE_KEY, JSON.stringify(run));
  } catch (err) {
    log.warn('refresher', `Persisting latest run failed (non-blocking): ${err.message}`);
  }
}

/**
 * Restore the last-good run from disk on boot, if memory is empty. The snapshot
 * keeps its original generatedAt/generatedAtMs, so the masthead reads STALE /
 * "UPDATED Xh ago" truthfully and the staleness decay engages — far more honest
 * than a blank board. The scheduled startup refresh still runs and replaces it.
 */
export function rehydrateLatestRun() {
  if (latestRun) return;
  try {
    const raw = getMeta(RUN_STATE_KEY);
    if (!raw) return;
    const run = JSON.parse(raw);
    if (run && Array.isArray(run.headlines) && Number.isFinite(run.generatedAtMs)) {
      latestRun = run;
      log.info('refresher', `Rehydrated last-good run from ${run.generatedAt} (${run.headlines.length} headlines)`);
    }
  } catch (err) {
    log.warn('refresher', `Rehydrating latest run failed: ${err.message}`);
  }
}

export function getLatestRun() {
  return latestRun;
}

/** Age of the latest run in milliseconds (Infinity when never run). */
export function getRunAgeMs() {
  return latestRun ? Date.now() - latestRun.generatedAtMs : Infinity;
}

/**
 * Run the pipeline now (deduped — concurrent callers share one run).
 * Returns the completed run.
 */
export async function refreshNow(reason = 'manual') {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const config = getConfig();
    log.info('refresher', `Pipeline refresh starting (${reason})`);
    try {
      const result = await runIntelligencePipeline(config);

      // A total feed outage must never erase a healthy last-good intelligence
      // snapshot. Feed health still records the failed attempt, while the Wire,
      // Wall, and next briefing retain their last defensible evidence set until
      // a later refresh returns usable headlines.
      if (latestRun?.headlines?.length && (!Array.isArray(result?.headlines) || result.headlines.length === 0)) {
        log.warn('refresher', `Discarding empty ${reason} refresh; retaining last-good run with ${latestRun.headlines.length} headlines`);
        return latestRun;
      }

      latestRun = {
        ...result,
        generatedAt: new Date().toISOString(),
        generatedAtMs: Date.now(),
      };

      try {
        archiveHeadlines(result.headlines);
        pruneHeadlineArchive(config.analysisSettings?.headlineArchiveDays ?? 14);
        pruneFeedHealth(7);
      } catch (err) {
        log.warn('refresher', `Archive write failed (non-blocking): ${err.message}`);
      }

      // Snapshot the fresh run so a restart rehydrates it instead of blanking.
      persistLatestRun(latestRun);

      // #18 — fire configured webhook for alert-matched items. Best-effort and
      // self-contained (never throws); disabled unless a webhook url is set.
      // Not awaited — alert delivery must never delay serving the fresh run.
      dispatchAlerts(result.headlines, config).catch(err =>
        log.warn('refresher', `Alert dispatch failed (non-blocking): ${err.message}`));

      return latestRun;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Return a run no older than maxAgeMs, refreshing first if needed.
 */
export async function getFreshRun(maxAgeMs = 5 * 60_000) {
  if (latestRun && getRunAgeMs() <= maxAgeMs) return latestRun;
  return refreshNow('stale-on-demand');
}

// Re-read the configured interval each tick and re-arm a fresh setTimeout,
// rather than a fixed setInterval — so a refreshMinutes change via config.json
// hot-reload (lib/config.js) takes effect on the NEXT tick instead of being
// silently ignored until restart. configVersion bumping is otherwise a lie:
// the cadence would keep its boot-time value forever. See finding #20.
function scheduleNextTick(epoch) {
  if (!scheduleActive || epoch !== scheduleEpoch) return;
  const config = getConfig();
  const intervalMs = (config.analysisSettings?.refreshMinutes ?? 10) * 60_000;
  timer = setTimeout(() => {
    timer = null;
    refreshNow('scheduled')
      .catch(err => log.error('refresher', `Scheduled refresh failed: ${err.message}`))
      // A refresh may still be in flight when shutdown stops the schedule. Keep
      // the epoch check here so its finally-handler cannot resurrect the timer.
      .finally(() => scheduleNextTick(epoch));
  }, intervalMs);
}

export function startRefreshSchedule() {
  // Idempotent across test harnesses and process lifecycle wrappers: clear any
  // prior startup/interval timer before arming a fresh schedule generation.
  stopRefreshSchedule();
  scheduleActive = true;
  const epoch = ++scheduleEpoch;
  const config = getConfig();
  const intervalMs = (config.analysisSettings?.refreshMinutes ?? 10) * 60_000;

  // Show the last-good run immediately (before the first new refresh, and even if
  // the feeds are unreachable) rather than a blank board.
  rehydrateLatestRun();

  // First run shortly after boot — lets the server come up fast.
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!scheduleActive || epoch !== scheduleEpoch) return;
    refreshNow('startup').catch(err => log.error('refresher', `Startup refresh failed: ${err.message}`));
  }, 3000);

  scheduleNextTick(epoch);

  log.info('refresher', `Refresh schedule started (every ${Math.round(intervalMs / 60000)} min)`);
}

export function stopRefreshSchedule() {
  scheduleActive = false;
  scheduleEpoch += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

/** Test-only: reset in-memory run state between test cases (module state is
 *  otherwise process-lifetime, so tests would bleed into each other). */
export function _resetForTests() {
  latestRun = null;
  refreshInFlight = null;
}

// BlueTeam.News — health endpoint.

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { getConfig, getConfigVersion, getLastReloadError } from './config.js';
import { FRESH_FEED_STATUSES, REACHABLE_FEED_STATUSES, getFeedHealth } from './feeds.js';
import { getDomainPack } from './domain.js';
import { getLatestRun, getRunAgeMs } from './refresher.js';
import { getKEVAge } from './db.js';

// "Reachable" = fetched fine, even if quiet (empty) or served from cache on
// a transient failure (stale). A burst publisher with nothing new this hour
// is healthy, not down — only http-*/parse-error/failed/circuit-open/rate-
// limited are genuine outages. `fresh` is the narrower "had new items" count.
//
// The prose status strings are owned by lib/feeds.js and exported there so the
// producer and /api/health consumer cannot silently drift. test/health.test.js
// still drives the health counts through the same strings as a contract check.
const REACHABLE = new Set(REACHABLE_FEED_STATUSES);
const FRESH = new Set(FRESH_FEED_STATUSES);

function getDatabaseStats(dataDir) {
  try {
    const dbPath = join(dataDir, 'watchfloor.db');
    if (!existsSync(dbPath)) return { size_mb: 0, status: 'missing' };
    const sizeMB = Math.round(statSync(dbPath).size / 1024 / 1024 * 10) / 10;
    const status = sizeMB > 500 ? 'warning' : sizeMB > 100 ? 'growing' : 'ok';
    return { size_mb: sizeMB, status };
  } catch {
    return { size_mb: 0, status: 'error' };
  }
}

// Count of feeds the PIPELINE actually reads, mirroring feeds.js's own
// resolution (runIntelligencePipeline: `getDomainPack().feeds?.sources` when
// the active pack declares them, else config.trustedFeeds). Duplicated here
// rather than imported because feeds.js doesn't export a getActiveFeeds()
// helper; if feeds.js's resolution order ever changes, this must change with it.
function countActiveFeeds(config) {
  const packFeeds = getDomainPack().feeds?.sources;
  return (packFeeds?.length ? packFeeds : config.trustedFeeds || []).length;
}

export function healthHandler({ bootTime, version, dataDir, getAiStatus, loopback = true }) {
  return (req, res) => {
    const uptimeMs = Date.now() - bootTime;
    const config = getConfig();
    const fh = getFeedHealth();
    const feedStatus = fh.feeds || {};
    const okFeeds = Object.values(feedStatus).filter(v => REACHABLE.has(v)).length;
    const freshFeeds = Object.values(feedStatus).filter(v => FRESH.has(v)).length;
    const totalFeeds = Object.keys(feedStatus).length;

    const run = getLatestRun();
    const runAge = getRunAgeMs();
    const refreshMinutes = config.analysisSettings?.refreshMinutes ?? 10;
    const reloadError = getLastReloadError();

    // Degraded when the data an operator/monitor actually cares about is
    // stale or broken — computed from figures already gathered above, not a
    // separate probe. Previously `status` was hardcoded 'ok'
    // regardless of pipeline age, feed outage rate, or DB health, so a wedged
    // refresh loop or a broken database reported healthy forever.
    const dbStats = getDatabaseStats(dataDir);
    const runAgeMinutes = Number.isFinite(runAge) ? runAge / 60_000 : Infinity;
    const staleRun = runAgeMinutes > refreshMinutes * 3;
    const feedsOutage = totalFeeds > 0 && okFeeds < totalFeeds * 0.5;
    const dbBroken = dbStats.status === 'missing' || dbStats.status === 'error';
    const degraded = staleRun || feedsOutage || dbBroken;
    const status = degraded ? 'degraded' : 'ok';

    // Untrusted (non-loopback, unauthenticated) callers get a minimal payload:
    // version disclosure aids targeting known-vuln releases, the feed list
    // reveals the operator's intel sources, and memory/DB size aids resource-
    // exhaustion timing. /api/health is exempt from both auth and rate
    // limiting (it's the container/uptime-probe endpoint), so this is the
    // only gate.
    const trusted = loopback || res.locals.authenticated === true;
    if (!trusted) {
      res.status(degraded ? 503 : 200).json({ status });
      return;
    }

    res.status(degraded ? 503 : 200).json({
      status,
      version,
      uptime: Math.floor(uptimeMs / 1000),
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      configVersion: getConfigVersion(),
      configReloadError: reloadError, // last rejected hot-reload, or null
      ai: (() => {
        const s = typeof getAiStatus === 'function' ? getAiStatus() : null;
        if (s) return { enabled: s.enabled, source: s.source, rotated: Boolean(s.rotated) };
        return process.env.ANTHROPIC_API_KEY ? 'configured' : 'disabled';
      })(),
      pipeline: {
        lastRun: run?.generatedAt || null,
        ageSeconds: Number.isFinite(runAge) ? Math.floor(runAge / 1000) : null,
        headlines: run?.headlines?.length ?? 0,
        stale: staleRun,
      },
      feeds: { ok: okFeeds, fresh: freshFeeds, total: totalFeeds, configured: countActiveFeeds(config), health: feedStatus },
      search: fh.search || {},
      kev: { ageHours: (() => { const h = getKEVAge(); return Number.isFinite(h) ? Math.round(h * 10) / 10 : null; })() },
      database: dbStats,
      memory: {
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    });
  };
}

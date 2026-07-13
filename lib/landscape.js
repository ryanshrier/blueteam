// BlueTeam.News — landscape state computation.
// Builds the payload that powers the wall display and the wire view:
// top signals, KEV activity, actor leaderboard, region activity, MITRE
// heatmap, vendor exposure, and convergence clusters.

import { matchActors, matchVendors } from './enrichment.js';
import { buildMitreHeatmap } from './mitre.js';
import { getConfig } from './config.js';
import { getEffectiveOrganization } from './user-settings.js';
import { getDomainPack } from './domain.js';
import {
  getRecentKEV, countKEVAddedSince, countKEVAddedToday, getArchivedHeadlines,
  getKEVDeadlines, countKEVOverdue, countKEVDueSoon, getKEVDueDates, titleKey,
} from './db.js';
import { getFeedHealth } from './feeds.js';

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** UI-warning threshold: two missed refresh windows, with a 20-minute floor. */
export function pipelineStaleAfterMs(refreshMinutes = 10) {
  const cadence = Number(refreshMinutes);
  const safeCadence = Number.isFinite(cadence) && cadence > 0 ? cadence : 10;
  return Math.max(20, safeCadence * 2) * 60_000;
}

/** Actor leaderboard from headlines (current run + recent archive). */
export function buildActorLeaderboard(headlines, archived = [], limit = 8) {
  const counts = new Map();

  const scan = (title, description = '') => {
    for (const actor of matchActors(title, description)) {
      const entry = counts.get(actor.name) || { name: actor.name, region: actor.region, mentions: 0 };
      entry.mentions++;
      counts.set(actor.name, entry);
    }
  };

  // refreshNow() archives the current run's headlines before serving it (lib/
  // refresher.js), so every current headline also exists in getArchivedHeadlines().
  // Scanning both unconditionally double-counted every current-run mention. Skip
  // archived rows already present in the current run — archived then only
  // contributes stories NOT in this run (i.e. genuinely older mentions).
  const currentKeys = new Set(headlines.map(h => titleKey(h.title)));

  for (const h of headlines) scan(h.title, h.description || '');
  for (const a of archived) {
    if (currentKeys.has(titleKey(a.title))) continue;
    scan(a.title);
  }

  return [...counts.values()]
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);
}

/** Activity grouped by attributed region of origin. */
export function buildRegionActivity(actorLeaderboard) {
  const regionNames = getDomainPack().entities?.regions || {};   // active edition's region labels
  const regions = new Map();
  for (const actor of actorLeaderboard) {
    const entry = regions.get(actor.region) || {
      code: actor.region,
      name: regionNames[actor.region] || actor.region,
      mentions: 0,
    };
    entry.mentions += actor.mentions;
    regions.set(actor.region, entry);
  }
  return [...regions.values()].sort((a, b) => b.mentions - a.mentions);
}

/** Enterprise vendor mentions across current headlines. */
export function buildVendorExposure(headlines, limit = 8) {
  const counts = new Map();
  for (const h of headlines) {
    const text = `${h.title} ${h.description || ''}`;
    const tagged = h.vendors || matchVendors(text);
    for (const vendor of tagged) {
      const entry = counts.get(vendor) || { name: vendor, mentions: 0, critical: 0, kev: 0 };
      entry.mentions++;
      if (h.urgency === 'critical') entry.critical++;
      if (h.isKEV) entry.kev++;
      counts.set(vendor, entry);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.mentions - a.mentions || b.critical - a.critical)
    .slice(0, limit);
}

/**
 * Multi-source convergence clusters — signals sharing actors, vendors, or CVEs
 * with a distinct-publisher count ≥ 2. These are the stories analysts should
 * triage first.
 */
export function buildConvergenceClusters(headlines, limit = 5) {
  const clusters = new Map();
  // CVE identifiers are a cyber/KEV concept — cluster them only when the active
  // pack actually surfaces that panel, same gate buildLandscape uses below, so a
  // non-cyber edition can't produce a stray 'cve'-typed cluster from an incidental
  // string match.
  const trackCves = getDomainPack().panels.includes('kev');

  const addToCluster = (key, label, type, headline) => {
    const id = `${type}:${key}`;
    const cluster = clusters.get(id) || {
      id,
      label,
      type,
      count: 0,
      sources: new Set(),
      publishers: new Set(),   // publisher identities — dedup feed copies, not proof of independence
      topTitle: headline.title,
      topScore: headline.score || 0,
      horizon: headline.horizon || 2,
      urgency: headline.urgency || 'routine',
      isKEV: Boolean(headline.isKEV),
    };
    cluster.count++;
    cluster.sources.add(headline.source);
    // Count distinct publisher identities for the cross-source read (matching the
    // gate); fall back to the feed label for headlines that predate publisher tagging
    // (e.g. reloaded from the archive).
    if (Array.isArray(headline.publishers) && headline.publishers.length) {
      for (const pk of headline.publishers) cluster.publishers.add(pk);
    } else if (headline.source) {
      cluster.publishers.add(headline.source);
    }
    if ((headline.score || 0) > cluster.topScore) {
      cluster.topScore = headline.score || 0;
      cluster.topTitle = headline.title;
      cluster.horizon = headline.horizon || 2;
      cluster.urgency = headline.urgency || 'routine';
      cluster.isKEV = Boolean(headline.isKEV);
    }
    clusters.set(id, cluster);
  };

  for (const h of headlines) {
    if ((h.corroboration || 1) < 2) continue;
    for (const a of h.actors || []) addToCluster(a.name, a.name, 'actor', h);
    for (const v of h.vendors || []) addToCluster(v, v, 'vendor', h);
    if (trackCves) {
      const cveMatch = `${h.title} ${h.description || ''}`.match(/CVE-\d{4}-\d{4,7}/i);
      if (cveMatch) addToCluster(cveMatch[0].toUpperCase(), cveMatch[0].toUpperCase(), 'cve', h);
    }
  }

  return [...clusters.values()]
    .map(c => ({
      id: c.id,
      label: c.label,
      type: c.type,
      count: c.count,
      sourceCount: c.publishers.size || c.sources.size,   // distinct publisher identities
      topTitle: c.topTitle,
      horizon: c.horizon,
      urgency: c.urgency,
      isKEV: c.isKEV,
    }))
    .filter(c => c.sourceCount >= 2 || c.count >= 2)
    .sort((a, b) => b.sourceCount - a.sourceCount || b.count - a.count)
    .slice(0, limit);
}

/** Match headlines against org-configured watch topics. */
export function buildWatchTopicHits(headlines, watchTopics = [], limit = 6) {
  if (!watchTopics.length) return [];
  const hits = [];
  for (const topic of watchTopics) {
    const pattern = new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let count = 0;
    let topTitle = null;
    let topScore = 0;
    for (const h of headlines) {
      const text = `${h.title} ${h.description || ''}`;
      if (pattern.test(text)) {
        count++;
        if ((h.score || 0) > topScore) {
          topScore = h.score || 0;
          topTitle = h.title;
        }
      }
    }
    if (count > 0) hits.push({ topic, count, topTitle });
  }
  return hits.sort((a, b) => b.count - a.count).slice(0, limit);
}

function compactHeadline(h, kevDueDates = {}) {
  const kevCVE = h.kevCVE || h.kev_cve || null;
  const due = (kevCVE && kevDueDates[kevCVE]) || null;
  return {
    title: h.title,
    source: h.source,
    link: h.link || null,
    horizon: h.horizon || 2,
    score: Math.round((h.score || 0) * 10) / 10,
    urgency: h.urgency || 'routine',
    isKEV: Boolean(h.isKEV || h.is_kev),
    kevCVE,
    kevDueDate: due ? due.due_date : null,
    kevOverdue: due ? Boolean(due.overdue) : false,
    corroboration: h.corroboration || 1,
    sources: h.sources && h.sources.length ? [...new Set(h.sources)] : (h.source ? [h.source] : []),
    date: h.date || h.published_at || null,
    dateUnknown: Boolean(h.dateUnknown),
    description: (h.description || '').slice(0, 240),
    cveData: h.cveData || null,
    actors: h.actors || null,
    vendors: h.vendors || null,
    mitre: h.mitre || null,
    epss: Number.isFinite(h.epss) ? h.epss : null,
    scoreRationale: h.scoreRationale || null,
  };
}

/**
 * Build the full landscape payload from the latest pipeline run.
 * `run` is { headlines, stats, generatedAt } from the refresher.
 * `latestBrief` is { filename, date, bluf, judgments } or null.
 */
export function buildLandscape(run, latestBrief = null, { runAgeMs = null } = {}) {
  const headlines = run?.headlines || [];
  const config = getConfig();
  const effectiveOrg = getEffectiveOrganization(config);
  // Which edition-specific panels this edition surfaces. The
  // universal panels below always build; these gate the cyber-flavoured ones so a
  // non-cyber edition shows none rather than empty cyber boxes.
  const panels = new Set(getDomainPack().panels || []);

  let kev24 = 0;
  let kev7d = 0;
  let recentKEV = [];
  let kevOverdue = 0;
  let kevDueSoon = 0;
  let kevDeadlines = [];
  let kevDueDates = {};
  if (panels.has('kev')) try {
    // "Today" (UTC calendar date), not a rolling 24h — CISA's date_added is
    // day-granular, so comparing against yesterday's date string actually spans
    // up to ~48h (see countKEVAddedToday). Wall/prompt surfaces label this
    // "N today" / "last 24h"; keep the underlying count honest to that grain.
    kev24 = countKEVAddedToday();
    kev7d = countKEVAddedSince(isoDaysAgo(7));
    kevOverdue = countKEVOverdue();
    kevDueSoon = countKEVDueSoon(14);
    kevDueDates = getKEVDueDates(headlines.map(h => h.kevCVE || h.kev_cve).filter(Boolean));
    recentKEV = getRecentKEV(8).map(k => ({
      cve: k.cve_id,
      vendor: k.vendor,
      product: k.product,
      name: k.vulnerability_name,
      dateAdded: k.date_added,
      dueDate: k.due_date,
    }));
    kevDeadlines = getKEVDeadlines(6).map(k => ({
      cve: k.cve_id,
      vendor: k.vendor,
      product: k.product,
      dueDate: k.due_date,
      overdue: Boolean(k.overdue),
      dueSoon: Boolean(k.due_soon),
    }));
  } catch { /* db not ready */ }

  const horizons = {};
  for (const n of [1, 2, 3]) {
    const items = headlines.filter(h => h.horizon === n);
    const top = items.slice(0, 1).map(h => compactHeadline(h, kevDueDates))[0] || null;
    horizons[n] = {
      count: items.length,
      critical: items.filter(h => h.urgency === 'critical').length,
      top: items.slice(0, 3).map(h => h.title),
      spotlight: top,
    };
  }

  let archived = [];
  try {
    archived = getArchivedHeadlines(7);
  } catch { /* db not ready */ }

  const actors = panels.has('actors') ? buildActorLeaderboard(headlines, archived) : [];
  const regions = panels.has('regions') ? buildRegionActivity(actors) : [];
  const mitre = panels.has('mitre') ? buildMitreHeatmap(headlines) : [];
  const vendors = panels.has('vendors') ? buildVendorExposure(headlines) : [];
  const convergence = buildConvergenceClusters(headlines);
  const watchTopics = buildWatchTopicHits(headlines, config.organization?.watchTopics || []);

  const fh = getFeedHealth();
  const feedEntries = Object.entries(fh.feeds || {});
  // The wall's "FEEDS n/total" reflects reachability: a feed that fetched fine
  // but is quiet (empty) or served from cache on a blip (stale) is up, not
  // down. Only genuine outages (http-*/parse-error/failed/circuit-open/rate-
  // limited) count against it. Keeps the readout honest, not alarmist.
  const REACHABLE = new Set(['ok', 'ok (cached)', 'ok (stale)', 'empty']);
  const feedsOk = feedEntries.filter(([, v]) => REACHABLE.has(v)).length;
  const feedStatusList = feedEntries
    .map(([source, status]) => ({
      source,
      ok: REACHABLE.has(status),
      status,
    }))
    .sort((a, b) => a.source.localeCompare(b.source));

  const ageMs = runAgeMs ?? (run?.generatedAtMs ? Date.now() - run.generatedAtMs : Infinity);
  const pipelineAgeMin = run ? Math.floor(ageMs / 60_000) : null;
  const refreshMinutes = config.analysisSettings?.refreshMinutes ?? 10;

  return {
    generatedAt: run?.generatedAt || null,
    stale: run ? ageMs > pipelineStaleAfterMs(refreshMinutes) : true,
    horizons,
    signals: headlines.slice(0, 14).map(h => compactHeadline(h, kevDueDates)),
    ticker: headlines.slice(0, 30).map(h => ({
      title: h.title,
      source: h.source,
      horizon: h.horizon,
      isKEV: Boolean(h.isKEV),
    })),
    kev: {
      added24h: kev24,
      added7d: kev7d,
      overdue: kevOverdue,
      dueSoon: kevDueSoon,
      recent: recentKEV,
      deadlines: kevDeadlines,
    },
    actors,
    regions,
    mitre,
    vendors,
    convergence,
    watchTopics,
    feeds: { ok: feedsOk, total: feedEntries.length, statuses: feedStatusList },
    pipeline: {
      ageMinutes: pipelineAgeMin,
      headlineCount: headlines.length,
      refreshMinutes,
      stats: run?.stats || null,
    },
    brief: latestBrief,
    organization: {
      sector: effectiveOrg.sector || '',
      profile: effectiveOrg.profile || '',
    },
  };
}

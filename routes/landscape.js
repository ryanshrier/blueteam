// BlueTeam.News — landscape routes: wall payload, wire headlines, manual refresh.

import { Router } from 'express';
import { createHash } from 'crypto';
import { buildLandscape, pipelineStaleAfterMs, currentKevCatalogStatus } from '../lib/landscape.js';
import { getKEVDueDates, getKEVRecords, getBriefMeta } from '../lib/db.js';
import { getLatestRun, refreshNow, getRunAgeMs } from '../lib/refresher.js';
import { parseBluf, parseSignalTitles } from '../lib/brief-schema.js';
import { getConfig, getConfigVersion, getHorizonName } from '../lib/config.js';
import { getDomainPack, getBrief } from '../lib/domain.js';
import { briefDateFromFilename, listBriefEditions } from '../lib/history.js';
import { briefPresentation } from '../lib/brief-reading-checks.js';
import { log } from '../lib/logger.js';
import { PUBLIC_APP_NAME } from '../lib/identity.js';
import { normalizePublicBaseUrl, requestBaseUrl } from '../lib/public-url.js';
import { getSourceEvidence } from '../lib/evidence.js';
import { getEffectiveWatchProfile } from '../lib/user-settings.js';
import { evaluateApplicability } from '../lib/watch-profile.js';
import { editorialContext, enrichmentStatus, headlineCves, normalizeFeedTimestamp, readableExcerpt } from '../lib/intelligence-context.js';
import { summarizeEvidence, briefingReadiness } from '../lib/evidence-freshness.js';
import { capturedSignalFacts } from '../public/modules/core/signal-facts.js';

// How many top-scored signals each feed publishes by default, and the hard cap
// a caller's own ?limit= may not exceed.
const FEED_LIMIT = 30;
const FEED_LIMIT_MAX = 100;

// Apply the syndication query filters (?tier=&kev=&min=&limit=) to an
// already-score-sorted headline list, then slice to the requested/default
// count. All params are optional and independently validated — an invalid or
// absent value is ignored rather than rejecting the request, so a feed reader
// with a typo'd query string still gets the unfiltered top-N instead of an
// error. `tier` matches h.horizon exactly (1/2/3); `kev=1` (or 'true') keeps
// only isKEV items; `min` is a score floor. Headlines are pre-sorted by score
// (pipeline step 10), so filtering first and slicing last preserves that order.
function filterFeedItems(headlines, query) {
  let items = headlines || [];

  const tier = Number(query.tier);
  if ([1, 2, 3].includes(tier)) items = items.filter(h => h.horizon === tier);

  if (query.kev === '1' || query.kev === 'true') items = items.filter(h => h.isKEV);

  const min = Number(query.min);
  if (Number.isFinite(min)) items = items.filter(h => (h.score || 0) >= min);

  const limit = Number(query.limit);
  const cap = (Number.isFinite(limit) && limit > 0) ? Math.min(Math.floor(limit), FEED_LIMIT_MAX) : FEED_LIMIT;

  return items.slice(0, cap);
}

// Exported for direct unit testing — pure functions with no route
// coupling. HTTP-level behavior (the anti-spoof invariant, illegal-host
// fallback) is covered separately in test/landscape-route.test.js by mounting
// the router and asserting on emitted feed URLs.
export function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Feed-controlled article links are emitted into syndication output; allow only
// http(s) so a malicious feed's data:/javascript: link never reaches a reader.
const httpLink = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

// Prefer the validated canonical origin; otherwise derive the base from the
// request so local and reverse-proxy deployments keep working without setup.
function baseUrl(req, configuredBaseUrl) {
  // X-Forwarded-* is only meaningful (and only trustworthy) once the operator has
  // told Express to trust a proxy hop (TRUST_PROXY in server.js) — that proxy is
  // what's supposed to strip/overwrite the header from the original client. With
  // no proxy configured, honoring it lets ANY direct caller spoof the host/proto
  // embedded in emitted feed/self URLs, so ignore it entirely in that case.
  // Still reject anything with control chars or illegal host characters, even
  // from a trusted proxy, and fall back to a safe loopback default.
  return requestBaseUrl(req, configuredBaseUrl);
}

// Guarantee the scoreComponents payload is { [string]: finite number } before it
// reaches the Wire breakdown — a malformed pipeline emission (NaN, nested object)
// is dropped rather than rendered as nonsense.
export function normalizeScoreComponents(sc) {
  if (!sc || typeof sc !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(sc)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function loadLatestBriefSummary(historyDir, reviewDirectory) {
  try {
    const edition = listBriefEditions(historyDir, { getMeta: getBriefMeta, limit: 1, eligibleOnly: true, reviewDirectory })[0];
    if (!edition) return null;
    const { filename } = edition;
    const { content, reviewed } = edition.reading;
    let legacyWarnings = [];
    try { const parsed = JSON.parse(edition.meta?.warnings || '[]'); if (Array.isArray(parsed)) legacyWarnings = parsed; } catch { /* invalid legacy metadata is not a check record */ }
    const presentation = briefPresentation(edition.reading, { legacyWarnings });
    return {
      filename,
      revision: createHash('sha256').update(content).update(JSON.stringify({ review: reviewed.review, disposition: edition.disposition, presentation: presentation.revision })).digest('hex'),
      date: briefDateFromFilename(filename),
      generatedAt: edition.generatedAt,
      bluf: parseBluf(content),
      judgments: parseSignalTitles(content).slice(0, 6),
      review: reviewed.review || null,
      disposition: edition.disposition,
      presentation,
    };
  } catch {
    return null;
  }
}

// ── /landscape memo ──
// buildLandscape() does real work per call: loadLatestBriefSummary's sync
// readdir+readFile, getArchivedHeadlines (JSON.parse per archived row), an actor
// regex scan over current+archived titles, the MITRE heatmap, vendor scan, and
// six kev_cache queries — none of which change between refreshes (every ~10min)
// or brief saves. Every Wall/Wire client polls this every 60s, so an unmemoized
// build multiplies that fixed cost per viewer, competing with SSE brief
// streaming on the single event loop. Cache the built payload keyed on the
// latest run's generatedAtMs (changes only when a new pipeline run lands) plus
// a short TTL that re-checks for a newly saved brief — loadLatestBriefSummary's
// own readdir/readFile cost is paid only on a cache miss, not per request.
// Evidence freshness and pipeline age drift between builds. Recompute those
// cheap elapsed-time summaries on every hit rather than freezing their counts.
const LANDSCAPE_MEMO_TTL_MS = 30_000;
let landscapeMemo = null; // { generatedAtMs, configVersion, briefRevision, builtAtMs, payload }

function buildLandscapeMemoized(historyDir, reviewDirectory) {
  const run = getLatestRun();
  const runAgeMs = getRunAgeMs();
  const now = Date.now();
  const configVersion = getConfigVersion();
  const catalogStatus = currentKevCatalogStatus(run);
  const catalogRevision = `${catalogStatus.status}:${catalogStatus.retrievedAt || ''}`;

  const runChanged = !landscapeMemo || landscapeMemo.generatedAtMs !== (run?.generatedAtMs ?? null);
  const configChanged = !landscapeMemo || landscapeMemo.configVersion !== configVersion;
  const catalogChanged = !landscapeMemo || landscapeMemo.catalogRevision !== catalogRevision;
  const ttlExpired = !landscapeMemo || (now - landscapeMemo.builtAtMs) > LANDSCAPE_MEMO_TTL_MS;

  if (runChanged || configChanged || catalogChanged || ttlExpired) {
    const brief = loadLatestBriefSummary(historyDir, reviewDirectory);
    let archivedCount = 0;
    if (!brief) { try { archivedCount = listBriefEditions(historyDir).length; } catch { /* unavailable archive has no usable default */ } }
    const briefAvailability = brief ? { status: 'available', eligibleForLatest: true }
      : archivedCount ? { status: 'no-eligible-edition', eligibleForLatest: false, excludedCount: archivedCount, message: 'Saved editions require review or have been superseded. Open History to inspect them.' }
        : { status: 'no-saved-edition', eligibleForLatest: false, excludedCount: 0, message: 'No saved Briefing is available yet.' };
    const briefRevision = brief ? `${brief.filename}:${brief.revision}` : briefAvailability.status;
    // Rebuild only when the run actually advanced or the brief on disk changed
    // since the last build — a same-brief TTL tick just refreshes the cache
    // bookkeeping so the next few requests skip straight to the age patch below.
    if (
      runChanged
      || configChanged
      || catalogChanged
      || !landscapeMemo
      || landscapeMemo.briefRevision !== briefRevision
    ) {
      landscapeMemo = {
        generatedAtMs: run?.generatedAtMs ?? null,
        configVersion,
        catalogRevision,
        briefRevision,
        builtAtMs: now,
        payload: { ...buildLandscape(run, brief, { runAgeMs }), briefAvailability },
      };
    } else {
      landscapeMemo.builtAtMs = now;
    }
  }

  // Retained observations can age out before the configured pipeline warning
  // threshold. Re-evaluate their window even while the expensive build is cached.
  const payload = landscapeMemo.payload;
  const pipelineAgeMin = run ? Math.floor(runAgeMs / 60_000) : null;
  const maxAgeMs = Math.max(15 * 60_000, (getConfig().analysisSettings?.refreshMinutes ?? 10) * 3 * 60_000);
  const evidence = summarizeEvidence(run?.headlines || [], { now, maxAgeMs });
  const readiness = briefingReadiness(run, { now, maxAgeMs });
  return {
    ...payload,
    generatedAt: evidence.observedAt,
    evidence,
    briefingReadiness: readiness,
    collection: readiness.collection ? { ...payload.collection, ...readiness.collection } : payload.collection,
    stale: !run || runAgeMs > pipelineStaleAfterMs(payload.pipeline?.refreshMinutes)
      || readiness.collection?.outage === true,
    pipeline: { ...payload.pipeline, ageMinutes: pipelineAgeMin },
  };
}

/** Publication can change the current briefing before the memo TTL expires. */
export function invalidateLandscapeMemo() {
  landscapeMemo = null;
}

export const _resetLandscapeMemoForTests = invalidateLandscapeMemo;

export function createLandscapeRouter({ historyDir, reviewDir, cooldown, publicBaseUrl = null, loopback = false }) {
  const router = Router();
  const canonicalPublicBaseUrl = normalizePublicBaseUrl(publicBaseUrl);

  // ── GET /edition — the active Domain Pack's client-facing identity. The app
  // shell reads the edition NAME (wordmark + document.title) and
  // the entity REGION map from here, so the views stop hardcoding "Blue Team" and
  // their own copy of the region labels — a second edition reskins by configuration.
  router.get('/edition', (req, res) => {
    try {
      const pack = getDomainPack();
      res.json({
        id: pack.id,
        title: getBrief().frame.title,        // the edition name shown in the UI
        label: pack.label,
        regions: pack.entities?.regions || {},
      });
    } catch (err) {
      log.error('edition', `Edition payload failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to build edition' });
    }
  });

  // ── GET /landscape — full wall payload ──
  router.get('/landscape', (req, res) => {
    try {
      res.json(buildLandscapeMemoized(historyDir, reviewDir));
    } catch (err) {
      log.error('landscape', `Payload build failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to build landscape' });
    }
  });

  // Retained public reporting uses the same API access boundary as Wire.
  // Missing/pruned evidence is explicit; no publisher fetch happens on a read.
  router.get('/evidence/:sourceId', (req, res) => {
    if (!/^src_[a-f0-9]{64}$/.test(req.params.sourceId)) {
      return res.status(400).json({ error: 'Invalid source identity', code: 'E_EVIDENCE_ID' });
    }
    try {
      const evidence = getSourceEvidence(req.params.sourceId);
      if (!evidence) return res.status(404).json({ error: 'Source evidence is unavailable or outside retention', code: 'E_EVIDENCE_MISSING' });
      res.set('Cache-Control', 'no-store').json(evidence);
    } catch (err) {
      log.warn('evidence', `Evidence read failed: ${err.message}`);
      res.status(503).json({ error: 'Evidence storage is unavailable', code: 'E_EVIDENCE_UNAVAILABLE' });
    }
  });

  // ── GET /headlines — scored headlines for the wire view ──
  router.get('/headlines', (req, res) => {
    res.vary('Authorization');
    const run = getLatestRun();
    if (!run) {
      return res.json({ generatedAt: null, ageSeconds: null, headlines: [] });
    }
    const headlines = run.headlines || [];
    const catalogStatus = currentKevCatalogStatus(run);
    const refreshMinutes = getConfig().analysisSettings?.refreshMinutes ?? 10;
    const readiness = briefingReadiness(run, { maxAgeMs: Math.max(15 * 60_000, refreshMinutes * 3 * 60_000) });
    const profile = loopback || res.locals.authenticated === true ? getEffectiveWatchProfile(getConfig()) : null;
    if (profile) res.set('Cache-Control', 'private, no-store');

    // One batched join of kev_cache.due_date for every KEV CVE in the run,
    // rather than a lookup per row. Tolerate a not-ready DB (empty map).
    let dueDates = {};
    let kevById = {};
    try {
      const ids = headlines.flatMap(h => [...headlineCves(h), h.kevCVE].filter(Boolean));
      dueDates = getKEVDueDates(ids);
      kevById = getKEVRecords(ids);
    } catch { /* db not ready */ }

    res.json({
      generatedAt: run.generatedAt,
      ageSeconds: Math.floor(getRunAgeMs() / 1000),
      refreshMinutes,
      briefingReadiness: readiness,
      collection: readiness.collection ? { ...run.stats?.collection, ...readiness.collection } : run.stats?.collection || null,
      kevCatalogStatus: catalogStatus,
      stats: run.stats,
      enrichmentFailures: run.stats?.enrichmentFailures || [],
      ...(profile ? { watchProfile: profile } : {}),
      headlines: headlines.map(h => {
        const due = (h.kevCVE && dueDates[h.kevCVE]) || null;
        const kevRecords = [...new Set([...headlineCves(h), h.kevCVE].filter(Boolean))].flatMap(cve => kevById[cve] ? [kevById[cve]] : []);
        const facts = capturedSignalFacts({ ...h, kevDueDate: due?.due_date || h.kevDueDate, kevDateAdded: due?.date_added || h.kevDateAdded,
          kevOverdue: due ? Boolean(due.overdue) : h.kevOverdue }, kevRecords, catalogStatus);
        const normalizedDate = normalizeFeedTimestamp(h.date);
        return {
          title: h.title,
          description: readableExcerpt(h.passage || h.description || '', 480),
          descriptionTruncated: String(h.passage || h.description || '').length > 480 || Boolean(h.passageTruncated),
          editorialContext: editorialContext({ ...h, ...facts }, facts.kevRecords, { preparedOnly: true }),
          ...facts,
          enrichmentStatus: enrichmentStatus(h, run.stats?.enrichmentFailures),
          link: h.link || null,
          source: h.source,
          horizon: h.horizon,
          score: Math.round((h.score || 0) * 10) / 10,
          urgency: h.urgency,
          cveData: h.cveData || null,
          corroboration: h.corroboration || 1,
          date: normalizedDate || h.date || null,
          originalDate: h.originalDate || h.date || null,
          dateUnknown: !normalizedDate,
          actors: h.actors || null,
          vendors: h.vendors || null,
          mitre: h.mitre || null,
          scoreComponents: normalizeScoreComponents(h.scoreComponents), // now [0,1] evidence axes
          scoreContributions: normalizeScoreComponents(h.scoreContributions),
          scoreWeights: normalizeScoreComponents(h.scoreWeights),
          scoreUnknowns: h.scoreUnknowns || [],
          scoreRationale: h.scoreRationale || null,                      // the evidence ledger behind the rank
          originalHorizon: h.originalHorizon || null,
          alertMatched: Boolean(h.alertMatched),
          sources: h.sources || null,
          evidence: h.evidence || [],
          ...(profile ? { applicability: evaluateApplicability(h, profile) } : {}),
        };
      }),
    });
  });

  // ── GET /feed.xml — RSS 2.0 of the top scored signals ──
  router.get('/feed.xml', (req, res) => {
    try {
      const run = getLatestRun();
      const cfg = getConfig();
      const items = filterFeedItems(run?.headlines, req.query);
      const base = baseUrl(req, canonicalPublicBaseUrl);
      const updated = run?.generatedAt || new Date().toISOString();

      const entries = items.map(h => {
        const horizon = getHorizonName(cfg, h.horizon);
        const score = Math.round((h.score || 0) * 10) / 10;
        const cats = [`H${h.horizon} ${horizon}`];
        if (h.isKEV) cats.push(h.kevCVE ? `KEV ${h.kevCVE}` : 'KEV');
        const desc = [h.description || '', `[${horizon} · score ${score}${h.isKEV ? ` · KEV${h.kevCVE ? ` ${h.kevCVE}` : ''}` : ''}]`]
          .filter(Boolean).join(' ');
        const link = httpLink(h.link);
        const guid = link || `${base}/api/feed.xml#${encodeURIComponent(h.title)}`;
        return [
          '    <item>',
          `      <title>${escapeXml(h.title)}</title>`,
          link ? `      <link>${escapeXml(link)}</link>` : '',
          `      <guid isPermaLink="${link ? 'true' : 'false'}">${escapeXml(guid)}</guid>`,
          (h.date && !Number.isNaN(Date.parse(h.date))) ? `      <pubDate>${escapeXml(new Date(h.date).toUTCString())}</pubDate>` : '',
          `      <source url="${escapeXml(base)}">${escapeXml(h.source || 'Unknown')}</source>`,
          ...cats.map(c => `      <category>${escapeXml(c)}</category>`),
          `      <description>${escapeXml(desc)}</description>`,
          '    </item>',
        ].filter(Boolean).join('\n');
      }).join('\n');

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        '  <channel>',
        `    <title>${PUBLIC_APP_NAME} — threat signals</title>`,
        `    <link>${escapeXml(base)}</link>`,
        '    <description>Top scored cyber-threat signals from BlueTeam.News.</description>',
        `    <lastBuildDate>${escapeXml(new Date(updated).toUTCString())}</lastBuildDate>`,
        `    <generator>${PUBLIC_APP_NAME}</generator>`,
        entries,
        '  </channel>',
        '</rss>',
        '',
      ].filter(l => l !== '').join('\n');

      res.set('Content-Type', 'application/rss+xml; charset=utf-8').send(xml);
    } catch (err) {
      log.error('landscape', `feed.xml build failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to build feed' });
    }
  });

  // ── GET /feed.json — JSON Feed 1.1 of the top scored signals ──
  router.get('/feed.json', (req, res) => {
    try {
      const run = getLatestRun();
      const cfg = getConfig();
      const items = filterFeedItems(run?.headlines, req.query);
      const base = baseUrl(req, canonicalPublicBaseUrl);

      const feed = {
        version: 'https://jsonfeed.org/version/1.1',
        title: `${PUBLIC_APP_NAME} — threat signals`,
        home_page_url: base,
        feed_url: `${base}/api/feed.json`,
        description: 'Top scored cyber-threat signals from BlueTeam.News.',
        items: items.map((h, i) => {
          const horizon = getHorizonName(cfg, h.horizon);
          const tags = [`H${h.horizon} ${horizon}`];
          if (h.isKEV) tags.push(h.kevCVE ? `KEV ${h.kevCVE}` : 'KEV');
          const link = httpLink(h.link);
          const item = {
            id: link || `urn:blueteam:signal:${i}:${encodeURIComponent(h.title)}`,
            title: h.title,
            content_text: h.description || h.title,
            tags,
            _blueteam: {
              source: h.source || null,
              horizon: h.horizon,
              horizonName: horizon,
              score: Math.round((h.score || 0) * 10) / 10,
              isKEV: Boolean(h.isKEV),
              kevCVE: h.kevCVE || null,
            },
          };
          if (link) item.url = link;
          if (h.date && !Number.isNaN(Date.parse(h.date))) {
            item.date_published = new Date(h.date).toISOString();
          }
          return item;
        }),
      };

      res.set('Content-Type', 'application/feed+json; charset=utf-8').send(JSON.stringify(feed));
    } catch (err) {
      log.error('landscape', `feed.json build failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to build feed' });
    }
  });

  // ── GET /briefs.xml — RSS 2.0 of the daily brief itself ──
  // The flagship artifact, syndicated the way Risky Biz / tl;dr sec are: one item
  // per brief, BLUF as the description, deep link back into the app. Reuses the
  // same escapeXml/baseUrl helpers as feed.xml and the same directory-scan +
  // getBriefMeta lookup routes/brief.js's GET /briefs list already relies on —
  // no new storage, no new dependency.
  router.get('/briefs.xml', (req, res) => {
    try {
      const base = baseUrl(req, canonicalPublicBaseUrl);
      const editions = listBriefEditions(historyDir, { getMeta: getBriefMeta, limit: 30, eligibleOnly: true, reviewDirectory: reviewDir });

      const entries = editions.map(({ filename, date, generatedAt, reading }) => {
        const bluf = parseBluf(reading.content) || '';
        const link = `${base}/briefing/${encodeURIComponent(filename)}`;
        const pubDate = new Date(generatedAt).toUTCString();
        return [
          '    <item>',
          `      <title>${PUBLIC_APP_NAME} Briefing — ${escapeXml(date)}</title>`,
          `      <link>${escapeXml(link)}</link>`,
          `      <guid isPermaLink="false">${escapeXml(link)}</guid>`,
          pubDate ? `      <pubDate>${escapeXml(pubDate)}</pubDate>` : '',
          `      <description>${escapeXml(bluf)}</description>`,
          '    </item>',
        ].filter(Boolean).join('\n');
      }).join('\n');

      const latestDate = editions[0]?.generatedAt;
      const updated = latestDate
        ? new Date(latestDate).toUTCString()
        : new Date().toUTCString();

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        '  <channel>',
        `    <title>${PUBLIC_APP_NAME} — Daily Briefing</title>`,
        `    <link>${escapeXml(base)}</link>`,
        '    <description>The BlueTeam.News daily AI intelligence briefing — BLUF and key judgments for cyber defense teams.</description>',
        `    <lastBuildDate>${escapeXml(updated)}</lastBuildDate>`,
        `    <generator>${PUBLIC_APP_NAME}</generator>`,
        entries,
        '  </channel>',
        '</rss>',
        '',
      ].filter(l => l !== '').join('\n');

      res.set('Content-Type', 'application/rss+xml; charset=utf-8').send(xml);
    } catch (err) {
      log.error('landscape', `briefs.xml build failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to build briefs feed' });
    }
  });

  // ── POST /refresh — force a pipeline run ──
  // refreshNow() already dedupes truly concurrent calls (refreshInFlight), but
  // back-to-back sequential requests each launched a fresh ~40-feed + Google-News
  // + KEV/NVD sweep with no limit besides the shared 180/min apiLimiter. A
  // 60s per-process cooldown (same debounce pattern POST /brief uses) caps how
  // often a client can force a full pipeline pass.
  router.post('/refresh', async (req, res) => {
    if (cooldown && !cooldown.check('refresh', 60000)) {
      return res.status(429).json({ error: 'Refresh already ran recently — please wait', code: 'E_COOLDOWN' });
    }
    try {
      const run = await refreshNow('api');
      res.json({ ok: true, generatedAt: run.generatedAt, headlines: run.headlines.length });
    } catch (err) {
      log.error('landscape', `Manual refresh failed: ${err.message}`);
      res.status(500).json({ error: 'Refresh failed' });
    }
  });

  return router;
}

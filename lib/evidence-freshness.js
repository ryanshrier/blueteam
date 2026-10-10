// Freshness comes from publisher observations, never from a local refresh clock.
import { selectGroundingMembers } from './grounding.js';
import { selectSourcePassage } from './evidence-quality.js';

const observationIsFresh = (value, now, maxAgeMs) => {
  const observed = Date.parse(value || '');
  return Number.isFinite(observed) && observed <= now + 60_000 && now - observed <= maxAgeMs;
};

export function summarizeEvidence(headlines = [], { maxAgeMs = 30 * 60_000, now = Date.now() } = {}) {
  let freshHeadlines = 0;
  let newestObservation = 0;
  for (const headline of headlines) {
    const members = selectGroundingMembers(headline);
    let fresh = false;
    for (const member of members) {
      const observed = Date.parse(member.retrievedAt || '');
      if (!Number.isFinite(observed) || observed > now + 60_000) continue;
      newestObservation = Math.max(newestObservation, observed);
      if (!member.collectionStale && now - observed <= maxAgeMs) fresh = true;
    }
    if (fresh) freshHeadlines++;
  }
  return {
    freshHeadlines, retainedHeadlines: headlines.length - freshHeadlines,
    observedAt: newestObservation ? new Date(newestObservation).toISOString() : null,
  };
}

/** Shared generation readiness, based on retained passages rather than a story quota.
 * A healthy, quiet collection can support a small briefing. A widespread outage
 * cannot establish that the landscape is quiet, even if one publisher responds.
 */
export function briefingReadiness(run, { maxAgeMs = 30 * 60_000, now = Date.now(), minHealthySourceRatio = 0.5 } = {}) {
  const headlines = Array.isArray(run?.headlines) ? run.headlines : [];
  const evidence = summarizeEvidence(headlines, { maxAgeMs, now });
  const age = Number.isFinite(run?.generatedAtMs) ? now - run.generatedAtMs : Infinity;
  const sources = new Set();
  let usableHeadlines = 0;
  for (const headline of headlines) {
    let usable = false;
    for (const member of selectGroundingMembers(headline)) {
      if (member.id === 'CISA-KEV' || member.passageKind === 'catalog-membership-only') continue;
      const selected = selectSourcePassage(member);
      const freshPassage = (selected.sourceParts || []).some(part => part.quality?.substantive
        && part.retrievalStatus !== 'retained-cache'
        && observationIsFresh(part.retrievedAt, now, maxAgeMs));
      if (!freshPassage) continue;
      usable = true;
      sources.add(member.source || member.link || member.title);
    }
    if (usable) usableHeadlines++;
  }
  const latestAttempt = run?.lastCollectionAttempt;
  const counts = latestAttempt?.retainedLastGood ? latestAttempt.collection : run?.stats?.collection;
  const configured = Number.isFinite(counts?.configuredSources) ? Math.max(0, counts.configuredSources) : null;
  // freshSources historically includes successful empty feed responses. Prefer
  // an explicitly named reachable count if the collector supplies one later.
  const reachable = Number.isFinite(counts?.reachableSources) ? Math.max(0, counts.reachableSources)
    : Number.isFinite(counts?.freshSources) ? Math.max(0, counts.freshSources) : null;
  const outage = latestAttempt?.failed === true || (configured > 0 && reachable !== null && reachable / configured < minHealthySourceRatio);
  const collection = counts || latestAttempt ? { configuredSources: configured, reachableSources: reachable,
    freshSources: Number.isFinite(counts?.freshSources) ? counts.freshSources : null, outage,
    ...(latestAttempt ? { lastAttemptAt: latestAttempt.observedAt || null, retainedLastGood: true } : {}) } : null;
  let code; let reason;
  if (!Number.isFinite(age) || age > maxAgeMs || age < -60_000) {
    code = 'stale'; reason = 'Briefing evidence is stale or its collection time is unavailable. Refresh the landscape before generating.';
  } else if (outage) {
    code = 'collection-outage'; reason = 'Most configured sources could not be checked. Retained coverage cannot establish a quiet day; refresh collection before generating.';
  } else if (!usableHeadlines) {
    code = 'no-usable-evidence'; reason = 'No fresh substantive source passages are available. Headline leads and retained evidence remain available on the Wire.';
  } else if (usableHeadlines < 5 || sources.size < 2 || !configured || reachable === null || reachable < configured) {
    code = 'limited-coverage'; reason = 'Fresh source passages support a limited briefing. Keep its scope to the observed evidence and identify collection gaps; do not fill a story quota.';
  } else {
    code = 'ready'; reason = 'Fresh substantive source passages are available for a briefing.';
  }
  const canGenerate = code === 'ready' || code === 'limited-coverage';
  return { status: canGenerate ? code === 'ready' ? 'ready' : 'limited' : 'blocked', canGenerate,
    scope: canGenerate ? code === 'ready' ? 'standard' : 'limited' : 'unavailable', code, reason,
    ...evidence, usableHeadlines, substantiveSources: sources.size,
    ageMs: Number.isFinite(age) ? Math.max(0, age) : null, collection };
}

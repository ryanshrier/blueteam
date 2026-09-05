// Freshness comes from publisher observations, never from a local refresh clock.
import { selectGroundingMembers } from './grounding.js';

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

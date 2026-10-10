// An assessment is historical user input. A changed source asks for review;
// it never silently changes the user's affected/not-affected conclusion.
export function decisionEvidence(headline = {}) {
  const refs = Array.isArray(headline.evidence) ? headline.evidence : [];
  return [...new Map(refs.filter(ref => ref && typeof ref.sourceId === 'string' && ref.sourceId && typeof ref.revisionId === 'string' && ref.revisionId)
    .map(ref => [`${ref.sourceId}:${ref.revisionId}`, { sourceId: ref.sourceId.slice(0, 128), revisionId: ref.revisionId.slice(0, 128),
      ...(/^[a-f0-9]{64}$/i.test(ref.contentHash || '') ? { contentHash: ref.contentHash.toLowerCase() } : {}) }])).values()]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.revisionId.localeCompare(b.revisionId)).slice(0, 100);
}

export function decisionReviewState(headline, decision, now = new Date()) {
  if (!decision?.state || decision.state === 'unreviewed') return { needsReview: false, reasons: [] };
  const bound = decisionEvidence({ evidence: decision.evidenceBinding });
  const current = decisionEvidence(headline);
  const reasons = [];
  if (!bound.length || !current.length) reasons.push('Evidence revision unavailable');
  else if (bound.length !== current.length || bound.some(ref => !current.some(other => ref.sourceId === other.sourceId &&
      (ref.contentHash && other.contentHash ? ref.contentHash === other.contentHash : ref.revisionId === other.revisionId)))) reasons.push('Evidence revision differs');
  const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (decision.nextReview && decision.nextReview <= localDay) reasons.push('Review due');
  return { needsReview: reasons.length > 0, reasons };
}

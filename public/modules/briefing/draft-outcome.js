// Describe retained work separately from transport failures and publication.
// This is presentation only: the server owns all publication decisions.
export function draftOutcome({ outcome = '', code = '', validation, publicationDecision, draftArtifact } = {}) {
  if (outcome === 'incomplete' || code === 'E_PARTIAL_GENERATION' || code === 'E_PROVIDER_INCOMPLETE'
    || code === 'E_GENERATION_TIMEOUT' || validation?.partial === true || draftArtifact?.partial === true) return 'incomplete';
  if (outcome === 'provider-failed' || /^E_PROVIDER/.test(code)) return 'provider-failed';
  const blockers = publicationDecision?.blockers?.length ?? draftArtifact?.blockerCount;
  if (blockers > 0 || outcome === 'checks-required') return 'checks-required';
  if (outcome === 'review-requested'
    || publicationDecision?.requiresReview || draftArtifact?.requiresReview) return 'review-requested';
  if (outcome === 'draft-ready' || publicationDecision?.canPublish || draftArtifact?.canPublish) return 'draft-ready';
  if (code === 'E_DRAFT_REVIEW') return 'review-requested';
  if (code === 'E006' || code === 'E_VALIDATION') return 'checks-required';
  return '';
}

export function draftOutcomePresentation(payload = {}) {
  const kind = draftOutcome(payload);
  const saved = Boolean(payload.draftArtifact?.id);
  const labels = {
    'review-requested': 'Draft generated · review requested',
    'checks-required': 'Draft generated · checks need attention',
    'draft-ready': saved ? 'Draft saved · ready to publish' : 'Draft ready to publish',
    incomplete: saved ? 'Incomplete draft saved' : 'Incomplete draft',
    'provider-failed': 'Provider could not complete generation',
  };
  const descriptions = {
    'review-requested': 'Review the listed findings before publishing.',
    'checks-required': 'Resolve the required findings before publishing.',
    'draft-ready': `The ${saved ? 'saved ' : ''}draft is ready for publication.`,
    incomplete: 'Generation did not finish. Review and complete the retained text before publishing.',
    'provider-failed': 'Review the retained text and provider details before choosing whether to retry.',
  };
  return { kind, label: labels[kind] || 'Draft not published',
    description: `${descriptions[kind] || 'Review the retained text before publishing.'} No edition was published.${saved ? ' Reviewing or saving this draft uses no additional model call.' : ''}`,
    neutral: ['review-requested', 'checks-required', 'draft-ready'].includes(kind),
    canRegenerate: !saved || ['incomplete', 'provider-failed'].includes(kind) };
}

import { expect, test } from '@jest/globals';
import { draftOutcomePresentation } from '../public/modules/briefing/draft-outcome.js';

test('legacy review-only and source-check drafts lead to saved recovery, not another paid generation', () => {
  for (const code of ['E_DRAFT_REVIEW', 'E006', 'E_VALIDATION']) {
    const display = draftOutcomePresentation({ code, draftArtifact: { id: 'saved-draft' } });
    expect(display).toMatchObject({ neutral: true, canRegenerate: false });
    expect(display.label).toContain('Draft generated');
    expect(display.description).toContain('No edition was published');
  }
});

test('real blockers take precedence over review labels and stale approval hints', () => {
  expect(draftOutcomePresentation({ outcome: 'review-requested', code: 'E_DRAFT_REVIEW',
    publicationDecision: { blockers: [{ code: 'KEV_DEADLINE_MISMATCH' }], requiresReview: true },
    draftArtifact: { id: 'saved-draft', canPublish: true } })).toMatchObject({
    kind: 'checks-required', label: 'Draft generated · checks need attention', canRegenerate: false,
  });
});

test.each([
  ['E_PARTIAL_GENERATION', 'incomplete'], ['E_PROVIDER_INCOMPLETE', 'incomplete'],
  ['E_GENERATION_TIMEOUT', 'incomplete'], ['E_PROVIDER_FAILURE', 'provider-failed'],
])('an interrupted or failed provider remains explicit despite reviewable findings: %s', (code, kind) => {
  expect(draftOutcomePresentation({ code, draftArtifact: { id: 'saved-draft', requiresReview: true } }))
    .toMatchObject({ kind, neutral: false, canRegenerate: true });
});

test('an unsaved draft never implies durable recovery and still offers regeneration', () => {
  const display = draftOutcomePresentation({ code: 'E_VALIDATION' });
  expect(display.canRegenerate).toBe(true);
  expect(display.description).not.toContain('saving this draft');
});

test('an explicit ready draft survives a legacy scheduled-review code without implying publication', () => {
  expect(draftOutcomePresentation({ outcome: 'draft-ready', code: 'E_DRAFT_REVIEW',
    draftArtifact: { id: 'ready-draft', canPublish: true } })).toMatchObject({
    kind: 'draft-ready', label: 'Draft saved · ready to publish', neutral: true, canRegenerate: false,
    description: expect.stringContaining('No edition was published'),
  });
  expect(draftOutcomePresentation({ outcome: 'draft-ready' }).label).toBe('Draft ready to publish');
});

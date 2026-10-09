import { describe, expect, test } from '@jest/globals';
import { repairRequest, publicationRequest, draftValidation, draftCheckLabel, draftPublicationLabel, rememberRepair, MAX_REPAIR_BYTES } from '../public/modules/briefing/brief-drafts.js';
import { eligibleEdition, publicationStateLabel } from '../public/modules/briefing/briefing-view.js';

describe('draft repair and publication UI boundaries', () => {
  const artifact = { id: 'draft-test', revisions: [{ number: 1, content: 'Original' }, { number: 2, content: 'Repaired' }] };
  test('repair carries the latest revision for optimistic concurrency without changing the retained original', () => {
    expect(repairRequest(artifact, 'Corrected\nclaim')).toEqual({ content: 'Corrected\nclaim', baseRevision: 2 });
    expect(artifact.revisions[0].content).toBe('Original');
  });
  test('missing revision, empty repair and oversized multibyte requests are rejected before submission', () => {
    expect(() => repairRequest({}, 'Text')).toThrow('Reload');
    expect(() => repairRequest(artifact, '  \n')).toThrow('empty');
    expect(() => repairRequest(artifact, '界'.repeat(Math.floor(MAX_REPAIR_BYTES / 3) + 1))).toThrow('80 KB');
    expect(repairRequest(artifact, 'a'.repeat(MAX_REPAIR_BYTES)).content.length).toBe(MAX_REPAIR_BYTES);
  });
  test('a successful source recheck does not claim editorial approval or publication', () => {
    expect(draftCheckLabel({ valid: true })).toBe('Draft saved · supported checks passed · unpublished');
    expect(draftCheckLabel({ valid: true, sourceCheckStatus: 'findings' })).toBe('Draft saved · checks need attention');
    expect(draftCheckLabel({})).toBe('Checks unavailable');
    expect(draftCheckLabel({}, { blockers: [{ code: 'SOURCE_UNSUPPORTED' }], requiresReview: true })).toBe('Draft saved · fixes needed before publication');
  });
  test('publication outcome distinguishes current, archived, and unavailable display status', () => {
    expect(draftPublicationLabel({ isCurrent: true })).toBe('Briefing published · now current in Latest and Wall');
    expect(draftPublicationLabel({ isCurrent: false })).toBe('Briefing published · available in the archive');
    expect(draftPublicationLabel({})).toBe('Briefing published · current display status unavailable');
  });
  test('publication uses exact input and text identities and only an explicit current-text control review', () => {
    const captured = { manifestSha256: 'a'.repeat(64), revisions: [{ number: 12, content: 'Reviewed text', sha256: 'b'.repeat(64) }] };
    expect(publicationRequest(captured, 'Changed text')).toEqual({ content: 'Changed text', baseRevision: 12, inputSha256: 'a'.repeat(64) });
    const review = { confirmed: true, reviewer: ' Analyst ', reason: ' Scoped action supported by captured advisory. ' };
    expect(publicationRequest(captured, 'Reviewed text', review).securityControlReview).toEqual({ reviewer: 'Analyst', reason: 'Scoped action supported by captured advisory.', contentSha256: 'b'.repeat(64) });
    expect(() => publicationRequest(captured, 'Changed text', review)).toThrow('draft changed');
    expect(() => publicationRequest(captured, 'Reviewed text', { ...review, confirmed: false })).toThrow('specific security-control review');
  });
  test('no-op rechecks supersede older findings only when their exact saved revision matches', () => {
    const captured = { revisions: [{ number: 12, content: 'Text', sha256: 'a'.repeat(64), validation: { valid: false } }],
      lastCheck: { revision: 12, contentSha256: 'a'.repeat(64), validation: { valid: true } } };
    expect(draftValidation(captured)).toEqual({ valid: true });
    captured.lastCheck.contentSha256 = 'b'.repeat(64);
    expect(draftValidation(captured)).toEqual({ valid: false });
    expect(draftCheckLabel({ valid: false }, { canPublish: true, notes: [{ message: 'Style note' }] })).toBe('Draft saved · ready to publish');
  });
  test('opening or closing a newer revision never overwrites an earlier unsaved repair', () => {
    const old = [{ baseRevision: 1, content: 'Important unsaved correction' }];
    const latest = { number: 2, content: 'Server revision' };
    expect(rememberRepair(old, latest, latest.content)).toEqual(old);
    const both = rememberRepair(old, latest, 'New revision repair');
    expect(both).toEqual([...old, { baseRevision: 2, content: 'New revision repair' }]);
    expect(rememberRepair(both, latest, latest.content)).toEqual(old);
  });
  test('Latest eligibility and review labels preserve the server disposition', () => {
    expect(eligibleEdition({ disposition: { status: 'review-required', eligibleForLatest: false } })).toBe(false);
    expect(eligibleEdition({ disposition: { status: 'superseded' } })).toBe(false);
    expect(eligibleEdition({ disposition: { status: 'eligible' } })).toBe(true);
    expect(publicationStateLabel({ sourceCheckStatus: 'passed-supported-checks', disposition: { editorialReviewStatus: 'reviewed' } })).toBe('Published briefing');
    expect(publicationStateLabel({ sourceCheckStatus: 'passed-supported-checks', review: { status: 'editorially-corrected' } })).toBe('Published briefing · corrected copy');
  });
});

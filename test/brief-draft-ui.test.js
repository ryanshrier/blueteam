import { describe, expect, test } from '@jest/globals';
import { repairRequest, draftCheckLabel, rememberRepair, MAX_REPAIR_BYTES } from '../public/modules/briefing/brief-drafts.js';
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
    expect(draftCheckLabel({ valid: true })).toBe('Supported checks passed · editorial review required');
    expect(draftCheckLabel({ valid: true, sourceCheckStatus: 'findings' })).toBe('Checks need attention');
    expect(draftCheckLabel({})).toBe('Checks unavailable');
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
    expect(publicationStateLabel({ sourceCheckStatus: 'passed-supported-checks', disposition: { editorialReviewStatus: 'reviewed' } })).toContain('Editorial review recorded');
    expect(publicationStateLabel({ sourceCheckStatus: 'passed-supported-checks', review: { status: 'editorially-corrected' } })).toContain('for the original generated revision');
  });
});

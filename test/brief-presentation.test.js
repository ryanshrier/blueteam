import { describe, expect, test } from '@jest/globals';
import { briefPresentation, issueAudience, presentationSourceCheckStatus } from '../lib/brief-reading-checks.js';
import { sha256 } from '../lib/generation-manifest.js';

const note = { code: 'CITED_SOURCE_LIMITED', severity: 'review', message: 'Version scope remains unconfirmed in the retained passage.', location: { scope: 'judgment', line: 12 } };
const originalIssue = { code: 'CVE_CITATION_MISMATCH', severity: 'trust', message: 'The original CVE was not supported.' };
const checks = issues => ({ valid: !issues.length, issues, warnings: issues.map(issue => issue.message) });
const state = overrides => ({ original: 'Original authored briefing', content: 'Original authored briefing', reviewed: {},
  manifest: { publicationValidation: checks([note]) }, receipt: { integrity: 'verified' }, readingChecks: null,
  disposition: { status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'not-reviewed' }, ...overrides });

describe('one reading-copy diagnostic presentation', () => {
  test('an advisory may matter to readers without holding publication or changing authored words', () => {
    const reading = state(); const before = JSON.stringify(reading);
    const result = briefPresentation(reading);
    expect(result.currentChecks).toMatchObject({ status: 'checked', basis: 'publication',
      issues: [{ ...note, audience: 'reader', consequence: 'note', acknowledged: false }], warnings: [note.message] });
    expect(result.copy).toMatchObject({ kind: 'published', contentSha256: sha256(reading.content) });
    expect(presentationSourceCheckStatus(result)).toBe('findings');
    expect(JSON.stringify(reading)).toBe(before);
  });

  test('classification is explicit; unknown notes survive rather than becoming hidden operator guidance', () => {
    expect(issueAudience({ code: 'JUDGMENT_ACTION_INVALID' })).toBe('operator');
    expect(issueAudience({ code: 'ACTION_DEPENDENCY_CONFLICT' })).toBe('reader');
    expect(issueAudience({ code: 'SOURCE_INDEPENDENCE_UNESTABLISHED' })).toBe('reader');
    expect(issueAudience({ code: 'FUTURE_UNKNOWN', message: 'Formatting harmless boilerplate' })).toBe('unclassified');
    const result = briefPresentation(state({ manifest: { publicationValidation: checks([{ code: 'FUTURE_UNKNOWN', severity: 'review', message: 'Retain this finding.' }]) } }));
    expect(result.currentChecks.issues[0]).toMatchObject({ audience: 'unclassified', message: 'Retain this finding.' });
  });

  test('current corrected findings stay separate from original and repaired-generation history', () => {
    const result = briefPresentation(state({ content: 'Corrected authored briefing', reviewed: { review: { status: 'editorially-corrected' } },
      readingChecks: { ...checks([note]), status: 'checked', checkedAt: '2026-10-09T12:00:00Z' },
      manifest: { publicationValidation: checks([originalIssue]), repairedDraft: { originalPublicationValidation: { ...checks([]), partial: true } } } }));
    expect(result.copy.kind).toBe('editorially-corrected');
    expect(result.currentChecks).toMatchObject({ basis: 'corrected-copy', warnings: [note.message] });
    expect(result.history).toEqual([
      expect.objectContaining({ kind: 'original-publication', warnings: [originalIssue.message] }),
      expect.objectContaining({ kind: 'original-generation', issues: [expect.objectContaining({ code: 'GENERATION_INCOMPLETE' })] }),
    ]);
  });

  test('repaired checks normalize to checked while preserving the original partial attempt', () => {
    const result = briefPresentation(state({ manifest: { publicationValidation: { ...checks([]), sourceCheckStatus: 'checked-supported-forms' },
      repairedDraft: { originalPublicationValidation: { partial: true, issues: [] } } } }));
    expect(result.copy.kind).toBe('operator-repaired');
    expect(result.currentChecks.status).toBe('checked');
    expect(presentationSourceCheckStatus(result)).toBe('passed-supported-checks');
    expect(result.history[0].issues[0].code).toBe('GENERATION_INCOMPLETE');
  });

  test('approval is scoped and acknowledged only for the exact eligible reading copy', () => {
    const content = 'Control exception text';
    const issue = { code: 'SECURITY_CONTROL_CHANGE', severity: 'review', message: 'Review the proposed control change.' };
    const reading = state({ original: content, content, manifest: { publicationValidation: checks([issue]) },
      disposition: { status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'reviewed', scope: 'security-control-change',
        readingSha256: sha256(content), reviewer: 'Operator', reason: 'Reviewed this exception.', reviewedAt: '2026-10-09T12:00:00Z' } });
    expect(briefPresentation(reading)).toMatchObject({ approval: { status: 'recorded', scope: 'security-control-change' }, currentChecks: { issues: [{ code: 'SECURITY_CONTROL_CHANGE', consequence: 'review', acknowledged: true }] } });
    const changed = briefPresentation({ ...reading, content: 'Different control exception' });
    expect(changed.approval.status).toBe('stale');
    expect(changed.currentChecks.issues[0].acknowledged).toBe(false);
  });

  test('legacy metadata and operational warnings cannot replace verified findings', () => {
    const result = briefPresentation(state(), { legacyWarnings: [note.message, 'QA review: Legacy annotation.', 'Search index failed — this brief will not appear in search until the next reindex.'] });
    expect(result.currentChecks.warnings).toEqual([note.message]);
    expect(result.history).toEqual([expect.objectContaining({ kind: 'legacy-metadata', warnings: ['QA review: Legacy annotation.'] })]);
    expect(result.operationalNotes).toEqual([expect.objectContaining({ code: 'SEARCH_INDEX_UNAVAILABLE' })]);
  });

  test('unavailable and absent records differ, and diagnostic revision excludes check timestamps', () => {
    expect(briefPresentation(state({ manifest: null, receipt: { integrity: 'missing' } })).currentChecks.status).toBe('not-recorded');
    expect(briefPresentation(state({ manifest: null, receipt: { integrity: 'invalid' } })).currentChecks).toMatchObject({ status: 'unavailable', issues: [expect.objectContaining({ code: 'VALIDATION_UNAVAILABLE' })] });
    expect(briefPresentation(state({ manifest: { publicationValidation: { status: 'unavailable', issues: [] } } })).currentChecks.status).toBe('unavailable');
    const first = state({ content: 'Corrected copy', reviewed: { review: { status: 'editorially-corrected' } }, readingChecks: { ...checks([note]), checkedAt: '2026-10-09T12:00:00Z' } });
    const later = { ...first, readingChecks: { ...first.readingChecks, checkedAt: '2026-10-09T13:00:00Z' } };
    expect(briefPresentation(first).revision).toBe(briefPresentation(later).revision);
    expect(briefPresentation({ ...later, readingChecks: checks([]) }).revision).not.toBe(briefPresentation(first).revision);
  });
});

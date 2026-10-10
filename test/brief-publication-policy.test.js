import { expect, test } from '@jest/globals';
import { publicationDecision, hasHardFail, hasTrustCriticalFailure, isMaterialReviewIssue } from '../lib/validation.js';
import { readingDisposition } from '../lib/brief-reading-checks.js';
import { editorialIssues } from '../lib/brief-editorial.js';
import { BRIEF_EVALUATION_CASES, referenceBrief } from './fixtures/brief-evaluation.js';

test.each([
  ['CITATION_IDENTITY_INVALID', 'trust'], ['CVE_CITATION_MISMATCH', 'trust'],
  ['CVE_CVSS_MISMATCH', 'trust'], ['CVSS_UNSUPPORTED', 'trust'], ['FACT_CVSS_UNSUPPORTED', 'trust'],
  ['VERSION_UNSUPPORTED', 'trust'], ['KEV_DEADLINE_MISMATCH', 'trust'],
  ['JUDGMENT_CITATION_MISSING', 'trust'], ['JUDGMENT_EVIDENCE_WEAK', 'trust'],
  ['ACTION_DEPENDENCY_CONFLICT', 'trust'], ['UNKNOWN_FUTURE_CHECK', 'trust'],
  ['ACTION_SUMMARY_CONFLICT', 'trust'],
  ['ENUMERATED_COUNT_MISMATCH', 'trust'], ['FACT_CVE_COUNT_MISMATCH', 'trust'],
  ['FACT_CVE_WINDOW_MISMATCH', 'trust'],
  ['UNKNOWN_REQUIRED_STRUCTURE', 'structure'],
])('keeps concrete or unknown severe failures blocking: %s', (code, severity) => {
  const issue = { code, severity, message: 'Captured evidence or required structure failed.' };
  const result = publicationDecision({ issues: [issue] });
  expect(result).toEqual({ blockers: [issue], reviewIssues: [], notes: [], canPublish: false, requiresReview: false });
  expect(isMaterialReviewIssue(issue)).toBe(true);
  expect(hasHardFail([issue]) || hasTrustCriticalFailure([issue])).toBe(true);
  expect(readingDisposition({ status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'reviewed' }, { issues: [issue] }).eligibleForLatest).toBe(false);
});

test.each([
  ['CITED_SOURCE_LIMITED', 'review'], ['SUPPORTING_SECTION_PROVENANCE_REQUIRED', 'review'],
  ['ACTION_LOOKBACK_BASIS_REQUIRED', 'review'], ['ACTION_RECOVERY_INCOMPLETE', 'review'],
  ['ACTION_ARTIFACT_UNSPECIFIED', 'review'], ['ANY_NAMED_EDITORIAL_NOTE', 'review'],
  ['CONVERGENCE_FORMAT_INVALID', 'structure'], ['FORECAST_UNRESOLVABLE', 'structure'],
  ['JUDGMENT_ACTION_INVALID', 'structure'], ['JUDGMENT_HORIZON_INVALID', 'structure'],
  ['APPLICABILITY_ACTION_UNCONDITIONAL', 'trust'], ['INDEPENDENCE_UNESTABLISHED', 'trust'],
  ['ACTION_SUMMARY_OWNER_CONFLICT', 'trust'],
  ['FACT_CVE_WINDOW_UNVERIFIED', 'trust'], ['FACT_EVENT_TIMELINE_UNSUPPORTED', 'trust'],
])('retains routine findings as notes without retrying or holding: %s', (code, severity) => {
  const issue = { code, severity, message: 'Editorial concern.' };
  const result = publicationDecision({ valid: false, hardFail: true, trustFail: true,
    coverage: { materialReviewRequired: true }, issues: [issue] });
  expect(result).toEqual({ blockers: [], reviewIssues: [], notes: [issue], canPublish: true, requiresReview: false });
  expect(isMaterialReviewIssue(issue)).toBe(false);
  expect(hasHardFail([issue])).toBe(false);
  expect(hasTrustCriticalFailure([issue])).toBe(false);
  expect(readingDisposition({ status: 'eligible', eligibleForLatest: true }, {
    issues: [issue], hardFail: true, trustFail: true, coverage: { materialReviewRequired: true },
  }).eligibleForLatest).toBe(true);
});

test('only an exact-copy operator review resolves a security-control exception', () => {
  const issue = { code: 'SECURITY_CONTROL_CHANGE', severity: 'review', message: 'Review the control exception.' };
  const checks = { issues: [issue], contentSha256: 'current' };
  expect(publicationDecision(checks)).toEqual({ blockers: [], reviewIssues: [issue], notes: [], canPublish: false, requiresReview: true });
  expect(hasHardFail([issue]) || hasTrustCriticalFailure([issue])).toBe(false);
  const approved = { status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'reviewed', readingSha256: 'current' };
  expect(readingDisposition(approved, checks)).toEqual(approved);
  expect(readingDisposition(approved, { ...checks, contentSha256: 'changed' }).eligibleForLatest).toBe(false);
  expect(checks.issues).toEqual([issue]);
});

test.each([
  { partial: true, issues: [] }, { status: 'unavailable', issues: [] },
  { integrity: 'invalid', issues: [] }, { hardFail: true }, { trustFail: true },
  { coverage: { materialReviewRequired: true } }, { valid: false },
])('fails closed on incomplete/unverifiable state or opaque legacy failure: %j', checks => {
  expect(publicationDecision(checks).blockers.length).toBeGreaterThan(0);
  expect(publicationDecision(checks).canPublish).toBe(false);
});

test('retaining a synthetic incomplete or unavailable finding does not duplicate it on reclassification', () => {
  for (const checks of [{ partial: true, issues: [] }, { status: 'unavailable', issues: [] }]) {
    const first = publicationDecision(checks);
    const retained = publicationDecision({ ...checks, issues: [...first.blockers, ...first.reviewIssues, ...first.notes] });
    expect(retained).toEqual(first);
    expect(retained.blockers).toHaveLength(1);
  }
});

test('legacy core-section messages block, watchlist quotas are editorial notes', () => {
  for (const message of ['Missing BLUF section', 'Missing Key Judgments section']) {
    expect(publicationDecision({ warnings: [message] }).canPublish).toBe(false);
  }
  expect(publicationDecision({ issues: [{ code: 'LEGACY_STRUCTURE', severity: 'structure', message: 'Unknown legacy core failure' }] }).canPublish).toBe(false);
  for (const message of ['Missing Watchlist section', 'Watchlist has 3 item(s) — expected at least 5']) {
    expect(publicationDecision({ issues: [{ code: 'LEGACY_STRUCTURE', severity: 'structure', message }] }).canPublish).toBe(true);
  }
});

test('missing core judgment content blocks but optional fields remain notes', () => {
  const issue = field => ({ code: 'JUDGMENT_FIELD_MISSING', severity: 'structure', message: `Signal 1 needs a populated ${field} field` });
  for (const field of ['Assessment', 'What happened']) expect(publicationDecision({ issues: [issue(field)] }).canPublish).toBe(false);
  for (const field of ['Confidence', 'The line', 'Decision window']) expect(publicationDecision({ issues: [issue(field)] }).canPublish).toBe(true);
  expect(publicationDecision({ issues: [issue('Unknown future core field')] }).canPublish).toBe(false);
});

test('executive targets compare calendar dates rather than equivalent display formats', () => {
  const text = referenceBrief(BRIEF_EVALUATION_CASES[0]);
  const changed = text.replace('identify applicable systems and review owners — recommended target September 8, 2026',
    'identify applicable systems and review owners — recommended target 2026-09-08');
  expect(editorialIssues(changed, []).filter(issue => issue.code.startsWith('ACTION_SUMMARY'))).toEqual([]);
  const contradiction = changed.replace('recommended target 2026-09-08', 'recommended target 2026-09-09');
  expect(publicationDecision({ issues: editorialIssues(contradiction, []) }).blockers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT' })]));
});

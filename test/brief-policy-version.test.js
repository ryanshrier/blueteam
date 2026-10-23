import { describe, expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { publicationDecision, validateBrief, VALIDATION_POLICY_VERSION } from '../lib/validation.js';
import { readingCopyChecks, recheckReadingCopy, readingDisposition, briefPresentation } from '../lib/brief-reading-checks.js';
import { applyBriefReview } from '../lib/brief-review.js';
import { sha256 } from '../lib/generation-manifest.js';

const a = 'CVE-2026-11111', b = 'CVE-2026-22222';
const citation = '[Vendor, October 9, 2026](https://vendor.example/advisory)';
const source = description => buildGroundingManifest({ headlines: [{ source: 'Vendor', date: '2026-10-09',
  title: `${a} and ${b} gateway fixes`, link: 'https://vendor.example/advisory', description }] });
function metrics(claim, description, field = 'What happened', version = VALIDATION_POLICY_VERSION) {
  const text = `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Gateway fixes\n**Assessment:** ${field === 'Assessment' ? claim : 'Review affected deployments.'}\n**What happened:** ${field === 'What happened' ? claim : `${a} and ${b} affect gateways.`} ${citation}\n`;
  const result = validateBrief(text, '2026-10-09', { publication: true, validationPolicyVersion: version,
    groundingManifest: source(description), kevSet: new Set() });
  return { ...result, issues: result.issues.filter(issue => /CVSS/.test(issue.code)), warnings: [] };
}

describe('versioned finding consequences', () => {
  test.each(['CVE_CVSS_AMBIGUOUS', 'ACTION_SUMMARY_ASSOCIATION_REVIEW', 'ACTION_PHASE_BUNDLE_REVIEW'])(
    '%s becomes a note only after a current-policy check', code => {
      const issue = { code, severity: 'trust', message: 'Association was not established.' };
      const historical = { issues: [issue] };
      expect(publicationDecision(historical).canPublish).toBe(false);
      expect(publicationDecision({ ...historical, validationPolicyVersion: 1 })).toEqual(publicationDecision(historical));
      const current = { ...historical, validationPolicyVersion: 2 };
      expect(publicationDecision(current)).toMatchObject({ blockers: [], reviewIssues: [], notes: [issue], canPublish: true });
      const disposition = { status: 'eligible', eligibleForLatest: true };
      expect(readingDisposition(disposition, historical).eligibleForLatest).toBe(false);
      expect(readingDisposition(disposition, current).eligibleForLatest).toBe(true);
      expect(historical).toEqual({ issues: [issue] });
    });

  test.each([null, '2', 0, 3])('an unknown explicit policy %j requires a recheck even with no findings', validationPolicyVersion => {
    const result = publicationDecision({ validationPolicyVersion, issues: [] });
    expect(result.blockers.map(issue => issue.code)).toEqual(['VALIDATION_POLICY_UNSUPPORTED']);
    expect(publicationDecision({ validationPolicyVersion, issues: result.blockers }).blockers).toHaveLength(1);
  });

  test.each(['What happened', 'Assessment'])('missing metric bindings in %s are notes, while supported conflicts still block', field => {
    const unbound = `${a} and ${b} affect gateways. The initial CVSS v3.1 9.8 was followed by CVSS v3.1 5.0. Verify affected deployments.`;
    const current = metrics(`${a}: CVSS v3.1 9.8.`, unbound, field);
    expect(current.validationPolicyVersion).toBe(2);
    expect(current.issues.map(issue => issue.code)).toContain('CVE_CVSS_UNVERIFIED');
    expect(publicationDecision(current).canPublish).toBe(true);
    expect(publicationDecision(metrics(`${a}: CVSS v3.1 9.8.`, unbound, field, 1)).canPublish).toBe(false);
    expect(publicationDecision(metrics(`${a}: CVSS v3.1 9.9.`, unbound, field)).canPublish).toBe(false);
    const bound = `${a}: CVSS v3.1 5.0. ${b}: provisional CVSS v4.0 9.8. Apply the corresponding gateway fixes.`;
    for (const claim of [`${a}: CVSS v3.1 9.8.`, `${b}: CVSS v3.1 9.8 (provisional).`, `${b}: CVSS v4.0 9.8, the final score.`]) {
      expect(publicationDecision(metrics(claim, bound, field)).blockers.map(issue => issue.code)).toContain('CVE_CVSS_MISMATCH');
    }
  });

  test('an unbound claim keeps a note without permitting an invented numeric score', () => {
    const bound = `${a}: CVSS v3.1 5.0. ${b}: CVSS v3.1 9.8. Apply the corresponding gateway fixes.`;
    expect(publicationDecision(metrics(`${a} and ${b} have CVSS v3.1 9.8.`, bound)).canPublish).toBe(true);
    expect(publicationDecision(metrics(`${a} and ${b} have CVSS v3.1 9.9.`, bound)).blockers.map(issue => issue.code)).toContain('CVSS_UNSUPPORTED');
  });
});

describe('retained corrected-copy checks', () => {
  const original = '# Original\n';
  const review = { schemaVersion: 1, originalSha256: sha256(original), corrections: [{ id: 'title',
    original: 'Original', replacement: 'Corrected', reason: 'Clarify the title.' }] };
  const manifest = { outputSha256: sha256(original), edition: { date: '2026-10-09' }, grounding: { sources: [], cves: [], urls: [] } };
  const reviewed = applyBriefReview(original, review);

  test('legacy replay remains explicitly policy 1 and an explicit recheck records current policy without mutating history', () => {
    const before = JSON.stringify({ manifest, review });
    expect(readingCopyChecks(original, reviewed, manifest)).toMatchObject({ validationPolicyVersion: 1, checkBasis: 'legacy-replay' });
    const checked = recheckReadingCopy(original, reviewed, manifest);
    expect(checked).toMatchObject({ validationPolicyVersion: 2, checkBasis: 'explicit-recheck',
      contentSha256: sha256(reviewed.reviewedContent), inputSha256: sha256(JSON.stringify(manifest)) });
    expect(JSON.stringify({ manifest, review })).toBe(before);
    const retained = { ...checked, checkedAt: '2026-10-09T12:00:00Z' };
    const projected = applyBriefReview(original, { ...review, readingChecks: retained });
    expect(readingCopyChecks(original, projected, manifest)).toEqual({ ...retained, checkBasis: 'retained-checks' });
  });

  test.each(['contentSha256', 'originalSha256', 'inputSha256'])('stale %s cannot attach a passing check to another copy or input', key => {
    const checked = { ...recheckReadingCopy(original, reviewed, manifest), [key]: 'wrong' };
    const projected = applyBriefReview(original, { ...review, readingChecks: checked });
    const reading = readingCopyChecks(original, projected, manifest);
    expect(reading).toMatchObject({ status: 'unavailable', integrity: 'invalid' });
    expect(publicationDecision(reading).canPublish).toBe(false);
  });

  test('presentation preserves separate versions for original publication and corrected checks', () => {
    const issue = { code: 'CVE_CVSS_AMBIGUOUS', severity: 'trust', message: 'Unverified association.' };
    const checks = { issues: [issue], warnings: [issue.message], validationPolicyVersion: 2, checkBasis: 'retained-checks' };
    const presentation = briefPresentation({ original, content: reviewed.reviewedContent, reviewed,
      manifest: { ...manifest, publicationValidation: { issues: [issue], warnings: [issue.message] } },
      receipt: { integrity: 'verified' }, readingChecks: checks, disposition: { status: 'eligible', eligibleForLatest: true } });
    expect(presentation.currentChecks).toMatchObject({ validationPolicyVersion: 2, checkBasis: 'retained-checks',
      issues: [expect.objectContaining({ consequence: 'note' })] });
    expect(presentation.history[0]).toMatchObject({ validationPolicyVersion: 1,
      issues: [expect.objectContaining({ consequence: 'block' })] });
  });
});

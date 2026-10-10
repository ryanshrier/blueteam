import { describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { draftCheckLabel, draftReviewIssues, draftReviewFormHtml, publicationRequest, capturedEvidenceHtml } from '../public/modules/briefing/brief-drafts.js';
import { decisionCopyText, readerPresentationIssues } from '../public/modules/briefing/brief-renderer.js';
import { attachEditorialReview, readerEvidenceLimits } from '../public/modules/briefing/brief-review.js';
import { reclassifyRetainedSource } from '../lib/evidence-quality.js';

const coverage = { code: 'PRIORITY_COVERAGE_MISSING', message: 'Explain why this priority advisory was deferred.', audience: 'reader', consequence: 'review', location: { scope: 'document', line: 1 } };
const association = { code: 'ACTION_SUMMARY_ASSOCIATION_REVIEW', message: 'Confirm the action associated with this summary deadline.', audience: 'reader', consequence: 'review', signal: 1 };
const security = { code: 'SECURITY_CONTROL_CHANGE', message: 'Review the scoped control exception.', audience: 'reader', consequence: 'review', signal: 1 };
const artifact = issues => ({ manifestSha256: 'a'.repeat(64), revisions: [{ number: 3, content: 'Saved text', sha256: 'b'.repeat(64) }],
  publicationDecision: { blockers: [], reviewIssues: issues, notes: [], requiresReview: true, canPublish: false } });
const review = { confirmed: true, reviewer: ' Duty analyst ', reason: ' Deferral is justified by the captured duplicate advisory. ' };

describe('current editorial review in draft publication', () => {
  test('submits only the exact current review issue codes with the saved text identity', () => {
    const captured = artifact([coverage, association, coverage]);
    expect(publicationRequest(captured, 'Saved text', { ...review, issueCodes: ['INVENTED_CODE'] })).toEqual({
      content: 'Saved text', baseRevision: 3, inputSha256: 'a'.repeat(64),
      editorialReview: { reviewer: 'Duty analyst', reason: review.reason.trim(), contentSha256: 'b'.repeat(64),
        issueCodes: ['ACTION_SUMMARY_ASSOCIATION_REVIEW', 'PRIORITY_COVERAGE_MISSING'] },
    });
  });

  test('a mixed review includes the control exception under the broader explicit scope', () => {
    const request = publicationRequest(artifact([coverage, security]), 'Saved text', review);
    expect(request.editorialReview.issueCodes).toEqual(['PRIORITY_COVERAGE_MISSING', 'SECURITY_CONTROL_CHANGE']);
    expect(request.securityControlReview).toBeUndefined();
    expect(draftCheckLabel({}, artifact([coverage, security]).publicationDecision)).toBe('Draft saved · editorial review required');
  });

  test('keeps the specific security review contract and labels when that is the only finding', () => {
    const captured = artifact([security]);
    expect(publicationRequest(captured, 'Saved text', review).securityControlReview).toMatchObject({ contentSha256: 'b'.repeat(64) });
    expect(draftCheckLabel({}, captured.publicationDecision)).toBe('Draft saved · specific control review required');
    expect(draftReviewFormHtml([security])).toContain('Review these security-control changes');
  });

  test('changed text must be rechecked before any generic or mixed approval', () => {
    for (const issues of [[coverage], [coverage, security]]) {
      expect(() => publicationRequest(artifact(issues), 'Changed text', review)).toThrow('draft changed');
      expect(publicationRequest(artifact(issues), 'Changed text')).toEqual({ content: 'Changed text', baseRevision: 3, inputSha256: 'a'.repeat(64) });
      expect(() => publicationRequest(artifact(issues), 'Saved text', { ...review, confirmed: false })).toThrow('specific editorial review');
      expect(() => publicationRequest(artifact(issues), 'Saved text', { ...review, reason: ' ' })).toThrow('specific editorial review');
    }
  });

  test('blockers suppress the review form and cannot be waived by a forged review request', () => {
    const captured = artifact([coverage, security]);
    captured.publicationDecision.blockers = [{ code: 'ACTION_SUMMARY_CONFLICT', message: 'Contradictory deadline.' }];
    expect(draftReviewIssues(captured)).toEqual([]);
    expect(draftReviewFormHtml(draftReviewIssues(captured))).toBe('');
    expect(() => publicationRequest(captured, 'Saved text', review)).toThrow('Resolve required fixes');
    expect(() => publicationRequest(artifact([]), 'Saved text', review)).toThrow('Resolve required fixes');
  });

  test('the generic form lists every current concern, explains the evidence requirement, and escapes input', () => {
    const html = draftReviewFormHtml([coverage, { ...association, message: '<script>untrusted</script>' }, security], { changed: true });
    expect(html).toContain('Review these editorial findings');
    expect(html).toContain(coverage.message);
    expect(html).toContain(security.message);
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('given these findings and the captured evidence');
    expect(html).toContain('I reviewed these specific findings');
    expect(html).toContain('<p data-control-changed>');
  });
});

describe('scoped approval in reader and copied decisions', () => {
  const presentation = () => ({ schemaVersion: 1, currentChecks: { status: 'checked', issues: [coverage, association, security].map(issue => ({ ...issue, acknowledged: true })) },
    approval: { status: 'recorded', scope: 'briefing-editorial', reviewer: 'Duty analyst', reason: 'Recorded evidence-based exception.', issueCodes: [coverage.code, security.code] } });

  test('only exact recorded codes are acknowledged and the remaining concern stays visible', () => {
    const state = presentation();
    expect(readerPresentationIssues(state).map(issue => [issue.code, issue.acknowledged])).toEqual([
      [coverage.code, true], [association.code, false], [security.code, true],
    ]);
    expect(readerEvidenceLimits({ presentation: state }).map(issue => issue.code)).toEqual([association.code]);
    const text = decisionCopyText({ action: 'Verify deployment first.', signal: 1, editionUrl: 'https://desk.test/briefing/brief-2026-10-09.md', presentation: state });
    expect(text).toContain(`Reviewed editorial finding: ${coverage.message}`);
    expect(text).toContain(`Reviewed control exception: ${security.message}`);
    expect(text).toContain(association.message);
    expect(text).not.toContain(`Reviewed editorial finding: ${association.message}`);
    expect(text).toContain('Specific editorial findings reviewed · Duty analyst');
  });

  test.each(['stale', 'unavailable', 'not-recorded'])('a %s approval cannot acknowledge findings in the current copy', status => {
    const state = presentation();
    state.approval.status = status;
    expect(readerPresentationIssues(state).every(issue => issue.acknowledged === false)).toBe(true);
    expect(readerEvidenceLimits({ presentation: state })).toHaveLength(3);
    const text = decisionCopyText({ action: 'Verify deployment first.', signal: 1, editionUrl: 'https://desk.test/briefing/brief-2026-10-09.md', presentation: state });
    expect(text).not.toContain('Duty analyst');
    expect(text).not.toContain('Reviewed editorial finding:');
  });

  test('generic approval with absent codes does not suppress any finding', () => {
    const state = presentation();
    delete state.approval.issueCodes;
    expect(readerEvidenceLimits({ presentation: state })).toHaveLength(3);
    expect(readerPresentationIssues(state).every(issue => issue.acknowledged === false)).toBe(true);
  });

  test('the edition record describes the actual scope and marks only its covered findings', () => {
    const state = presentation();
    const nodes = [];
    const content = { ownerDocument: { createElement: tagName => ({ tagName }) }, querySelectorAll: () => [], querySelector: () => null, prepend: node => nodes.push(node) };
    attachEditorialReview(content, { presentation: state });
    expect(nodes[0].innerHTML).toContain('Specific editorial review');
    expect(nodes[0].innerHTML).toContain('This approval applies only to the findings marked with a specific review in this copy.');
    expect(nodes[0].innerHTML.match(/Specific review recorded/g)).toHaveLength(2);
    expect(nodes[0].innerHTML).not.toContain('Specific security-control review');
  });
});

describe('current source-quality diagnostics in draft evidence', () => {
  const feed = 'CISA added five exploited vulnerabilities to its catalog and set the federal remediation deadline for October 11, including CVE-2015-3306.';
  const advert = 'You Secure the Apps. Now the Apps Have LLMs in Them. Find SANS training for app sec and cloud teams who inherited GenAI risk, from RAG pipelines to AI agents.';
  const part = (kind, passage) => ({ kind, passage, passageSha256: createHash('sha256').update(passage).digest('hex'), quality: { substantive: true, status: 'substantive' } });
  function captured({ feedPresent = true } = {}) {
    const source = { id: 'S5.1', label: 'The Hacker News', title: 'Flax Typhoon Exploits Five Flaws as CISA Sets October 11 Deadline for Federal Agencies',
      url: 'https://example.test/flax-typhoon', passage: advert, passageKind: 'article-excerpts', evidenceText: advert,
      quality: { substantive: true, status: 'substantive' }, sourceParts: [...(feedPresent ? [part('feed-excerpt', feed)] : []), part('article-excerpts', advert)] };
    const assessment = reclassifyRetainedSource(source).qualityAssessment;
    return { ...artifact([]), manifest: { grounding: { sources: [source] } },
      lastCheck: { revision: 3, contentSha256: 'b'.repeat(64), validation: { sourceQuality: { policyVersion: assessment.policyVersion, sources: [{ id: source.id, ...assessment }] } } } };
  }

  test('uses retained feed evidence while moving the exact rejected advertisement into a collapsed audit disclosure', () => {
    const value = captured();
    const before = JSON.stringify(value.manifest);
    // Diagnostic order is not an identity binding.
    value.lastCheck.validation.sourceQuality.sources[0].parts.reverse();
    const html = capturedEvidenceHtml(value);
    expect(html).toContain('data-draft-source="S5.1"');
    expect(html).toContain('href="https://example.test/flax-typhoon"');
    expect(html).toContain('Current evidence filtered');
    expect(html).toContain('Retained feed evidence remains available.');
    expect(html).toContain('Advertisement, promotional, or access-page text was excluded.');
    expect(html).toContain(`<section class="draft-current-evidence"><p>Retained feed evidence</p><blockquote>${feed}</blockquote></section>`);
    const audit = html.indexOf('<details class="draft-excluded-evidence">');
    expect(audit).toBeGreaterThan(0);
    expect(html.slice(0, audit)).not.toContain(advert);
    expect(html.slice(audit)).toContain(advert);
    expect(html).not.toContain('draft-excluded-evidence" open');
    expect(JSON.stringify(value.manifest)).toBe(before);
  });

  test('an entirely excluded source no longer presents its old substantive label as usable support', () => {
    const html = capturedEvidenceHtml(captured({ feedPresent: false }));
    expect(html).toContain('No usable passage remains for current checks.');
    expect(html).not.toContain('class="draft-current-evidence"');
    expect(html).toContain('These passages are not used as current supporting evidence.');
  });

  test('an accepted diagnostic cannot attach to a different retained passage digest', () => {
    const value = captured();
    value.manifest.grounding.sources[0].sourceParts[0].passageSha256 = 'f'.repeat(64);
    const html = capturedEvidenceHtml(value);
    expect(html).toContain('its passage could not be matched to this receipt');
    expect(html).not.toContain('class="draft-current-evidence"');
    expect(html).toContain(feed);
  });

  test('stale revision diagnostics are not shown as current classification', () => {
    const value = captured();
    value.lastCheck.contentSha256 = 'c'.repeat(64);
    const html = capturedEvidenceHtml(value);
    expect(html).not.toContain('Current evidence filtered');
    expect(html).not.toContain('Retained feed evidence remains available.');
  });

  test('dated source context is a separate disclosure and never becomes accepted current evidence', () => {
    const value = captured();
    const earlier = 'Earlier investigation: attempts were observed; successful exploitation remains unconfirmed. <script>bad()</script>';
    value.manifest.grounding.sources[0].historicalCaptures = [{ passage: earlier, publishedAt: '2026-10-08T09:00:00Z',
      retrievedAt: '2026-10-08T14:00:00Z', currentFactAuthority: false, retrievalStatus: 'prior-receipt-not-refreshed',
      retainedFrom: { sourceId: 'S2.1', generationId: 'prior', capturedAt: '2026-10-08T15:00:00Z' } }];
    const before = JSON.stringify(value.manifest);
    const html = capturedEvidenceHtml(value);
    const start = html.indexOf('<details class="brief-historical-context">');
    expect(start).toBeGreaterThan(0);
    expect(html.slice(0, start)).not.toContain('Earlier investigation');
    expect(html).toContain('Captured evidence · 1 sources');
    expect(html.match(/class="draft-current-evidence"/g)).toHaveLength(1);
    expect(html).toContain('Earlier captured source context');
    expect(html).toContain('not refreshed for this edition');
    expect(html).toContain('does not establish current facts');
    expect(html).toContain('Retrieved Oct 8, 2026, 14:00 UTC');
    expect(html).toContain('Originally published Oct 8, 2026, 09:00 UTC');
    expect(html).toContain('input receipt captured Oct 8, 2026, 15:00 UTC');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(JSON.stringify(value.manifest)).toBe(before);
  });
});

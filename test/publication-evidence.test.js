import { describe, expect, test } from '@jest/globals';
import { buildGroundingManifest, sourcePublicationDay } from '../lib/grounding.js';
import { buildUserPrompt } from '../lib/prompts.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';

const vendor = {
  source: 'Vendor', title: 'CVE-2026-1234 vulnerability',
  description: 'This vulnerability has CVSS 9.8.',
  link: 'https://vendor.example/advisory', date: '2026-09-04', horizon: 1,
};
const citation = '[Vendor, September 4, 2026](https://vendor.example/advisory)';
function auditClaim(claim, headlines = [vendor], citations = citation) {
  // Deliberately isolate the evidence contract from unrelated length/layout
  // checks; each assertion below addresses a publication trust issue.
  const text = `## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Verify applicability
**What happened:** ${claim} ${citations}
**Decision window:** 72 hours
`;
  return validateBrief(text, '2026-09-05', {
    publication: true, groundingManifest: buildGroundingManifest({ headlines }), kevSet: new Set(),
  });
}

describe('publisher calendar dates shared by prompting and validation', () => {
  test.each([
    ['Fri, 04 Sep 2026 22:00:00 -0500', '2026-09-04'],
    ['2026-09-04T22:00:00-05:00', '2026-09-04'],
    ['Sat, 05 Sep 2026 00:30:00 +0900', '2026-09-05'],
    ['2026-09-05T00:30:00+09:00', '2026-09-05'],
    ['4 September 2026 22:00:00 -0500', '2026-09-04'],
    ['2024-02-29', '2024-02-29'],
    ['2026-02-29', ''],
    ['2026-02-30T00:00:00Z', ''],
    ['31 Apr 2026 12:00:00 GMT', ''],
    ['not a date', ''],
    ['', ''],
    [null, ''],
  ])('normalizes %s without changing its explicit day', (raw, expected) => {
    expect(sourcePublicationDay(raw)).toBe(expected);
  });

  test('a faithful late-evening RFC citation resolves to the same source as an ISO citation', () => {
    const source = { ...vendor, date: 'Fri, 04 Sep 2026 22:00:00 -0500' };
    const result = auditClaim('CVE-2026-1234 CVSS 9.8.', [source]);
    expect(hasTrustCriticalFailure(result.issues)).toBe(false);
    expect(result.judgmentEvidence).toEqual([{ signal: 1, sourceIds: ['S1.1'] }]);
    expect(auditClaim('CVE-2026-1234 CVSS 9.8.', [source], citation.replace('September 4', 'September 5')).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CITATION_IDENTITY_INVALID' })]));
  });

  test('prompt labels use the canonical citation day and retain the original timestamp separately', () => {
    const source = { ...vendor, date: 'Fri, 04 Sep 2026 22:00:00 -0500' };
    const prompt = buildUserPrompt({ headlines: [source], config: {}, editionContext: { date: '2026-09-05' } });
    expect(prompt).toContain('Published: <source>2026-09-04</source>');
    expect(prompt).toContain('Publisher timestamp (original): <source>Fri, 04 Sep 2026 22:00:00 -0500</source>');
  });
});

describe('per-source CVE and CVSS association', () => {
  test('accepts a sentence-final version while rejecting a longer version or suffix', () => {
    const claim = 'Manager version 2.1.';
    expect(auditClaim(claim, [{ ...vendor, description: 'Manager version 2.1.' }]).issues.map(issue => issue.code)).not.toContain('VERSION_UNSUPPORTED');
    for (const version of ['2.1.7', '2.1-beta']) {
      expect(auditClaim(claim, [{ ...vendor, description: `Manager version ${version}.` }]).issues.map(issue => issue.code)).toContain('VERSION_UNSUPPORTED');
    }
  });

  test.each(['CVSS 10.0', 'CVSS score 10.0', 'CVSS v3.1 score 10.0', 'CVSS 3.1 base score 10.0'])(
    'reads the complete supported score in %s', score => {
      const source = { ...vendor, description: 'CVE-2026-1234 has CVSS score 10.0.' };
      expect(hasTrustCriticalFailure(auditClaim(`CVE-2026-1234 ${score}.`, [source]).issues)).toBe(false);
    },
  );

  test('CVSS 10.0 cannot borrow support from a cited score of 0.0', () => {
    const source = { ...vendor, description: 'CVE-2026-1234 has CVSS score 0.0.' };
    expect(auditClaim('CVE-2026-1234 CVSS 10.0.', [source]).issues.map(issue => issue.code))
      .toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']));
  });

  test('one source with one CVE and one nonadjacent score supports that pair', () => {
    expect(hasTrustCriticalFailure(auditClaim('CVE-2026-1234 CVSS 9.8.').issues)).toBe(false);
  });

  test('an invented score remains blocked', () => {
    expect(auditClaim('CVE-2026-1234 CVSS 9.9.').issues.map(issue => issue.code))
      .toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']));
  });

  test('an ambiguous source with multiple distinct scores does not imply a pair', () => {
    const source = { ...vendor, description: 'Initial CVSS 9.8; revised CVSS 4.3.' };
    expect(auditClaim('CVE-2026-1234 CVSS 9.8.', [source]).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CVE_CVSS_MISMATCH' })]));
  });

  test('an ambiguous source with multiple CVEs does not imply either score association', () => {
    const source = { ...vendor, title: 'CVE-2026-1234 and CVE-2026-5678 vulnerabilities' };
    expect(auditClaim('CVE-2026-1234 CVSS 9.8.', [source]).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CVE_CVSS_MISMATCH' })]));
  });

  test('separate single-CVE sources do not permit their scores to be swapped', () => {
    const other = { ...vendor, source: 'Other', title: 'CVE-2026-5678 vulnerability',
      description: 'This vulnerability has CVSS 4.3.', link: 'https://other.example/advisory' };
    const citations = `${citation} [Other, September 4, 2026](${other.link})`;
    const result = auditClaim('CVE-2026-1234 CVSS 4.3; CVE-2026-5678 CVSS 9.8.', [vendor, other], citations);
    expect(result.issues.filter(issue => issue.code === 'CVE_CVSS_MISMATCH')).toHaveLength(2);
    expect(hasTrustCriticalFailure(auditClaim('CVE-2026-1234 CVSS 9.8; CVE-2026-5678 CVSS 4.3.', [vendor, other], citations).issues)).toBe(false);
  });

  test('a source ending with a CVE cannot borrow a score from the following cited source', () => {
    const first = { ...vendor, title: 'CVE-2026-1234', description: '' };
    const second = { ...vendor, source: 'Other', title: 'CVSS 9.8', description: '', link: 'https://other.example/score' };
    const result = auditClaim('CVE-2026-1234 CVSS 9.8.', [first, second],
      `${citation} [Other, September 4, 2026](${second.link})`);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CVE_CVSS_MISMATCH' })]));
  });
});

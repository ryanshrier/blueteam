import { describe, expect, test } from '@jest/globals';
import { captureKevTiming, validateBrief } from '../lib/validation.js';
import { buildGroundingManifest } from '../lib/grounding.js';

const cves = ['CVE-2026-83548', 'CVE-2026-83549'];
const kevSet = new Set(cves);
const timing = captureKevTiming(Object.fromEntries(cves.map(cve => [cve, { date_added: '2026-09-02', due_date: '2026-09-05' }])), kevSet);
function deadlineIssues(claim, kevTiming = timing) {
  const headline = { title: cves.join(' and '), source: 'Synthetic publisher', date: '2026-09-02', description: claim, link: '' };
  const text = `## KEY JUDGMENTS\n\n### Signal 1 — [Horizon 1] Verify the appliance\n\n**What happened:** ${claim} [Synthetic publisher, September 2, 2026]\n`;
  return validateBrief(text, '2026-09-05', { publication: true, groundingManifest: buildGroundingManifest({ headlines: [headline] }), kevSet, kevTiming }).issues
    .filter(issue => issue.code.startsWith('KEV_DEADLINE_'));
}

describe('captured CISA KEV remediation dates', () => {
  test('blocks the observed two-CVE plural deadline contradiction even when publisher text repeats it', () => {
    const claim = 'SonicWall disclosed CVE-2026-83548 (CVSS 10.0) and CVE-2026-83549 (CVSS 7.8) on September 1, 2026; both added to CISA KEV September 2, 2026, FCEB remediation due September 16, 2026.';
    expect(deadlineIssues(claim).map(issue => issue.code)).toEqual(['KEV_DEADLINE_MISMATCH', 'KEV_DEADLINE_MISMATCH']);
    expect(deadlineIssues(claim.replace('September 16', 'September 5'))).toEqual([]);
  });

  test('checks separately named deadlines without borrowing another CVE date', () => {
    const distinct = { ...timing, [cves[1]]: { ...timing[cves[1]], dueDate: '2026-09-09' } };
    expect(deadlineIssues('CISA KEV CVE-2026-83548 remediation due 2026-09-05; CVE-2026-83549 remediation due 2026-09-09.', distinct)).toEqual([]);
    expect(deadlineIssues('CISA KEV CVE-2026-83548 remediation due 2026-09-09; CVE-2026-83549 remediation due 2026-09-05.', distinct)).toHaveLength(2);
  });

  test('checks the published remediation-for-CVEs phrase for one or two explicit CVEs', () => {
    const sonicWall = 'CVE-2026-83548 and CVE-2026-83549 affect SonicWall SMA1000 appliances. Both were added to CISA KEV September 2, 2026 with FCEB remediation for CVE-2026-83548 and CVE-2026-83549 due 2026-09-05.';
    expect(deadlineIssues(sonicWall)).toEqual([]);
    expect(deadlineIssues(sonicWall.replace('due 2026-09-05', 'due 2026-09-16')).map(issue => issue.code))
      .toEqual(['KEV_DEADLINE_MISMATCH', 'KEV_DEADLINE_MISMATCH']);
    const single = 'CVE-2026-83548 was added to CISA KEV September 2, 2026 with FCEB remediation for CVE-2026-83548 due 2026-09-05.';
    expect(deadlineIssues(single)).toEqual([]);
    expect(deadlineIssues(single.replace('due 2026-09-05', 'due 2026-09-16')))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_MISMATCH' })]);
  });

  test('an explicit remediation object does not borrow an earlier CVE deadline', () => {
    const distinct = { ...timing, [cves[1]]: { ...timing[cves[1]], dueDate: '2026-09-09' } };
    const claim = 'CVE-2026-83548 and CVE-2026-83549 are in CISA KEV, with FCEB remediation for CVE-2026-83549 due 2026-09-09.';
    expect(deadlineIssues(claim, distinct)).toEqual([]);
    const wrong = deadlineIssues(claim.replace('due 2026-09-09', 'due 2026-09-05'), distinct);
    expect(wrong).toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_MISMATCH', message: expect.stringContaining(cves[1]) })]);
  });

  test('unknown catalog dates and ambiguous plural associations remain unverified', () => {
    expect(deadlineIssues('CISA KEV CVE-2026-83548 remediation due September 5, 2026.', {}))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_UNVERIFIED' })]);
    expect(deadlineIssues('CVE-2026-83548 and CVE-2026-83549 are related; FCEB remediation due September 5, 2026.'))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_AMBIGUOUS' })]);
  });

  test('does not reinterpret organizational targets or negated and explicitly historical deadlines', () => {
    expect(deadlineIssues('CVE-2026-83548 is in CISA KEV. Infrastructure — verify exposure — recommended target September 16, 2026.')).toEqual([]);
    expect(deadlineIssues('CISA KEV CVE-2026-83548 is not remediation due September 16, 2026.')).toEqual([]);
    expect(deadlineIssues('CISA KEV CVE-2026-83548 previously had remediation due September 16, 2026; remediation due September 5, 2026.')).toEqual([]);
    expect(deadlineIssues('CISA KEV CVE-2026-83548 previously had remediation due September 5, 2026; remediation due September 16, 2026.'))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_MISMATCH' })]);
    expect(deadlineIssues('CISA KEV CVE-2026-83548 is not patched, FCEB remediation due September 16, 2026.'))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_MISMATCH' })]);
  });

  test('date-only records do not support invented federal clock times', () => {
    expect(deadlineIssues('CISA KEV CVE-2026-83548 remediation due September 5, 2026 at 5 PM UTC.'))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_PRECISION' })]);
  });

  test('capture rejects invalid dates and excludes CVEs outside verified membership', () => {
    expect(captureKevTiming({ [cves[0]]: { due_date: '2026-02-30' }, 'CVE-2026-99999': { due_date: '2026-09-05' } }, kevSet))
      .toEqual({ [cves[0]]: { dateAdded: null, dueDate: null, scope: 'FCEB', precision: 'day' } });
  });
});

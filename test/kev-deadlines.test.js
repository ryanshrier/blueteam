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
  test('binds a post-date CVE object without borrowing the other named CVE deadline', () => {
    const distinct = { ...timing, [cves[1]]: { ...timing[cves[1]], dueDate: '2026-09-16' } };
    const claim = 'CVE-2026-83548 and CVE-2026-83549 are listed. CISA FCEB remediation due 2026-09-05 for CVE-2026-83548 per system catalog record.';
    expect(deadlineIssues(claim, distinct)).toEqual([]);
    const issues = deadlineIssues(claim.replace('due 2026-09-05', 'due 2026-09-16'), distinct);
    expect(issues.map(issue => issue.code)).toEqual(['KEV_DEADLINE_MISMATCH']);
    expect(issues[0].location.line).toBe(5);
    expect(issues[0].location.excerpt).toContain('due 2026-09-16 for CVE-2026-83548');
  });
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

  test('rejects the retained September 6 draft remediation-for-both contradiction', () => {
    // Exact generated prose captured in brief-recovery/post-cvss-fix-rejected-draft.txt,
    // line 24; copied here so the regression does not depend on audit artifacts.
    const claim = 'CVE-2026-83548 (pre-auth SSRF, CVSS 10.0 per NVD) and CVE-2026-83549 (OS command injection, CVSS 7.8 per NVD) affect SMA1000 models 6210, 7210, 8200v running 12.4.3-03453 platform-hotfix and earlier, or 12.5.0-02835 platform-hotfix and earlier. Fixed in 12.4.3-03526 and 12.5.0-02952 platform-hotfix. CISA added both CVE-2026-83548 and CVE-2026-83549 to KEV on 2026-09-02, with FCEB remediation for both due 2026-09-16.';
    const result = deadlineIssues(claim);
    expect(result).toHaveLength(2);
    for (const cve of cves) expect(result).toContainEqual(expect.objectContaining({
      code: 'KEV_DEADLINE_MISMATCH', message: expect.stringContaining(`${cve} FCEB remediation deadline 2026-09-16 contradicts the captured CISA KEV date 2026-09-05`),
    }));
    expect(deadlineIssues(claim.replace('due 2026-09-16', 'due 2026-09-05'))).toEqual([]);
  });

  test.each(['both', 'both vulnerabilities', 'both CVEs', 'the two vulnerabilities'])(
    'binds remediation for %s to an unambiguous earlier pair in the same paragraph', reference => {
      const claim = `CVE-2026-83548 and CVE-2026-83549 affect the gateway. CISA added them to KEV, with FCEB remediation for ${reference} due 2026-09-05.`;
      expect(deadlineIssues(claim)).toEqual([]);
      expect(deadlineIssues(claim.replace('due 2026-09-05', 'due 2026-09-16')).map(issue => issue.code))
        .toEqual(['KEV_DEADLINE_MISMATCH', 'KEV_DEADLINE_MISMATCH']);
    },
  );

  test('a shared deadline must match each member of the pair individually', () => {
    const distinct = { ...timing, [cves[1]]: { ...timing[cves[1]], dueDate: '2026-09-09' } };
    const claim = 'CVE-2026-83548 and CVE-2026-83549 affect the gateway. FCEB remediation for both due 2026-09-05.';
    expect(deadlineIssues(claim, distinct)).toEqual([expect.objectContaining({
      code: 'KEV_DEADLINE_MISMATCH', message: expect.stringContaining(cves[1]),
    })]);
  });

  test.each([
    'CVE-2026-83548 is in KEV. FCEB remediation for both due 2026-09-05.',
    'CVE-2026-83548, CVE-2026-83549, and CVE-2026-99999 are in KEV. FCEB remediation for both due 2026-09-05.',
    'CVE-2026-83548 and CVE-2026-83549 are in KEV.\n\nFCEB remediation for both due 2026-09-05.',
    'FCEB remediation for both due 2026-09-05. CVE-2026-83548 and CVE-2026-83549 are in KEV.',
  ])('does not invent a pair or borrow across a paragraph: %s', claim => {
    expect(deadlineIssues(claim)).toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_AMBIGUOUS' })]);
  });

  test('an explicit current pair takes precedence over a different earlier paragraph CVE', () => {
    const claim = 'CVE-2026-99999 concerns another product. CISA added CVE-2026-83548 and CVE-2026-83549 to KEV, with FCEB remediation for both due 2026-09-05.';
    expect(deadlineIssues(claim)).toEqual([]);
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

  test('explicit per-CVE deadlines override both in an earlier catalog-addition clause', () => {
    const claim = 'CISA added both to KEV September 2, 2026: CVE-2026-83548 FCEB remediation due September 5, 2026; CVE-2026-83549 FCEB remediation due September 5, 2026.';
    expect(deadlineIssues(claim)).toEqual([]);
    expect(deadlineIssues(claim.replace('83549 FCEB remediation due September 5', '83549 FCEB remediation due September 16')))
      .toEqual([expect.objectContaining({ code: 'KEV_DEADLINE_MISMATCH', message: expect.stringContaining(cves[1]) })]);
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

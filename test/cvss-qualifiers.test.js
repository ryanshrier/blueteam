import { describe, expect, test } from '@jest/globals';
import { proseCvssScores, scoreSupportedBy } from '../lib/cvss.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';

const a = 'CVE-2026-12345', b = 'CVE-2026-54321';
const metric = { cve: a, score: 9.5, version: '4.0', type: 'Secondary', provisional: true, selected: true };
const nvdUrl = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${a}`;
const findings = (claim, field = 'What happened', metrics = [metric]) => {
  const groundingManifest = buildGroundingManifest({ headlines: [{ source: 'Vendor',
    title: `${a} gateway advisory`, link: 'https://vendor.example/gateway', date: '2026-10-09',
    description: `${a} affects the gateway. Verify applicable configurations.`,
    cveData: `${a}: CVSS v4.0 9.5 (Secondary assessment) (provisional)`, cvssMetrics: metrics,
  }] });
  const text = `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Review gateway\n**Assessment:** ${field === 'Assessment' ? claim : 'Verify applicable configurations.'}\n**What happened:** ${field === 'What happened' ? claim : `${a} affects the gateway.`} [NVD, date unavailable](${nvdUrl})\n`;
  return validateBrief(text, '2026-10-09', { publication: true, groundingManifest, kevSet: new Set() });
};
const cvssIssues = result => result.issues.filter(issue => /CVSS/.test(issue.code));

describe('provider-independent CVSS qualifier grammar', () => {
  test.each([
    `${a}: CVSS v4.0 9.5 (Secondary assessment) (provisional).`,
    `${a}: CVSS 4.0 9.5 (Secondary assessment) (provisional).`,
    `${a} has a provisional secondary CVSS v4.0 assessment of 9.5.`,
    `${a} has a provisional secondary CVSS 4.0 rating is 9.5.`,
    `${a}: CVSS v4.0 9.5 — provisional (Secondary assessment).`,
    `${a}: CVSS v4.0 9.5 (Secondary assessment) – provisional.`,
    `${a}: CVSS v4.0 9.5 (Secondary, provisional).`,
    `${a}: CVSS v4.0 9.5 — Secondary, provisional.`,
    `${a}: CVSS v4.0 9.5 (provisional, Secondary).`,
  ])('accepts the same captured assessment in %s', claim => {
    expect(proseCvssScores(claim)).toEqual([expect.objectContaining({ score: 9.5, version: '4.0', type: 'Secondary', provisional: true })]);
    for (const field of ['What happened', 'Assessment']) expect(cvssIssues(findings(claim, field))).toEqual([]);
  });

  test.each([
    `${a}: CVSS v4.0 9.5 (Primary assessment) (provisional).`,
    `${a}: CVSS v3.1 9.5 (Secondary assessment) (provisional).`,
    `${a}: CVSS v4.0 9.9 (Secondary assessment) (provisional).`,
    `${a}: CVSS v4.0 9.5 (Secondary assessment) (non-provisional).`,
    `${a}: CVSS v4.0 9.5 (Secondary assessment) (no longer provisional).`,
    `${a}: CVSS v4.0 9.5 (Secondary assessment) (not a provisional assessment).`,
    `${a}: CVSS v4.0 9.5, a Secondary assessment without a provisional label.`,
    `${a}: CVSS v4.0 9.5, a Secondary assessment not marked provisional.`,
    `${a}: CVSS v4.0 9.5 (Secondary assessment) (provisional) — no longer provisional.`,
    `${a}: CVSS v4.0 9.5 (Secondary assessment) (provisional) — final.`,
    `${a}: CVSS v4.0 9.5 (Primary, provisional).`,
    `${a}: CVSS v4.0 9.5 — Primary, provisional.`,
    `${a}: (Primary, provisional) CVSS v4.0 9.5.`,
  ])('keeps explicit conflicting qualifications blocking: %s', claim => {
    for (const field of ['What happened', 'Assessment']) {
      expect(publicationDecision(findings(claim, field)).blockers.map(issue => issue.code)).toContain('CVE_CVSS_MISMATCH');
    }
  });

  test('missing version/type stay optional, while an explicitly incorrect type cannot borrow an equal score', () => {
    const mixed = proseCvssScores('CVSS v4.0 9.5, a provisional Secondary assessment, and CVSS v3.1 8.1, a Primary assessment without a provisional label.');
    expect(mixed.map(({ provisional, type }) => ({ provisional, type }))).toEqual([{ provisional: true, type: 'Secondary' }, { provisional: false, type: 'Primary' }]);
    expect(cvssIssues(findings(`${a}: provisional CVSS 9.5.`))).toEqual([]);
    const both = [metric, { ...metric, type: 'Primary', provisional: false, selected: false }];
    expect(cvssIssues(findings(`${a}: CVSS v4.0 9.5 (Primary assessment).`, 'What happened', both))).toEqual([]);
    expect(cvssIssues(findings(`${a}: CVSS v4.0 9.5 (Secondary assessment).`, 'What happened', both)).map(issue => issue.code))
      .toContain('CVSS_QUALIFIER_OMITTED');
    expect(scoreSupportedBy({ ...metric, type: 'secondary' }, metric)).toBe(true);
  });

  test('the repair finding includes the exact captured version, assessment type and provisional qualifier', () => {
    const issue = findings(`${a}: CVSS v3.1 9.5.`).issues.find(issue => issue.code === 'CVE_CVSS_MISMATCH');
    expect(issue.message).toContain('Captured for this CVE: CVSS v4.0 9.5 (Secondary assessment) (provisional).');
    expect(issue.sourceIds).toEqual([`NVD-${a}`]);
  });

  test.each([
    `${a}: CVSS v4.0 9.5 and provisional secondary CVSS v4.0 9.5.`,
    `${a}: CVSS v4.0 9.5, provisional secondary CVSS v4.0 9.5.`,
    `${a}: CVSS v4.0 9.5 — provisional secondary CVSS v4.0 9.5.`,
    `${a}: CVSS v4.0 9.5 — ${b}: provisional secondary CVSS v4.0 9.5.`,
    `${a}: CVSS v4.0 9.5; ${b}: provisional secondary CVSS v4.0 9.5.`,
  ])('a later assessment cannot qualify the earlier score: %s', claim => {
    const scores = proseCvssScores(claim);
    expect(scores[0]).toMatchObject({ provisional: false });
    expect(scores[0].type).toBeUndefined();
    expect(scores[1]).toMatchObject({ provisional: true, type: 'Secondary' });
  });

  test.each(['; ', ' and ', ' '])('an earlier assessment cannot qualify a later unmarked score (%j)', separator => {
    const scores = proseCvssScores(`${a}: CVSS v4.0 9.5 (Secondary assessment) (provisional)${separator}CVSS v4.0 9.5.`);
    expect(scores[0]).toMatchObject({ provisional: true, type: 'Secondary' });
    expect(scores[1]).toMatchObject({ provisional: false });
    expect(scores[1].type).toBeUndefined();
  });

  test.each(['Secondary, provisional', 'provisional, Secondary', 'Secondary assessment and provisional'])('parenthetical punctuation preserves its own metric scope: %s', qualifier => {
    const suffix = proseCvssScores(`${a}: CVSS v4.0 9.5 (${qualifier}) CVSS v4.0 9.5.`);
    expect(suffix[0]).toMatchObject({ provisional: true, type: 'Secondary' });
    expect(suffix[1]).toMatchObject({ provisional: false });
    expect(suffix[1].type).toBeUndefined();
    expect(proseCvssScores(`${a}: (${qualifier}) CVSS v4.0 9.5.`)[0]).toMatchObject({ provisional: true, type: 'Secondary' });
  });

  test.each([' and ', ', ', ' — '])('metrics inside one enclosing parenthesis retain separate qualifier scopes (%j)', separator => {
    const scores = proseCvssScores(`${a} (CVSS v3.1 9.8${separator}provisional Secondary CVSS v4.0 9.5).`);
    expect(scores[0]).toMatchObject({ score: 9.8, provisional: false });
    expect(scores[0].type).toBeUndefined();
    expect(scores[1]).toMatchObject({ score: 9.5, provisional: true, type: 'Secondary' });
    const trailing = proseCvssScores(`${a} (CVSS v3.1 9.8 (Secondary, provisional)${separator}CVSS v4.0 9.5).`);
    expect(trailing[0]).toMatchObject({ provisional: true, type: 'Secondary' });
    expect(trailing[1]).toMatchObject({ provisional: false });
    expect(trailing[1].type).toBeUndefined();
  });

  test('a primary product or secondary impact is not an assessment type', () => {
    const scores = proseCvssScores(`The primary gateway has provisional CVSS v4.0 9.5; secondary impacts remain unknown.`);
    expect(scores[0].type).toBeUndefined();
  });
});

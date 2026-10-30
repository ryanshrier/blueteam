import { expect, test } from '@jest/globals';
import { groupBriefFindings, metricClaimKey } from '../public/modules/core/brief-findings.js';
import { draftFindingsHtml, draftRepairGuidance } from '../public/modules/briefing/brief-drafts.js';
import { repairFindingContext } from '../lib/brief-fact-ledger.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';

const cve = 'CVE-2026-12345';
const claimKey = metricClaimKey({ cve, score: 9.5, version: '4.0', type: 'Secondary' });
const findings = ['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED', 'FACT_CVSS_UNSUPPORTED'].map((code, i) => ({
  code, claimKey, severity: 'trust', message: `${cve} diagnostic ${i} <unsafe>`,
  sourceIds: [`S${i + 1}.1`], location: { scope: 'paragraph', line: 8, excerpt: `${cve}: CVSS v4.0 9.5.` },
}));

test('one known claim produces one repair group with all diagnostics and source links', () => {
  const snapshot = JSON.stringify(findings);
  const groups = groupBriefFindings(findings);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ indexes: [0, 1, 2], codes: findings.map(issue => issue.code), sourceIds: ['S1.1', 'S2.1', 'S3.1'] });
  const decision = publicationDecision({ issues: findings });
  expect(decision.blockers).toHaveLength(3);
  expect(decision.canPublish).toBe(false);
  expect(draftRepairGuidance(decision)).toContain('1 required fix remains');
  const html = draftFindingsHtml(findings, decision);
  expect(html).toContain('diagnostic 2 &lt;unsafe&gt;');
  expect(html).not.toContain('<unsafe>');
  expect(repairFindingContext(findings)).toEqual([expect.objectContaining({ codes: findings.map(issue => issue.code), diagnostics: findings.map(issue => issue.message) })]);
  expect(JSON.stringify(findings)).toBe(snapshot);
});

test('different values, versions, identities, locations and legacy findings are not collapsed', () => {
  const different = [
    { ...findings[0], claimKey: metricClaimKey({ cve, score: 9.9, version: '4.0' }) },
    { ...findings[0], claimKey: metricClaimKey({ cve, score: 9.5, version: '3.1' }) },
    { ...findings[0], claimKey: metricClaimKey({ cve: 'CVE-2026-67890', score: 9.5, version: '4.0' }) },
    { ...findings[0], location: { ...findings[0].location, line: 10 } },
    { ...findings[0], claimKey: undefined },
    { ...findings[0], claimKey: undefined },
  ];
  expect(groupBriefFindings([...findings, ...different])).toHaveLength(7);
});

test('real checks bind repeated metric diagnostics to the same assessment claim', () => {
  const groundingManifest = buildGroundingManifest({ headlines: [{ source: 'Vendor', title: `${cve} gateway advisory`,
    link: 'https://vendor.example/gateway', date: '2026-10-09', description: `${cve} affects the gateway. Verify applicable configurations.`,
    cveData: `${cve}: CVSS v4.0 9.5 (Secondary assessment) (provisional)`,
    cvssMetrics: [{ cve, score: 9.5, version: '4.0', type: 'Secondary', provisional: true, selected: true }] }] });
  const text = `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Review gateway\n**Assessment:** ${cve}: CVSS v4.0 9.5 (Secondary assessment).\n**What happened:** ${cve} affects the gateway. [NVD, date unavailable](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve})\n`;
  const issues = validateBrief(text, '2026-10-09', { publication: true, groundingManifest, kevSet: new Set() }).issues.filter(issue => /CVSS/.test(issue.code));
  expect(issues.length).toBeGreaterThan(1);
  expect(groupBriefFindings(issues)).toHaveLength(1);
});

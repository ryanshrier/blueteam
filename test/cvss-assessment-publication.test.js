import { describe, expect, test } from '@jest/globals';
import { proseCvssScores } from '../lib/cvss.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief } from '../lib/validation.js';

// The first live OpenAI edition used "CVSS v4.0 assessment of 9.5".
// Keep the captured edition immutable; reproduce its grammar with a small
// authored source and test both supported and materially changed assertions.
const cve = 'CVE-2026-12345';
const nvdUrl = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve}`;
const claim = `NVD separately records ${cve} with a provisional secondary CVSS v4.0 assessment of 9.5.`;
const grounding = buildGroundingManifest({ headlines: [{
  source: 'Vendor', title: `${cve} gateway advisory`, date: '2026-10-09',
  link: 'https://vendor.example/gateway', description: `${cve} affects the gateway. Verify applicable configurations.`,
  cveData: `${cve}: CVSS v4.0 9.5 (Secondary assessment) (provisional)`,
  cvssMetrics: [{ cve, score: 9.5, version: '4.0', type: 'Secondary', status: 'Received', provisional: true, selected: true }],
}] });

function findings(value, field) {
  const text = `## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Verify gateway applicability
**Assessment:** ${field === 'Assessment' ? value : 'Verify affected deployments.'}
**What happened:** ${field === 'What happened' ? value : `${cve} affects the gateway.`} [NVD, date unavailable](${nvdUrl})
**Decision window:** Current shift
`;
  // Isolate metric trust checks from the intentionally abbreviated layout.
  return validateBrief(text, '2026-10-09', { publication: true, groundingManifest: grounding, kevSet: new Set() })
    .issues.filter(issue => /CVSS/.test(issue.code));
}

describe('CVSS assessment wording from live publication', () => {
  test('recognizes the numeric score, version and preceding provisional qualifier', () => {
    expect(proseCvssScores(claim)).toEqual([expect.objectContaining({ score: 9.5, version: '4.0', provisional: true })]);
    expect(proseCvssScores(claim.replace('v4.0', '4.0'))).toEqual([expect.objectContaining({ score: 9.5, version: '4.0', provisional: true })]);
    expect(proseCvssScores('The CVSS v4.0 assessment is pending.')).toEqual([]);
  });

  test.each(['What happened', 'Assessment'])('%s verifies assessment values against cited metrics', field => {
    expect(findings(claim, field)).toEqual([]);
    for (const changed of [
      claim.replace('of 9.5', 'of 9.9'),
      claim.replace('v4.0', 'v3.1'),
      claim.replace('provisional secondary', 'final primary'),
    ]) {
      expect(findings(changed, field)).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'trust' })]));
    }
  });
});

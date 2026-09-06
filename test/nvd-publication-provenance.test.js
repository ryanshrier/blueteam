import { describe, expect, test } from '@jest/globals';
import { buildGroundingManifest, selectGroundingMembers } from '../lib/grounding.js';
import { buildUserPrompt } from '../lib/prompts.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';

const cve = 'CVE-2026-12345';
const otherCve = 'CVE-2026-54321';
const nvdUrl = id => `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${id}`;
const nvdCitation = id => `[NVD, date unavailable](${nvdUrl(id)})`;
const primary = { source: 'CISA advisory', title: `${cve} vulnerability advisory`, description: 'Check the vendor patch and affected systems.', link: 'https://www.cisa.gov/advisory/example', date: '2026-09-04', horizon: 1,
  cveData: `${cve}: CVSS 9.8 — Affects: Vendor Product`, cveDetails: [`${cve}: CVSS 9.8 — Affects: Vendor Product`] };
const primaryCitation = `[CISA advisory, September 4, 2026](${primary.link})`;
function audit(headlines, claim, citations) {
  return validateBrief(`## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Check the affected systems
**What happened:** ${claim} ${citations}
**Decision window:** 72 hours
`, '2026-09-05', { publication: true, groundingManifest: buildGroundingManifest({ headlines }), kevSet: new Set() });
}

describe('NVD enrichment keeps its own publisher attribution', () => {
  test('primary-only citation cannot support a score present solely in NVD enrichment', () => {
    const result = audit([primary], `${cve}: CVSS 9.8.`, primaryCitation);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['CVSS_UNSUPPORTED', 'CVE_CVSS_MISMATCH']));
    expect(hasTrustCriticalFailure(result.issues)).toBe(true);
  });

  test('the supplied per-CVE NVD citation supports the actual lookup score', () => {
    const result = audit([primary], `${cve}: CVSS 9.8.`, `${primaryCitation} ${nvdCitation(cve)}`);
    expect(hasTrustCriticalFailure(result.issues)).toBe(false);
    expect(result.judgmentEvidence[0].sourceIds).toEqual(['S1.1', `NVD-${cve}`]);
  });

  test('lookup details and actual request URLs are separately visible without inventing a publication date', () => {
    const grounding = buildGroundingManifest({ headlines: [primary] });
    expect(grounding.sources[0].evidenceText).not.toMatch(/CVSS|Vendor Product/);
    expect(grounding.members.find(record => record.id === `NVD-${cve}`)).toMatchObject({ label: 'NVD', date: '', url: nvdUrl(cve), evidenceText: primary.cveData });
    const prompt = buildUserPrompt({ headlines: [primary], groundingManifest: grounding, config: {} });
    expect(prompt).toContain(nvdCitation(cve));
    expect(prompt).toContain('Attribute NVD-only scores and product details to NVD');
    expect(grounding.cves.has(cve)).toBe(true);
  });

  test('per-CVE lookup records do not permit scores to be swapped across a roundup', () => {
    const headline = { ...primary, title: `${cve} and ${otherCve}`, cveDetails: [primary.cveData, `${otherCve}: CVSS 4.3 — Affects: Other Product`] };
    const citations = `${nvdCitation(cve)} ${nvdCitation(otherCve)}`;
    expect(hasTrustCriticalFailure(audit([headline], `${cve}: CVSS 9.8; ${otherCve}: CVSS 4.3.`, citations).issues)).toBe(false);
    expect(audit([headline], `${cve}: CVSS 4.3; ${otherCve}: CVSS 9.8.`, citations).issues.filter(issue => issue.code === 'CVE_CVSS_MISMATCH')).toHaveLength(2);
  });

  test('legacy joined enrichment retains per-CVE records and repeated identical lookups share one identity', () => {
    const headline = { ...primary, cveDetails: undefined, cveData: `${cve}: CVSS 9.8 · ${otherCve}: CVSS 4.3` };
    const grounding = buildGroundingManifest({ headlines: [headline, { ...headline, source: 'Another publisher', link: 'https://other.example/advisory' }] });
    expect(grounding.members.filter(record => record.label === 'NVD')).toHaveLength(2);
    expect(grounding.members.find(record => record.id === `NVD-${otherCve}`).evidenceText).toBe(`${otherCve}: CVSS 4.3`);
  });
});

describe('exact secondary source copies do not create citation ambiguity', () => {
  const secondary = { source: 'Vendor', title: `${cve} patch`, description: `${cve}: CVSS 9.8.`, date: '2026-09-04', link: 'https://vendor.example/patch' };

  test('RSS/search duplicates occupy one evidence slot and the faithful citation resolves', () => {
    const headline = { ...primary, cveData: '', cveDetails: [], sourceMembers: [primary, secondary, { ...secondary }] };
    expect(selectGroundingMembers(headline)).toHaveLength(2);
    expect(hasTrustCriticalFailure(audit([headline], `${cve}: CVSS 9.8.`, '[Vendor, September 4, 2026](https://vendor.example/patch)').issues)).toBe(false);
  });

  test('distinct passages or retained revisions remain separately visible', () => {
    const changed = { ...secondary, description: `${cve}: CVSS 4.3.` };
    const revised = { ...secondary, evidence: [{ sourceId: 'vendor', revisionId: 'changed-revision' }] };
    expect(selectGroundingMembers({ ...primary, sourceMembers: [primary, secondary, changed, revised] })).toHaveLength(4);
  });
});

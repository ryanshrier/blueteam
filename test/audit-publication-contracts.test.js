import { describe, expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildGenerationManifest } from '../lib/generation-manifest.js';
import { validateBrief, isMaterialReviewIssue } from '../lib/validation.js';
import { validationSourceFromManifest } from '../lib/brief-drafts.js';
import { field, rawField, parseBrief, parseDeveloping } from '../lib/brief-schema.js';
import { BRIEF_EVALUATION_CASES, referenceBrief } from './fixtures/brief-evaluation.js';

const a = 'CVE-2026-12345';
const b = 'CVE-2026-54321';
const source = (description, extras = {}) => ({ title: `${a} advisory`, source: 'Vendor', link: 'https://vendor.example/advisory', date: '2026-09-04', description, ...extras });
const citation = '[Vendor, September 4, 2026](https://vendor.example/advisory)';
const codes = result => result.issues.map(issue => issue.code);
function audit(claim, headlines, tail = '') {
  return validateBrief(`## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Verify exposure\n**What happened:** ${claim} ${citation}\n${tail}`, '2026-09-05', {
    publication: true, editorialStandard: 2, groundingManifest: buildGroundingManifest({ headlines }), kevSet: new Set(),
  });
}

describe('entity-bound metric contract', () => {
  const roundup = source(`${a}: CVSS 5.0. ${b}: CVSS 9.8. Update affected products to the fixed releases.`);
  test('ordinary narrative cannot swap two CVEs scores', () => {
    const result = audit(`${a} carries a rating of CVSS 9.8; ${b} carries a rating of CVSS 5.0.`, [roundup]);
    expect(result.issues.filter(issue => issue.code === 'CVE_CVSS_MISMATCH')).toHaveLength(2);
    expect(codes(audit(`${a} carries a rating of CVSS 5.0; ${b} carries a rating of CVSS 9.8.`, [roundup])))
      .not.toContain('CVE_CVSS_MISMATCH');
  });
  test('a multiple-CVE list cannot silently assign one score to the last identity', () => {
    expect(codes(audit(`${a} and ${b} have CVSS 9.8.`, [roundup]))).toContain('CVE_CVSS_AMBIGUOUS');
    const summary = audit(`${a}: CVSS 5.0; ${b}: CVSS 9.8.`, [roundup], `\n## BLUF\n${a} and ${b} have CVSS 9.8.`);
    expect(codes(summary)).toContain('FACT_CVSS_ASSOCIATION_UNVERIFIED');
    expect(summary.coverage.materialReviewRequired).toBe(true);
  });
  test('explicit postposed metric objects preserve both vulnerability identities', () => {
    expect(codes(audit(`CVSS 5.0 for ${a} and CVSS 9.8 for ${b}.`, [roundup]))).not.toContain('CVE_CVSS_MISMATCH');
    expect(codes(audit(`CVSS 9.8 for ${a} and CVSS 5.0 for ${b}.`, [roundup]))).toContain('CVE_CVSS_MISMATCH');
    expect(codes(audit(`CVSS 5.0 for ${a} and ${b}.`, [roundup]))).toContain('CVE_CVSS_AMBIGUOUS');
  });
  test('another CVEs score does not contradict an honest missing-score statement', () => {
    const headline = source(`${a} has no known score. ${b}: CVSS 9.8. The vendor provides an update for both vulnerabilities.`);
    const result = audit(`${a} has no known score.`, [headline], `**Assessment:** ${a}: no CVSS available.`);
    expect(codes(result)).not.toContain('EVIDENCE_ABSENCE_CONTRADICTED');
    expect(codes(audit(`${b}: CVSS 9.8.`, [headline], `**Assessment:** ${b}: no CVSS available.`))).toContain('EVIDENCE_ABSENCE_CONTRADICTED');
  });
  test('legacy suffix versions and provisional status remain binding', () => {
    const headline = source(`${a}: CVSS 9.3 (CRITICAL) (v4.0) (provisional). Update the affected gateway.`);
    expect(codes(audit(`${a}: CVSS v3.1 9.3, the final score.`, [headline]))).toContain('CVE_CVSS_MISMATCH');
    expect(codes(audit(`${a}: CVSS v4.0 9.3 (provisional).`, [headline]))).not.toContain('CVE_CVSS_MISMATCH');
    expect(codes(audit(`${a}: CVSS v4.0 9.3.`, [headline]))).toContain('CVSS_UNSUPPORTED');
  });
  test.each([', but ', ' — '])('provisional qualification cannot cross another CVE (%s)', separator => {
    const headline = source(`${a}: CVSS v3.1 5 (provisional). ${b}: CVSS v3.1 9.8 (provisional). Update the affected gateways.`);
    const result = audit(`${a}: CVSS v3.1 5 (provisional)${separator}${b}: CVSS v3.1 9.8 (final).`, [headline]);
    expect(result.issues.filter(issue => issue.code === 'CVE_CVSS_MISMATCH').map(issue => issue.message)).toEqual([expect.stringContaining(b)]);
  });
  test('structured metrics retain assessment identity through the saved replay', () => {
    const cvssMetrics = [{ cve: a, score: 9.3, version: '4.0', source: 'vendor@example.test', type: 'Secondary', status: 'Awaiting Analysis', provisional: true, selected: true }];
    const headline = source('The vendor recommends updating affected gateways.', { cveDetails: [`${a}: CVSS v4.0 9.3 (provisional)`], cvssMetrics });
    const grounding = buildGroundingManifest({ headlines: [headline] });
    const manifest = buildGenerationManifest({ run: { headlines: [headline] }, config: {}, editionContext: { date: '2026-09-05' }, groundingManifest: grounding });
    expect(manifest.grounding.sources.find(item => item.id === `NVD-${a}`).cvssMetrics).toEqual(cvssMetrics);
    const replay = validationSourceFromManifest(manifest);
    expect(replay.groundingManifest.members.find(item => item.id === `NVD-${a}`).cvssMetrics).toEqual(cvssMetrics);
    const nvd = `[NVD, date unavailable](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${a})`;
    const result = validateBrief(`## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Review\n**What happened:** ${a}: CVSS v3.1 9.3, the final NVD score. ${nvd}`, '2026-09-05', replay);
    expect(codes(result)).toContain('CVE_CVSS_MISMATCH');
  });
});

describe('authored content and publication coverage', () => {
  test('multiline qualifications survive the same field parser used by structured views', () => {
    const markdown = '## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Review\n**Assessment:** A vendor reports exploitation.\nLocal applicability remains unknown.\n**Confidence:** Moderate — one source.\n';
    expect(rawField(markdown, 'Assessment')).toContain('Local applicability remains unknown.');
    expect(field(markdown, 'Assessment')).toBe('A vendor reports exploitation. Local applicability remains unknown.');
    expect(parseBrief(markdown).stories[0].assessment).toContain('Local applicability remains unknown.');
  });
  test.each(['Unchanged', 'Uncertain'])('the canonical %s trajectory is retained', state => {
    expect(parseDeveloping(`## DEVELOPING SITUATIONS\n### Review\n**Trajectory:** ${state} — limited new reporting.\n**Watch criteria:** Vendor confirmation.`)[0].trajectory).toBe(state);
  });
  test('unheaded positive convergence claims fail the entry contract', () => {
    expect(codes(audit(`${a}: CVSS 5.0.`, [source(`${a}: CVSS 5.0. An update is available.`)], '\n## CONVERGENCE\nA common cause links every attack.'))).toContain('CONVERGENCE_FORMAT_INVALID');
    expect(codes(audit(`${a}: CVSS 5.0.`, [source(`${a}: CVSS 5.0. An update is available.`)], '\n## CONVERGENCE\nNo supported intersection was found in the retained source evidence.'))).not.toContain('CONVERGENCE_FORMAT_INVALID');
  });
  test.each(['WATCHLIST', 'DEVELOPING SITUATIONS', 'CONVERGENCE'])('%s citations retain exact publisher and date', section => {
    const result = audit(`${a}: CVSS 5.0.`, [source(`${a}: CVSS 5.0. An update is available.`)], `\n## ${section}\n- Review [Wrong publisher, 2020-01-01](https://vendor.example/advisory).`);
    expect(codes(result)).toContain('CITATION_IDENTITY_INVALID');
  });
  test('mixed title-only citations require material review while cosmetic warnings stay advisory', () => {
    const item = BRIEF_EVALUATION_CASES[0];
    const limited = { title: 'Additional announcement', source: 'Limited', date: '2026-09-04', link: 'https://vendor.example/limited', description: '' };
    // Cite the supplied vendor in the watch conditions to avoid unrelated missing-provenance findings.
    const base = referenceBrief(item).replace('The vendor publishes a revised affected-version range.', `The vendor publishes a revised affected-version range. [Synthetic Vendor, September 4, 2026](${item.headlines[0].link})`);
    const mixed = base.replace('**What happened:**', '**What happened:** [Limited, September 4, 2026](https://vendor.example/limited)');
    const checked = validateBrief(mixed, '2026-09-05', { publication: true, editorialStandard: 2, headlines: [...item.headlines, limited], kevSet: new Set() });
    expect(codes(checked)).toContain('CITED_SOURCE_LIMITED');
    expect(checked.coverage.materialReviewRequired).toBe(true);
    expect(isMaterialReviewIssue({ code: 'REVIEW', severity: 'review', message: 'BLUF is two sentences' })).toBe(false);
  });
  test('a known loaded catalog with no selected KEVs replays faithfully', () => {
    const headline = source(`${a} is under vendor investigation. An update is available.`);
    const grounding = buildGroundingManifest({ headlines: [headline] });
    const manifest = buildGenerationManifest({ run: { headlines: [headline] }, config: {}, editionContext: { date: '2026-09-05' }, groundingManifest: grounding });
    manifest.verification = { kevCatalogLoaded: true, selectedKevCves: [] };
    const markdown = `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Review\n**What happened:** ${a} is not in CISA KEV. ${citation}`;
    const checked = validateBrief(markdown, '2026-09-05', validationSourceFromManifest(manifest));
    expect(checked.warnings.join(' ')).not.toMatch(/KEV catalog unavailable/);
    expect(validateBrief(markdown.replace('is not in', 'is in'), '2026-09-05', validationSourceFromManifest(manifest)).warnings.join(' ')).toMatch(/not in the verified catalog/);
    manifest.verification.kevCatalogLoaded = false;
    expect(validateBrief(markdown, '2026-09-05', validationSourceFromManifest(manifest)).warnings.join(' ')).toMatch(/KEV catalog unavailable/);
  });
});

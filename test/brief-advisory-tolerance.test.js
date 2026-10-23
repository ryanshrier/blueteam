import { describe, expect, test } from '@jest/globals';
import { editorialIssues } from '../lib/brief-editorial.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildPriorityCoverage, validatePriorityCoverage } from '../lib/brief-coverage.js';
import { publicationDecision, validateBrief } from '../lib/validation.js';
import { SECTIONS, section, splitEntries } from '../lib/brief-schema.js';

const actionBrief = response => `## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Gateway response
**Relevance:** Local deployment is unverified.
**Confidence:** Moderate — one vendor advisory.
**Recommended actions:**
- Operations — ${response} — recommended target October 25, 2026.
`;
const editorial = (text, options) => editorialIssues(text, splitEntries(section(text, SECTIONS.keyJudgments)), options);
const applicability = (response, options) => editorial(actionBrief(response), options).filter(issue => issue.code === 'APPLICABILITY_ACTION_UNCONDITIONAL');
const cascade = value => editorial(`## CONVERGENCE
### Convergence 1 — Gateway and identity exposure
**The cascade:** ${value}
**Confirmation:** Evidence of token reuse.
**Action rationale:** Limit the paths available to stolen credentials.
`).filter(issue => issue.code === 'SCENARIO_NOT_LABELED');

describe('advisory language recognizes equivalent meaning', () => {
  test.each([
    'First verify whether affected gateways are deployed, then apply the vendor fix',
    'Begin by reviewing the inventory for affected gateways',
    'Establish whether the vulnerable release is installed before scheduling a patch',
    'Apply the patch only if an affected gateway is deployed',
    'Apply the patch where the vulnerable release is installed',
    'Apply the patch only on confirmed affected gateways',
    'Apply the vendor patch; **Condition:** only affected deployments require the update',
    'If the product is deployed, validate its installed version',
  ])('accepts qualified applicability: %s', response => {
    expect(applicability(response)).toEqual([]);
  });

  test.each([
    'Patch every gateway immediately',
    'Confirm the patch succeeded on all gateways',
    'Apply the patch, then review exposure',
    'Apply the patch; investigate if the gateway was exploited',
    'Patch every gateway; if vulnerable deployments are found, investigate them',
    'If attackers use stolen credentials, patch every gateway',
  ])('retains a note for an unconditional local response: %s', response => {
    const issues = applicability(response);
    expect(issues).toHaveLength(1);
    expect(publicationDecision({ validationPolicyVersion: 2, issues })).toMatchObject({ blockers: [], notes: issues, canPublish: true });
  });

  test('policy 1 compatibility replay keeps its original literal applicability recognition', () => {
    const response = 'Apply the patch only if an affected gateway is deployed';
    expect(applicability(response, { validationPolicyVersion: 1 })).toHaveLength(1);
    expect(applicability(response)).toEqual([]);
  });

  test.each([
    'Analytical hypothesis: credential theft enables lateral movement.',
    'Potential cascade: credential theft enables lateral movement.',
    'Credential theft could enable lateral movement and access to backups.',
    'An attacker might reuse a stolen token to reach the backup service.',
    'If a gateway token is stolen, then the backup service becomes reachable.',
  ])('accepts an explicitly uncertain cascade: %s', value => {
    expect(cascade(value)).toEqual([]);
  });

  test.each([
    'Credential theft enables lateral movement and backup compromise.',
    'This is not a hypothesis: credential theft enables lateral movement.',
    'This is not a hypothetical cascade: credential theft enables lateral movement.',
    'The attacker compromised backups. The team might investigate later.',
  ])('keeps a note for a cascade presented as observed: %s', value => {
    const issues = cascade(value);
    expect(issues).toHaveLength(1);
    expect(publicationDecision({ validationPolicyVersion: 2, issues })).toMatchObject({ blockers: [], notes: issues, canPublish: true });
  });
});

const a = 'CVE-2026-11111', b = 'CVE-2026-22222';
const headline = { source: 'Vendor', date: '2026-10-23', title: `${a} and ${b} gateway fixes`,
  link: 'https://vendor.example/advisory', description: `${a}: CVSS v4.0 9.2. ${b}: CVSS v3.1 5.0. Update affected gateways to the vendor fixed release.`,
  score: 95, urgency: 'critical', isKEV: true };
const groundingManifest = buildGroundingManifest({ headlines: [headline] });
const citation = '[Vendor, October 23, 2026](https://vendor.example/advisory)';
const brief = `## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Gateway response
**Assessment:** ${a} and ${b} affect gateways. CVSS v4.0 9.2.
**What happened:** ${a} and ${b} affect gateways. CVSS v4.0 9.2. ${citation}
`;
const validate = (text, options = {}) => validateBrief(text, '2026-10-23', {
  publication: true, editorialStandard: 2, groundingManifest, kevSet: new Set(), ...options,
});

describe('CVSS summaries retain claim locations without repeated generic advice', () => {
  test('repeated metric advice appears once in flat warnings and keeps both claim locations', () => {
    const result = validate(brief);
    const issues = result.issues.filter(issue => issue.code === 'CVE_CVSS_AMBIGUOUS');
    expect(issues).toHaveLength(2);
    expect(issues.map(issue => issue.location.line)).toEqual([3, 4]);
    expect(result.warnings.filter(message => message === issues[0].message)).toHaveLength(1);
    expect(result.issues.filter(issue => issue.code === 'FACT_CVSS_ASSOCIATION_UNVERIFIED')).toEqual([]);
    expect(publicationDecision({ ...result, issues, warnings: [] }).canPublish).toBe(true);
  });

  test('independent summary ambiguity and unsupported factual scores still receive checks', () => {
    const result = validate(`${brief}\n## BLUF\n${a} and ${b} affect gateways. CVSS v4.0 9.2.`);
    expect(result.issues.filter(issue => issue.code === 'FACT_CVSS_ASSOCIATION_UNVERIFIED')).toHaveLength(1);
    const unsupported = validate(brief.replaceAll('v4.0 9.2', 'v4.0 9.9'));
    expect(publicationDecision(unsupported).blockers.map(issue => issue.code)).toContain('CVSS_UNSUPPORTED');
    expect(unsupported.issues.filter(issue => issue.code === 'CVE_CVSS_AMBIGUOUS')).toHaveLength(2);
  });
});

describe('optional coverage records are never required', () => {
  const priorityCoverage = buildPriorityCoverage({ headlines: [headline], groundingManifest, editionDate: '2026-10-23' });

  test.each([undefined, null, []])('missing or empty bookkeeping %j is not invalid', dispositions => {
    const result = validatePriorityCoverage(brief, { groundingManifest, priorityCoverage, dispositions });
    expect(result.notes.filter(issue => issue.code === 'PRIORITY_COVERAGE_INVALID')).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ outcome: 'covered', basis: 'visible-citation' });
  });

  test('normal publication without a hidden record never emits an invalid-array warning', () => {
    expect(validate(brief, { priorityCoverage }).issues.map(issue => issue.code)).not.toContain('PRIORITY_COVERAGE_INVALID');
  });

  test('malformed bookkeeping is clearly optional and visible coverage still works', () => {
    const result = validatePriorityCoverage(brief, { groundingManifest, priorityCoverage, dispositions: {} });
    expect(result.notes).toEqual([expect.objectContaining({ code: 'PRIORITY_COVERAGE_INVALID', message: expect.stringContaining('no hidden record is required') })]);
    expect(result.items[0]).toMatchObject({ outcome: 'covered', basis: 'visible-citation' });
    const invalidEnvelope = validate(`${brief}\n<!-- briefing-metadata {"coverage":{}} -->`, { priorityCoverage });
    expect(invalidEnvelope.issues.map(issue => issue.code)).toContain('BRIEF_METADATA_INVALID');
    expect(invalidEnvelope.issues.map(issue => issue.code)).not.toContain('PRIORITY_COVERAGE_INVALID');
  });
});

import { describe, test, expect } from '@jest/globals';
import { nvdApplicabilityEvidence, nvdApplicabilitySupportsVersion } from '../lib/nvd-applicability.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief } from '../lib/validation.js';

const cve = 'CVE-2026-12345';
const match = (overrides = {}) => ({ criteria: 'cpe:2.3:a:vendor:gateway:*:*:*:*:*:*:*:*', vulnerable: true,
  versionStartIncluding: '1.2.0', versionEndExcluding: '1.2.4', ...overrides });
function recordWith(configurations) {
  const evidence = nvdApplicabilityEvidence(cve, configurations);
  return { id: `NVD-${cve}`, configurations, applicabilityPassage: evidence.passage, applicabilityComplete: evidence.complete };
}
const configuration = (matches = [match()]) => [{ operator: 'AND', negate: false, cpeMatch: [], nodes: [
  { operator: 'OR', negate: false, cpeMatch: [{ criteria: 'cpe:2.3:o:vendor:platform:10:*:*:*:*:*:*:*', vulnerable: false }], nodes: [] },
  { operator: 'OR', negate: false, cpeMatch: matches, nodes: [] },
] }];
const record = recordWith(configuration());
const check = (text, version, source = record, occurrence = 0) => {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(version, index + 1);
  return nvdApplicabilitySupportsVersion(source, { text, version, index });
};

describe('additive NVD applicability version support', () => {
  test('accepts a faithful reported boundary without demanding an unrelated disclaimer', () => {
    expect(check(`NVD lists an exclusive upper bound of version 1.2.4 for ${cve}.`, '1.2.4')).toBe(true);
    expect(check(`NVD records version 1.2.0 as an inclusive lower bound for ${cve}.`, '1.2.0')).toBe(true);
    expect(check(`NVD lists an exclusive upper bound of version 1.2.4 for ${cve}, not a fixed release.`, '1.2.4')).toBe(true);
  });

  test('accepts a conditioned range with faithful endpoints from one match', () => {
    const text = `NVD applicability for ${cve} includes versions 1.2.0 inclusive to 1.2.4 exclusive, subject to the full configuration conditions.`;
    expect(check(text, '1.2.0')).toBe(true);
    expect(check(text, '1.2.4')).toBe(true);
    expect(record.configurations[0].operator).toBe('AND');
  });

  test('preserves ordinary range qualification without requiring exact boilerplate', () => {
    for (const text of [
      `NVD lists ${cve} affected versions 1.2.0 inclusive to before version 1.2.4, with other configuration conditions applying.`,
      `NVD lists ${cve} versions 1.2.0 inclusive to 1.2.4 exclusive under NVD applicability conditions.`,
    ]) {
      expect(check(text, '1.2.0')).toBe(true);
      expect(check(text, '1.2.4')).toBe(true);
    }
    expect(check(`NVD lists ${cve} versions 1.2.0 inclusive to 1.2.4 exclusive with no other configuration conditions applying.`, '1.2.0')).toBe(false);
  });

  test('does not promote an exclusive endpoint to an affected or fixed release', () => {
    for (const text of [
      `NVD says ${cve} affects version 1.2.4 (exclusive upper bound).`,
      `NVD says ${cve} is fixed in version 1.2.4.`,
      `NVD lists an exclusive upper bound of version 1.2.4 for ${cve}; upgrade to that release.`,
      `NVD applicability for ${cve} includes versions 1.2.0 inclusive to 1.2.4 inclusive, subject to the full configuration conditions.`,
    ]) expect(check(text, '1.2.4')).toBe(false);
    const wrongRange = `NVD applicability for ${cve} includes versions 1.2.0 inclusive to 1.2.4 inclusive, subject to the full configuration conditions.`;
    expect(check(wrongRange, '1.2.0')).toBe(false);
  });

  test('does not invent a union of disjoint matches or discard their conditions', () => {
    const disjoint = recordWith(configuration([match({ versionEndExcluding: '1.2.2' }), match({ versionStartIncluding: '1.2.3' })]));
    const text = `NVD applicability for ${cve} includes versions 1.2.0 inclusive to 1.2.4 exclusive, subject to the full configuration conditions.`;
    expect(check(text, '1.2.0', disjoint)).toBe(false);
    expect(check(text.replace(', subject to the full configuration conditions', ''), '1.2.0')).toBe(false);
  });

  test('cannot borrow another CVE or another sentence to support this version', () => {
    expect(check('NVD lists an exclusive upper bound of version 1.2.4 for CVE-2026-99999.', '1.2.4')).toBe(false);
    expect(check(`NVD describes ${cve}. It lists an exclusive upper bound of version 1.2.4.`, '1.2.4')).toBe(false);
    expect(check(`NVD lists an exclusive upper bound of version 1.2.4 for ${cve} and CVE-2026-99999.`, '1.2.4')).toBe(false);
    const repeated = `NVD lists an exclusive upper bound of version 1.2.4 for ${cve}. Install version 1.2.4.`;
    expect(check(repeated, '1.2.4', record, 1)).toBe(false);
  });

  test('does not use environmental, negated, unknown-vulnerability or hidden facts as positive version support', () => {
    const text = `NVD lists an exclusive upper bound of version 1.2.4 for ${cve}.`;
    expect(check(text, '1.2.4', recordWith(configuration([match({ vulnerable: false })])))).toBe(false);
    expect(check(text, '1.2.4', recordWith(configuration([match({ vulnerable: null })])))).toBe(false);
    const negated = configuration();
    negated[0].nodes[1].negate = true;
    expect(check(text, '1.2.4', recordWith(negated))).toBe(false);
    expect(check(text, '1.2.4', { ...record, applicabilityComplete: false })).toBe(false);
    expect(check(text, '1.2.4', { ...record, applicabilityPassage: '' })).toBe(false);
  });

  test('retains an exact CPE version as an attributed match fact', () => {
    const exact = recordWith(configuration([match({ criteria: 'cpe:2.3:a:vendor:gateway:1.2.3:*:*:*:*:*:*:*' })]));
    expect(check(`NVD records exact CPE version 1.2.3 for ${cve}.`, '1.2.3', exact)).toBe(true);
    expect(check(`NVD records exact CPE version 1.2.4 for ${cve}.`, '1.2.4', exact)).toBe(false);
  });

  test('publication uses typed applicability support while ordinary publisher prose remains sufficient', () => {
    const headline = { title: `${cve} Gateway advisory`, source: 'Vendor', link: 'https://vendor.example/advisory',
      description: `${cve} affects Gateway.`, cveData: `${cve}: CVSS N/A`,
      cveConfigurations: [{ cve, configurations: configuration() }] };
    const audit = (claim, source = headline, vendorCitation = '', citeNvd = true) => validateBrief(`## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Applicability\n**What happened:** ${claim} ${citeNvd ? `[NVD, date unavailable](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve})` : ''} ${vendorCitation}\n**Decision window:** 72 hours`, '2026-10-09', {
      publication: true, groundingManifest: buildGroundingManifest({ headlines: [source] }), kevSet: new Set(),
    }).issues.filter(issue => issue.code === 'VERSION_UNSUPPORTED');
    expect(audit(`NVD lists ${cve} versions 1.2.0 inclusive to before version 1.2.4, with other configuration conditions applying.`)).toEqual([]);
    expect(audit(`NVD lists an exclusive upper bound of version 1.2.4 for ${cve}.`)).toEqual([]);
    expect(audit(`NVD lists ${cve} fixed version 1.2.4.`)).toHaveLength(1);
    expect(audit(`NVD lists an exclusive upper bound of version 1.2.4 for ${cve}.`, headline,
      '[Vendor, date unavailable](https://vendor.example/advisory)', false)).toHaveLength(1);
    expect(audit(`${cve} has a vendor fixed version 1.2.4.`, { ...headline, description: `${cve} has a vendor fixed version 1.2.4.` }, '[Vendor, date unavailable](https://vendor.example/advisory)')).toEqual([]);
  });
});

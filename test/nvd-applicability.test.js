import { describe, test, expect } from '@jest/globals';
import { nvdApplicabilityEvidence, nvdApplicabilityVersionFacts, MAX_NVD_APPLICABILITY_PASSAGE } from '../lib/nvd-applicability.js';

describe('NVD applicability evidence', () => {
  test('preserves combined conditions, negation, exact versions and inclusive/exclusive bounds', () => {
    const configurations = [{ operator: 'AND', negate: false, cpeMatch: [], nodes: [
      { operator: 'OR', negate: false, nodes: [], cpeMatch: [{ criteria: 'cpe:2.3:o:vendor:platform:10:*:*:*:*:*:*:*', vulnerable: false }] },
      { operator: 'OR', negate: false, nodes: [], cpeMatch: [{ criteria: 'cpe:2.3:a:vendor:gateway:*:*:*:*:*:*:*:*', vulnerable: true, versionStartIncluding: '1.2.0', versionEndExcluding: '1.2.4' }] },
      { operator: 'OR', negate: true, nodes: [], cpeMatch: [{ criteria: 'cpe:2.3:a:vendor:extension:3.0:*:*:*:*:*:*:*', vulnerable: true, versionStartExcluding: '2.0', versionEndIncluding: '3.0' }] },
    ] }];
    const evidence = nvdApplicabilityEvidence('CVE-2026-12345', configurations);
    expect(evidence.configurations).toEqual(configurations);
    expect(evidence.complete).toBe(true);
    expect(evidence.passage).toContain(JSON.stringify(configurations));
    expect(evidence.passage).toContain('vulnerable:false match describes an environmental condition, not an affected product');
    expect(evidence.passage).toContain('exclusive upper bound does not establish a fixed release');
    expect(evidence.passage).toContain('do not establish local deployment or exposure');
    expect(nvdApplicabilityVersionFacts({ configurations })).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: '10', role: 'exact', vulnerable: false, negated: false }),
      expect.objectContaining({ version: '1.2.0', role: 'start-inclusive', vulnerable: true, conditions: [{ operator: 'AND', negate: false }, { operator: 'OR', negate: false }] }),
      expect.objectContaining({ version: '1.2.4', role: 'end-exclusive', vulnerable: true }),
      expect.objectContaining({ version: '3.0', role: 'exact', negated: true }),
      expect.objectContaining({ version: '3.0', role: 'end-inclusive', negated: true }),
      expect.objectContaining({ version: '2.0', role: 'start-exclusive', negated: true }),
    ]));
  });

  test('never truncates away a required condition to fit the display budget', () => {
    const configurations = [{ operator: 'AND', nodes: Array.from({ length: 400 }, (_, index) => ({ operator: 'OR', cpeMatch: [{ criteria: `cpe:2.3:a:vendor:product_${index}:*:*:*:*:*:*:*:*`, vulnerable: true, versionEndExcluding: '1.2.4' }] })) }];
    const evidence = nvdApplicabilityEvidence('CVE-2026-12345', configurations);
    expect(evidence.configurations).toEqual(configurations);
    expect(evidence.complete).toBe(false);
    expect(evidence.passage.length).toBeLessThan(MAX_NVD_APPLICABILITY_PASSAGE);
    expect(evidence.passage).toContain('No partial condition or version range is shown');
    expect(evidence.passage).not.toContain('1.2.4');
  });
});

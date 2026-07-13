import { describe, test, expect, afterAll } from '@jest/globals';
import { scoreHeadline } from '../lib/scoring.js';
import { setDomainPack } from '../lib/domain.js';
import { cyberPack } from '../config/domains/cyber.js';

// The two edition-coupled axes (exploitation weights, severity
// source/parse) and the rationale vocabulary come from the active pack's scoring
// dictionary. The five-axis weighting model + max-not-sum collapse stay in core.
// These guard that cyber scores with KEV/CVSS verbatim AND a second edition swaps
// its own catalog/severity/words without touching scoring.js.

const cfg = { analysisSettings: {} };

describe('scoring — pack-driven exploitation / severity / rationale', () => {
  afterAll(() => setDomainPack(cyberPack));   // restore the default for later suites

  test('cyber: verified-catalog + CVSS render with cyber weights and vocabulary', () => {
    setDomainPack(cyberPack);
    const h = { title: 'x', horizon: 1, weight: 1, date: new Date().toISOString(), urgency: 'critical', corroboration: 1, isKEV: true, cvssSeverityText: 'CVSS 9.8 (CRITICAL)' };
    scoreHeadline(h, cfg);
    expect(h.scoreComponents.exploitation).toBe(1);    // cyber verified weight
    expect(h.scoreComponents.severity).toBeCloseTo(0.98);
    expect(h.scoreRationale).toContain('KEV-verified');
    expect(h.scoreRationale).toContain('CVSS 9.8');
  });

  test('a second edition swaps catalog weight, severity source, and rationale words', () => {
    setDomainPack({
      id: 'sc', label: 'Supply Chain', entities: { actors: [], regions: {}, vendors: [] },
      urgencyLexicon: { critical: [], elevated: [], horizon1Promote: [] },
      scoring: {
        exploitation: { verified: 0.6, critical: 0.5, elevated: 0.2 },
        severity: { dataProperty: 'riskData', pattern: 'risk\\s+([\\d.]+)', max: 5, bands: {} },
        rationale: { verified: 'catalog-listed', critical: 'active disruption', elevated: 'watch', severityLabel: 'risk' },
      },
    });
    const h = { title: 'x', horizon: 1, weight: 1, date: new Date().toISOString(), urgency: 'critical', corroboration: 1, isKEV: true, riskData: 'risk 4.0' };
    scoreHeadline(h, cfg);
    expect(h.scoreComponents.exploitation).toBe(0.6);   // max(verified 0.6, critical 0.5)
    expect(h.scoreComponents.severity).toBeCloseTo(0.8); // 4.0 / max 5
    expect(h.scoreRationale).toContain('catalog-listed');
    expect(h.scoreRationale).toContain('risk 4.0');
    expect(h.scoreRationale).not.toContain('KEV');
    expect(h.scoreRationale).not.toContain('CVSS');
  });
});

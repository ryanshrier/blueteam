import { describe, expect, test } from '@jest/globals';
import { capturedSignalFacts, signalSeverity, signalMetrics, kevFact, evidenceQualifications, briefingReadinessLabel } from '../public/modules/core/signal-facts.js';
import { toCsv } from '../public/modules/wire/wire-format.js';
import { cvssFrom } from '../public/modules/wall/wall-format.js';
import { buildPresentationPages, buildGlanceModel } from '../public/modules/wall/wall-presentation.js';

const cve = 'CVE-2026-12345';
const selected = { cve, version: '3.1', score: 7.5, source: 'vendor.test', type: 'Primary', provisional: true, selected: true };
const alternative = { ...selected, version: '4.0', score: 9.8, source: 'nvd@nist.gov', type: 'Secondary', selected: false };

describe('shared captured fact presentation', () => {
  test('uses the selected assessment and retains its authority, version and provisional qualification', () => {
    const headline = { cvssMetrics: [alternative, selected] };
    const severity = signalSeverity(headline);
    expect(severity).toMatchObject({ scope: cve, metric: selected, value: expect.stringContaining('7.5 High · v3.1 · vendor.test · Primary assessment · provisional') });
    expect(severity.metrics).toHaveLength(2);
    expect(cvssFrom(headline)).toContain(`${cve} · CVSS 7.5 High`);
    expect(cvssFrom(headline)).not.toContain('9.8');
    const page = buildPresentationPages(null, { signals: [{ ...headline, title: 'Gateway vulnerability', source: 'Publisher' }] })[0];
    expect(buildGlanceModel(page).facts).toContainEqual({ label: 'CVSS severity', value: `${cve} · ${severity.value}` });
  });

  test('ambiguous selected assessments never silently become the highest alternative', () => {
    const headline = { cvssMetrics: [selected, { ...selected, score: 9.8 }] };
    expect(signalSeverity(headline)).toMatchObject({ scope: '', value: 'Conflicting assessments', unresolved: 1 });
    expect(signalSeverity({ cvssMetrics: [{ ...selected, selected: false }] }).scope).toBe('');
  });

  test('supports captured v-prefixed legacy prose without associating an unscoped score', () => {
    const headline = { cveData: `${cve}: CVSS v3.1 9.8 (CRITICAL) (source: vendor.test) (Primary assessment) (provisional)` };
    expect(signalSeverity(headline)).toMatchObject({ scope: cve, value: expect.stringContaining('9.8 Critical · v3.1 · vendor.test · Primary assessment · provisional') });
    expect(signalMetrics({ cveData: 'CVSS v3.1 9.8' })).toEqual([]);
    expect(signalSeverity({ cvssMetrics: [{ ...selected, status: 'Rejected' }], cveData: headline.cveData }).scope).toBe('');
  });

  test('current catalog records override inherited flags while stale captures retain qualified positives', () => {
    const stale = { isKEV: true, kevCVE: cve, kevDueDate: '2026-10-01', kevOverdue: true };
    const freshStatus = { status: 'fresh', retrievedAt: '2026-10-09T12:00:00Z' };
    expect(capturedSignalFacts(stale, [], freshStatus)).toMatchObject({ isKEV: false, kevCVE: null, kevDueDate: null, kevOverdue: false });
    const record = { cve, dueDate: '2026-10-30' };
    expect(capturedSignalFacts({ isKEV: false }, [record], freshStatus)).toMatchObject({ isKEV: true, kevCVE: cve, kevDueDate: '2026-10-30' });
    expect(capturedSignalFacts(stale, [{ cve }], freshStatus)).toMatchObject({ isKEV: true, kevDueDate: null, kevOverdue: false });
    const retained = capturedSignalFacts(stale, [], { status: 'stale', retrievedAt: '2026-10-08T12:00:00Z' });
    expect(kevFact(retained)).toMatchObject({ listed: true, label: 'KEV · retained', description: expect.stringContaining('Current catalog membership is unverified') });
    expect(kevFact({ kevCatalogStatus: { status: 'unavailable' } }).description).toContain('does not establish absence');
  });

  test('CSV retains evidence qualifications and all bounded assessment records', () => {
    const headline = { title: 'Gateway', cvssMetrics: [selected, alternative], collectionStale: true, retrievedAt: '2026-10-08T12:00:00Z', articleRetrievalStatus: 'unavailable',
      isKEV: true, kevCVE: cve, kevDueDate: '2026-10-01', kevCatalogStatus: { status: 'stale' }, enrichmentStatus: { epss: 'unavailable' },
      cveObservations: [{ cve, retrievedAt: '2026-10-07T12:00:00Z', privateField: 'do not export' }] };
    const qualifications = evidenceQualifications(headline);
    expect(qualifications).toMatchObject({ collectionState: 'retained-cache', kevCatalogState: 'stale', enrichmentAvailability: 'epss: unavailable', kevDeadlineScope: expect.stringContaining('FCEB only') });
    const csv = toCsv([headline]);
    expect(csv).toContain('sourceRetrievedAt,collectionState,articleRetrievedAt,articleRetrievalStatus');
    expect(csv).toContain('retained-cache');
    expect(csv).toContain('FCEB only; external catalog deadline');
    expect(csv).toContain('vendor.test');
    expect(csv).toContain('nvd@nist.gov');
    expect(csv).toContain('Current catalog membership is unverified');
    expect(csv).toContain('2026-10-07T12:00:00Z');
    expect(csv).not.toContain('privateField');
    expect(capturedSignalFacts(headline).cveObservations).toEqual([{ cve, retrievedAt: '2026-10-07T12:00:00Z' }]);
  });

  test('readiness remains separate from source reachability and ages between loads', () => {
    expect(briefingReadinessLabel({ status: 'limited', ageMs: 0, reason: 'Limited fresh evidence' })).toMatchObject({ label: 'Limited briefing ready', status: 'limited' });
    expect(briefingReadinessLabel({ status: 'ready', ageMs: 10 * 60_000 }, { elapsedMs: 21 * 60_000 })).toMatchObject({ status: 'blocked', label: 'Briefing evidence stale' });
    expect(briefingReadinessLabel(null).status).toBe('unknown');
  });
});

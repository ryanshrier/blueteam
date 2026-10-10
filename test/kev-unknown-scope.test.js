import { describe, expect, test } from '@jest/globals';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { BRIEF_EVALUATION_CASES, EVAL_DATE, referenceBrief } from './fixtures/brief-evaluation.js';

const item = BRIEF_EVALUATION_CASES.find(value => value.id === 'conflicting-multi-cve');
const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
const briefWith = (claim, watch = '') => referenceBrief(item)
  .replace('**What happened:**', `**What happened:** ${claim} `)
  .replace(/## WATCHLIST[^\n]*/, heading => `${heading}\n\n${watch ? `- ${watch}` : ''}`);
const check = (claim, watch = '', kev = []) => validateBrief(briefWith(claim, watch), EVAL_DATE, {
  publication: true, groundingManifest, kevSet: new Set(kev),
});
const kevWarnings = result => result.warnings.filter(value => /KEV catalog (?:freshness )?unavailable|labeled KEV|described as pending\/not in KEV/.test(value));

describe('KEV snapshot freshness does not manufacture current membership', () => {
  const checkSnapshot = (claim, status, kev = ['CVE-2026-12345']) => validateBrief(briefWith(claim), EVAL_DATE, {
    publication: true, groundingManifest, kevSet: new Set(kev), kevCatalogLoaded: true,
    kevCatalogStatus: { status, retrievedAt: '2026-09-01T12:00:00Z' },
  });
  test.each(['stale', 'unknown'])('retains positive captured membership and allows honest uncertainty when %s', status => {
    for (const claim of ['CVE-2026-12345 is in KEV.', 'CVE-2026-12345 current KEV status is unknown.', 'CVE-2026-54321 is not confirmed in KEV.']) {
      expect(kevWarnings(checkSnapshot(claim, status))).toEqual([]);
    }
  });
  test.each(['stale', 'unknown'])('missing membership with %s freshness is unverified rather than a known contradiction', status => {
    for (const claim of ['CVE-2026-54321 is in KEV.', 'CVE-2026-54321 is not in KEV.', 'CVE-2026-12345 is not in KEV.']) {
      const result = checkSnapshot(claim, status);
      expect(kevWarnings(result).join(' ')).toMatch(/KEV catalog freshness unavailable/);
      expect(hasTrustCriticalFailure(result.warnings)).toBe(true);
      expect(kevWarnings(result).join(' ')).not.toMatch(/verified catalog/);
    }
  });
  test('fresh membership contradictions still block publication', () => {
    expect(kevWarnings(checkSnapshot('CVE-2026-54321 is in KEV.', 'fresh')).join(' ')).toContain('not in the verified catalog');
    expect(kevWarnings(checkSnapshot('CVE-2026-12345 is not in KEV.', 'fresh')).join(' ')).toContain('already in the verified catalog');
  });
});

describe('KEV unknown status and future Watchlist scope', () => {
  test.each([
    ['CISA KEV catalog data was not loaded this run, so KEV membership for CVE-2026-12345 is unresolved — not confirmed absent, not confirmed present.', 'CISA KEV catalog adds CVE-2026-12345.'],
    ['CISA KEV catalog was not loaded this run — KEV membership for CVE-2026-12345 and CVE-2026-54321 is unverified and neither is confirmed as KEV-listed.', 'CISA adds CVE-2026-12345 or CVE-2026-54321 to the KEV catalog.'],
    ["CISA KEV catalog data was not loaded this run — CVE-2026-12345's KEV status is unknown and unverified; treat it as not-yet-confirmed rather than absent.", 'CISA adds CVE-2026-12345 to the KEV catalog.'],
    ['CVE-2026-12345 is not confirmed in KEV.', 'CISA adds CVE-2026-12345 and CVE-2026-54321 to KEV.'],
    ['CVE-2026-12345 has not yet been confirmed in KEV.', ''],
    ['There is no evidence that CISA added CVE-2026-12345 to KEV.', ''],
  ])('allows honest unverified membership without a catalog: %s', (claim, watch) => {
    const result = check(claim, watch);
    expect(kevWarnings(result)).toEqual([]);
    expect(hasTrustCriticalFailure(result.warnings)).toBe(false);
  });

  test.each([
    'CISA added CVE-2026-12345 to KEV.',
    'CVE-2026-12345 is in KEV.',
    'CISA KEV catalog lists CVE-2026-12345.',
    'CVE-2026-12345 is not in KEV.',
    'CVE-2026-12345 remains pending KEV.',
    'CISA has not added CVE-2026-12345 to KEV.',
    'CVE-2026-12345 has yet to enter KEV.',
    'CVE-2026-12345 has not yet been added to KEV.',
    'CVE-2026-12345 is not a KEV entry.',
  ])('still blocks actual presence or absence assertions without a catalog: %s', claim => {
    const result = check(claim);
    expect(kevWarnings(result).join(' ')).toMatch(/KEV catalog unavailable.*CVE-2026-12345/);
    expect(hasTrustCriticalFailure(result.warnings)).toBe(true);
  });

  test.each(['CVE-2026-12345 is in KEV.', 'CISA KEV catalog lists CVE-2026-12345.', 'CISA added CVE-2026-12345 to KEV.'])('a Watchlist heading does not hide a factual assertion: %s', watch => {
    expect(kevWarnings(check('', watch)).join(' ')).toMatch(/KEV catalog unavailable.*CVE-2026-12345/);
  });

  test('an unknown caveat for one identifier cannot mask a positive claim for another', () => {
    const warnings = kevWarnings(check('CVE-2026-12345 KEV status is unknown; CVE-2026-54321 is in KEV.')).join(' ');
    expect(warnings).toContain('CVE-2026-54321');
    expect(warnings).not.toContain('CVE-2026-12345');
  });

  test('a future Watchlist condition cannot swallow a neighboring factual clause', () => {
    const warnings = kevWarnings(check('', 'CISA adds CVE-2026-12345 to KEV, while CVE-2026-54321 is in KEV.')).join(' ');
    expect(warnings).toContain('CVE-2026-54321');
    expect(warnings).not.toContain('CVE-2026-12345');
  });

  test('unknown status contradicts supplied verified membership', () => {
    expect(kevWarnings(check('CVE-2026-12345 KEV status is unknown.', '', ['CVE-2026-12345'])).join(' '))
      .toMatch(/described as pending\/not in KEV.*CVE-2026-12345/);
  });

  test.each([
    'CVE-2026-12345 is not patched despite its KEV listing.',
    'CVE-2026-12345 remediation is pending following its KEV addition.',
    'CVE-2026-12345 KEV remediation is pending.',
    'KEV remediation for CVE-2026-12345 is pending.',
    'CVE-2026-12345 remediation is pending while CVE-2026-54321 is in KEV.',
    'CVE-2026-12345 is in KEV and its patch status is unknown.',
  ])('does not turn remediation status into a membership contradiction: %s', claim => {
    expect(kevWarnings(check(claim, '', ['CVE-2026-12345', 'CVE-2026-54321']))).toEqual([]);
  });

  test.each([
    'CVE-2026-12345 patch status is unknown; consult KEV guidance.',
    'CVE-2026-12345 KEV remediation status is unknown.',
    'KEV remediation guidance for CVE-2026-12345 is pending.',
    'Pending remediation following KEV guidance for CVE-2026-12345 needs an owner.',
  ])('does not require a catalog to check an unrelated status: %s', claim => {
    expect(kevWarnings(check(claim))).toEqual([]);
  });

  test.each([
    'CVE-2026-12345 is not in KEV.',
    'CVE-2026-12345 is not confirmed on the KEV catalog in the current supplied records.',
    'CVE-2026-12345 is not yet KEV-listed.',
    'CVE-2026-12345 has not yet been added to KEV.',
    'CVE-2026-12345 is not currently listed in KEV.',
    'CVE-2026-12345 has not yet been confirmed in KEV.',
    'CVE-2026-12345 is not a KEV entry.',
    'CVE-2026-12345 remains absent from the KEV catalog.',
    'CVE-2026-12345 is outside CISA’s KEV catalog.',
    'CVE-2026-12345 is awaiting addition to the KEV catalog.',
    'CVE-2026-12345 has unknown KEV membership.',
    'CVE-2026-12345 KEV listing is not confirmed.',
    'KEV membership for CVE-2026-12345 is unknown.',
    'Pending KEV addition for CVE-2026-12345 remains a watch condition.',
  ])('still detects a catalog-membership contradiction: %s', claim => {
    expect(kevWarnings(check(claim, '', ['CVE-2026-12345'])).join(' '))
      .toMatch(/described as pending\/not in KEV.*CVE-2026-12345/);
  });

  test('an unrelated pending remediation cannot inherit a second CVE membership claim', () => {
    const claim = 'CVE-2026-12345 remediation is pending while CVE-2026-54321 is not in KEV.';
    const warnings = kevWarnings(check(claim, '', ['CVE-2026-12345', 'CVE-2026-54321'])).join(' ');
    expect(warnings).toMatch(/described as pending\/not in KEV.*CVE-2026-54321/);
    expect(warnings).not.toContain('CVE-2026-12345');
    const unavailable = kevWarnings(check(claim)).join(' ');
    expect(unavailable).toMatch(/KEV catalog unavailable.*CVE-2026-54321/);
    expect(unavailable).not.toContain('CVE-2026-12345');
  });

  test('a future two-identifier addition cannot ignore already supplied membership', () => {
    const warnings = kevWarnings(check('', 'CISA adds CVE-2026-12345 or CVE-2026-54321 to the KEV catalog.', ['CVE-2026-54321'])).join(' ');
    expect(warnings).toMatch(/described as pending\/not in KEV.*CVE-2026-54321/);
    expect(warnings).not.toContain('CVE-2026-12345');
  });
});

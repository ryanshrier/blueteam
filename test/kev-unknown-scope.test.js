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
const kevWarnings = result => result.warnings.filter(value => /KEV catalog unavailable|labeled KEV|described as pending\/not in KEV/.test(value));

describe('KEV unknown status and future Watchlist scope', () => {
  test.each([
    ['CISA KEV catalog data was not loaded this run, so KEV membership for CVE-2026-12345 is unresolved — not confirmed absent, not confirmed present.', 'CISA KEV catalog adds CVE-2026-12345.'],
    ['CISA KEV catalog was not loaded this run — KEV membership for CVE-2026-12345 and CVE-2026-54321 is unverified and neither is confirmed as KEV-listed.', 'CISA adds CVE-2026-12345 or CVE-2026-54321 to the KEV catalog.'],
    ["CISA KEV catalog data was not loaded this run — CVE-2026-12345's KEV status is unknown and unverified; treat it as not-yet-confirmed rather than absent.", 'CISA adds CVE-2026-12345 to the KEV catalog.'],
    ['CVE-2026-12345 is not confirmed in KEV.', 'CISA adds CVE-2026-12345 and CVE-2026-54321 to KEV.'],
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

  test('a future two-identifier addition cannot ignore already supplied membership', () => {
    const warnings = kevWarnings(check('', 'CISA adds CVE-2026-12345 or CVE-2026-54321 to the KEV catalog.', ['CVE-2026-54321'])).join(' ');
    expect(warnings).toMatch(/described as pending\/not in KEV.*CVE-2026-54321/);
    expect(warnings).not.toContain('CVE-2026-12345');
  });
});

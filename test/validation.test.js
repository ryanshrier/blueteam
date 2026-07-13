import { describe, test, expect } from '@jest/globals';
import { marked } from 'marked';
import {
  validateBrief, countHorizons, hasHardFail, isHardFailWarning,
  hasTrustCriticalFailure, isTrustCriticalWarning,
} from '../lib/validation.js';
import {
  buildGroundingManifest, CISA_KEV_CATALOG_URL, delinkUnallowlistedMarkdownUrls,
  findUnallowlistedMarkdownUrls, containsRawHtmlAnchor, stripRawHtmlAnchors,
} from '../lib/grounding.js';
import { BRIEF_GROUNDING_REGRESSION } from './fixtures/brief-grounding-regression.js';

function makeBrief({ bluf = true, judgments = true, convergence = true, watchlist = true, horizons = 3, pad = true } = {}) {
  let text = '# THREAT LANDSCAPE BRIEFING\n';
  if (bluf) text += '\n## BLUF\n\nOne sharp judgment.\n';
  text += '\n## EXECUTIVE SUMMARY\n\n- A high-level bullet.\n';
  if (judgments) {
    text += '\n## KEY JUDGMENTS\n';
    for (let i = 1; i <= horizons; i++) {
      text += `\n### Signal ${i} — [Horizon ${i}] Something happened\n**Assessment:** It matters.\n**Confidence:** Likely (55-80%).\n**The line:** A sharp line.\n**Decision window:** Next 30 days.\n`;
    }
  }
  if (convergence) text += '\n## CONVERGENCE\n\n### Two things intersect\n**The intersection:** Where they meet.\n**The move:** What to do.\n';
  if (watchlist) text += '\n## WATCHLIST — NEXT 72 HOURS\n\n- Observable thing\n';
  if (pad) text += '\n' + 'Detail sentence for length. '.repeat(80);
  return text;
}

function withJudgmentClaim(claim) {
  return makeBrief().replace(
    '**Assessment:** It matters.',
    `**Assessment:** It matters.\n${claim}`
  );
}

describe('validateBrief', () => {
  test('complete briefing passes', () => {
    const result = validateBrief(makeBrief());
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('missing BLUF is flagged', () => {
    const result = validateBrief(makeBrief({ bluf: false }));
    expect(result.valid).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/BLUF/);
  });

  test('an empty BLUF heading hard-fails like a missing section', () => {
    const brief = makeBrief().replace('## BLUF\n\nOne sharp judgment.', '## BLUF\n');
    const result = validateBrief(brief);
    expect(result.warnings).toContain('Missing BLUF section');
    expect(hasHardFail(result.warnings)).toBe(true);
  });

  test('an empty Key Judgments heading hard-fails like a missing section', () => {
    const brief = makeBrief().replace(/## KEY JUDGMENTS[\s\S]*?(?=\n## CONVERGENCE)/, '## KEY JUDGMENTS\n');
    const result = validateBrief(brief);
    expect(result.warnings).toContain('Missing Key Judgments section');
    expect(hasHardFail(result.warnings)).toBe(true);
  });

  test('single-horizon briefing is flagged', () => {
    const result = validateBrief(makeBrief({ horizons: 1 }));
    expect(result.warnings.join(' ')).toMatch(/distinct horizon/);
  });

  test('short briefing is flagged', () => {
    const result = validateBrief(makeBrief({ pad: false }));
    expect(result.warnings.join(' ')).toMatch(/chars/);
  });

  test('the retired "Revises if" field is not required', () => {
    expect(validateBrief(makeBrief()).warnings.join(' ')).not.toMatch(/Revises if/);
  });

  test('an archived brief containing "Revises if" remains valid', () => {
    const archived = makeBrief().replace(
      '**The line:** A sharp line.',
      '**Revises if:** first-party evidence changes the assessment.\n**The line:** A sharp line.'
    );
    expect(validateBrief(archived).warnings).toEqual([]);
  });

  test('a Current shift decision horizon without Act now receives the soft action warning', () => {
    const brief = makeBrief().replace('**Decision window:** Next 30 days.', '**Decision window:** Current shift.');
    expect(validateBrief(brief).warnings).toContain('No "Act now:" action found in 1 current-shift judgment(s)');
  });

  test('a Current shift decision horizon with Act now does not receive the action warning', () => {
    const brief = makeBrief().replace(
      '**Decision window:** Next 30 days.',
      '**Decision window:** Current shift.\n**Recommended actions:**\n- **Act now:** Infrastructure — verify exposure — recommended target July 13, 2026.'
    );
    expect(validateBrief(brief).warnings.join(' ')).not.toMatch(/No "Act now:" action/);
  });
});

describe('validateBrief — grounding', () => {
  test('an ungrounded CVE (in no source) is flagged', () => {
    const brief = makeBrief() + '\n\nThe flaw CVE-2099-99999 is critical.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'Some real bug CVE-2026-1111' }] });
    expect(r.warnings.join(' ')).toMatch(/Ungrounded CVE/);
    expect(r.warnings.join(' ')).toMatch(/CVE-2099-99999/);
  });

  test('a CVE present in a source headline is NOT flagged', () => {
    const brief = makeBrief() + '\n\nThe flaw CVE-2026-1111 is critical.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'Real bug', cveData: 'CVE-2026-1111: CVSS 9.8' }] });
    expect(r.warnings.join(' ')).not.toMatch(/Ungrounded CVE/);
  });

  test.each([
    'CVE-2099-**9999**',
    'CVE-2099-__9999__',
    'CVE-2099-~~9999~~',
    'CVE-2099-<strong>9999</strong>',
  ])('normalizes rendered formatting before auditing an ungrounded CVE: %s', (formatted) => {
    const r = validateBrief(withJudgmentClaim(`${formatted} requires action.`), null, {
      headlines: [{ title: 'A different issue CVE-2026-1111' }],
    });
    expect(r.warnings.join(' ')).toMatch(/Ungrounded CVE.*CVE-2099-9999/);
  });

  test('normalizes split HTML in both a CVE and KEV status assertion', () => {
    const r = validateBrief(withJudgmentClaim('CVE-2026-<strong>4444</strong> is in K<strong>E</strong>V.'), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not.*CVE-2026-4444/);
  });

  test.each([
    'CVE-2026-4444 is in __KEV__.',
    'CVE-2026-4444 is in K~~E~~V.',
  ])('normalizes rendered GFM delimiters before auditing KEV status: %s', (claim) => {
    const r = validateBrief(withJudgmentClaim(claim), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not.*CVE-2026-4444/);
  });

  // The KEV audit is checked against the real catalog (source.kevSet),
  // not just the subset of today's headlines that happened to carry isKEV.
  test('a CVE labeled KEV but not in the real catalog is flagged', () => {
    const brief = withJudgmentClaim('KEV: CVE-2026-2222 is now exploited.');
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'y', cveData: 'CVE-2026-2222' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not in the verified/);
  });

  // Previously the KEV-mislabel check only ran `if (verifiedKev.size)`,
  // i.e. only when a headline itself was KEV-flagged, so a fabricated KEV claim
  // on a quiet day (no headline is KEV) passed unaudited. It must now be caught
  // whenever the real catalog (kevSet) is supplied, headline-independent.
  test('a false KEV claim is caught even when NO headline is KEV-flagged', () => {
    const brief = withJudgmentClaim('KEV: CVE-2026-2222 is now exploited.');
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'y', cveData: 'CVE-2026-2222' }],   // no isKEV anywhere
      kevSet: new Set(['CVE-2026-9999']),                      // real catalog, unrelated CVE
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not in the verified/);
  });

  test('a CVE correctly labeled KEV against the real catalog is NOT flagged', () => {
    const brief = withJudgmentClaim('KEV: CVE-2026-2222 is now exploited.');
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'y', cveData: 'CVE-2026-2222' }],
      kevSet: new Set(['CVE-2026-2222']),
    });
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not in the verified/);
  });

  test('pending or conditional KEV language is not treated as an affirmative claim', () => {
    const brief = withJudgmentClaim('CVE-2026-50656 KEV status remains unresolved. Escalate if CISA adds CVE-2026-50656 to KEV.');
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'RoguePlanet CVE-2026-50656' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not in the verified/);
  });

  // A CVE the model was handed in the SYSTEM-DERIVED FACTS ground-truth
  // block (extraSourceText), not in any headline, must not be flagged as
  // ungrounded just because sourceCves only scanned headlines.
  test('a ground-truth CVE (extraSourceText) is NOT flagged as ungrounded', () => {
    const brief = makeBrief() + '\n\nCISA added CVE-2026-3333 to KEV in the last 24h.';
    const r = validateBrief(brief, null, {
      headlines: [],
      extraSourceText: 'SYSTEM-DERIVED FACTS: CISA KEV catalog: 1 new entry added in the last 24h: CVE-2026-3333.',
    });
    expect(r.warnings.join(' ')).not.toMatch(/Ungrounded CVE/);
  });

  test('grounding is skipped when no source is provided', () => {
    const brief = makeBrief() + '\n\nThe flaw CVE-2099-99999 is critical.';
    expect(validateBrief(brief).warnings.join(' ')).not.toMatch(/Ungrounded/);
  });

  test('the shipped blank-link/continuity regression flags all three prior CVEs and the stale KEV-pending claim', () => {
    const f = BRIEF_GROUNDING_REGRESSION;
    const brief = makeBrief() + `
- CISA adds ${f.continuityCves[0]} to KEV.
- CISA adds ${f.continuityCves[1]} to KEV.
- CISA adds ${f.continuityCves[2]} to KEV.`;
    const groundingManifest = buildGroundingManifest({ headlines: [f.coldFusionHeadline] });
    const r = validateBrief(brief, null, {
      groundingManifest,
      kevSet: new Set([f.verifiedKevCve]),
    });
    const joined = r.warnings.join(' ');
    for (const cve of f.continuityCves) expect(joined).toContain(cve);
    expect(joined).toMatch(/described as pending\/not in KEV/);
    expect(hasTrustCriticalFailure(r.warnings)).toBe(true);
  });

  test('inverse KEV validation does not flag a truthful past-tense addition', () => {
    const cve = BRIEF_GROUNDING_REGRESSION.verifiedKevCve;
    const brief = withJudgmentClaim(`CISA added ${cve} to KEV on June 11, 2026.`);
    const r = validateBrief(brief, null, {
      headlines: [{ title: `Vendor advisory for ${cve}` }],
      kevSet: new Set([cve]),
    });
    expect(r.warnings.join(' ')).not.toMatch(/described as pending\/not in KEV/);
  });

  test.each([
    'CISA added CVE-2026-4444 to KEV.',
    'CVE-2026-4444 was added to KEV.',
    'CVE-2026-4444 was listed in KEV.',
    'KEV includes CVE-2026-4444.',
    'CVE-2026-4444 entered KEV.',
    'CISA’s addition of CVE-2026-4444 to KEV changed the deadline.',
    'CVE-2026-4444 became a KEV entry.',
    'CISA placed CVE-2026-4444 on KEV.',
    'CVE-2026-4444 is on CISA’s KEV catalog.',
    'CISA’s KEV catalog includes CVE-2026-4444.',
    "CVE-2026-4444 was added to CISA's KEV.",
    'When CISA added CVE-2026-4444 to KEV, it triggered a deadline.',
    'When CVE-2026-4444 was added to KEV, it triggered a deadline.',
    'CVE-2026-4444 remains in KEV.',
    'CVE-2026-4444 appears in KEV.',
    'CISA confirmed CVE-2026-4444 in its KEV catalog.',
    'CISA added CVE-2026-4444 to its Known Exploited Vulnerabilities catalog (KEV).',
    'CISA added CVE-2026-4444 to its Known Exploited Vulnerabilities (KEV) Catalog.',
    "CVE-2026-4444 is now in CISA's Known Exploited Vulnerabilities catalog.",
    "CISA's Known Exploited Vulnerabilities list includes CVE-2026-4444.",
  ])('flags a source-grounded affirmative claim absent from the catalog: %s', (claim) => {
    const r = validateBrief(withJudgmentClaim(claim), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not in the verified catalog.*CVE-2026-4444/);
  });

  test.each([
    'If CISA added CVE-2026-4444 to KEV, the deadline would change.',
    'Whether CVE-2026-4444 was added to KEV remains unknown.',
    'CVE-2026-4444 could be added to KEV.',
    'When CISA adds CVE-2026-4444 to KEV, the deadline will change.',
    'When CVE-2026-4444 is added to KEV, the deadline will change.',
  ])('does not treat conditional language as affirmative membership: %s', (claim) => {
    const r = validateBrief(withJudgmentClaim(claim), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not in the verified catalog/);
  });

  test.each([
    'No evidence shows CISA added CVE-2026-4444 to KEV.',
    'There is no evidence that CISA added CVE-2026-4444 to KEV.',
  ])('an explicitly negated evidence caveat is not misread as affirmative: %s', (claim) => {
    const r = validateBrief(withJudgmentClaim(claim), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not|described as pending\/not in KEV/);
  });

  test.each([
    'CISA has not added CVE-2026-4444 to KEV.',
    'CISA did not add CVE-2026-4444 to KEV.',
    'CVE-2026-4444 has yet to enter KEV.',
    'No evidence shows CISA added CVE-2026-4444 to KEV.',
    'There is no evidence CISA added CVE-2026-4444 to KEV.',
    'CISA did not add CVE-2026-4444 to its Known Exploited Vulnerabilities catalog (KEV).',
    'CVE-2026-4444 is not in the Known Exploited Vulnerabilities list.',
  ])('flags a negative catalog claim when the CVE is verified KEV: %s', (claim) => {
    const r = validateBrief(withJudgmentClaim(claim), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(['CVE-2026-4444']),
    });
    expect(r.warnings.join(' ')).toMatch(/described as pending\/not in KEV.*CVE-2026-4444/);
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not/);
  });

  test('scopes inverse status to its associated CVE on a mixed line', () => {
    const a = 'CVE-2026-61001';
    const b = 'CVE-2026-61002';
    const r = validateBrief(withJudgmentClaim(`${a} is in KEV; ${b} remains pending KEV.`), null, {
      headlines: [{ title: `${a} and ${b}` }],
      kevSet: new Set([a, b]),
    });
    const inverse = r.warnings.find(w => /described as pending\/not in KEV/.test(w));
    expect(inverse).toContain(b);
    expect(inverse).not.toContain(a);
  });

  test('scopes inverse status to the nearest CVE even when clauses use a comma', () => {
    const a = 'CVE-2026-61001';
    const b = 'CVE-2026-61002';
    const r = validateBrief(withJudgmentClaim(`${a} is in KEV, ${b} remains pending KEV.`), null, {
      headlines: [{ title: `${a} and ${b}` }],
      kevSet: new Set([a, b]),
    });
    const inverse = r.warnings.find(w => /described as pending\/not in KEV/.test(w));
    expect(inverse).toContain(b);
    expect(inverse).not.toContain(a);
  });

  test.each([
    'CISA added CVE-2026-4444 to KEV.',
    'CVE-2026-4444 remains pending KEV.',
  ])('fails closed when a supplied runtime catalog is empty: %s', (claim) => {
    const r = validateBrief(withJudgmentClaim(claim), null, {
      headlines: [{ title: 'Vendor advisory CVE-2026-4444' }],
      kevSet: new Set(),
    });
    expect(r.warnings.join(' ')).toMatch(/KEV catalog unavailable.*CVE-2026-4444/);
    expect(hasTrustCriticalFailure(r.warnings)).toBe(true);
  });

  test.each([
    'KEV',
    'the Known Exploited Vulnerabilities (KEV) catalog',
  ])('a grounded future Watchlist condition is not mislabeled as affirmative membership: %s', (catalog) => {
    const cve = 'CVE-2026-4555';
    const brief = makeBrief() + `\n- CISA adds ${cve} to ${catalog}.`;
    const r = validateBrief(brief, null, {
      headlines: [{ title: `Vendor advisory ${cve}` }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not|catalog unavailable|described as pending/);
    expect(hasTrustCriticalFailure(r.warnings)).toBe(false);
  });

  test('an unambiguous affirmative claim cannot hide inside Watchlist', () => {
    const cve = 'CVE-2026-4555';
    const brief = makeBrief() + `\n- ${cve} is in KEV.`;
    const r = validateBrief(brief, null, {
      headlines: [{ title: `Vendor advisory ${cve}` }],
      kevSet: new Set(['CVE-2026-9999']),
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not.*CVE-2026-4555/);
    expect(hasTrustCriticalFailure(r.warnings)).toBe(true);
  });
});

// Cited-link grounding: a URL rendered as a numbered citation must have
// actually appeared in the input (headlines[].link), or a fabricated 404
// dressed as provenance passes unaudited.
describe('validateBrief — cited link grounding', () => {
  test('a link present in a source headline is NOT flagged', () => {
    const brief = makeBrief() + '\n\nSee [Source, 2026-07-01](https://example.com/real-article) for detail.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'x', link: 'https://example.com/real-article' }] });
    expect(r.warnings.join(' ')).not.toMatch(/Unverifiable source link/);
  });

  test('a link not present in any source headline is flagged', () => {
    const brief = makeBrief() + '\n\nSee [Source, 2026-07-01](https://example.com/fabricated-slug) for detail.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'x', link: 'https://example.com/real-article' }] });
    expect(r.warnings.join(' ')).toMatch(/Unverifiable source link/);
    expect(r.warnings.join(' ')).toMatch(/fabricated-slug/);
  });

  test('the exact source path with a tracking query dropped is NOT flagged', () => {
    const brief = makeBrief() + '\n\nSee [Source, 2026-07-01](https://example.com/article-a) for detail.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'x', link: 'https://example.com/article-a?utm_source=feed' }] });
    expect(r.warnings.join(' ')).not.toMatch(/Unverifiable source link/);
  });

  test('a same-origin parent or root path cannot ground a different source path', () => {
    const brief = makeBrief() + '\n\nSee [Source](https://example.com/) for detail.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'x', link: 'https://example.com/real-article' }] });
    expect(r.warnings.join(' ')).toMatch(/Unverifiable source link/);
  });

  test('tracking-query and fragment differences on the exact source path remain grounded', () => {
    const brief = makeBrief() + '\n\nSee [Source](https://example.com/real-article#details) for detail.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'x', link: 'https://example.com/real-article?utm_source=feed' }] });
    expect(r.warnings.join(' ')).not.toMatch(/Unverifiable source link/);
  });

  test('a meaningful query identifier must match exactly', () => {
    const brief = makeBrief() + '\n\nSee [Source](https://example.com/article?id=999) for detail.';
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'x', link: 'https://example.com/article?id=123&utm_source=feed' }],
    });
    expect(r.warnings.join(' ')).toMatch(/Unverifiable source link/);
    expect(r.warnings.join(' ')).toContain('id=999');
  });

  test('a prompt-visible &amp; URL copy canonicalizes to the raw source query', () => {
    const copied = 'https://example.com/article?id=123&amp;utm_source=feed&amp;lang=en';
    const brief = makeBrief() + `\n\nSee [Source](${copied}) for detail.`;
    const groundingManifest = buildGroundingManifest({
      headlines: [{ title: 'x', link: 'https://example.com/article?id=123&utm_source=feed&lang=en' }],
    });
    expect(validateBrief(brief, null, { groundingManifest }).warnings.join(' '))
      .not.toMatch(/Unverifiable source link/);
    expect(delinkUnallowlistedMarkdownUrls(brief, groundingManifest)).toContain(`](${copied})`);
  });

  test('link grounding is skipped when no headlines are provided', () => {
    const brief = makeBrief() + '\n\nSee [Source, 2026-07-01](https://example.com/whatever) for detail.';
    expect(validateBrief(brief).warnings.join(' ')).not.toMatch(/Unverifiable/);
  });

  test('a blank-link ColdFusion source is safely de-linked while preserving citation text', () => {
    const f = BRIEF_GROUNDING_REGRESSION;
    const groundingManifest = buildGroundingManifest({ headlines: [f.coldFusionHeadline] });
    const linked = makeBrief() + `\n\n[Help Net Security, July 7](${f.inventedColdFusionUrl})`;
    expect(validateBrief(linked, null, { groundingManifest }).warnings.join(' '))
      .toMatch(/Unverifiable source link/);

    const safe = delinkUnallowlistedMarkdownUrls(linked, groundingManifest);
    expect(safe).toContain('[Help Net Security, July 7]');
    expect(safe).not.toContain(f.inventedColdFusionUrl);
    expect(validateBrief(safe, null, { groundingManifest }).warnings.join(' '))
      .not.toMatch(/Unverifiable source link/);
  });

  test('the system-shown CISA catalog URL remains a valid live citation', () => {
    const headline = { title: 'Known exploited issue', isKEV: true, kevCVE: 'CVE-2026-10520' };
    const groundingManifest = buildGroundingManifest({ headlines: [headline] });
    const brief = makeBrief() + `\n\n[CISA KEV catalog](${CISA_KEV_CATALOG_URL})`;
    expect(validateBrief(brief, null, {
      groundingManifest, kevSet: new Set(['CVE-2026-10520']),
    }).warnings.join(' ')).not.toMatch(/Unverifiable source link/);
  });

  test('non-HTTP markdown targets are also de-linked when they are not allowlisted', () => {
    const groundingManifest = buildGroundingManifest({ headlines: [{ title: 'No link' }] });
    const linked = makeBrief() + '\n\n[Untrusted citation](javascript:alert(1))';
    const safe = delinkUnallowlistedMarkdownUrls(linked, groundingManifest);
    expect(safe).not.toContain('javascript:');
    expect(safe).toContain('[Untrusted citation]');
  });

  test('an unsupported bare/autolink URL cannot bypass the live-link fallback', () => {
    const f = BRIEF_GROUNDING_REGRESSION;
    const groundingManifest = buildGroundingManifest({ headlines: [f.coldFusionHeadline] });
    const linked = makeBrief() + `\n\nSource: ${f.inventedColdFusionUrl}`;
    expect(findUnallowlistedMarkdownUrls(linked, groundingManifest)).toContain(f.inventedColdFusionUrl);
    const safe = delinkUnallowlistedMarkdownUrls(linked, groundingManifest);
    expect(safe).toContain('[source link unavailable]');
    expect(safe).not.toContain(f.inventedColdFusionUrl);
  });

  test('the grounding gate neutralizes every implicit link form Marked GFM renders', () => {
    const allowed = 'https://allowed.example/article';
    const groundingManifest = buildGroundingManifest({
      headlines: [{ title: 'Grounded source', link: allowed }],
    });
    const code = '`www.code.example user@code.example ftp://code.example/x`\n```text\nwww.fenced.example user@fenced.example ftp://fenced.example/x\n```';
    const linked = makeBrief() + [
      `Allowed: ${allowed}`,
      'WWW: www.evil.example/path',
      'Email: user@evil.example',
      'FTP: ftp://evil.example/path',
      'CommonMark: <irc://evil.example/path>',
      'Other scheme: [Phone](tel:+15551212)',
      code,
    ].join('\n\n');

    expect(findUnallowlistedMarkdownUrls(linked, groundingManifest)).toEqual(expect.arrayContaining([
      'http://www.evil.example/path',
      'mailto:user@evil.example',
      'ftp://evil.example/path',
      'irc://evil.example/path',
      'tel:+15551212',
    ]));

    const safe = delinkUnallowlistedMarkdownUrls(linked, groundingManifest);
    expect(safe).toContain(code);
    expect(findUnallowlistedMarkdownUrls(safe, groundingManifest)).toEqual([]);
    const renderedHrefs = [...marked.parse(safe, { gfm: true, breaks: true })
      .matchAll(/<a href="([^"]+)"/g)].map(match => match[1]);
    expect(renderedHrefs).toEqual([allowed]);
  });

  test('protocol-relative, FTP, and mail reference definitions cannot bypass grounding', () => {
    const groundingManifest = buildGroundingManifest({ headlines: [{ title: 'No link' }] });
    const linked = makeBrief() + '\n\n[Protocol relative][rel] [FTP][ftp] [Mail][mail]\n\n'
      + '[rel]: //evil.example/path\n[ftp]: ftp://evil.example/path\n[mail]: mailto:user@evil.example';

    expect(findUnallowlistedMarkdownUrls(linked, groundingManifest)).toEqual(expect.arrayContaining([
      '//evil.example/path',
      'ftp://evil.example/path',
      'mailto:user@evil.example',
    ]));

    const safe = delinkUnallowlistedMarkdownUrls(linked, groundingManifest);
    expect(findUnallowlistedMarkdownUrls(safe, groundingManifest)).toEqual([]);
    expect(marked.parse(safe, { gfm: true, breaks: true })).not.toMatch(/<a\s/i);
  });

  test('raw HTML anchors are rejected and stripped while preserving labels', () => {
    const raw = makeBrief() + '\n\n<a href="https://example.com/allowed">Allowed label</a> <a href="//evil.example/x">Evil label</a> <a href="mailto:user@example.com">Mail label</a>';
    expect(containsRawHtmlAnchor(raw)).toBe(true);
    const r = validateBrief(raw, null, {
      headlines: [{ title: 'x', link: 'https://example.com/allowed' }],
    });
    expect(r.warnings).toContain('Raw HTML anchor(s) are not allowed in generated brief');
    expect(hasTrustCriticalFailure(r.warnings)).toBe(true);
    const safe = stripRawHtmlAnchors(raw);
    expect(safe).toContain('Allowed label');
    expect(safe).toContain('Evil label');
    expect(safe).toContain('Mail label');
    expect(safe).not.toMatch(/<\/?a\b|href=/i);
  });

  test('URL and raw-anchor examples inside code remain byte-for-byte unchanged', () => {
    const code = '`<a href="https://allowed.example/x">sample</a>` and ``https://unlisted.example/x``\n```html\n<a href="https://unlisted.example/fenced">sample</a>\n```';
    const groundingManifest = buildGroundingManifest({
      headlines: [{ title: 'x', link: 'https://allowed.example/x' }],
    });
    expect(containsRawHtmlAnchor(code)).toBe(false);
    expect(stripRawHtmlAnchors(code)).toBe(code);
    expect(delinkUnallowlistedMarkdownUrls(code, groundingManifest)).toBe(code);
    expect(findUnallowlistedMarkdownUrls(code, groundingManifest)).toEqual([]);
  });
});

describe('validateBrief — voice', () => {
  test('the banned convergence scaffold is flagged', () => {
    const brief = makeBrief().replace('Where they meet.', 'Horizon 1 (cyber) intersects with Horizon 2 (policy).');
    expect(validateBrief(brief).warnings.join(' ')).toMatch(/banned "Horizon X intersects/);
  });

  test('a banned filler phrase is flagged', () => {
    const brief = makeBrief() + '\n\nThis is a paradigm shift for defenders.';
    expect(validateBrief(brief).warnings.join(' ')).toMatch(/Banned filler/);
  });

  test('a multi-sentence BLUF is flagged', () => {
    const brief = makeBrief().replace('## BLUF\n\nOne sharp judgment.', '## BLUF\n\nFirst judgment here. And a second sentence.');
    expect(validateBrief(brief).warnings.join(' ')).toMatch(/BLUF is \d+ sentences/);
  });
});

describe('countHorizons', () => {
  test('counts tags per horizon', () => {
    const counts = countHorizons('[Horizon 1] a [Horizon 1] b [Horizon 3] c');
    expect(counts).toEqual({ 1: 2, 2: 0, 3: 1 });
  });
});

// hasHardFail/isHardFailWarning are exported from THIS module (the
// same one that produces the warning strings) so routes/brief.js's hard-fail
// gate can never drift out of sync with a rewording here — pinned by running
// validateBrief output straight through the predicate, not a re-implemented
// regex in the test.
describe('hasHardFail / isHardFailWarning', () => {
  test('a brief missing BLUF hard-fails', () => {
    const result = validateBrief(makeBrief({ bluf: false }));
    expect(hasHardFail(result.warnings)).toBe(true);
  });

  test('a brief missing Key Judgments hard-fails', () => {
    const result = validateBrief(makeBrief({ judgments: false }));
    expect(hasHardFail(result.warnings)).toBe(true);
  });

  test('a structurally complete brief does not hard-fail', () => {
    const result = validateBrief(makeBrief());
    expect(hasHardFail(result.warnings)).toBe(false);
  });

  // A missing "Act now:" label is a soft warning only (brief-schema.js
  // documents it as warn-only, and the Wall degrades gracefully). It must NOT
  // trip the same hard-fail gate as a missing BLUF/Key Judgments section.
  test('a missing "Act now:" action-shift warning does NOT hard-fail', () => {
    expect(isHardFailWarning('No "Act now:" action found in 2 this-shift judgment(s)')).toBe(false);
    expect(hasHardFail(['No "Act now:" action found in 2 this-shift judgment(s)'])).toBe(false);
  });

  test('an unrelated warning does not hard-fail', () => {
    expect(hasHardFail(['Banned filler phrase(s): synergies'])).toBe(false);
  });

  test('an empty/undefined warning list does not hard-fail', () => {
    expect(hasHardFail([])).toBe(false);
    expect(hasHardFail(undefined)).toBe(false);
  });
});

describe('hasTrustCriticalFailure / isTrustCriticalWarning', () => {
  test('CVE, KEV, and source-link grounding failures block publication', () => {
    expect(isTrustCriticalWarning('Ungrounded CVE(s) in no source headline: CVE-2099-9999')).toBe(true);
    expect(isTrustCriticalWarning('CVE(s) labeled KEV but not in the verified catalog: CVE-2099-9999')).toBe(true);
    expect(isTrustCriticalWarning('CVE(s) described as pending/not in KEV but already in the verified catalog: CVE-2026-10520')).toBe(true);
    expect(isTrustCriticalWarning('Unverifiable source link(s) not found in the input: https://example.com/x')).toBe(true);
  });

  test('voice and structure warnings are not factual trust failures', () => {
    expect(hasTrustCriticalFailure(['Missing BLUF section', 'Banned filler phrase(s): synergies'])).toBe(false);
  });
});

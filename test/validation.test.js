import { describe, test, expect } from '@jest/globals';
import { validateBrief, countHorizons, hasHardFail, isHardFailWarning } from '../lib/validation.js';

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

  // The KEV audit is checked against the real catalog (source.kevSet),
  // not just the subset of today's headlines that happened to carry isKEV.
  test('a CVE labeled KEV but not in the real catalog is flagged', () => {
    const brief = makeBrief() + '\n\nKEV: CVE-2026-2222 is now exploited.';
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
    const brief = makeBrief() + '\n\nKEV: CVE-2026-2222 is now exploited.';
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'y', cveData: 'CVE-2026-2222' }],   // no isKEV anywhere
      kevSet: new Set(['CVE-2026-9999']),                      // real catalog, unrelated CVE
    });
    expect(r.warnings.join(' ')).toMatch(/labeled KEV but not in the verified/);
  });

  test('a CVE correctly labeled KEV against the real catalog is NOT flagged', () => {
    const brief = makeBrief() + '\n\nKEV: CVE-2026-2222 is now exploited.';
    const r = validateBrief(brief, null, {
      headlines: [{ title: 'y', cveData: 'CVE-2026-2222' }],
      kevSet: new Set(['CVE-2026-2222']),
    });
    expect(r.warnings.join(' ')).not.toMatch(/labeled KEV but not in the verified/);
  });

  test('pending or conditional KEV language is not treated as an affirmative claim', () => {
    const brief = makeBrief() + '\n\nCVE-2026-50656 KEV status remains unresolved. Escalate if CISA adds CVE-2026-50656 to KEV.';
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

  test('query and fragment differences on the exact source path remain grounded', () => {
    const brief = makeBrief() + '\n\nSee [Source](https://example.com/real-article#details) for detail.';
    const r = validateBrief(brief, null, { headlines: [{ title: 'x', link: 'https://example.com/real-article?utm_source=feed' }] });
    expect(r.warnings.join(' ')).not.toMatch(/Unverifiable source link/);
  });

  test('link grounding is skipped when no headlines are provided', () => {
    const brief = makeBrief() + '\n\nSee [Source, 2026-07-01](https://example.com/whatever) for detail.';
    expect(validateBrief(brief).warnings.join(' ')).not.toMatch(/Unverifiable/);
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

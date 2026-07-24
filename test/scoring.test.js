import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  scoreHeadline, applyAlertRules, escapeRegExp, getEffectiveAlertRules,
  classifyUrgency, applyHorizonOverrides, enforceDiversity, writeScoringDebugLog,
} from '../lib/scoring.js';
import { loadUserSettings, saveUserSettings } from '../lib/user-settings.js';
import { isUnsafePattern } from '../lib/regex-util.js';

const baseConfig = {
  analysisSettings: {
    horizonWeights: { horizon1: 0.45, horizon2: 0.4, horizon3: 0.15 },
  },
};

describe('scoreHeadline', () => {
  const fresh = () => ({
    title: 'Zero-day exploited', horizon: 1, weight: 1.2,
    date: new Date().toISOString(), urgency: 'critical', corroboration: 3, isKEV: true,
  });

  test('score is a bounded 0–100 integer', () => {
    const s = scoreHeadline(fresh(), baseConfig);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  test('fresh exploited horizon-1 outscores stale routine horizon-3', () => {
    const hot = { title: 'Zero-day exploited', horizon: 1, weight: 1.2, date: new Date().toISOString(), urgency: 'critical', corroboration: 1 };
    const cold = { title: 'Policy musings', horizon: 3, weight: 1.0, date: new Date(Date.now() - 5 * 86400_000).toISOString(), urgency: 'routine', corroboration: 1 };
    expect(scoreHeadline(hot, baseConfig)).toBeGreaterThan(scoreHeadline(cold, baseConfig));
  });

  test('exploitation evidence COLLAPSES — KEV + critical urgency do not double-count', () => {
    const both = { title: 'X', horizon: 1, weight: 1, date: new Date().toISOString(), urgency: 'critical', corroboration: 1, isKEV: true };
    scoreHeadline(both, baseConfig);
    // the axis is max(catalog=1, urgency=0.85), never their sum
    expect(both.scoreComponents.exploitation).toBe(1);
  });

  test('every axis is normalized to [0,1] and the score never exceeds 100', () => {
    const maxed = { title: 'CVE-2026-1 actively exploited', horizon: 1, weight: 2, date: new Date().toISOString(), urgency: 'critical', corroboration: 64, isKEV: true, alertMatched: true, alertBoost: 10, cvssSeverityText: 'CVSS 10.0 (CRITICAL)' };
    const s = scoreHeadline(maxed, baseConfig);
    for (const v of Object.values(maxed.scoreComponents)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(s).toBeLessThanOrEqual(100);
  });

  test('more corroboration raises the score; the axis saturates in [0,1]', () => {
    const make = (corroboration) => ({ title: 'Story', horizon: 2, weight: 1, date: new Date().toISOString(), urgency: 'routine', corroboration });
    expect(scoreHeadline(make(5), baseConfig)).toBeGreaterThan(scoreHeadline(make(1), baseConfig));
    const h = make(1024); scoreHeadline(h, baseConfig);
    expect(h.scoreComponents.corroboration).toBeLessThanOrEqual(1);
    expect(h.scoreComponents.corroboration).toBeGreaterThan(0.99);
  });

  test('severity folds in from a parsed CVSS', () => {
    const make = (cvssSeverityText) => ({ title: 'V', horizon: 2, weight: 1, date: new Date().toISOString(), urgency: 'routine', corroboration: 1, cvssSeverityText });
    const sev = make('CVSS 9.8 (CRITICAL)');
    const none = make('');
    scoreHeadline(sev, baseConfig); scoreHeadline(none, baseConfig);
    expect(sev.scoreComponents.severity).toBeCloseTo(0.98, 2);
    expect(none.scoreComponents.severity).toBe(0);
    expect(sev.score).toBeGreaterThan(none.score);
  });

  test('emits the five evidence axes and a rationale ledger', () => {
    const h = fresh();
    scoreHeadline(h, baseConfig);
    for (const k of ['recency', 'corroboration', 'exploitation', 'severity', 'relevance']) {
      expect(h.scoreComponents).toHaveProperty(k);
    }
    expect(typeof h.scoreRationale).toBe('string');
    expect(h.scoreRationale).toMatch(/KEV-verified/);
    expect(h.scoreRationale).toContain('reported by 3 distinct sources');
  });

  test('config axis weights re-rank — emphasizing recency lifts a fresh routine item', () => {
    const item = () => ({ title: 'Fresh but routine', horizon: 2, weight: 1, date: new Date().toISOString(), urgency: 'routine', corroboration: 1 });
    const base = scoreHeadline(item(), baseConfig);
    const recencyHeavy = { analysisSettings: { ...baseConfig.analysisSettings, scoring: { axisWeights: { recency: 0.9, corroboration: 0.025, exploitation: 0.025, severity: 0.025, relevance: 0.025 } } } };
    expect(scoreHeadline(item(), recencyHeavy)).toBeGreaterThan(base);
  });

  // #41 — a single-source authoritative advisory (gov-advisory/ics-advisory/
  // vendor-advisory) gets a source-count floor instead of the same 0 an
  // unverified single-source blog rumor gets, so a fresh CISA directive isn't
  // structurally out-ranked by syndicated churn before anyone re-reports it.
  test('a lone authoritative-category advisory outranks an equally-evidenced syndicated blog story', () => {
    const now = new Date().toISOString();
    const cisaDirective = { title: 'CISA emergency directive', horizon: 1, weight: 1.5, date: now, urgency: 'routine', corroboration: 1, category: 'gov-advisory' };
    const syndicatedBlog = { title: 'Syndicated story', horizon: 1, weight: 1.0, date: now, urgency: 'routine', corroboration: 1, category: 'cyber-news' };
    expect(scoreHeadline(cisaDirective, baseConfig)).toBeGreaterThan(scoreHeadline(syndicatedBlog, baseConfig));
  });

  test('the authoritative-category source-count floor does not apply once a second source reports it', () => {
    const h = { title: 'x', horizon: 1, weight: 1, date: new Date().toISOString(), urgency: 'routine', corroboration: 2, category: 'gov-advisory' };
    scoreHeadline(h, baseConfig);
    expect(h.scoreComponents.corroboration).toBeCloseTo(0.5); // unchanged: n=2 formula, not the n=1 floor
  });

  // #72 — KEV catalog membership ages toward the classifier's "elevated" floor as
  // the underlying CVE's date_added gets old, rather than granting permanent max
  // credit; a freshly added entry (or one with no date_added wired through) keeps
  // full credit, so this only changes the ranking of old catalog retrospectives.
  test('an old KEV entry (date_added) scores below a freshly added one, but never below "elevated"', () => {
    const now = new Date().toISOString();
    const freshKEV = { title: 'x', horizon: 1, weight: 1, date: now, urgency: 'routine', corroboration: 1, isKEV: true, kevDateAdded: new Date().toISOString() };
    const oldKEV = { title: 'y', horizon: 1, weight: 1, date: now, urgency: 'routine', corroboration: 1, isKEV: true, kevDateAdded: new Date(Date.now() - 400 * 86400_000).toISOString() };
    scoreHeadline(freshKEV, baseConfig);
    scoreHeadline(oldKEV, baseConfig);
    expect(freshKEV.scoreComponents.exploitation).toBe(1);
    expect(oldKEV.scoreComponents.exploitation).toBeLessThan(1);
    expect(oldKEV.scoreComponents.exploitation).toBeCloseTo(0.45, 2); // floors at the 'elevated' weight
  });

  test('a KEV hit with no kevDateAdded wired through keeps full legacy credit', () => {
    const h = { title: 'x', horizon: 1, weight: 1, date: new Date().toISOString(), urgency: 'routine', corroboration: 1, isKEV: true };
    scoreHeadline(h, baseConfig);
    expect(h.scoreComponents.exploitation).toBe(1);
  });
});

describe('applyAlertRules', () => {
  test('boosts matching headlines and skips invalid regex', () => {
    const headlines = [
      { title: 'New zero-day in firewall product', description: '' },
      { title: 'Quarterly earnings preview', description: '' },
    ];
    applyAlertRules(headlines, [
      { pattern: 'zero.?day', boost: 5 },
      { pattern: '([', boost: 9 }, // invalid — must not throw
    ]);
    expect(headlines[0].alertBoost).toBe(5);
    expect(headlines[0].alertMatched).toBe(true);
    expect(headlines[1].alertBoost).toBeUndefined();
  });

  test('stacks multiple matching rules', () => {
    const headlines = [{ title: 'Ransomware crew exploits zero-day', description: '' }];
    applyAlertRules(headlines, [
      { pattern: 'zero.?day', boost: 5 },
      { pattern: 'ransomware', boost: 4 },
    ]);
    expect(headlines[0].alertBoost).toBe(9);
  });

  test('caps cumulative alert boost at 10', () => {
    const headlines = [{ title: 'Ransomware crew exploits zero-day breach', description: '' }];
    applyAlertRules(headlines, [
      { pattern: 'zero.?day', boost: 5 },
      { pattern: 'ransomware', boost: 5 },
      { pattern: 'breach', boost: 4 }, // 5+5+4 = 14, capped to 10
    ]);
    expect(headlines[0].alertBoost).toBe(10);
  });

  test('preserves an explicit zero boost instead of replacing it with the default', () => {
    const headlines = [{ title: 'Observe this vendor', description: '' }];
    applyAlertRules(headlines, [{ pattern: 'vendor', boost: 0 }]);
    expect(headlines[0].alertMatched).toBe(true);
    expect(headlines[0].alertBoost).toBe(0);
  });
});

describe('classifyUrgency', () => {
  test('critical patterns', () => {
    expect(classifyUrgency({ title: 'Actively exploited zero-day in VPN appliance' })).toBe('critical');
    expect(classifyUrgency({ title: 'CISA emergency directive orders patch' })).toBe('critical');
  });

  test('elevated patterns', () => {
    // Pure severity/announcement language ("emergency patch", "RCE") is not
    // activity evidence, so it classifies as elevated, not critical — see
    // config/domains/cyber.js urgencyLexicon comment.
    expect(classifyUrgency({ title: 'Emergency patch released for RCE flaw' })).toBe('elevated');
    expect(classifyUrgency({ title: 'New ransomware variant targets healthcare' })).toBe('elevated');
    expect(classifyUrgency({ title: 'Patch Tuesday fixes 90 vulnerabilities' })).toBe('elevated');
  });

  test('routine fallback', () => {
    expect(classifyUrgency({ title: 'Vendor announces new partnership' })).toBe('routine');
  });
});

describe('applyHorizonOverrides', () => {
  test('promotes urgent content to horizon 1 and remembers origin', () => {
    const headlines = [
      { title: 'CVE-2026-12345 under active exploitation', horizon: 3 },
      { title: 'Think tank publishes cyber norms paper', horizon: 3 },
    ];
    applyHorizonOverrides(headlines);
    expect(headlines[0].horizon).toBe(1);
    expect(headlines[0].originalHorizon).toBe(3);
    expect(headlines[1].horizon).toBe(3);
  });
});

describe('enforceDiversity', () => {
  test('reserves floor slots for under-represented horizons', () => {
    const headlines = [];
    for (let i = 0; i < 40; i++) {
      headlines.push({ title: `H1 story ${i}`, horizon: 1, source: `Source${i % 6}`, score: 100 - i });
    }
    headlines.push({ title: 'H3 story', horizon: 3, source: 'PolicyFeed', score: 1 });

    const result = enforceDiversity(headlines, null, 20, baseConfig);
    expect(result.some(h => h.horizon === 3)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test('caps any single source within a horizon during fill', () => {
    const headlines = [];
    for (let i = 0; i < 30; i++) {
      headlines.push({ title: `Flood ${i}`, horizon: 1, source: 'LoudFeed', score: 50 - i });
    }
    for (let i = 0; i < 10; i++) {
      headlines.push({ title: `Other ${i}`, horizon: 2, source: `Quiet${i}`, score: 10 });
    }
    const result = enforceDiversity(headlines, { 1: 3, 2: 3, 3: 0 }, 15);
    const loudCount = result.filter(h => h.source === 'LoudFeed').length;
    expect(loudCount).toBeLessThan(15);
    expect(result.length).toBe(15);
  });

  // #79 — the floor-fill pass (pass 1) must honor the same per-source cap as the
  // top-up pass, not just top-up: otherwise a single prolific feed can occupy
  // most of a horizon's floor slots (the Wall's top-of-tier), defeating the
  // "no single feed dominates a horizon" guarantee this function documents.
  test('a burst from one feed cannot dominate the horizon floor itself', () => {
    const headlines = [];
    // One feed posts 7 high-scoring items — more than the floor (7) for H1.
    for (let i = 0; i < 7; i++) {
      headlines.push({ title: `Burst ${i}`, horizon: 1, source: 'BurstFeed', score: 100 - i });
    }
    // A handful of other, lower-scoring H1 items from distinct sources.
    for (let i = 0; i < 5; i++) {
      headlines.push({ title: `Other ${i}`, horizon: 1, source: `OtherFeed${i}`, score: 50 - i });
    }
    const result = enforceDiversity(headlines, { 1: 7, 2: 0, 3: 0 }, 7, baseConfig);
    const burstCount = result.filter(h => h.source === 'BurstFeed').length;
    expect(burstCount).toBeLessThanOrEqual(3); // SOURCE_CAP
    expect(result.length).toBe(7); // still filled from other sources, not left short
  });

  test('explicit floors can never make pass 1 exceed maxTotal', () => {
    const headlines = Array.from({ length: 12 }, (_, i) => ({
      title: `Story ${i}`, horizon: (i % 3) + 1, source: `Feed ${i}`, score: 100 - i,
    }));
    expect(enforceDiversity(headlines, { 1: 10, 2: 10, 3: 10 }, 4)).toHaveLength(4);
  });
});

describe('escapeRegExp', () => {
  test('every regex metacharacter is quoted, so a term matches literally', () => {
    const term = 'C++ (a.b)? [x]* ^$|\\';
    const re = new RegExp(escapeRegExp(term), 'i');
    // The escaped pattern must match the literal string it came from…
    expect(re.test(term)).toBe(true);
    // …and NOT behave as the pattern it looks like (the metachars are inert).
    expect(re.test('Cb')).toBe(false);
  });

  test('a would-be ReDoS term is neutralized to a harmless literal', () => {
    // (a+)+ is the classic catastrophic-backtracking shape; escaped, it can only
    // match the literal characters, so applyAlertRules compiles and runs it safely.
    const re = new RegExp(escapeRegExp('(a+)+'), 'i');
    expect(re.test('(a+)+')).toBe(true);
    expect(re.test('aaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });
});

// #119 — isUnsafePattern must also catch quantified overlapping alternation
// (no inner +/* required), not just a re-quantified group with an inner
// quantifier. These shapes are the OTHER classic catastrophic-backtracking
// trigger and previously sailed straight through to `new RegExp(...)`.
describe('isUnsafePattern — overlapping alternation', () => {
  test('flags quantified alternations whose branches overlap', () => {
    expect(isUnsafePattern('(a|a)+')).toBe(true);
    expect(isUnsafePattern('(a|ab)*c')).toBe(true);
    expect(isUnsafePattern('(x|x|x)*$')).toBe(true);
  });

  test('still flags the original re-quantified-group shape', () => {
    expect(isUnsafePattern('(a+)+')).toBe(true);
  });

  test('does not flag ordinary alert-rule patterns used elsewhere in this suite', () => {
    expect(isUnsafePattern('zero.?day')).toBe(false);
    expect(isUnsafePattern('ransomware')).toBe(false);
    expect(isUnsafePattern(escapeRegExp('C++'))).toBe(false);
    expect(isUnsafePattern('(foo|bar)+')).toBe(false); // quantified but non-overlapping
  });
});

describe('getEffectiveAlertRules', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-scoring-'));
  });
  afterAll(() => {
    // Restore a clean in-memory settings cache for any later test in this file.
    loadUserSettings(mkdtempSync(join(tmpdir(), 'wf-scoring-reset-')));
  });

  test('merges config rules with escaped-literal watch-terms (boost 4)', () => {
    saveUserSettings(dir, { watchTerms: ['Fortinet', 'C++'] });
    loadUserSettings(dir);
    const config = { alertRules: [{ pattern: 'zero.?day', boost: 5 }] };
    const rules = getEffectiveAlertRules(config);
    expect(rules).toEqual([
      { pattern: 'zero.?day', boost: 5 },
      { pattern: 'Fortinet', boost: 4 },
      { pattern: 'C\\+\\+', boost: 4 },
    ]);
  });

  test('watch-terms flow through applyAlertRules as literal matches only', () => {
    saveUserSettings(dir, { watchTerms: ['a.b'] }); // a literal, NOT "a<any>b"
    loadUserSettings(dir);
    const headlines = [
      { title: 'a.b confirmed', description: '' },
      { title: 'axb decoy', description: '' },
    ];
    applyAlertRules(headlines, getEffectiveAlertRules({ alertRules: [] }));
    expect(headlines[0].alertMatched).toBe(true);
    expect(headlines[0].alertBoost).toBe(4);
    expect(headlines[1].alertMatched).toBeUndefined(); // '.' did not act as wildcard
  });

  test('no watch-terms → just the config rules', () => {
    saveUserSettings(dir, { watchTerms: [] });
    loadUserSettings(dir);
    const config = { alertRules: [{ pattern: 'ransomware', boost: 5 }] };
    expect(getEffectiveAlertRules(config)).toEqual([{ pattern: 'ransomware', boost: 5 }]);
  });
});

describe('writeScoringDebugLog — untrusted field hardening', () => {
  test('keeps each headline on its record and neutralizes controls and secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-scoring-log-'));
    const anthropicFixture = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    try {
      writeScoringDebugLog([{
        score: 90,
        horizon: 1,
        source: 'Source\n999. [100] FORGED\x1b]8;;https://evil.example\x07',
        title: 'Incident \u202e https://user:debug-secret@example.com/private',
        corroboration: 1,
        scoreComponents: { 'axis\nforged': anthropicFixture },
      }], dir);

      const output = readFileSync(join(dir, 'scoring-debug.log'), 'utf8');
      expect(output).not.toContain('\x1b');
      expect(output).not.toContain('\u202e');
      expect(output).not.toContain('debug-secret');
      expect(output).not.toContain('sk-ant-api03');
      expect(output).toContain('Source\\n999. [100] FORGED');
      expect(output).toContain('https://[REDACTED]@example.com/private');
      expect(output).toContain('[REDACTED_ANTHROPIC_KEY]');
      expect(output).toContain('axis\\nforged=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

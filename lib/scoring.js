// BlueTeam.News — headline scoring, urgency classification, diversity enforcement.
// Simple, interpretable, calibratable. Every component is logged when
// debugScoring is enabled so teams can tune their config with evidence.

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { log, sanitizeLogText } from './logger.js';
import { getDomainPack, getScoring } from './domain.js';
import { getUserSettings } from './user-settings.js';
import { escapeRegExp, isUnsafePattern } from './regex-util.js';

export { escapeRegExp };

// ── The score: a normalized 0–100 weighted model of separate evidence axes ──
// Every signal is ranked on five bounded [0,1] sub-scores, each weighted by a
// config-declared weight that sums to 1.0, so the final number is `100 × Σ wᵢ·axisᵢ`
// — defensible by construction (no un-bounded channel can dominate) and auditable
// (the same axes render as the score's evidence ledger). The previous additive
// model counted one "actively-exploited KEV zero-day" up to 5× through collinear
// channels (urgency +5, alert +5, KEV +5, horizon-1 +3, horizonWeight); here the
// exploitation evidence is collapsed into ONE axis computed once (a max, not a sum),
// tier lives only in relevance, and recency is a continuous half-life decay.
const DEFAULT_AXIS_WEIGHTS = { recency: 0.22, corroboration: 0.18, exploitation: 0.28, severity: 0.16, relevance: 0.16 };
const DEFAULT_RECENCY_HALFLIFE_H = 30;

const unit = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

// Continuous recency: a half-life decay (no 11h-vs-13h cliff). Undated → a low,
// non-zero prior so it can still surface on other evidence but never reads fresh.
// A future-dated item (broken feed clock, mangled TZ offset) is untrusted,
// not "fresher than fresh": treat anything more than ~1h ahead of now as unknown
// rather than letting it pin at recency 1.0 forever.
function recencyUnit(headline, halfLifeHours) {
  const t = headline.date ? Date.parse(headline.date) : NaN;
  if (!Number.isFinite(t)) return 0.25;
  if (t - Date.now() > 3_600_000) return 0.25; // >1h in the future — treat as undated
  const hours = Math.max(0, (Date.now() - t) / 3_600_000);
  return Math.pow(2, -hours / (halfLifeHours || DEFAULT_RECENCY_HALFLIFE_H));
}

// Categories whose items are authoritative first-party records: CISA/NCSC/PSIRT-
// class advisories do not need cross-source reporting to establish publication,
// so a lone first-hour posting should not score like a lone, unverified blog rumor.
// Matched against headline.category, which comes straight from the feed's
// config.json entry.
const AUTHORITATIVE_CATEGORIES = new Set(['gov-advisory', 'ics-advisory', 'vendor-advisory']);

// Cross-source reporting saturates: 1 source identity → 0, 2 → 0.5, 3 → 0.67,
// 4 → 0.75 … → 1. The stored `corroboration` count deduplicates feed copies by
// publisher identity but does not prove editorial independence. A single
// authoritative-category source gets a floor (as if n=2) instead of the same 0
// floor as an unverified blog post, so a fresh CISA/NCSC/PSIRT advisory is not
// structurally out-ranked by syndicated churn before anyone re-reports it.
function corroborationUnit(headline) {
  const n = Math.max(1, Number(headline.corroboration) || 1);
  if (n === 1 && AUTHORITATIVE_CATEGORIES.has(headline.category)) return 0.5;
  return 1 - 1 / n;
}

// Catalog membership is a permanent fact, but its RANK contribution ages:
// a two-year-old MOVEit retrospective citing CVE-2023-34362 shouldn't take the
// same max-axis credit as a CVE added to the catalog this week. Scale toward the
// urgency-classifier's "elevated" level (never below it — catalog membership is
// still stronger evidence than an unconfirmed elevated-urgency guess) as the
// KEV entry ages from fresh (≤30d, full credit) to long-settled (≥180d, floor).
// The KEV badge / due-date display (headline.isKEV / kevCVE) stay unconditional
// — this only touches the score, not the fact.
const KEV_FRESH_DAYS = 30;
const KEV_SETTLED_DAYS = 180;
function kevRecencyFactor(dateAddedStr, elevatedWeight) {
  const floor = Number.isFinite(elevatedWeight) ? elevatedWeight : 0.45;
  if (!dateAddedStr) return 1; // date_added not wired through — preserve prior behavior
  const added = Date.parse(dateAddedStr);
  if (!Number.isFinite(added)) return 1;
  const ageDays = (Date.now() - added) / 86_400_000;
  if (ageDays <= KEV_FRESH_DAYS) return 1;
  if (ageDays >= KEV_SETTLED_DAYS) return floor;
  const t = (ageDays - KEV_FRESH_DAYS) / (KEV_SETTLED_DAYS - KEV_FRESH_DAYS);
  return 1 - t * (1 - floor);
}

// The COLLAPSED exploitation axis — the strongest single piece of "confirmed and/or
// active threat" evidence, taken as a MAX so the same fact is never summed: a
// verified-catalog hit (h.isKEV for cyber) scores `exp.verified`; classifier-critical
// `exp.critical`; elevated `exp.elevated`; otherwise 0. The weights come from the
// active edition's pack (cyber: 1 / 0.85 / 0.45); the max-not-sum collapse is the
// engine's. Verified and urgency are correlated, so we take the max.
function exploitationUnit(headline, exp) {
  const verified = headline.isKEV ? (exp.verified ?? 1) * kevRecencyFactor(headline.kevDateAdded, exp.elevated) : 0;
  const urgency = headline.urgency === 'critical' ? (exp.critical ?? 0.85)
    : headline.urgency === 'elevated' ? (exp.elevated ?? 0.45) : 0;
  // EPSS (FIRST.org exploit-prediction, 0–1) is forecast likelihood, not confirmed
  // exploitation — credit it as a bounded contributor that approaches but never
  // reaches a fresh catalog hit (scaled by exp.epss, default 0.9). Same max-not-sum
  // discipline: the single strongest piece of exploitation evidence wins.
  const epss = Number.isFinite(headline.epss) ? unit(headline.epss) * (exp.epss ?? 0.9) : 0;
  return Math.max(verified, urgency, epss);
}

// Severity = impact magnitude, distinct from exploitation. Parses a magnitude from
// the edition's severity source (cyber: a CVSS score in `cvssSeverityText`, 0–10 →
// 0–1); falls back to a parenthesized band word; 0 when unknown (enrichment may not
// have run yet — survivors are re-scored after enrichment so this folds in then).
function severityUnit(headline, sev) {
  const data = headline[sev.dataProperty] || '';
  // sev._compiledPattern is precompiled once per pack swap (lib/domain.js),
  // not re-parsed for every headline — also null when the pack's pattern was
  // ReDoS-prone or invalid, in which case we fall through to the band match.
  const score = sev._compiledPattern ? parseFloat((data.match(sev._compiledPattern) || [])[1]) : NaN;
  if (Number.isFinite(score)) return unit(score / (sev.max || 10));
  const band = ((data.match(/\(([A-Za-z]+)\)/) || [])[1] || '').toLowerCase();
  return (sev.bands || {})[band] ?? 0;
}

// Operator relevance — does THIS operator care: a trusted source (feed authority),
// their own alert rules, and their tier weighting. Tier lives here (not as a
// separate score boost), so a Tactical item outranks an equally-evidenced Strategic
// one by the operator's declared priority, not by double-counting urgency.
function relevanceUnit(headline, config) {
  const authority = unit(((Number(headline.weight) || 1) - 0.5) / 1.5); // feed weight ~0.5–2 → 0–1
  const alert = headline.alertMatched ? unit((Number(headline.alertBoost) || 0) / 10) : 0;
  const hw = config?.analysisSettings?.horizonWeights || {};
  const tw = { 1: hw.horizon1 ?? 0.45, 2: hw.horizon2 ?? 0.4, 3: hw.horizon3 ?? 0.15 };
  const maxW = Math.max(tw[1], tw[2], tw[3]) || 1;
  const tier = (tw[headline.horizon] ?? maxW * 0.6) / maxW;
  return unit(0.45 * authority + 0.35 * alert + 0.20 * tier);
}

/**
 * Score a headline 0–100 as a weighted sum of five normalized evidence axes.
 * Emits `scoreComponents` (the [0,1] axis values, for the breakdown UI) and
 * `scoreRationale` (a human-readable evidence ledger, e.g.
 * "KEV-verified · reported by 3 distinct sources · CVSS 9.8 · active exploitation").
 */
export function scoreHeadline(headline, config) {
  const cfgW = config?.analysisSettings?.scoring?.axisWeights || {};
  const w = { ...DEFAULT_AXIS_WEIGHTS, ...cfgW };
  const halfLife = config?.analysisSettings?.scoring?.recencyHalfLifeHours || DEFAULT_RECENCY_HALFLIFE_H;
  const sc = getScoring();   // the active edition's exploitation/severity inputs + rationale words

  const axes = {
    recency: recencyUnit(headline, halfLife),
    corroboration: corroborationUnit(headline),
    exploitation: exploitationUnit(headline, sc.exploitation),
    severity: severityUnit(headline, sc.severity),
    relevance: relevanceUnit(headline, config),
  };

  // Weights normalize to 1 defensively, so a misconfigured set can't inflate the
  // score above 100 or let one axis silently dominate.
  const wSum = Object.values(w).reduce((a, b) => a + (Number(b) || 0), 0) || 1;
  let score01 = 0;
  for (const k of Object.keys(axes)) score01 += ((Number(w[k]) || 0) / wSum) * axes[k];

  if (!Number.isFinite(score01)) {
    log.warn('scoring', `Non-finite score for "${(headline.title || '').slice(0, 60)}" — coercing to 0`);
    score01 = 0;
  }
  headline.score = Math.round(unit(score01) * 100);
  headline.scoreComponents = axes;
  headline.scoreRationale = buildRationale(headline, axes, sc);
  return headline.score;
}

// The evidence ledger: the human-readable receipt behind the rank. Lists only the
// factors that actually contributed, strongest evidence first — the same honesty
// the KEV path already models, made the score's standfirst on every surface.
function buildRationale(headline, axes, sc) {
  const r = sc.rationale || {};
  const sev = sc.severity || {};
  const parts = [];
  if (headline.isKEV) parts.push(r.verified);
  else if (headline.urgency === 'critical') parts.push(r.critical);
  else if (headline.urgency === 'elevated') parts.push(r.elevated);
  const n = Math.max(1, Number(headline.corroboration) || 1);
  if (n > 1) parts.push(`reported by ${n} distinct sources`);
  const sevMatch = sev._compiledPattern ? (headline[sev.dataProperty] || '').match(sev._compiledPattern) : null;
  if (sevMatch) parts.push(`${r.severityLabel} ${sevMatch[1]}`);
  if (headline.alertMatched) parts.push('matches your alert rules');
  // Surface a notable EPSS forecast (≥50%) as a labeled model estimate, distinct
  // from catalog-verified exploitation above — the reader sees prediction vs fact.
  if (Number.isFinite(headline.epss) && headline.epss >= 0.5) {
    parts.push(`EPSS ${Math.round(headline.epss * 100)}% (FIRST — model estimate)`);
  }
  if (axes.recency >= 0.7) parts.push('fresh');
  return parts.filter(Boolean).join(' · ');
}

/** Apply alert rules from config — boost headlines matching patterns. */
export function applyAlertRules(headlines, alertRules) {
  if (!alertRules || alertRules.length === 0) return;

  const compiled = alertRules.map(rule => {
    // alertRules come from config.json. Reject a catastrophic-backtracking shape
    // (a re-quantified group like (a+)+) before it runs against every headline on
    // every refresh and hangs the pipeline. Skip + log rather than block the run.
    if (isUnsafePattern(rule.pattern)) {
      log.warn('scoring', `Skipping alert rule with an unsafe (ReDoS-prone) pattern: ${rule.pattern}`);
      return null;
    }
    try {
      return { regex: new RegExp(rule.pattern, 'i'), boost: rule.boost ?? 5 };
    } catch {
      log.warn('scoring', `Skipping alert rule with an invalid regex: ${rule.pattern}`);
      return null;
    }
  }).filter(Boolean);

  for (const h of headlines) {
    for (const rule of compiled) {
      if (rule.regex.test(h.title) || rule.regex.test(h.description || '')) {
        h.alertBoost = (h.alertBoost || 0) + rule.boost;
        h.alertMatched = true;
      }
    }
    // Cap cumulative alert contribution — a headline matching many rules is the
    // most gameable input; bound it so stacked boosts can't dominate the score.
    if (h.alertBoost) h.alertBoost = Math.min(h.alertBoost, 10);
  }
}

// escapeRegExp (imported from regex-util.js, re-exported above) is the hard
// boundary that keeps the client-supplied side of alerting free of regex/ReDoS
// injection: watch-terms are keywords ("C++", "AT&T", "Fortinet"), so we quote
// them before they ever reach the RegExp constructor in applyAlertRules.

// Turn the operator's saved literal watch-terms into alert rules. Each term is
// escaped (see escapeRegExp) so it matches as a substring, boost fixed at 4 —
// below the config rules' typical 5 so a personal keyword nudges rank without
// out-shouting a curated rule, and well under the cumulative cap of 10.
function watchTermsToRules(terms) {
  if (!Array.isArray(terms)) return [];
  return terms.map(term => ({ pattern: escapeRegExp(term), boost: 4 }));
}

// The full alert-rule set the pipeline actually applies: the config rules PLUS
// the operator's watch-terms as escaped literals. applyAlertRules already
// ReDoS-filters and try/catches every pattern, so the escaped literals pass
// through the same safe compile path as config rules — one honest surface, no
// special-casing. Read watch-terms live from user-settings so a save takes on
// the next refresh (the UI copy promises exactly that).
export function getEffectiveAlertRules(config) {
  return [...(config?.alertRules || []), ...watchTermsToRules(getUserSettings().watchTerms)];
}

/**
 * Classify headline urgency from the active Domain Pack's urgency lexicon (cyber
 * by default). The lexicon — not a hardcoded regex — defines what "critical" and
 * "elevated" mean, so a new edition redefines threat activity by configuration.
 */
export function classifyUrgency(headline, pack = getDomainPack()) {
  const text = `${headline.title || ''} ${headline.description || ''}`.toLowerCase();
  const c = pack?._compiled || {};
  if (c.critical && c.critical.test(text)) return 'critical';
  if (c.elevated && c.elevated.test(text)) return 'elevated';
  return 'routine';
}

/**
 * Promote headlines to Tier 1 when content matches the pack's horizon1Promote
 * lexicon (active exploitation, a bare CVE reference, etc.), regardless of which
 * feed carried them — operationally urgent content jumps the queue per edition.
 */
export function applyHorizonOverrides(headlines, pack = getDomainPack()) {
  const promote = pack?._compiled?.horizon1Promote;
  if (!promote) return;
  for (const h of headlines) {
    if (h.horizon > 1 && promote.test(h.title)) {
      h.originalHorizon = h.horizon;
      h.horizon = 1;
    }
  }
}

/**
 * Enforce minimum per-horizon representation after scoring, with a
 * per-source cap so no single feed dominates a horizon.
 */
export function enforceDiversity(headlines, floors = null, maxTotal = 50, config = null) {
  if (!floors) {
    floors = { 1: 7, 2: 6, 3: 2 };
    if (config?.analysisSettings?.horizonWeights) {
      const hw = config.analysisSettings.horizonWeights;
      const total = maxTotal * 0.4; // ~40% of slots are floor-reserved
      floors = {
        1: Math.max(2, Math.round((hw.horizon1 ?? 0.25) * total)),
        2: Math.max(2, Math.round((hw.horizon2 ?? 0.25) * total)),
        3: Math.max(1, Math.round((hw.horizon3 ?? 0.25) * total)),
      };
    }
  }

  const sorted = [...headlines].sort((a, b) => (b.score || 0) - (a.score || 0));
  const byHorizon = { 1: [], 2: [], 3: [] };
  for (const h of sorted) {
    (byHorizon[h.horizon] || byHorizon[2]).push(h);
  }

  const result = [];
  const used = new Set();
  const SOURCE_CAP = 3;
  const sourceCount = {};

  // Pass 1: fill floors from each horizon, honoring the same per-source cap as
  // pass 2 — the floor decides what the Wall's top-of-tier shows, so a
  // single prolific feed skipping the cap here defeated the diversity guarantee
  // this function's doc comment promises. An item over the cap is skipped in
  // favor of the next by score within the same horizon; pass 3 remains the
  // uncapped safety valve if a horizon can't fill its floor without it.
  for (const [horizon, floor] of Object.entries(floors)) {
    if (result.length >= maxTotal) break;
    let filled = 0;
    for (const h of (byHorizon[horizon] || [])) {
      if (filled >= floor || result.length >= maxTotal) break;
      if (used.has(h)) continue;
      const key = `${h.horizon}:${h.source}`;
      if ((sourceCount[key] || 0) >= SOURCE_CAP) continue;
      result.push(h);
      used.add(h);
      sourceCount[key] = (sourceCount[key] || 0) + 1;
      filled++;
    }
  }

  // Pass 2: fill remaining slots with the same per-source cap
  for (const h of sorted) {
    if (result.length >= maxTotal) break;
    if (used.has(h)) continue;
    const key = `${h.horizon}:${h.source}`;
    if ((sourceCount[key] || 0) >= SOURCE_CAP) continue;
    result.push(h);
    used.add(h);
    sourceCount[key] = (sourceCount[key] || 0) + 1;
  }

  // Pass 3: top off without the cap
  for (const h of sorted) {
    if (result.length >= maxTotal) break;
    if (!used.has(h)) {
      result.push(h);
      used.add(h);
    }
  }

  return result.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/** Append a scored-headline dump for tuning sessions. */
export function writeScoringDebugLog(headlines, dataDir) {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const logPath = join(dataDir, 'scoring-debug.log');
    const header = `\n${'='.repeat(60)}\nSCORING DEBUG — ${new Date().toISOString()}\n${'='.repeat(60)}\n`;
    const lines = headlines.map((h, i) => {
      const safe = (value, maxLength) =>
        sanitizeLogText(value, { maxLength, preserveNewlines: false });
      const comps = h.scoreComponents
        ? Object.entries(h.scoreComponents).slice(0, 20)
          .map(([k, v]) => `${safe(k, 48)}=${safe(v, 64)}`).join(' ')
        : '';
      return `${String(i + 1).padStart(3)}. [${safe(h.score || 0, 16)}] H${safe(h.horizon, 8)} [${safe(h.source, 128)}] ${safe(h.title, 512)}` +
        `${h.corroboration > 1 ? ` (×${safe(h.corroboration, 16)})` : ''}` +
        `${h.alertMatched ? ' *ALERT*' : ''}` +
        `${h.originalHorizon ? ` (promoted from H${safe(h.originalHorizon, 8)})` : ''}\n     ${comps}`;
    });
    writeFileSync(logPath, header + lines.join('\n') + '\n', { flag: 'a' });
  } catch (err) {
    log.warn('scoring', `Debug log write failed: ${err.message}`);
  }
}

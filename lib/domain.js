// ── The Domain Pack loader ──
//
// One seam that converts "a cyber app with a config file" into "the engine + a
// cyber pack." The active pack declares everything domain-specific (entities,
// urgency lexicon, edition identity); core modules read it via getDomainPack()
// instead of hardcoding cyber literals. Cyber ships as the default, so nothing
// regresses. Validated with Zod (Carbon-grade discipline) and hot-swappable via
// setDomainPack(), the seam for per-edition / multi-board configuration later.

import { z } from 'zod';
import { cyberPack } from '../config/domains/cyber.js';
import { log } from './logger.js';
import { isUnsafePattern, safeCompileRegExp } from './regex-util.js';

const ActorSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  region: z.string().min(1),
});

// The engine's CTI fallback briefer — the COMPLETE generic threat-intelligence brief. The
// active pack's `brief` is deep-merged OVER this (see getBrief), so every field
// is guaranteed present even when an edition declares only a few. Cyber overrides
// all of these with its full dictionary; this is what a bare pack falls back to.
// (The section GRAMMAR stays in prompts.js; only this DICTIONARY lives in packs.)
const GENERIC_BRIEF = {
  frame: { title: 'BlueTeam.News', subtitle: 'Intelligence Briefing' },
  persona: {
    system: 'You are the daily cyber threat-intelligence briefer for a defensive security team. You produce a grounded decision-support document for working defenders and security leadership.',
    voiceStandard: 'if a defender reads only the BLUF and one signal, they should still make a better defensive decision today than they would have without it.',
    exampleAudience: 'A cyber defense team: analysts, incident responders, threat intelligence, detection engineering, and security leadership.',
    analystSpecifics: 'threat actors, affected technologies, dates, evidence, and concrete defensive actions',
  },
  tierModelNote: 'the pyramid of who consumes the intelligence and on what horizon',
  horizons: {
    1: { roles: 'front-line operators', signalTypes: 'immediate, actionable developments that demand attention this week.', question: 'What demands attention before the next cycle?' },
    2: { roles: 'threat-intelligence analysts and security managers', signalTypes: 'developing threat capabilities, exposure changes, and defensive posture shifts over the coming weeks or months.', question: 'What developing threat activity or exposure requires a defensive adjustment?' },
    3: { roles: 'directors and leadership', signalTypes: 'long-arc structural shifts that will define the operating environment.', question: 'What structural shift will define the environment we operate in next?' },
  },
  filters: {
    hardExclude: [
      'Marketing dressed as analysis; thought-leadership fluff',
      'Noise without structural consequence',
      'Hype without a specific, verifiable implication',
      "Anything that would not appear in a serious decision-maker's morning read",
    ],
  },
  fields: {
    impactLabel: 'Impact',
    impactInstruction: 'What this means for the team. Name the affected process, asset, or decision.',
  },
  exemplars: {
    bluf: 'Not "X published a report" but "Decision-makers face X because Y changed."',
    actNow: 'Pull the relevant records and flag the exposure.',
    convergence: 'Two trends meet through a shared mechanism — name the link in plain prose, not as a scaffold.',
    watchlist: '"X happens by date Y" not "the situation develops."',
    tierMigration: 'Flagged at Tier 2 last week; new evidence moves this to Tier 1.',
    execAvoid: 'no codes, no internal jargon',
    actionOwners: 'analyst / specialist / leadership',
    actionCatalogNote: '',   // an edition with a verified catalog adds its this-shift citation rule
    absentSpecific: '"not yet confirmed"',
    whatHappenedSpecifics: 'names, figures, dates, and identifiers',
    numberExamples: 'figures, dates, and counts',
  },
  grounding: {
    specifics: 'Every figure, date, count, named entity, and identifier',
    systemFactsNote: 'the system-derived counts',
    verifiedCatalog: 'Distinguish verified facts from inferred ones; when the input flags an item as verified against an authoritative catalog, cite it exactly as provided and never substitute an unverified one.',
    deadlineScopeInstruction: 'Put external deadlines in "What happened" with the issuing authority, affected scope, and original precision; a date-only deadline never gains a clock time or timezone.',
  },
  dayModes: {
    monday: 'Cover what accumulated over the weekend and set the posture for the week.',
    friday: "Flag what needs weekend monitoring, and synthesize the week's pattern in one short paragraph before the Key Judgments.",
    weekend: 'Reduced tempo. Tier 1: critical-only. Expand the longer-horizon reading.',
  },
};

// Deep-merge plain objects (override wins; arrays/scalars replace, not concat) —
// used to overlay a pack's partial `brief` onto the complete GENERIC_BRIEF so
// callers never touch an undefined field. Avoids Zod's non-cascading .default().
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = isPlainObject(base?.[k]) && isPlainObject(override[k])
      ? deepMerge(base[k], override[k])
      : override[k];
  }
  return out;
}

// The engine's domain-free scoring DICTIONARY — the edition-specific inputs to two
// of the five axes, plus the rationale vocabulary. The WEIGHTING MODEL (the five
// axes, Σ wᵢ·axisᵢ normalization, the max-not-sum exploitation collapse) stays in
// scoring.js; only WHAT counts as "verified/severe" and WHAT the receipt says move
// here. getScoring() merges a pack's `scoring` over this, so a bare pack still
// scores coherently and cyber overrides with KEV/CVSS specifics.
const GENERIC_SCORING = {
  // exploitation axis weights: verified-catalog membership (h.isKEV) vs the urgency
  // classifier's bands. Taken as a MAX in scoring.js, never summed.
  exploitation: { verified: 1, critical: 0.85, elevated: 0.45 },
  // severity axis: parse a magnitude out of `dataProperty` with `pattern` (capture
  // group 1, normalized by `max`), else map a parenthesized band word.
  severity: {
    dataProperty: 'cveData',
    pattern: '(?:score|severity)\\s+([\\d.]+)',
    max: 10,
    bands: { critical: 1, high: 0.75, medium: 0.5, low: 0.25 },
  },
  // rationale vocabulary — the words the evidence ledger uses for this edition.
  rationale: { verified: 'verified', critical: 'active threat', elevated: 'elevated activity', severityLabel: 'severity' },
};

const DomainPackSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  entities: z.object({
    actors: z.array(ActorSchema).default([]),
    regions: z.record(z.string(), z.string()).default({}),
    vendors: z.array(z.string()).default([]),
  }).default({ actors: [], regions: {}, vendors: [] }),
  urgencyLexicon: z.object({
    critical: z.array(z.string()).default([]),
    elevated: z.array(z.string()).default([]),
    horizon1Promote: z.array(z.string()).default([]),
  }).default({ critical: [], elevated: [], horizon1Promote: [] }),

  // The brief's edition DICTIONARY — frame, persona, tier roles/signal-types,
  // hard filters, field labels, exemplars, grounding, and day-modes.
  // Every field is OPTIONAL: getBrief() deep-merges what a pack declares over the
  // complete GENERIC_BRIEF, so the prompt never reads an undefined field and a
  // sparse pack still briefs coherently. `frame.subtitle` is the dateline anchor
  // the validator reads back.
  brief: z.object({
    frame: z.object({ title: z.string(), subtitle: z.string() }).partial().optional(),
    persona: z.object({
      system: z.string(), voiceStandard: z.string(), exampleAudience: z.string(), analystSpecifics: z.string(),
    }).partial().optional(),
    tierModelNote: z.string().optional(),
    horizons: z.record(z.string(), z.object({ roles: z.string(), signalTypes: z.string(), question: z.string() }).partial()).optional(),
    filters: z.object({ hardExclude: z.array(z.string()) }).partial().optional(),
    fields: z.object({ impactLabel: z.string(), impactInstruction: z.string() }).partial().optional(),
    exemplars: z.object({
      bluf: z.string(), actNow: z.string(), convergence: z.string(), watchlist: z.string(), tierMigration: z.string(),
      execAvoid: z.string(), execRows: z.string(), actionOwners: z.string(), actionFormat: z.string(),
      priorityLanguage: z.string(), actionCatalogNote: z.string(), absentSpecific: z.string(),
      whatHappenedSpecifics: z.string(), numberExamples: z.string(),
    }).partial().optional(),
    grounding: z.object({
      specifics: z.string(), systemFactsNote: z.string(), verifiedCatalog: z.string(),
      sourceFreshness: z.string(), certaintyLanguage: z.string(), deadlineScopeInstruction: z.string(),
    }).partial().optional(),
    dayModes: z.object({ monday: z.string(), friday: z.string(), weekend: z.string() }).partial().optional(),
  }).partial().default({}),

  // News-search sweep queries — the pipeline iterates these
  // instead of a hardcoded cyber list. `horizon` tags which tier the angle feeds.
  feeds: z.object({
    // RSS/Atom sources for this edition. When present, the pipeline uses these
    // instead of config.trustedFeeds; cyber leaves them in config (so it's unchanged).
    sources: z.array(z.object({
      source: z.string(),
      url: z.string(),
      category: z.string().optional(),
      horizon: z.number().optional(),
      weight: z.number().optional(),
      deepExtract: z.boolean().optional(),
    })).default([]),
    searchQueries: z.array(z.object({ q: z.string(), horizon: z.number().default(2) })).default([]),
  }).default({ sources: [], searchQueries: [] }),

  // Edition scoring inputs — all optional; getScoring() merges
  // over GENERIC_SCORING so the weighting model in scoring.js reads a complete config.
  scoring: z.object({
    exploitation: z.object({ verified: z.number(), critical: z.number(), elevated: z.number() }).partial().optional(),
    severity: z.object({
      dataProperty: z.string(), pattern: z.string(), max: z.number(),
      bands: z.record(z.string(), z.number()),
    }).partial().optional(),
    rationale: z.object({ verified: z.string(), critical: z.string(), elevated: z.string(), severityLabel: z.string() }).partial().optional(),
  }).partial().default({}),

  // The edition-specific landscape panels this edition surfaces.
  // The universal panels (scored signals, convergence, watchlist, velocity, feed
  // health) always render; these gate the cyber-flavoured computed panels so a
  // non-cyber edition's Wall shows none of them rather than empty cyber boxes.
  // Known kinds: 'kev' · 'actors' · 'regions' · 'mitre' · 'vendors'.
  panels: z.array(z.string()).default([]),
});

// Compile a list of regex source strings into ONE case-insensitive alternation,
// or null when the list is empty (so callers can short-circuit cleanly). A
// ReDoS-prone pattern is dropped and logged rather than let into the alternation
// — this compiles once per pack swap, but the result runs against every headline
// on every refresh, same hazard applyAlertRules guards against for config rules.
export function compileLexicon(patterns) {
  if (!patterns || !patterns.length) return null;
  const safe = patterns.filter(p => {
    if (isUnsafePattern(p)) {
      log.warn('domain', `Skipping urgency-lexicon pattern with an unsafe (ReDoS-prone) shape: ${p}`);
      return false;
    }
    return true;
  });
  if (!safe.length) return null;
  try {
    return new RegExp(safe.join('|'), 'i');
  } catch (err) {
    log.warn('domain', `Invalid urgency-lexicon pattern set, ignoring: ${err.message}`);
    return null;
  }
}

// Precompile the per-pack regexes once so the per-headline hot path (classifyUrgency,
// applyHorizonOverrides) never recompiles. Stored on a non-enumerable cache field.
function withCompiled(pack) {
  const lex = pack.urgencyLexicon || {};
  Object.defineProperty(pack, '_compiled', {
    value: {
      critical: compileLexicon(lex.critical),
      elevated: compileLexicon(lex.elevated),
      horizon1Promote: compileLexicon(lex.horizon1Promote),
    },
    enumerable: false,
    configurable: true,
  });
  // The complete brief = the pack's declarations overlaid on the generic fallback,
  // so getBrief() callers never hit an undefined field (see getBrief / GENERIC_BRIEF).
  Object.defineProperty(pack, '_brief', {
    value: deepMerge(GENERIC_BRIEF, pack.brief || {}),
    enumerable: false,
    configurable: true,
  });
  // The complete scoring dictionary (pack's `scoring` over the generic default).
  // The severity regex is precompiled here — once per pack swap, not once per
  // headline scored — and rejected (→ null) the same way a lexicon pattern is
  // when it's ReDoS-prone or invalid; scoring.js falls back to the band match.
  const scoring = deepMerge(GENERIC_SCORING, pack.scoring || {});
  scoring.severity._compiledPattern = safeCompileRegExp(scoring.severity?.pattern, 'i');
  Object.defineProperty(pack, '_scoring', {
    value: scoring,
    enumerable: false,
    configurable: true,
  });
  return pack;
}

let active = withCompiled(DomainPackSchema.parse(cyberPack));

// The pipeline's enricher list lives in a SEPARATE registry slot, not on the pack:
// enrichers carry function references + Node-only deps, so they can't ride the
// Zod-validated (serializable) pack data, and wiring them through domain.js's
// import graph would create a fatal cycle (enrichment.js reads getDomainPack at
// load). The composition root sets the active edition's enrichers via setEnrichers;
// it defaults to none so a bare pack (or a test) simply runs no enrichment.
let activeEnrichers = [];

/** The active Domain Pack (cyber by default). */
export function getDomainPack() {
  return active;
}

/** The active pack's COMPLETE brief dictionary (pack declarations merged over the
 *  generic fallback). Every field is guaranteed present. Read by prompts.js +
 *  validation.js so neither hardcodes cyber language nor risks an undefined field. */
export function getBrief() {
  return active._brief;
}

/** The active pack's COMPLETE scoring dictionary (exploitation weights, severity
 *  parser, rationale vocabulary) merged over the generic default. Read by
 *  scoring.js so the two edition-coupled axes aren't hardcoded to KEV/CVSS. */
export function getScoring() {
  return active._scoring;
}

/** The active edition's ordered enricher list (function-bearing). The pipeline
 *  iterates these by stage instead of calling KEV/CVE/MITRE by name. */
export function getEnrichers() {
  return activeEnrichers;
}

/** Set the active edition's enrichers (the composition root wires the default
 *  cyber list at boot; a new edition supplies its own). Orthogonal to the pack
 *  data so functions never touch the validated/serializable manifest. */
export function setEnrichers(list) {
  activeEnrichers = Array.isArray(list) ? list : [];
  return activeEnrichers;
}

/** Swap the active pack (validated + recompiled). The seam for new editions.
 *  Enrichers are managed separately (see setEnrichers). */
export function setDomainPack(pack) {
  active = withCompiled(DomainPackSchema.parse(pack));
  return active;
}

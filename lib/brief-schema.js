// BlueTeam.News — the brief→structured-data contract.
//
// The AI brief is free-form markdown, yet it is the universal contract that the
// server (history continuity, latest-brief summary) and the loved Wall both
// re-parse. Two independent regex sets used to drift: a renamed label silently
// blanked the Wall. This module is the ONE place the section names, field
// labels, and parse rules live, so the emit side (prompts.js) and every read
// side (history.js, routes/landscape.js, the Wall) share a single source.
//
// Pure ES module: constants + string functions only, no Node or DOM deps, so it
// imports unchanged on the server and in the browser.

// ── Section names (the `## ` headings the brief produces) ──
export const SECTIONS = {
  bluf: 'BLUF',
  execSummary: 'EXECUTIVE SUMMARY',
  keyJudgments: 'KEY JUDGMENTS',
  developing: 'DEVELOPING SITUATIONS',
  convergence: 'CONVERGENCE',
  watchlist: 'WATCHLIST',
};

// ── Field labels (the **bold** lead-ins inside a section's entries) ──
// These strings are emitted by prompts.js and matched by the parse helpers; a
// rename here propagates to both sides at once.
export const FIELDS = {
  assessment: 'Assessment',
  confidence: 'Confidence',
  forecast: 'Forecast',
  whatHappened: 'What happened',
  defenderImpact: 'Defender impact',
  relevance: 'Relevance',
  recommendedActions: 'Recommended actions',
  decisionWindow: 'Decision window',
  theLine: 'The line',
  trajectory: 'Trajectory',
  watchCriteria: 'Watch criteria',
  theIntersection: 'The intersection',
  theCascade: 'The cascade',
  theMove: 'The move',
};

// Canonical one-word trajectory states accepted by the Developing Situations
// parser. "Stalled" occurs in valid archived Briefings and must remain visible
// on the Wall instead of falling through to the presentation-only "Tracking"
// placeholder.
export const TRAJECTORY_VALUES = Object.freeze([
  'Accelerating',
  'Decelerating',
  'Inflecting',
  'Stalled',
]);

// A judgment's Decision window is an operator-response clock, not the
// judgment's analytic tier and not a prediction about when the reported event
// will occur. Keep the model's allowed vocabulary here so the prompt,
// validator, Wall, Briefing, and Print Edition cannot each invent a subtly
// different meaning. Presentation intentionally expands the terse Markdown
// values ("7 days") into explicit reader copy ("Within 7 days").
export const DECISION_WINDOW_VALUES = Object.freeze([
  'Current shift',
  '72 hours',
  '7 days',
  '30 days',
  'This quarter',
]);

const DECISION_WINDOW_DISPLAY = Object.freeze({
  'Current shift': 'This shift',
  '72 hours': 'Within 72 hours',
  '7 days': 'Within 7 days',
  '30 days': 'Within 30 days',
  'This quarter': 'This quarter',
});

function cleanDecisionWindow(value) {
  return stripMd(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:!?]+$/g, '')
    .trim();
}

/**
 * Return the canonical Decision-window value, or an empty string when a newly
 * generated value is outside the current contract. Case and sentence-ending
 * punctuation are presentation noise and do not make an otherwise exact value
 * noncanonical.
 */
export function normalizeDecisionWindow(value) {
  const clean = cleanDecisionWindow(value).toLowerCase();
  return DECISION_WINDOW_VALUES.find(candidate => candidate.toLowerCase() === clean) || '';
}

/**
 * Shape canonical and archived Decision-window text for reader-facing surfaces.
 *
 * `display` is always safe to insert as text after HTML escaping. `relative`
 * tells the Briefing renderer to retain the edition date that anchors a relative
 * window. `legacy` distinguishes compatibility rendering from the vocabulary
 * accepted for a newly generated Briefing.
 */
export function formatDecisionWindow(value) {
  const source = cleanDecisionWindow(value);
  if (!source) {
    return { source: '', canonical: '', display: '', relative: false, legacy: false, kind: 'missing' };
  }

  const canonical = normalizeDecisionWindow(source);
  if (canonical) {
    return {
      source,
      canonical,
      display: DECISION_WINDOW_DISPLAY[canonical],
      relative: true,
      legacy: false,
      kind: canonical === 'Current shift' || canonical === 'This quarter' ? 'this' : 'within',
    };
  }

  const lower = source.toLowerCase();
  const relativeMatch = lower.match(/^(?:next|within)\s+(\d+)\s+(hours?|days?|weeks?|months?)$/);
  if (relativeMatch) {
    const amount = relativeMatch[1];
    const unit = relativeMatch[2];
    return {
      source,
      canonical: '',
      display: `Within ${amount} ${unit}`,
      relative: true,
      legacy: true,
      kind: 'within',
    };
  }

  const legacyRelative = {
    'this shift': 'This shift',
    today: 'Today',
    tonight: 'Tonight',
    tomorrow: 'Tomorrow',
    'this week': 'This week',
    'next quarter': 'Next quarter',
    quarter: 'This quarter',
  }[lower];
  if (legacyRelative) {
    return {
      source,
      canonical: '',
      display: legacyRelative,
      relative: true,
      legacy: true,
      kind: 'this',
    };
  }

  // Archived Briefings used absolute internal decision deadlines. Normalize
  // an existing timing prefix and label the date "By"; never reinterpret it as
  // a sourced deadline or silently convert it into the new relative buckets.
  const looksAbsolute = (
    /\b\d{4}-\d{2}-\d{2}\b/.test(source)
    || /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\b/i.test(source)
    || /\b(?:close of business|COB|end of (?:day|week|month)|\d{1,2}:\d{2})\b/i.test(source)
  );
  if (looksAbsolute) {
    const deadline = source
      .replace(/^(?:by|due(?:\s+by)?|until)\b\s*(?:[:—–-]\s*)?/i, '')
      .trim();
    return {
      source,
      canonical: '',
      display: `By ${deadline || source}`,
      relative: false,
      legacy: true,
      kind: 'by',
    };
  }

  // Unknown archived text remains visible under the explicit "Decision" label.
  // Do not invent "within" or "by" semantics the source did not contain.
  return {
    source,
    canonical: '',
    display: source,
    relative: false,
    legacy: true,
    kind: 'raw',
  };
}

// The BLUF word budget. One shared constant so the emit side (prompts.js,
// which tells the model the target) and the audit side (validation.js, which
// warns past it) can never disagree — previously the prompt said only "One
// sentence" with no length budget while the validator silently warned past 45
// words, so every brief routinely tripped a warning the model was never told
// about. The prompt states this as "maximum ~35 words"; the validator
// warns a little past it (below) so a brief that is honestly one tight
// sentence at 40 words isn't flagged for missing an unstated target.
export const BLUF_MAX_WORDS = 35;

// The Watchlist is useful only as a small set of independent, observable
// conditions. Keep the prompt and validator on one shared range so a truncated
// final section cannot satisfy one side of the contract but fail the other.
export const WATCHLIST_MIN_ITEMS = 5;
export const WATCHLIST_MAX_ITEMS = 8;

// The stable machine-parseable label for the single this-shift action. The
// model emits it as the FIRST recommended action when there is a this-shift
// move (see prompts.js → "Recommended actions"); the Wall reads it back into
// the judgment's `actionShift`. Defined once here so emit and parse can never
// drift. Older briefs predate it — the Wall falls back to the legacy
// "**Analyst/Detection Engineering (this shift):**" form, and the validator
// only warns on its absence.
export const ACT_NOW_LABEL = 'Act now:';

// Filler/cliché phrases the brief must never use. ONE list: the system prompt
// (prompts.js) instructs the model to avoid them, and the validator flags any
// that survive — so the voice rule is enforced on both the emit and the audit
// side from a single source and can never drift.
export const BANNED_PHRASES = [
  'increasingly important', 'rapidly evolving landscape', 'key stakeholders',
  'it remains to be seen', 'only time will tell', "in today's environment",
  'game-changer', 'paradigm shift', 'double-edged sword', 'at the end of the day',
  'moving forward', 'best practices', 'synergies', 'holistic',
  'deep dive', 'unpack',
];

// The CONVERGENCE scaffold the prompt forbids: naming the tier numbers as a
// crutch ("Horizon 1 (…) intersects with Horizon 2 (…)") instead of naming the
// mechanism in plain prose. The validator flags it because shipped briefs violate
// it while structural validation passes them clean.
export const BANNED_SCAFFOLD = /Horizon\s+\d\b[^.\n]{0,80}?\bintersect/i;

// ── Shared parse helpers ──

/** Strip markdown decoration to plain text. */
export function stripMd(s) {
  return (s || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Body of a `## ` section by name, trimmed. The name is a literal section
 * string from SECTIONS (e.g. "EXECUTIVE SUMMARY"); trailing words on the
 * heading line (the BLUF dateline, "WATCHLIST — NEXT 72 HOURS") are tolerated.
 */
export function section(md, name) {
  const m = (md || '').match(
    new RegExp('(?:^|\\n)##\\s+' + escapeRe(name) + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)', 'i')
  );
  return m ? m[1].trim() : '';
}

/**
 * The ONE BLUF rule: the first paragraph of the BLUF section, with a
 * leading rule (`---`) tolerated and markdown stripped. Consolidates the old
 * server `extractBluf` and the Wall's inline BLUF parse so the cover line and
 * the history snippet can no longer disagree. `limit` clamps length (the server
 * snippet wants ≤300; the Wall clamps visually and passes Infinity).
 */
export function parseBluf(md, limit = 300) {
  const block = section(md, SECTIONS.bluf);
  if (!block) return '';
  const firstPara = (block.replace(/^-{2,}\s*$/gm, '').trim().split(/\n\s*\n/)[0] || '');
  const bluf = stripMd(firstPara);
  return Number.isFinite(limit) ? bluf.slice(0, limit) : bluf;
}

// Signal heading: "### Signal {N}{sep}[Horizon {d}] {title}". The separator
// between the signal number and the horizon tag varies in practice — em-dash,
// en-dash, plain hyphen, or a colon, with arbitrary surrounding spaces — and a
// strict pattern silently drops signals. This matcher tolerates all of
// them and an absent separator.
const SIGNAL_HEADING = /Signal\s+\d+\s*[—–:\-]?\s*\[Horizon\s+(\d)\]\s*(.+?)\s*$/i;

/**
 * Signal titles with horizon tags, for continuity and the latest-brief summary.
 * Reads the `### Signal N — [Horizon d] Title` headings in KEY JUDGMENTS.
 */
export function parseSignalTitles(md) {
  return [...(md || '').matchAll(new RegExp('###\\s*' + SIGNAL_HEADING.source, 'gim'))]
    .map(m => ({ horizon: parseInt(m[1], 10), title: stripMd(m[2]) }));
}

/** A single field value from an entry block: `**Label:** value` (one line). */
export function field(block, label) {
  const m = (block || '').match(new RegExp('\\*\\*' + escapeRe(label) + ':\\*\\*\\s*([^\\n]+)', 'i'));
  return m ? stripMd(m[1]) : '';
}

/** True when a `**Label:**` field is present anywhere in the block. */
export function hasField(block, label) {
  return new RegExp('\\*\\*' + escapeRe(label) + ':\\*\\*', 'i').test(block || '');
}

/** `- ` / `• ` bullets in a block, markdown stripped. */
export function bullets(block) {
  return [...(block || '').matchAll(/^[-•]\s+(.+)$/gm)].map(m => stripMd(m[1])).filter(Boolean);
}

/**
 * Split a section body into its `### Heading … body` entries. matchAll (not
 * split().slice(1)) so the FIRST entry survives when the section was trimmed
 * and begins at "###" with no preceding newline.
 */
export function splitEntries(block) {
  return [...(block || '').matchAll(/(?:^|\n)###\s+([\s\S]*?)(?=\n###\s|$)/g)].map(m => m[1].trim());
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Brief parsers (shape the brief markdown into the editorial objects the Wall
// renders). Pure string functions, built on the primitives above; the Wall
// imports these from /vendor/brief-schema.js so its parsing and the server's
// share one source. Behavior is byte-identical to the Wall's former inline copy.

/**
 * The whole brief, shaped for the Wall: BLUF, exec-summary lead/tail bullets,
 * judgments, developing situations, convergence, and the watchlist.
 */
export function parseBrief(md, options = {}) {
  const stories = parseJudgments(md, options);
  const watchHeading = stripMd((String(md || '').match(/^##\s+(WATCHLIST[^\n]*)/im) || [])[1] || '');
  const validThrough = (watchHeading.match(/\bTHROUGH\s+(.+)$/i) || [])[1] || '';
  return {
    bluf: parseBluf(md, Infinity),
    execSummary: parseExecBullets(section(md, SECTIONS.execSummary)),
    stories,
    actions: stories.flatMap(story => story.actions),
    developing: parseDeveloping(md),
    convergence: parseConvergence(md),
    watchlist: bullets(section(md, SECTIONS.watchlist)),
    watchlistEntries: [...section(md, SECTIONS.watchlist).matchAll(/^[-•]\s+(.+)$/gm)].map(match => ({ text: stripMd(match[1]), citations: sourceCitations(match[1]) })),
    watchlistMetadata: { heading: watchHeading, validThrough, validityText: validThrough ? `Through ${validThrough}` : '' },
  };
}

// Additive, browser/server-safe action identity. Reordering judgments or actions
// does not change an identity; editing an authored action deliberately does.
function authoredId(prefix, text) {
  let hash = 2166136261;
  for (const char of String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

/** Complete action records; optional context is extracted only when authored. */
export function parseRecommendedActions(part, { judgmentId = '', judgmentAnchor = '', decisionWindow = '' } = {}) {
  const lines = String(part || '').split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*\*\*Recommended actions:\*\*/i.test(line));
  const records = [];
  if (start >= 0) {
    let current = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\*\*[^*]+:\*\*|^---\s*$|^###\s/.test(line)) break;
      if (/^[-*•]\s+/.test(line)) {
        if (current.length) records.push(current.join('\n').trim());
        current = [line.replace(/^[-*•]\s+/, '')];
      } else if (current.length && line.trim()) current.push(line);
    }
    if (current.length) records.push(current.join('\n').trim());
  }
  // Historical role-labelled directives can exist without the modern list.
  if (!records.length) {
    const legacy = String(part || '').match(/\*\*(Act now|Analyst\s*\(this shift\)|Detection Engineering\s*\(this shift\)):\*\*\s*([^\n]+)/i);
    if (legacy) records.push(/^Act now$/i.test(legacy[1]) ? legacy[2] : `${legacy[1].replace(/\s*\(this shift\)/i, '')} — ${legacy[2]}`);
  }
  const identities = new Map();
  return records.map(markdown => {
    const first = stripMd(markdown.split('\n')[0]).replace(/^Act now:\s*/i, '');
    let imperative = first, owner = '', target = '', targetType = '';
    const targetMatch = imperative.match(/(?:\s*[—–]\s*|\s+-\s+|;\s*)(recommended\s+target|target(?:\s+date)?|due)\s*:?\s+(.+?)\.?$/i);
    if (targetMatch) {
      target = targetMatch[2].replace(/[.;]+$/, '').trim();
      targetType = /^recommended/i.test(targetMatch[1]) ? 'recommended' : /^due$/i.test(targetMatch[1]) ? 'due' : 'target';
      imperative = imperative.slice(0, targetMatch.index).trim();
    }
    const ownerMatch = imperative.match(/^([^—–\n]{2,80}?)(?:\s*[—–]\s*|\s+-\s+)(.+)$/);
    if (ownerMatch) { owner = ownerMatch[1].trim(); imperative = ownerMatch[2].trim(); }
    const contexts = new Map(), continuation = [];
    let contextLabel = '';
    // Producer templates and editorial copies can keep optional labelled context
    // on the same bullet. A label must start the text or follow a sentence/list
    // boundary; ordinary semicolons inside its value remain authored text.
    {
      const inline = [...imperative.matchAll(/(?:^|[;.]\s+)(Condition|Dependencies|Initiation|Evidence\s*\/\s*artifact|Completion criterion|Recovery):\s*/gi)];
      inline.forEach((label, index) => {
        contextLabel = label[1].toLowerCase().replace(/\s*\/\s*/g, '/');
        contexts.set(contextLabel, imperative.slice(label.index + label[0].length, inline[index + 1]?.index ?? imperative.length).trim());
      });
      if (inline.length) imperative = imperative.slice(0, inline[0].index).trim();
    }
    for (const line of markdown.split('\n').slice(1)) {
      const label = /^\s*(?:[-*•]\s*)?(?:\*\*)?(Condition|Dependencies|Initiation|Evidence\s*\/\s*artifact|Completion criterion|Recovery):(?:\*\*)?\s*(.*)$/i.exec(line);
      if (label) {
        contextLabel = label[1].toLowerCase().replace(/\s*\/\s*/g, '/');
        contexts.set(contextLabel, [contexts.get(contextLabel), stripMd(label[2])].filter(Boolean).join(' '));
      } else if (contextLabel) contexts.set(contextLabel, [contexts.get(contextLabel), stripMd(line)].filter(Boolean).join(' '));
      else continuation.push(line);
    }
    const context = label => contexts.get(label.toLowerCase()) || '';
    // Unlabelled continuation remains part of the imperative. Continuations of
    // a labelled context stay with that field, including authored recovery lists.
    if (continuation.length) imperative += ` ${stripMd(continuation.join(' '))}`;
    const baseId = authoredId('action', `${judgmentId}\n${stripMd(markdown)}`);
    const occurrence = (identities.get(baseId) || 0) + 1;
    identities.set(baseId, occurrence);
    return {
      id: occurrence > 1 ? `${baseId}-${occurrence}` : baseId,
      judgmentId, judgmentAnchor, decisionWindow, owner, imperative, target, targetType,
      condition: context('Condition') || ((imperative.match(/^((?:if|unless|when)\b[^,;]+)[,;]/i) || [])[1] || ''),
      dependencies: context('Dependencies'), initiationTrigger: context('Initiation'),
      evidence: context('Evidence/artifact'), completionCriterion: context('Completion criterion'), recoverySteps: context('Recovery'),
      text: stripMd(markdown).replace(/^Act now:\s*/i, ''), markdown, citations: sourceCitations(markdown),
    };
  });
}

/**
 * KEY JUDGMENTS as focal objects: horizon, title, line, assessment, decision
 * window, confidence, the single this-shift action, and the KEV CVE if any.
 */
export function parseJudgments(md, { verifiedKevCves = [] } = {}) {
  const block = section(md, SECTIONS.keyJudgments);
  if (!block) return [];
  return splitEntries(block).map((part, index) => {
    const firstLine = part.split('\n')[0] || '';
    // Parse this entry's own heading. Looking titles up by their position in a
    // separate list makes one malformed heading shift every later title onto
    // the wrong judgment.
    const heading = firstLine.match(SIGNAL_HEADING);
    const hm = firstLine.match(/\[Horizon\s+(\d)\]/i);
    const horizon = heading ? parseInt(heading[1], 10) : (hm ? parseInt(hm[1], 10) : 2);
    const title = heading
      ? stripMd(heading[2])
      : stripMd(firstLine.replace(/^Signal\s+\d+\s*[—–:\-]?\s*/i, '').replace(/\[Horizon\s+\d\]\s*/i, ''));
    // Keep the complete authored certainty statement. Presentation distinguishes
    // probability terms from legacy confidence levels without dropping the basis.
    const confidence = field(part, FIELDS.confidence).trim();
    const decision = field(part, FIELDS.decisionWindow).split(/\s+[—–-]\s+/)[0].trim();

    // The single "this shift" action. Prefer the stable shared label
    // (**Act now:** …) the prompt now emits; fall back to the legacy role-in-
    // label form (**Analyst/Detection Engineering (this shift):** …) so older
    // briefs still surface it. Never fabricated when neither is present.
    const escLabel = ACT_NOW_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const actNow = part.match(new RegExp('\\*\\*\\s*' + escLabel + '\\s*\\*\\*\\s*([^\\n]+)', 'i'));
    const legacy = !actNow && part.match(/\*\*(Analyst|Detection Engineering)\s*\(this shift\):\*\*\s*([^\n]+)/i);
    const actionShift = actNow
      ? { owner: null, imperative: stripMd(actNow[1]) }
      : legacy ? { owner: legacy[1], imperative: stripMd(legacy[2]) } : null;

    // KEV badge: prefer a CVE the model carried verbatim immediately beside the
    // word "KEV" — same line or the line adjacent. If "KEV" appears but no CVE
    // sits unambiguously next to it, do not fabricate a badge.
    const kevCVE = pickKevCVE(part, verifiedKevCves);
    const id = authoredId('judgment', title);
    const actions = parseRecommendedActions(part, { judgmentId: id, judgmentAnchor: `judgment-${index + 1}`, decisionWindow: decision });

    return {
      id, actions,
      horizon, title, line: field(part, FIELDS.theLine),
      assessment: field(part, FIELDS.assessment),
      whatHappened: field(part, FIELDS.whatHappened), defenderImpact: field(part, FIELDS.defenderImpact), relevance: field(part, FIELDS.relevance),
      forecast: field(part, FIELDS.forecast),
      decision, confidence, actionShift, isKEV: !!kevCVE, kevCVE,
      citations: judgmentCitations(part),
    };
  }).filter(s => s.title);
}

/** Presentation only: a probability statement is likelihood, not evidence confidence. */
export function judgmentCertainty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const likelihood = /^(?:(?:almost|virtually) certain|(?:highly|very) (?:likely|unlikely)|likely|unlikely|roughly even(?: chance)?|(?:a )?realistic possibility|(?:a )?remote chance)\b/i.test(text)
    || (!/^(?:high|moderate|medium|low)\b/i.test(text) && /^\d+(?:\.\d+)?\s*(?:[-–]\s*\d+(?:\.\d+)?)?\s*%/.test(text));
  let split = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if ('([{'.includes(text[i])) depth++;
    else if (')]}'.includes(text[i])) depth = Math.max(0, depth - 1);
    else if (!depth && /[—–]/.test(text[i]) && /\s/.test(text[i - 1] || '') && /\s/.test(text[i + 1] || '')) { split = i; break; }
  }
  return {
    label: likelihood ? 'Likelihood' : 'Confidence',
    value: split >= 0 ? text.slice(0, split).trim() : text,
    basis: split >= 0 ? text.slice(split + 1).trim() : '',
    text,
  };
}

// An official badge requires edition-bound catalog verification and one uniquely
// affirmative clause. Neither proximity to a CVE nor a lookup instruction is evidence.
function pickKevCVE(part, verifiedKevCves) {
  const verified = verifiedKevCves instanceof Set ? verifiedKevCves : new Set(verifiedKevCves || []);
  const claims = [...affirmativeKevClaims(stripMd(part))];
  return claims.length === 1 && verified.has(claims[0]) ? claims[0] : '';
}

/** Saved judgment links for provenance displays; never infer them from today's feed. */
export function judgmentCitations(part) {
  return sourceCitations(rawField(part, FIELDS.whatHappened));
}

/** Exact authored links from any entry; no inference from another section. */
export function sourceCitations(markdown) {
  return [...String(markdown || '').matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)]
    .map(match => ({ label: stripMd(match[1]), url: match[2] }));
}

/** A field's complete Markdown value, including action bullets and source links. */
export function rawField(block, label) {
  const re = new RegExp('(?:^|\\n)\\s*\\*\\*' + escapeRe(label) + ':\\*\\*[ \\t]*([\\s\\S]*?)(?=\\n\\s*\\*\\*[^*\\n]+:\\*\\*|\\n---|$)', 'i');
  return (re.exec(block || '')?.[1] || '').trim();
}

// Executive Summary bullets keep the bold lead-in separate from the muted tail.
export function parseExecBullets(block) {
  return [...block.matchAll(/^[-•]\s+(.+)$/gm)].map(m => {
    const raw = m[1].trim();
    const bm = raw.match(/^\*\*([^*]+)\*\*/);
    const lead = bm ? stripMd(bm[1]) : stripMd(raw);
    const tail = bm ? stripMd(raw.slice(bm[0].length).replace(/^[:\s]+/, '')) : '';
    return { lead, tail };
  }).filter(b => b.lead);
}

// Developing Situations: retain the complete trajectory explanation and watch
// criteria. A separate approved leading verb drives the state color without
// replacing the explanation or guessing a state from words later in the note.
export function parseDeveloping(md) {
  const block = section(md, SECTIONS.developing);
  if (!block) return [];
  return splitEntries(block).map(part => {
    const name = stripMd(part.split('\n')[0] || '');
    const trajRaw = field(part, FIELDS.trajectory);
    // The contract puts the state first, before its explanatory dash. Match
    // that leading token only so prose such as "Stalled — not accelerating"
    // cannot be mislabeled by a later keyword in the explanation.
    const leadState = (trajRaw.match(/^\s*([A-Za-z]+)\b/) || [])[1] || '';
    const trajectory = TRAJECTORY_VALUES.find(value => (
      value.toLowerCase() === leadState.toLowerCase()
    )) || '';
    const watch = field(part, FIELDS.watchCriteria);
    return { name, trajectory, trajectoryDetail: trajRaw, watch, citations: sourceCitations(part) };
  }).filter(d => d.name);
}

// Convergence is the connect-the-dots story: the ### heading names WHICH two
// threats converge, the intersection is the mechanism, the cascade is the
// second-order chain (the highest-value reasoning), and the move is the one
// directive. All four are surfaced on the Wall's convergence page.
export function normalizeConvergenceOpening(md) {
  const lines = String(md || '').split('\n');
  let inConvergence = false;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length
        && lines[i].slice(marker[0].length).trim() === '') fence = null;
      continue;
    }
    if (fence) continue;
    if (/^##\s+/.test(lines[i])) inConvergence = /^##\s+CONVERGENCE\s*$/i.test(lines[i]);
    if (!inConvergence || !/^###\s+/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end++;
    const part = lines.slice(i + 1, end).join('\n');
    if (hasField(part, FIELDS.theIntersection)
      || !field(part, FIELDS.theCascade) || !field(part, FIELDS.theMove)) continue;
    const firstField = lines.findIndex((line, index) => index > i && index < end && /^\s*\*\*[^*]+:\*\*/.test(line));
    if (firstField < 0 || !/^\s*\*\*The cascade:\*\*/i.test(lines[firstField])) continue;
    const opening = lines.slice(i + 1, firstField).join('\n').trim();
    // Repair only the label on one existing prose paragraph. Lists, code,
    // quotes, multiple paragraphs and missing analysis are not substitutes.
    if (!opening || /\n\s*\n|^\s*(?:[#>*`~|-]|\d+[.)]\s)/m.test(opening)) continue;
    const firstProse = lines.findIndex((line, index) => index > i && index < firstField && line.trim());
    if (firstProse >= 0) lines[firstProse] = `**${FIELDS.theIntersection}:** ${lines[firstProse].trimStart()}`;
  }
  return lines.join('\n');
}

/** Same deterministic section anchor used by the reader after removing BLUF. */
export function briefSectionAnchors(md) {
  let index = 0;
  return [...String(md || '').matchAll(/^##\s+(.+)$/gm)].filter(match => !/^BLUF\b/i.test(match[1])).map(match => ({
    label: stripMd(match[1]), id: `section-${index++}-${stripMd(match[1]).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 40)}`,
  }));
}

export function parseConvergence(md) {
  const block = section(md, SECTIONS.convergence);
  if (!block) return [];
  return splitEntries(block).map(part => {
    // The heading is the first line of each entry (splitEntries strips the '### ').
    const title = stripMd((part.split('\n')[0] || '').trim());
    // Older/model-drifted briefs sometimes put the mechanism directly beneath
    // the heading without its bold label. Recover that opening prose so the Wall
    // and exports do not lose the most important sentence over presentation syntax.
    const lines = part.split('\n');
    const firstField = lines.findIndex((line, i) => i > 0 && /^\s*\*\*[^*]+:\*\*/.test(line));
    const openingProse = stripMd(lines.slice(1, firstField === -1 ? lines.length : firstField).join(' '));
    const intersection = field(part, FIELDS.theIntersection) || openingProse;
    const cascade = field(part, FIELDS.theCascade);
    const moveRaw = field(part, FIELDS.theMove);
    // Keep the leading taxonomy verb as a one-word stance (Act/Prepare/Observe/
    // Document); `move` is the verb-stripped imperative sentence itself.
    const moveVerb = (moveRaw.match(/^(Act|Prepare|Observe|Document)\b/i) || [])[1] || '';
    const move = stripMd(moveRaw.replace(/^(Act|Prepare|Observe|Document)\b[\s—–-]*/i, ''));
    return { title, intersection, cascade, move, moveVerb,
      confirmation: field(part, 'Confirmation'), actionRationale: field(part, 'Action rationale'), citations: sourceCitations(part) };
  }).filter(c => c.intersection || c.cascade || c.move);
}

// Catalog-claim grammar shared with publication validation.
function isConditionalAt(text, index) {
  const prefix = text.slice(Math.max(0, index - 64), index);
  if (/\b(?:check|verify|confirm|determine|monitor|look\s+up)(?:\s+that)?\s*$/i.test(prefix)) return true;
  if (/(?:\bno\s+evidence\s+(?:shows?|showed|indicates?|indicated|confirms?|confirmed)|\bthere\s+is\s+no\s+evidence(?:\s+that)?)\s*$/i.test(prefix)) {
    return true;
  }
  // A past-tense "when" clause reports a completed addition. Present-tense
  // "when CISA adds" remains a prospective Watchlist condition.
  if (/\bwhen\b[^.;:\n]{0,28}$/i.test(prefix)) {
    const claim = text.slice(index);
    const activePast = /^CISA\s+(?:had\s+)?(?:added|listed|included)\b/i.test(claim);
    const passivePast = /^CVE-\d{4}-\d{3,7}\s+(?:(?:had\s+)?been|was|were)\s+(?:added|listed|included)\b/i.test(claim);
    return !(activePast || passivePast);
  }
  return /\b(?:if|unless|whether)\b[^.;:\n]{0,28}$|\b(?:should|would|could|may|might)\s*$/i.test(prefix);
}

export const KEV_TERM_SRC = String.raw`(?:KEV(?:\s+catalog)?\b|Known\s+Exploited\s+Vulnerabilities(?:\s*\(KEV\))?\s+(?:catalog|list)\b(?:\s*\(KEV\))?)`;
const kevPattern = source => new RegExp(source, 'gi');

/** Explicit catalog-membership assertions, excluding conditional grammar. */
export function affirmativeKevClaims(text) {
  const patterns = [
    kevPattern(String.raw`\bCISA\s+(?:(?:has|had)\s+)?(?:added|adds|listed|lists|included|includes)\s+(CVE-\d{4}-\d{3,7})\s+(?:to|in|on)\s+(?:(?:the|its)\s+)?(?:CISA(?:['’]s)?\s+)?${KEV_TERM_SRC}`),
    kevPattern(String.raw`\b(CVE-\d{4}-\d{3,7})\s+(?:(?:has|had)\s+been|is|was|are|were)\s+(?:added|listed|included)\s+(?:to|in|on)\s+(?:(?:the|its)\s+)?(?:CISA(?:['’]s)?\s+)?${KEV_TERM_SRC}`),
    kevPattern(String.raw`\b(?:the\s+)?(?:CISA(?:['’]s)?\s+)?${KEV_TERM_SRC}\s+(?:includes|lists|contains)\s+(CVE-\d{4}-\d{3,7})\b`),
    kevPattern(String.raw`\b(CVE-\d{4}-\d{3,7})\s+(?:is|was|are|were|remains?|appears?)\s+(?:now\s+)?(?:on|in)\s+(?:the\s+)?(?:CISA(?:['’]s)?\s+)?${KEV_TERM_SRC}`),
    /\b(CVE-\d{4}-\d{3,7})\s+(?:is|was)\s+KEV-listed\b/gi,
    /\bKEV-listed\s+(CVE-\d{4}-\d{3,7})\b/gi,
    /\bKEV\s*:\s*(CVE-\d{4}-\d{3,7})(?![^.;\n]{0,60}\b(?:pending|unresolved|unknown|not\b))/gi,
    kevPattern(String.raw`\b(CVE-\d{4}-\d{3,7})\s+(?:enters|entered)\s+(?:the\s+)?(?:CISA(?:['’]s)?\s+)?${KEV_TERM_SRC}`),
    kevPattern(String.raw`\bCISA['’]s\s+addition\s+of\s+(CVE-\d{4}-\d{3,7})\s+to\s+(?:the\s+)?${KEV_TERM_SRC}`),
    /\b(CVE-\d{4}-\d{3,7})\s+became\s+a\s+KEV\s+entry\b/gi,
    kevPattern(String.raw`\bCISA\s+placed\s+(CVE-\d{4}-\d{3,7})\s+on\s+(?:the\s+)?${KEV_TERM_SRC}`),
    kevPattern(String.raw`\bCISA\s+(?:(?:has|had)\s+)?confirmed\s+(CVE-\d{4}-\d{3,7})\s+(?:in|on)\s+(?:(?:the|its)\s+)?(?:CISA(?:['’]s)?\s+)?${KEV_TERM_SRC}`),
  ];
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!isConditionalAt(text, match.index || 0)) found.add(match[1].toUpperCase());
    }
  }
  return found;
}

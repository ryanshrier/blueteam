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

// The BLUF word budget. One shared constant so the emit side (prompts.js,
// which tells the model the target) and the audit side (validation.js, which
// warns past it) can never disagree — previously the prompt said only "One
// sentence" with no length budget while the validator silently warned past 45
// words, so every brief routinely tripped a warning the model was never told
// about. The prompt states this as "maximum ~35 words"; the validator
// warns a little past it (below) so a brief that is honestly one tight
// sentence at 40 words isn't flagged for missing an unstated target.
export const BLUF_MAX_WORDS = 35;

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
export function parseBrief(md) {
  return {
    bluf: parseBluf(md, Infinity),
    execSummary: parseExecBullets(section(md, SECTIONS.execSummary)),
    stories: parseJudgments(md),
    developing: parseDeveloping(md),
    convergence: parseConvergence(md),
    watchlist: bullets(section(md, SECTIONS.watchlist)),
  };
}

/**
 * KEY JUDGMENTS as focal objects: horizon, title, line, assessment, decision
 * window, confidence, the single this-shift action, and the KEV CVE if any.
 */
export function parseJudgments(md) {
  const block = section(md, SECTIONS.keyJudgments);
  if (!block) return [];
  return splitEntries(block).map(part => {
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
    // Confidence is now a calibrated estimative term + band ("Likely (55-80%)");
    // keep the term+band, drop the " — basis" tail. Old High/Moderate/Low briefs
    // parse through unchanged (no spaced dash → whole value kept, term still leads).
    const confidence = field(part, FIELDS.confidence).split(/\s+[—–]\s+/)[0].trim();
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
    const kevCVE = pickKevCVE(part);

    return {
      horizon, title, line: field(part, FIELDS.theLine),
      assessment: field(part, FIELDS.assessment),
      decision, confidence, actionShift, isKEV: !!kevCVE, kevCVE,
    };
  }).filter(s => s.title);
}

// The KEV CVE for a judgment, chosen conservatively. A judgment may list several
// CVEs; only one is the KEV one. Take the CVE on the same line as "KEV", or on
// the immediately adjacent line — that is the listed/verified one the prompt was
// told to cite verbatim. When no CVE sits unambiguously next to "KEV", return ''
// rather than guessing from distance (avoids badging the wrong CVE).
function pickKevCVE(part) {
  const lines = part.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\bKEV\b/i.test(lines[i])) continue;
    // A mention is not membership. Suppress badges for explicit negation,
    // uncertainty, and conditionals such as "not yet in KEV" or "if added to
    // KEV"; false-positive KEV badges are worse than omitting an uncertain one.
    const nonAffirmativeBefore = /\b(?:no|not|never|without|isn['’]t|wasn['’]t|if|whether|may|might|could|possibly|potentially)\b[^.\n]{0,48}\bKEV\b/i;
    const nonAffirmativeAfter = /\bKEV\b[^.\n]{0,48}\b(?:unconfirmed|unknown|unresolved|pending|false|isn['’]t|wasn['’]t|not\s+(?:listed|confirmed|verified|present))\b/i;
    if (nonAffirmativeBefore.test(lines[i]) || nonAffirmativeAfter.test(lines[i])) continue;
    const here = lines[i].match(/CVE-\d{4}-\d{3,}/);
    if (here) return here[0];
    const prev = i > 0 && lines[i - 1].match(/CVE-\d{4}-\d{3,}/);
    const next = i < lines.length - 1 && lines[i + 1].match(/CVE-\d{4}-\d{3,}/);
    // Adjacent only when exactly one side carries a CVE — two candidates is
    // ambiguous, so abstain.
    if (prev && !next) return prev[0];
    if (next && !prev) return next[0];
  }
  return '';
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

// Developing Situations: split on ### like judgments. Take only the trajectory
// VERB (for color) and the one-line watch criteria; drop the long trajectory note
// and any trailing source link (terminate at end-of-line).
export function parseDeveloping(md) {
  const block = section(md, SECTIONS.developing);
  if (!block) return [];
  return splitEntries(block).map(part => {
    const name = stripMd(part.split('\n')[0] || '');
    const trajRaw = field(part, FIELDS.trajectory);
    const vm = trajRaw.match(/\b(Inflecting|Accelerating|Decelerating)\b/i);
    const trajectory = vm ? vm[1][0].toUpperCase() + vm[1].slice(1).toLowerCase() : '';
    const watch = field(part, FIELDS.watchCriteria);
    return { name, trajectory, watch };
  }).filter(d => d.name);
}

// Convergence is the connect-the-dots story: the ### heading names WHICH two
// threats converge, the intersection is the mechanism, the cascade is the
// second-order chain (the highest-value reasoning), and the move is the one
// directive. All four are surfaced on the Wall's convergence page.
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
    return { title, intersection, cascade, move, moveVerb };
  }).filter(c => c.intersection);
}

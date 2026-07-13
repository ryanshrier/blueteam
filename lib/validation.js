// BlueTeam.News — post-generation briefing validation.
// Structural sanity checks; warnings are logged, never blocking. The label and
// section names come from the shared brief contract so a relabel can't drift
// the validator out of sync with what the Wall actually parses.

import {
  SECTIONS, FIELDS, ACT_NOW_LABEL, BANNED_PHRASES, BANNED_SCAFFOLD, BLUF_MAX_WORDS,
  section, splitEntries, field, hasField, parseBluf,
} from './brief-schema.js';
import { getBrief } from './domain.js';
import { escapeRegExp } from './regex-util.js';

const CVE_RE = /CVE-\d{4}-\d{3,7}/gi;

/**
 * Validate a generated brief. Structural checks always run; the GROUNDING checks
 * (the anti-fabrication guarantee) run when `source.headlines` (or
 * `source.extraSourceText`) is supplied — they turn the prompt's "never
 * fabricate" contract from aspiration into an enforced audit: any CVE the brief
 * cites that no source mentions, any CVE it labels KEV that isn't in the real
 * catalog, any cited link not present in the input, the banned convergence
 * scaffold, banned filler phrases, and a BLUF that isn't one tight sentence are
 * all flagged. All warnings are soft (logged + surfaced), never blocking.
 *
 * `source` accepts:
 *   headlines       — the scored headline objects handed to the model.
 *   extraSourceText — additional model-visible source text not in headlines
 *                     (e.g. the SYSTEM-DERIVED FACTS ground-truth block), so a
 *                     brief that cites a ground-truth CVE isn't flagged as
 *                     ungrounded.
 *   kevSet          — the full verified CISA KEV catalog (a Set of CVE IDs), so
 *                     a false KEV claim is caught even on a day when no
 *                     headline itself happened to be KEV-flagged.
 */
export function validateBrief(text, expectedDate = null, source = {}) {
  const warnings = [];
  const judgments = splitEntries(section(text, SECTIONS.keyJudgments));

  // A heading by itself is not a usable section. The Wall consumes parsed
  // content, so an empty BLUF or an empty Key Judgments heading must trigger
  // the same corrective retry as a missing heading.
  if (!parseBluf(text, Infinity).trim()) {
    warnings.push('Missing BLUF section');
  }

  const horizonMatches = [...text.matchAll(/\[Horizon (\d)\]/gi)];
  const distinct = new Set(horizonMatches.map(m => m[1]));
  if (distinct.size < 2) {
    warnings.push(`Only ${distinct.size} distinct horizon(s) found — expected at least 2`);
  }

  if (judgments.length === 0) {
    warnings.push('Missing Key Judgments section');
  }

  if (!/##\s*CONVERGENCE/i.test(text)) {
    warnings.push('Missing Convergence section');
  }

  if (!/##\s*WATCHLIST/i.test(text)) {
    warnings.push('Missing Watchlist section');
  }

  if (text.length < 2000) {
    warnings.push(`Briefing is only ${text.length} chars — expected at least 2,000`);
  }

  // ── Per-signal field grammar — each judgment the Wall reads must carry
  // its standfirst/chip fields, else the loved surface blanks silently. ──
  const required = [FIELDS.assessment, FIELDS.confidence, FIELDS.theLine, FIELDS.decisionWindow];
  judgments.forEach((part, i) => {
    const missing = required.filter(label => !hasField(part, label));
    if (missing.length) {
      warnings.push(`Signal ${i + 1} missing field(s): ${missing.join(', ')}`);
    }
  });

  // ── Other Wall-consumed section labels — EXECUTIVE SUMMARY bullets and
  // the DEVELOPING / CONVERGENCE field labels the Wall pages depend on. ──
  if (!section(text, SECTIONS.execSummary)) {
    warnings.push('Missing Executive Summary section');
  }
  const developing = splitEntries(section(text, SECTIONS.developing));
  developing.forEach((part, i) => {
    const missing = [FIELDS.trajectory, FIELDS.watchCriteria].filter(label => !hasField(part, label));
    if (missing.length) {
      warnings.push(`Developing situation ${i + 1} missing field(s): ${missing.join(', ')}`);
    }
  });
  const convergence = splitEntries(section(text, SECTIONS.convergence));
  convergence.forEach((part, i) => {
    const lines = part.split('\n');
    const firstField = lines.findIndex((line, idx) => idx > 0 && /^\s*\*\*[^*]+:\*\*/.test(line));
    const hasOpeningProse = lines.slice(1, firstField === -1 ? lines.length : firstField).join(' ').trim().length > 0;
    const missing = [FIELDS.theIntersection, FIELDS.theMove].filter(label => (
      label === FIELDS.theIntersection ? !hasField(part, label) && !hasOpeningProse : !hasField(part, label)
    ));
    if (missing.length) {
      warnings.push(`Convergence ${i + 1} missing field(s): ${missing.join(', ')}`);
    }
  });

  // ── This-shift action label — soft only. Older briefs predate the
  // "Act now:" convention, so warn when a judgment has a this-shift decision
  // window but no "Act now:" label, never block. ──
  const actLabel = new RegExp('\\*\\*\\s*' + escapeRegExp(ACT_NOW_LABEL) + '\\s*\\*\\*', 'i');
  const thisShift = judgments.filter(part => /^this shift\b/i.test(field(part, FIELDS.decisionWindow)));
  if (thisShift.length && !thisShift.some(part => actLabel.test(part))) {
    warnings.push(`No "${ACT_NOW_LABEL}" action found in ${thisShift.length} this-shift judgment(s)`);
  }

  // ── Dateline vs generation date — the brief's own dateline shouldn't
  // disagree with the filename/generation date the reader sees. Warn only. ──
  if (expectedDate) {
    // Anchor on the active pack's brief subtitle — the same string prompts.js emits
    // as the dateline — so renaming the edition heading can't silently disable this.
    const subtitle = getBrief().frame.subtitle;
    const dm = text.match(new RegExp('###\\s*' + escapeRegExp(subtitle) + '\\s*·\\s*(\\d{4}-\\d{2}-\\d{2})', 'i'));
    if (dm && dm[1] !== expectedDate) {
      warnings.push(`Brief dateline (${dm[1]}) does not match generation date (${expectedDate})`);
    }
  }

  // ── Grounding (the anti-fabrication guarantee) — only when the source material
  // is provided. The model is told never to invent a specific; here we verify it. ──
  const headlines = Array.isArray(source.headlines) ? source.headlines : [];
  // extraSourceText carries the SYSTEM-DERIVED FACTS block (buildGroundTruth in
  // routes/brief.js) — the model is handed those KEV CVE IDs directly and told to
  // use them, so a brief that dutifully cites one must not be flagged as citing a
  // CVE "in no source headline" just because sourceCves only scanned headlines.
  const extraSourceText = typeof source.extraSourceText === 'string' ? source.extraSourceText : '';
  // kevSet is the full verified CISA KEV catalog (db.js getKEVSet), not just the
  // subset of today's headlines that happen to be KEV-flagged. Auditing against
  // the headline-derived set alone meant a fabricated KEV claim passed unaudited
  // whenever no headline happened to carry isKEV — exactly the quiet days a
  // fabrication is most tempting and least likely to be caught by a human.
  const kevSet = source.kevSet instanceof Set ? source.kevSet : null;
  if (headlines.length || extraSourceText) {
    const sourceCves = new Set();
    for (const h of headlines) {
      const blob = `${h.title || ''} ${h.description || ''} ${h.cveData || ''} ${h.articleBody || ''} ${h.kevCVE || ''}`;
      for (const m of blob.matchAll(CVE_RE)) sourceCves.add(m[0].toUpperCase());
    }
    for (const m of extraSourceText.matchAll(CVE_RE)) sourceCves.add(m[0].toUpperCase());
    // A CVE the brief cites that NO source mentions is almost certainly fabricated —
    // the cardinal "wrong specific in front of leadership" failure the prompt forbids.
    const briefCves = new Set([...text.matchAll(CVE_RE)].map(m => m[0].toUpperCase()));
    const ungrounded = [...briefCves].filter(c => !sourceCves.has(c));
    if (ungrounded.length) {
      warnings.push(`Ungrounded CVE(s) in no source headline: ${ungrounded.slice(0, 5).join(', ')}${ungrounded.length > 5 ? '…' : ''}`);
    }
    // A CVE the brief labels "KEV" that isn't in the verified catalog — KEV is
    // verified, not inferred, so a mislabel is a trust failure. Checked
    // unconditionally against the real catalog (when supplied) rather than only
    // when a headline happened to carry isKEV, so a fabricated KEV claim can't
    // slip past the audit just because today's headline set is quiet.
    if (kevSet && kevSet.size) {
      // Match affirmative catalog assertions, not conditional/pending language
      // such as "if CISA adds CVE-X to KEV" or "KEV status remains unresolved."
      const kevClaims = [...text.matchAll(
        /KEV(?:-listed|:|\s+(?:catalog|entry|obligation|vulnerabilit(?:y|ies)))[^.\n]{0,60}?(CVE-\d{4}-\d{3,7})|(CVE-\d{4}-\d{3,7})[^.\n]{0,45}?(?:KEV-listed|(?:is|was|are|were)\s+(?:on|in)\s+(?:the\s+)?KEV\s+catalog)/gi
      )].map(m => (m[1] || m[2] || '').toUpperCase()).filter(Boolean);
      const falseKev = [...new Set(kevClaims)].filter(c => !kevSet.has(c));
      if (falseKev.length) {
        warnings.push(`CVE(s) labeled KEV but not in the verified catalog: ${falseKev.slice(0, 5).join(', ')}`);
      }
    }
  }

  // ── Cited-link grounding — the prompt orders "never invent a link" and the
  // renderer promotes every https href into a numbered citation plus a Sources
  // appendix with hostname verifiers, but nothing previously checked that a cited
  // URL actually appeared in the input. A model that reconstructs a plausible slug
  // produces a 404 dressed as provenance — this is the one-click-verify chain's
  // core trust claim, so it is audited the same way CVEs are. ──
  if (headlines.length) {
    const sourceLinks = new Set(headlines.map(h => h.link).filter(Boolean));
    const citedLinks = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]);
    if (citedLinks.length) {
      // Exact match, ignoring only query/fragment and a trailing slash. A
      // bidirectional path-prefix check let a citation to the site root `/`
      // "ground" every unrelated source path on that origin.
      const grounded = (url) => {
        if (sourceLinks.has(url)) return true;
        try {
          const u = new URL(url);
          const normalizedPath = (value) => value.replace(/\/+$/, '') || '/';
          for (const s of sourceLinks) {
            const su = new URL(s);
            if (u.origin === su.origin && normalizedPath(u.pathname) === normalizedPath(su.pathname)) {
              return true;
            }
          }
        } catch { /* malformed URL — falls through to unverifiable */ }
        return false;
      };
      const unverifiable = [...new Set(citedLinks)].filter(url => !grounded(url));
      if (unverifiable.length) {
        warnings.push(`Unverifiable source link(s) not found in the input: ${unverifiable.slice(0, 3).join(', ')}${unverifiable.length > 3 ? '…' : ''}`);
      }
    }
  }

  // ── Voice: the banned convergence scaffold (forbidden by the prompt, yet shipped
  // briefs violate it while structural validation passes clean). ──
  if (BANNED_SCAFFOLD.test(text)) {
    warnings.push('Convergence uses the banned "Horizon X intersects Horizon Y" scaffold instead of naming the mechanism');
  }

  // ── Voice: banned filler phrases the prompt forbids. ──
  const usedBanned = BANNED_PHRASES.filter(p =>
    new RegExp('\\b' + escapeRegExp(p) + '\\b', 'i').test(text));
  if (usedBanned.length) {
    warnings.push(`Banned filler phrase(s): ${usedBanned.slice(0, 5).join(', ')}${usedBanned.length > 5 ? '…' : ''}`);
  }

  // ── BLUF discipline: the prompt demands ONE sentence; flag a multi-sentence or
  // bloated BLUF so the single decision stays inevitable (and the Wall cover stays sharp). ──
  const bluf = parseBluf(text, Infinity);
  if (bluf) {
    const sentences = bluf.split(/[.!?](?:\s|$)/).filter(s => s.trim().length > 4);
    const words = bluf.split(/\s+/).filter(Boolean).length;
    if (sentences.length > 1) warnings.push(`BLUF is ${sentences.length} sentences — should be one`);
    else if (words > BLUF_MAX_WORDS + 10) warnings.push(`BLUF is ${words} words — should be one tight sentence (~${BLUF_MAX_WORDS})`);
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

// A missing BLUF or Key Judgments section is a structural failure, not a soft
// warning — the Wall/Briefing blank silently otherwise, so routes/brief.js uses
// this to offer a prominent retry rather than render a broken brief. This used
// to be a regex duplicated in routes/brief.js that matched these warning STRINGS
// verbatim — a harmless rewording here ("Missing BLUF section" → "BLUF section
// absent") would have silently disabled the client's retry with no test to catch
// it. Exporting the predicate from the same module that produces the
// warning text closes that coupling permanently: there is only one place left
// that can drift, and it can't drift from itself.
//
// The "No Act now: action found" warning does NOT hard-fail: brief-schema.js
// documents that label as warn-only, and the Wall degrades gracefully when it's
// absent (actionShift: null) — a brief that is complete and grounded but phrases
// its this-shift action without the exact bold label doesn't deserve the alarming
// "missing required section" banner and a burned regeneration.
const HARD_FAIL_RE = /^Missing (BLUF|Key Judgments) section$/i;

/** True when a warning produced by validateBrief represents a structural hard-fail. */
export function isHardFailWarning(warning) {
  return HARD_FAIL_RE.test(warning);
}

/** True when any warning in the list represents a structural hard-fail. */
export function hasHardFail(warnings) {
  return (warnings || []).some(isHardFailWarning);
}

/** Count signals per horizon for metadata. */
export function countHorizons(content) {
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const m of content.matchAll(/\[Horizon (\d)\]/gi)) {
    const n = parseInt(m[1]);
    if (counts[n] !== undefined) counts[n]++;
  }
  return counts;
}

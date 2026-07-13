// BlueTeam.News — shared regex helpers.

// Any string interpolated into a `new RegExp(...)` pattern (a title, a label, a
// watch-term) must go through this first, or it's parsed as a pattern instead of
// matched as a literal.
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A catastrophic-backtracking shape — a re-quantified group like (a+)+ — hangs
// on adversarial input. Every regex pattern that arrives from config.json or a
// Domain Pack is untrusted for this purpose: one bad pattern shouldn't be able
// to hang a scoring pass run against every headline.
const CATASTROPHIC_BACKTRACK = /\([^()]*[+*][^()]*\)[+*]/;

// #119 — the re-quantified-group check above only catches a quantifier INSIDE
// the group body (e.g. (a+)+). It misses the other classic exponential shape:
// a quantified group whose alternation branches overlap — (a|a)+, (a|ab)*c,
// (x|x|x)*$ — which has no inner +/* at all, so it sails past the check above
// and straight into `new RegExp(...)` (scoring.js). Flag a quantified,
// top-level (non-nested-paren) alternation where any branch is a prefix of, or
// identical to, another — the ambiguity that makes the engine try exponentially
// many ways to partition the same input across group repetitions.
const QUANTIFIED_ALTERNATION = /\(([^()]*\|[^()]*)\)[+*]/g;
function hasOverlappingAlternation(pattern) {
  let m;
  QUANTIFIED_ALTERNATION.lastIndex = 0;
  while ((m = QUANTIFIED_ALTERNATION.exec(pattern))) {
    const branches = m[1].split('|');
    for (let i = 0; i < branches.length; i++) {
      for (let j = 0; j < branches.length; j++) {
        if (i === j) continue;
        const a = branches[i], b = branches[j];
        if (a.length > 0 && b.length > 0 && b.startsWith(a)) return true;
      }
    }
  }
  return false;
}

// This remains a heuristic, not a proof: it catches the two most common
// catastrophic shapes (re-quantified groups and quantified overlapping
// alternation) but does not exhaustively analyze arbitrary NFA structure —
// nested alternations, backreferences, or cross-group ambiguity can still
// construct a pathological pattern that slips through undetected. config.json
// alertRules and Domain Pack lexicons are operator-owned, which bounds the
// blast radius; a hard execution time budget (worker + timeout) would close
// the residual gap completely and is the recommended follow-up if untrusted
// third-party pattern packs are ever accepted.
export function isUnsafePattern(pattern) {
  return CATASTROPHIC_BACKTRACK.test(pattern) || hasOverlappingAlternation(pattern);
}

// Compile a regex pattern string, rejecting ReDoS-prone shapes and invalid
// syntax by returning null instead of throwing — so a hot path (scoring,
// lexicon compilation) can skip a bad pattern rather than crash on it.
export function safeCompileRegExp(pattern, flags = 'i') {
  if (!pattern || isUnsafePattern(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

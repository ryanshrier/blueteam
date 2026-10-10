// BlueTeam.News — shared regex helpers.
import { configuredPattern, evaluateConfiguredRegexSync } from './configured-regex.js';

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

// Counted repeats and nested groups have the same ambiguity as (a+)+.
// Track nesting rather than attempting to match balanced groups with a regex.
function hasNestedRepetition(pattern) {
  const groups = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      // Backreferences make arbitrary matching cost particularly hard to bound.
      if (!inClass && /[1-9k]/.test(pattern[i + 1] || '')) return true;
      i++; continue;
    }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') { groups.push(false); continue; }
    if (char === ')' && groups.length) {
      const repeatedInside = groups.pop();
      const repeated = /^(?:[+*?]|\{\d+(?:,\d*)?\})/.test(pattern.slice(i + 1));
      // A single optional wrapper does not repeat its inner expression.
      const repeatsMoreThanOnce = repeatedGroup(pattern.slice(i + 1));
      if (repeatedInside && repeatsMoreThanOnce) return true;
      if (groups.length && (repeatedInside || repeated)) groups[groups.length - 1] = true;
    } else if (groups.length && ((/[+*?]/.test(char) && pattern[i - 1] !== '(')
        || (char === '{' && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(i))))) {
      groups[groups.length - 1] = true;
    }
  }
  return false;
}

// #119 — the re-quantified-group check above only catches a quantifier INSIDE
// the group body (e.g. (a+)+). It misses the other classic exponential shape:
// a quantified group whose alternation branches overlap — (a|a)+, (a|ab)*c,
// (x|x|x)*$ — which has no inner +/* at all, so it sails past the check above
// and straight into `new RegExp(...)` (scoring.js). Flag a repeated alternation,
// including noncapturing and unquantified wrappers, where any branch is a prefix of, or
// identical to, another — the ambiguity that makes the engine try exponentially
// many ways to partition the same input across group repetitions.
const repeatedGroup = suffix => {
  if (/^[+*]/.test(suffix)) return true;
  const counted = /^\{(\d+)(?:,(\d*))?\}/.exec(suffix);
  return Boolean(counted && (counted[2] === '' || Number(counted[2] ?? counted[1]) > 1));
};

function overlappingBranches(body) {
  if (body.startsWith('?:')) body = body.slice(2);
  let depth = 0, inClass = false, start = 0;
  const branches = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\') { i++; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      // Unquantified group wrappers do not resolve the ambiguity underneath.
      if (depth === 0 && body[0] === '(' && i === body.length - 1 && !branches.length) {
        return overlappingBranches(body.slice(1, -1));
      }
    } else if (char === '|' && depth === 0) { branches.push(body.slice(start, i)); start = i + 1; }
  }
  branches.push(body.slice(start));
  return branches.some((a, i) => a.length > 0 && branches.some((b, j) => i !== j && b.startsWith(a)));
}

function hasOverlappingAlternation(pattern) {
  const groups = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') { i++; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') groups.push(i);
    else if (char === ')' && groups.length) {
      const start = groups.pop();
      if (repeatedGroup(pattern.slice(i + 1)) && overlappingBranches(pattern.slice(start + 1, i))) return true;
    }
  }
  return false;
}

// This remains a heuristic, not a proof: it catches the two most common
// catastrophic shapes (re-quantified groups and quantified overlapping
// alternation) but does not exhaustively analyze arbitrary NFA structure —
// nested alternations, backreferences, or cross-group ambiguity can still
// construct a pathological pattern that slips through undetected. Production
// configurable matching therefore runs in configured-regex's bounded worker;
// this heuristic remains only a compatibility/preflight aid.
export function isUnsafePattern(pattern) {
  return CATASTROPHIC_BACKTRACK.test(pattern) || hasNestedRepetition(pattern) || hasOverlappingAlternation(pattern);
}

// Compatibility admission helper: return an inert worker-backed descriptor,
// or null for rejected syntax/shapes. Production batches do not use this
// fallback; compilation failure or timeout rejects the whole collection.
export function safeCompileRegExp(pattern, flags = 'i') {
  if (!pattern || isUnsafePattern(pattern)) return null;
  try {
    evaluateConfiguredRegexSync({ operation: 'validate', patterns: [{ source: pattern, flags }] });
    return configuredPattern(pattern, flags);
  } catch {
    return null;
  }
}

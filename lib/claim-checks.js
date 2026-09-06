// Explicit syntax checks, not arbitrary natural-language entailment. Findings
// identify unsupported precision or internal contradictions for correction.
const numbers = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 });
const numberPattern = String.raw`(?:\d+(?:\.\d+)?|${Object.keys(numbers).join('|')})`;
const asNumber = value => numbers[value.toLowerCase()] ?? Number(value);
const cvePattern = /\bCVE-\d{4}-\d{3,7}\b/gi;
const issue = (code, message) => ({ code, severity: 'trust', message });

/** Only explicit closed enumerations; examples and open-ended lists abstain. */
export function enumeratedCountIssues(text) {
  const issues = [];
  const pattern = new RegExp(String.raw`\b(${numberPattern})\s+(?:of\s+(?:(?:this|last|the|these|those|our)\s+)?(?:week['’]s|month['’]s|today['’]s|listed|named)\s+)?(?:(?:distinct|different|known|exploited|KEV|catalog)\s+){0,3}(vendors?|products?|sources?|CVEs?|entries|vulnerabilities)\s*(?:\(([^()\n]{1,350})\)|[—–]\s*([^—–\n]{1,350})[—–])`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const list = match[3] || match[4];
    // "Two of the listed vendors (A, B, C)" may describe a subset of a
    // parenthesized set. A dash-delimited CVE appositive is explicit instead.
    if (match[3] && new RegExp(String.raw`^${numberPattern}\s+of\b`, 'i').test(match[0])) continue;
    if (/\b(?:including|such as|for example|among|etc)\b|e\.g\.|\.\.\.|…/i.test(list)) continue;
    let actual;
    if (/^(?:CVEs?|entries|vulnerabilities)$/i.test(match[2])) {
      const cves = [...list.matchAll(cvePattern)].map(value => value[0].toUpperCase());
      if (!cves.length || list.replace(cvePattern, '').replace(/\band\b/gi, '').replace(/[\s,&]/g, '')) continue;
      actual = new Set(cves).size;
    } else {
      // A comma-delimited closed list avoids guessing whether an isolated
      // "A and B" is one company/product name or two entities.
      const items = list.split(',').map(value => value.trim()).filter(Boolean);
      if (items.length < 2) continue;
      items[items.length - 1] = items.at(-1).replace(/^and\s+/i, '');
      // An internal "and" may be part of a name (Marks and Spencer). Do
      // not pretend this syntax identifies the entity boundary reliably.
      if (items.some(value => /\band\b/i.test(value))) continue;
      if (items.some(value => !/^[\p{L}\p{N}][\p{L}\p{N}\s.&/_'’-]*$/u.test(value))) continue;
      actual = new Set(items.map(value => value.toLowerCase())).size;
    }
    if (actual !== asNumber(match[1])) issues.push(issue('ENUMERATED_COUNT_MISMATCH', `The stated ${match[1]} ${match[2]} contradicts its closed list of ${actual}`));
  }
  return issues;
}

function durations(text) {
  const units = { minute: 1, hour: 60, day: 1440, week: 10080 };
  return [...text.matchAll(new RegExp(String.raw`\b(${numberPattern})\s*(?:-\s*)?(minutes?|hours?|days?|weeks?)\b`, 'gi'))]
    .map(match => ({ text: match[0], index: match.index, end: match.index + match[0].length, minutes: asNumber(match[1]) * units[match[2].toLowerCase().replace(/s$/, '')] }));
}
function isForecast(text, index, end = index) {
  const prefix = text.slice(0, index);
  const boundary = [...prefix.matchAll(/[.!?](?!\d)\s+|\n|;\s*/g)].at(-1);
  const clause = prefix.slice(boundary ? boundary.index + boundary[0].length : 0);
  const prospective = clause.replace(/\b(?:would|could|may|might)\s+have\b/gi, '');
  return /\b(?:if|would|could|may|might|expect|forecast|project|recommend|should|aim|target|plan(?:ned)?)\b/i.test(prospective)
    || /\b(?:the\s+)?next\s*$/i.test(clause)
    // The modal must directly govern the duration-bearing subject. An
    // independent later clause ("and could recur") does not erase a past fact.
    || /^\s+(?:would|could|may|might)\b/i.test(text.slice(end));
}

/** Assertion fields only: callers exclude action targets and scenario cascades. */
export function assertionPrecisionIssues(text, citedEvidence, signal) {
  const issues = [];
  const supportedDurations = new Set(citedEvidence.flatMap(durations).map(value => value.minutes));
  const seenDurations = new Set();
  for (const duration of durations(text)) {
    if (!isForecast(text, duration.index, duration.end) && !supportedDurations.has(duration.minutes) && !seenDurations.has(duration.minutes)) {
      seenDurations.add(duration.minutes);
      issues.push(issue('FACT_DURATION_UNSUPPORTED', `Signal ${signal} factual duration "${duration.text}" is not stated in its cited passages; omit the interval or cite evidence that states it`));
    }
  }
  const comparison = /\b(?:most|least)\s+(?:(?:repeatedly|frequently|widely|heavily|commonly)\s+)?(?:breached|exploited|targeted|attacked|affected|compromised|used)\b|\b(?:largest|biggest|fastest|worst|highest|lowest)\s+(?:(?:reported|observed|known)\s+)?(?:breach|attack|campaign|compromise|infection|incident|exploitation|rate|volume)\b/gi;
  const normalized = value => value.toLowerCase().replace(/\s+/g, ' ');
  for (const match of text.matchAll(comparison)) {
    if (!isForecast(text, match.index) && !citedEvidence.some(value => normalized(value).includes(normalized(match[0])))) {
      issues.push(issue('FACT_COMPARISON_UNSUPPORTED', `Signal ${signal} comparison "${match[0]}" is not stated in its cited passages; repeated incidents alone do not establish a ranking`));
    }
  }
  return issues;
}

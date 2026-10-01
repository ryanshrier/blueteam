// Shared bounded metric contract. Numeric agreement alone never establishes
// which vulnerability, version, or provisional assessment a claim describes.
const CVE = /\bCVE-\d{4}-\d{3,7}\b/gi;
const SCORE = String.raw`\bCVSS(?!:\d+(?:\.\d+)?/)(?:\s+v(\d(?:\.\d)?)|\s+(\d\.\d)(?=\s+(?:base\s+)?score))?(?:\s+(?:base\s+)?score)?\s*(?:of\s+|[:=]\s*)?(\d{1,2}(?:\.\d)?)\b(?!\d|\.\d|/)`;
export const validCvssScore = score => Number.isFinite(score) && score >= 0 && score <= 10;
const identities = value => [...new Set([...String(value || '').matchAll(CVE)].map(match => match[0].toUpperCase()))];

export function proseCvssScores(value) {
  const text = String(value || '');
  return [...text.matchAll(new RegExp(SCORE, 'gi'))].map(match => {
    const end = match.index + match[0].length;
    const suffix = text.slice(end);
    // Older retained NVD passages place the version after score and severity.
    const version = match[1] || match[2] || /^\s*(?:\((?:CRITICAL|HIGH|MEDIUM|LOW|NONE)\)\s*)?\(v(\d\.\d)\)/i.exec(suffix)?.[1] || null;
    const nextBoundary = suffix.search(/[;\n—–]|[.!?](?:\s|$)|\b(?:CVE-\d{4}-\d{3,7}|CVSS|but|however)\b/i);
    const qualifier = suffix.slice(0, nextBoundary < 0 ? 160 : nextBoundary);
    const prefix = text.slice(Math.max(0, match.index - 80), match.index)
      .split(/[,;:\n—–]|[.!?](?:\s|$)|\b(?:CVE-\d{4}-\d{3,7}|but|however|and)\b/i).at(-1);
    const qualifiers = `${prefix} ${qualifier}`;
    const provisional = /\bprovisional(?:ly)?\b/i.test(qualifiers)
      && !/\b(?:not|no longer)\s+provisional\b|\b(?:final|authoritative)\s+(?:(?:NVD|CVSS)\s+)?(?:score|rating|assessment)\b|\(final\)/i.test(qualifiers);
    return { version, score: Number(match[3]), index: match.index, end, provisional };
  });
}

// Bind a metric only within its clause, or to one unambiguous enclosing CVE.
// A list of two CVEs before one metric is deliberately left unbound.
export function bindCvssScores(value, fallbackCves = []) {
  const text = String(value || '');
  const fallback = [...new Set(fallbackCves)];
  const claims = proseCvssScores(text);
  return claims.map((claim, index) => {
    const prefix = text.slice(0, claim.index);
    const boundaries = [...prefix.matchAll(/[;\n]|[.!?](?=\s|$)/g)];
    const start = Math.max(boundaries.at(-1)?.index + 1 || 0, claims[index - 1]?.end || 0);
    const before = identities(text.slice(start, claim.index));
    const suffix = text.slice(claim.end);
    const endBoundary = suffix.search(/[;\n]|[.!?](?=\s|$)|\bCVSS\b/i);
    const after = identities(suffix.slice(0, endBoundary < 0 ? undefined : endBoundary));
    const explicitObject = /^\s+for\s+(CVE-\d{4}-\d{3,7})\b/i.exec(suffix)?.[1]?.toUpperCase();
    const local = before.length ? before : after;
    const cve = explicitObject ? (after.length === 1 ? explicitObject : null)
      : local.length === 1 ? local[0] : !local.length && fallback.length === 1 ? fallback[0] : null;
    return { ...claim, cve };
  });
}

export const pairedCvssScores = value => bindCvssScores(value).filter(fact => fact.cve);

// A flattened publisher table must retain its header and complete base vector.
export function tableCvssScores(value) {
  const text = String(value || '').replace(/\s+/g, ' ');
  const header = /\bCVSS Version Base Score Base Severity Vector String\s+/gi;
  const row = /^(3\.[01]|4\.0)\s+(\d{1,2}(?:\.\d)?)\s+(NONE|LOW|MEDIUM|HIGH|CRITICAL)\s+CVSS:(3\.[01]|4\.0)((?:\/[A-Z]{1,3}:[A-Z])+)\b(?![\w/:])/i;
  const baseValues = {
    '3': { AV: 'NALP', AC: 'LH', PR: 'NLH', UI: 'NR', S: 'UC', C: 'NLH', I: 'NLH', A: 'NLH' },
    '4': { AV: 'NALP', AC: 'LH', AT: 'NP', PR: 'NLH', UI: 'NPA', VC: 'HLN', VI: 'HLN', VA: 'HLN', SC: 'HLN', SI: 'HLN', SA: 'HLN' },
  };
  const result = [];
  for (const match of text.matchAll(header)) {
    let tail = text.slice(match.index + match[0].length);
    for (let count = 0; count < 8; count++) {
      const metric = row.exec(tail);
      if (!metric) break;
      const score = Number(metric[2]);
      const fields = metric[5].slice(1).toUpperCase().split('/').map(field => field.split(':'));
      const values = new Map(fields);
      const required = baseValues[metric[1][0]];
      if (metric[1] !== metric[4] || !validCvssScore(score) || fields.length !== values.size
        || !Object.entries(required).every(([key, allowed]) => values.has(key) && allowed.includes(values.get(key)))) break;
      result.push({ version: metric[1], score, provisional: false });
      tail = tail.slice(metric[0].length).trimStart();
    }
  }
  return result;
}

export function recordCvssFacts(record) {
  const ids = record.cves instanceof Set ? [...record.cves] : Array.isArray(record.cves) ? record.cves : identities(record.evidenceText);
  if (Array.isArray(record.cvssMetrics) && record.cvssMetrics.length) {
    return record.cvssMetrics.filter(fact => ids.includes(fact.cve) && validCvssScore(fact.score)
      && /^(?:2\.0|3\.[01]|4\.0)$/.test(fact.version));
  }
  const value = record.passage || record.evidenceText || '';
  // An enclosing CVE cannot disambiguate conflicting or historical scores.
  // Those assessments need an explicit local CVE binding or structured data.
  const numericScores = new Set(proseCvssScores(value).filter(fact => validCvssScore(fact.score)).map(fact => fact.score));
  const prose = bindCvssScores(value, numericScores.size === 1 ? ids : []).filter(fact => validCvssScore(fact.score));
  const table = tableCvssScores(value).map(fact => ({ ...fact, cve: ids.length === 1 ? ids[0] : null }));
  return [...prose, ...table];
}

export const scoreSupportedBy = (claim, fact) => claim.score === fact.score
  && (!claim.version || !fact.version || claim.version === fact.version)
  && (fact.provisional !== true || claim.provisional === true);

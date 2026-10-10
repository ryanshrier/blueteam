// Shared bounded metric contract. Numeric agreement alone never establishes
// which vulnerability, version, or provisional assessment a claim describes.
const CVE = /\bCVE-\d{4}-\d{3,7}\b/gi;
const SCORE = String.raw`\bCVSS(?!:\d+(?:\.\d+)?/)(?:\s+v(\d(?:\.\d)?)|\s+(2\.0|3\.[01]|4\.0)(?=\s+(?:base\s+)?(?:score|assessment)|\s*:))?(?:\s+(?:base\s+)?(?:score|assessment))?\s*(?:of\s+|[:=]\s*)?(\d{1,2}(?:\.\d)?)\b(?!\d|\.\d|/)`;
export const validCvssScore = score => Number.isFinite(score) && score >= 0 && score <= 10;
const identities = value => [...new Set([...String(value || '').matchAll(CVE)].map(match => match[0].toUpperCase()))];

// Markdown wraps prose within a paragraph. Keep real paragraph, field, list,
// heading and table boundaries, while retaining original offsets/line numbers.
export function cvssTextBlocks(value) {
  const lines = String(value || '').split('\n');
  const rule = line => /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
  const startsBlock = line => /^(?: {4}|\t)/.test(line) || rule(line)
    || /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>|`{3}|~{3}|\|)/.test(line)
    || /^\s*(?:\*\*|__)?[A-Za-z][\w /-]{0,60}:(?:\*\*|__)?(?:\s|$)/.test(line);
  const endsBlock = line => rule(line) || /^\s*(?:#{1,6}\s|`{3}|~{3}|\|)/.test(line);
  const blocks = [];
  for (const [line, text] of lines.entries()) {
    const previous = lines[line - 1];
    if (!line || !text.trim() || !previous.trim() || startsBlock(text) || endsBlock(previous)) {
      blocks.push({ text, line });
    } else blocks.at(-1).text += ` ${text}`;
  }
  return blocks;
}

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
  const text = cvssTextBlocks(value).map(block => block.text).join('\n');
  const fallback = [...new Set(fallbackCves)];
  const claims = proseCvssScores(text);
  // A semicolon inside a CVE's parenthetical description does not start a
  // different entity: "CVE-X (SSRF; CVSS 10) and CVE-Y (...; CVSS 7.8)".
  const depth = [];
  let nesting = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    depth[index] = nesting;
    if (character === '(') nesting++;
    else if (character === ')') nesting = Math.max(0, nesting - 1);
  }
  const boundaries = [...text.matchAll(/[;\n]|[.!?](?=\s|$)/g)]
    .filter(match => match[0] !== ';' || depth[match.index] === 0);
  let consumedObjectEnd = 0;
  return claims.map((claim, index) => {
    const prefix = text.slice(0, claim.index);
    const preceding = boundaries.filter(boundary => boundary.index < claim.index);
    const boundary = preceding.at(-1);
    const start = Math.max(boundary?.index + 1 || 0, claims[index - 1]?.end || 0, consumedObjectEnd);
    const before = identities(text.slice(start, claim.index));
    const suffix = text.slice(claim.end);
    // Do not take the identity after a closing parenthesis as the object of
    // the metric inside it. It belongs to the next item in the enumeration.
    const endBoundary = suffix.search(/[;)\n]|[.!?](?=\s|$)|\bCVSS\b/i);
    const after = identities(suffix.slice(0, endBoundary < 0 ? undefined : endBoundary));
    const explicitFor = /^\s+for\s+(CVE-\d{4}-\d{3,7})\b/i.exec(suffix);
    const parentheticalObject = /^[^\S\n]*\([^\S\n]*(CVE-\d{4}-\d{3,7})[^\S\n]*\)/i.exec(suffix);
    // A metric immediately followed by (CVE-X) names its object, even if a
    // different CVE precedes it. A plural/incomplete object stays unbound.
    const hasParentheticalObject = /^[^\S\n]*\([^\S\n]*CVE-\d{4}-\d{3,7}\b/i.test(suffix);
    const explicitObject = explicitFor?.[1]?.toUpperCase();
    const local = before.length ? before : after;
    // A narrow attribution continuation can retain a single named antecedent
    // across a semicolon. Never infer an entity from an arbitrary nearby name,
    // another sentence, or a clause that names multiple CVEs.
    const continuation = !local.length && boundary?.[0] === ';'
      && /^\s*(?:NVD|CISA|the vendor)\s+(?:lists?|rates?|scores?|assigns?)\s+(?:it|this vulnerability)\s+(?:at|as|a score of)\s*$/i.test(prefix.slice(boundary.index + 1));
    const antecedents = continuation
      ? identities(text.slice((preceding.at(-2)?.index ?? -1) + 1, boundary.index)) : [];
    const cve = explicitObject ? (after.length === 1 ? explicitObject : null)
      : hasParentheticalObject ? (parentheticalObject?.[1]?.toUpperCase() || null)
      : local.length === 1 ? local[0] : !local.length && antecedents.length === 1 ? antecedents[0]
        : !local.length && fallback.length === 1 ? fallback[0] : null;
    // An identity used as one metric's trailing object cannot become the
    // next metric's preceding subject: "CVSS 5 (A) and CVSS 9.8 (B)".
    if (cve && (explicitFor || parentheticalObject)) {
      consumedObjectEnd = claim.end + (explicitFor || parentheticalObject)[0].length;
    }
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

function passageCvssFacts(value, ids) {
  // An enclosing CVE cannot disambiguate conflicting or historical scores.
  // Those assessments need an explicit local CVE binding or structured data.
  const numericScores = new Set(proseCvssScores(value).filter(fact => validCvssScore(fact.score)).map(fact => fact.score));
  const prose = bindCvssScores(value, numericScores.size === 1 ? ids : []).filter(fact => validCvssScore(fact.score));
  const table = tableCvssScores(value).map(fact => ({ ...fact, cve: ids.length === 1 ? ids[0] : null }));
  return [...prose, ...table];
}

export function recordCvssFacts(record) {
  const ids = record.cves instanceof Set ? [...record.cves] : Array.isArray(record.cves) ? record.cves : identities(record.evidenceText);
  if (Array.isArray(record.cvssMetrics) && record.cvssMetrics.length) {
    return record.cvssMetrics.filter(fact => ids.includes(fact.cve) && validCvssScore(fact.score)
      && /^(?:2\.0|3\.[01]|4\.0)$/.test(fact.version));
  }
  if (Array.isArray(record.sourceParts) && record.sourceParts.length) {
    // Feed and article captures share a citation, not an implicit metric
    // subject. Bind each capture using only its own identities and qualifiers.
    return record.sourceParts.filter(part => part?.quality?.substantive === true && typeof part.passage === 'string')
      .flatMap(part => {
        const partIds = part.cves instanceof Set ? [...part.cves] : Array.isArray(part.cves) ? part.cves : identities(part.passage);
        return passageCvssFacts(part.passage, partIds);
      });
  }
  return passageCvssFacts(record.passage || record.evidenceText || '', ids);
}

export const scoreSupportedBy = (claim, fact) => claim.score === fact.score
  && (!claim.version || !fact.version || claim.version === fact.version)
  && (fact.provisional !== true || claim.provisional === true);

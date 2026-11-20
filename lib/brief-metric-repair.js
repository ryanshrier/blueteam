// Local edits for a metric whose identity and value the captured record
// establishes. These run on new/rechecked drafts only.
import { bindCvssScores, recordCvssFacts } from './cvss.js';
import { protectedSpans, renderBriefCitations } from './brief-citations.js';
import { metricClaimKey } from '../public/modules/core/brief-findings.js';

export function repairMetricQualifiers(text, issues = []) {
  const findings = issues.filter(issue => issue.code === 'CVSS_QUALIFIER_OMITTED'
    && typeof issue.claimKey === 'string' && Number.isSafeInteger(issue.location?.line));
  if (!findings.length) return { content: text, repairs: [] };
  const protectedRanges = protectedSpans(text);
  const lines = text.split('\n');
  const starts = []; let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const edits = new Map();
  for (const finding of findings) {
    const lineIndex = finding.location.line - 1, line = lines[lineIndex];
    if (line === undefined || /^\s*(?:>|\||#{1,6}\s)/.test(line)) continue;
    const candidates = bindCvssScores(line).filter(claim => claim.cve && !claim.provisional && !claim.provisionalDenied
      && metricClaimKey(claim) === finding.claimKey);
    // Repeated identical scores on one line do not establish which occurrence
    // the validator meant. Leave a note rather than making a speculative edit.
    if (candidates.length !== 1) continue;
    const claim = candidates[0];
    const start = starts[lineIndex] + claim.index, end = starts[lineIndex] + claim.end;
    if (protectedRanges.some(([a, b]) => start < b && end > a)) continue;
    edits.set(end, { line: finding.location.line, cve: claim.cve, score: claim.score,
      version: claim.version, type: claim.type || null, sourceIds: finding.sourceIds || [],
      kind: 'add-provisional-qualifier', before: text.slice(start, end), after: `${text.slice(start, end)} (provisional)` });
  }
  let content = text;
  for (const end of [...edits.keys()].sort((a, b) => b - a)) content = `${content.slice(0, end)} (provisional)${content.slice(end)}`;
  return { content, repairs: [...edits.values()] };
}

const missingMetricSupport = new Set(['FACT_CVSS_UNSUPPORTED', 'CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']);

// The writer named NVD and the CVE explicitly. Supply its captured citation
// only for a standalone, otherwise matching score statement. A publisher's
// own score, a quoted claim or competing captured assessments require context.
export function repairMissingMetricCitations(text, findings, grounding = {}) {
  if (!findings.length || findings.some(issue => !missingMetricSupport.has(issue.code) || !issue.claimKey || issue.location?.scope !== 'paragraph')) {
    return { content: text, repairs: [] };
  }
  const claimsByLine = new Map();
  for (const issue of findings) {
    const line = issue.location.line;
    if (!claimsByLine.has(line)) claimsByLine.set(line, new Set());
    claimsByLine.get(line).add(issue.claimKey);
  }
  const records = grounding.members || grounding.sources || [];
  const lines = text.split('\n');
  const spans = protectedSpans(text);
  const repairs = [];
  let offset = 0;
  const content = lines.map((line, index) => {
    const start = offset;
    offset += line.length + 1;
    const located = claimsByLine.get(index + 1);
    if (located?.size !== 1 || /^\s*(?:[>|#]|[-*+]\s|\d+[.)]\s)/.test(line)) return line;
    if (/["“”‘«»]|(?:^|\s)'/.test(line)) return line;
    const claims = bindCvssScores(line);
    if (claims.length !== 1 || !claims[0].cve || !located.has(metricClaimKey(claims[0]))) return line;
    const claim = claims[0];
    const prefix = line.slice(0, claim.index);
    const attribution = /(?:^|[.!?]\s+)NVD\s+(?:lists|rates|reports|scores|assigns|assigned)\s+(CVE-\d{4}-\d{3,7})(?:\s+(?:at|as|with|a)|:)?\s+$/i.exec(prefix)
      || /(?:^|[.!?]\s+)According to NVD,\s+(CVE-\d{4}-\d{3,7})\s+(?:has|had)\s+a\s+$/i.exec(prefix);
    const tail = /^(?:\s*\((?:provisional|(?:Primary|Secondary)(?: assessment)?)\))*\.([ \t]*)(?=\[|\r?$)/i.exec(line.slice(claim.end));
    if (!attribution || attribution[1].toUpperCase() !== claim.cve || !tail || claim.provisionalDenied) return line;
    const end = claim.end + tail[0].length - tail[1].length;
    if (spans.some(([a, b]) => start + attribution.index < b && start + end > a)) return line;
    const sourceId = `NVD-${claim.cve}`;
    const matching = records.filter(record => record.id === sourceId);
    if (matching.length !== 1) return line;
    const [record] = matching;
    if (record.label !== 'NVD' || record.passageKind !== 'structured-cve-record'
      || record.url !== `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${claim.cve}` || record.urlUnavailable || record.applicabilityRejected
      || record.quality?.substantive !== true || !record.cvssMetrics?.length || line.includes(record.url)) return line;
    // Qualifiers must identify one assessment before comparing its number.
    // Otherwise a matching number could silently choose between conflicting captures.
    const facts = recordCvssFacts(record).filter(fact => fact.cve === claim.cve
      && (!claim.version || fact.version === claim.version || fact.version.startsWith(`${claim.version}.`))
      && (!claim.type || claim.type === fact.type) && (!claim.provisional || fact.provisional));
    if (facts.length !== 1 || facts[0].score !== claim.score || (facts[0].type && !['Primary', 'Secondary'].includes(facts[0].type))) return line;
    const citation = renderBriefCitations(`[${sourceId}]`, grounding);
    if (citation.references.length !== 1) return line;
    const [fact] = facts;
    const before = line.slice(claim.index, end);
    const metric = `CVSS v${fact.version} ${fact.score}${fact.type ? ` (${fact.type} assessment)` : ''}${fact.provisional ? ' (provisional)' : ''}.`;
    const after = `${metric} ${citation.content}`;
    repairs.push({ kind: 'cite-captured-nvd-metric', line: index + 1, cve: claim.cve, score: fact.score, version: fact.version, sourceIds: [sourceId], before, after });
    return line.slice(0, claim.index) + after + line.slice(end);
  }).join('\n');
  return repairs.length === claimsByLine.size ? { content, repairs } : { content: text, repairs: [] };
}

// Add a qualification established by the validator's exact CVE/metric match.
// Never choose a different numeric value, version, assessment or source. This
// runs on new/rechecked drafts only; archive reads remain immutable.
import { bindCvssScores } from './cvss.js';
import { protectedSpans } from './brief-citations.js';
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

// Bounded regression checks for a corrective attempt. Passing these checks is
// not proof of equivalent meaning or editorial quality; publication still uses
// the complete validator. A smaller repair may remove only located defective
// judgments while retaining every surviving judgment's authored content.
import { publicationDecision } from './validation.js';
import { SECTIONS, section, splitEntries, stripMd } from './brief-schema.js';

const material = validation => {
  const decision = publicationDecision(validation);
  return [...decision.blockers, ...decision.reviewIssues];
};
// Locations and judgment ordinals may change during a legitimate repair.
// Preserve all remaining message details, including identities and values.
function findingKeys(issue) {
  const message = String(issue.message || '').replace(/\b(Signal|Convergence) \d+\b/g, '$1');
  // These checkers aggregate identities in one finding. Resolving one identity
  // must not look like a new finding merely because the list became shorter.
  // Truncated lists and unknown formats remain opaque: don't infer their scope.
  const list = issue.code === 'GROUNDING' && /^(Ungrounded CVE\(s\) in no source headline|CVE\(s\) labeled KEV but not in the verified catalog|CVE\(s\) described as pending\/not in KEV but already in the verified catalog|KEV catalog unavailable — cannot verify claim\(s\)|KEV catalog freshness unavailable — cannot establish current membership claim\(s\)): (CVE-\d{4}-\d{3,7}(?:, CVE-\d{4}-\d{3,7})*)$/.exec(message);
  return list ? list[2].split(', ').map(id => `${issue.code}:${list[1]}:${id}`) : [`${issue.code}:${message}`];
}

const plain = text => stripMd(String(text || '')).replace(/\s+/g, ' ').trim();

// Use the same entry grammar as publication, retaining actual document lines.
// Ambiguous section boundaries and code/comment headings cannot authorize a
// deletion. This is a narrow recovery exception, not a second prose parser.
function locatedJudgments(text) {
  const document = String(text || '').replace(/\r\n/g, '\n');
  const headings = [...document.matchAll(/^##[ \t]+KEY JUDGMENTS[^\n]*\n/gim)];
  if (headings.length !== 1) return null;
  const prefix = document.slice(0, headings[0].index);
  // A protected region may begin before this section, so examining the section
  // body alone would mistake a quoted/commented report for visible judgments.
  if (prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->')) return null;
  let fence = null;
  const visiblePrefix = prefix.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
  for (const line of visiblePrefix.split('\n')) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
      && !line.slice(marker[0].length).trim()) fence = null;
  }
  if (fence) return null;
  const block = section(document, SECTIONS.keyJudgments);
  if (/(?:^|\n)[ \t]*(?:```|~~~)|<!--/.test(block)) return null;
  const offset = document.indexOf(block, headings[0].index + headings[0][0].length);
  if (!block || offset < 0) return null;
  const entries = [...block.matchAll(/(?:^|\n)###\s+([\s\S]*?)(?=\n###\s|$)/g)];
  return entries.map((match, index) => {
    const start = offset + match.index + (match[0].startsWith('\n') ? 1 : 0);
    const end = offset + match.index + match[0].length;
    const entry = match[1].trim();
    return {
      index,
      startLine: document.slice(0, start).split('\n').length,
      endLine: document.slice(0, end).split('\n').length,
      signal: Number(/^Signal\s+(\d+)(?=\s|$)/i.exec(entry)?.[1]),
      // A section separator may move onto the last surviving entry. All
      // actual prose, values, citations and action text remain byte-sensitive.
      key: entry.replace(/^Signal\s+\d+(?=\s|$)/i, 'Signal #')
        .replace(/\n(?:[ \t]*\n)*[ \t]*---[ \t]*(?:\n[ \t]*)*$/, '').trim(),
    };
  });
}

function blockerJudgment(issue, entries, lines) {
  const signals = [...new Set([...String(issue.message || '').matchAll(/\bSignal\s+(\d+)\b/gi)]
    .map(match => Number(match[1])))];
  if (signals.length > 1) return null;
  let explicit = null;
  if (signals.length) {
    explicit = entries[signals[0] - 1];
    // Validator messages use ordinal positions. Noncanonical or repeated
    // authored numbers cannot silently redirect that identity to another entry.
    if (!explicit || explicit.signal !== signals[0]
      || entries.filter(entry => entry.signal === signals[0]).length !== 1) return null;
  }
  const location = issue.location;
  if (!location) return explicit;
  if (!['judgment', 'paragraph'].includes(location.scope)
    || !Number.isInteger(location.line) || location.line < 1) return null;
  const located = entries.find(entry => location.line >= entry.startLine && location.line <= entry.endLine);
  if (!located || (explicit && located !== explicit)) return null;
  const excerpt = plain(location.excerpt);
  const actual = plain(lines[location.line - 1]);
  if (excerpt && (!actual || !actual.includes(excerpt))) return null;
  // A bare global line number is not enough evidence to remove content.
  return explicit || (excerpt && actual ? located : null);
}

function onlyDefectiveJudgmentsRemoved(original, candidate) {
  const before = locatedJudgments(original.text);
  const after = locatedJudgments(candidate.text);
  if (!before || !after || !after.length) return false;
  const surviving = new Set();
  for (const entry of after) {
    const matches = before.filter(previous => previous.key === entry.key);
    // Identical repeated entries have no reliable identity for deletion.
    if (matches.length !== 1 || surviving.has(matches[0].index)) return false;
    surviving.add(matches[0].index);
  }
  const lines = String(original.text || '').replace(/\r\n/g, '\n').split('\n');
  const defective = new Set(publicationDecision(original.validation).blockers
    .map(issue => blockerJudgment(issue, before, lines)?.index).filter(index => index !== undefined));
  return before.every(entry => surviving.has(entry.index) || defective.has(entry.index));
}

export function correctiveRecoveryDecision(original, candidate) {
  if (!original.partial && candidate.partial) return { accepted: false, reason: 'incomplete-replacement' };
  const originalJudgments = splitEntries(section(original.text, SECTIONS.keyJudgments)).length;
  const candidateJudgments = splitEntries(section(candidate.text, SECTIONS.keyJudgments)).length;
  // Output-limit recovery explicitly requests a shorter complete edition. A
  // completed response may omit a specifically defective judgment, but cannot
  // improve its checks by removing unaffected coverage or rewriting survivors.
  if (!original.partial && candidateJudgments < originalJudgments
    && !onlyDefectiveJudgmentsRemoved(original, candidate)) return { accepted: false, reason: 'judgments-removed' };
  const before = material({ ...original.validation, partial: original.partial }).flatMap(findingKeys);
  const after = material({ ...candidate.validation, partial: candidate.partial }).flatMap(findingKeys);
  const remaining = new Map();
  for (const key of before) remaining.set(key, (remaining.get(key) || 0) + 1);
  for (const key of after) {
    const available = remaining.get(key) || 0;
    if (!available) return { accepted: false, reason: 'new-material-findings' };
    remaining.set(key, available - 1);
  }
  if (after.length >= before.length) return { accepted: false, reason: 'no-material-improvement' };
  return { accepted: true, reason: 'resolved-findings' };
}

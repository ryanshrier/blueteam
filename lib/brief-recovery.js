// Bounded regression checks for a corrective attempt. Passing these checks is
// not proof of equivalent meaning or editorial quality; publication still uses
// the complete validator. Never improve a score by deleting a judgment.
import { publicationDecision } from './validation.js';
import { SECTIONS, section, splitEntries } from './brief-schema.js';

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

export function correctiveRecoveryDecision(original, candidate) {
  if (!original.partial && candidate.partial) return { accepted: false, reason: 'incomplete-replacement' };
  const originalJudgments = splitEntries(section(original.text, SECTIONS.keyJudgments)).length;
  const candidateJudgments = splitEntries(section(candidate.text, SECTIONS.keyJudgments)).length;
  // Output-limit recovery explicitly requests a shorter complete edition. A
  // completed response receiving a factual repair must keep its coverage.
  if (!original.partial && candidateJudgments < originalJudgments) return { accepted: false, reason: 'judgments-removed' };
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

import { marked } from '/vendor/marked.esm.js';
import { briefSourceIndex, sourceFindingLocation } from './brief-source-index.js';
import { sanitize } from '../core/sanitize.js';

let cachedSource = null, cachedIndex = null;
function sourceIndex(source) {
  if (source !== cachedSource) {
    cachedSource = source;
    cachedIndex = briefSourceIndex(source, marked.lexer(source.replace(/\r\n?/g, '\n'), { gfm: true, breaks: true }));
  }
  return cachedIndex;
}

/** Associate rendered headings with real Markdown headings before semantic
 * styling. Raw HTML can render an H3, but cannot invent a judgment ordinal. */
export function markSourceJudgmentHeadings(root, sourceContent) {
  if (typeof sourceContent !== 'string') return;
  const index = sourceIndex(sourceContent);
  const headings = [...root.querySelectorAll('h2, h3')].filter(heading => heading.parentElement === root);
  root.dataset.sourceJudgmentsIndexed = 'true';
  for (const heading of headings) delete heading.dataset.sourceSignal;
  const plainLabel = value => {
    const holder = root.ownerDocument.createElement('span');
    holder.innerHTML = sanitize(marked.parseInline(value));
    return holder.textContent.trim();
  };
  const counts = new Map();
  for (const judgment of index.judgments) {
    const label = plainLabel(judgment.sourceLabel);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  for (const judgment of index.judgments) {
    const label = plainLabel(judgment.sourceLabel);
    const matches = headings.filter(heading => heading.tagName === 'H3' && heading.textContent.trim() === label);
    // Repeated indistinguishable labels cannot safely distinguish a raw HTML
    // heading from a real one. The findings remain in the edition record.
    if (counts.get(label) === 1 && matches.length === 1) matches[0].dataset.sourceSignal = String(judgment.signal);
  }
}

/** Resolve only a current-copy location. A message's Signal spelling and an
 * optional legacy signal field cannot override the visible document's order. */
export function readerFindingLocation(issue, presentation, sourceContent = '') {
  const checks = presentation?.currentChecks;
  if (checks?.contentSha256 && checks.contentSha256 !== presentation?.copy?.contentSha256) return null;
  if (issue?.association && issue.association.contentSha256 !== presentation?.copy?.contentSha256) return null;
  if (issue?.location?.scope === 'document') return { kind: 'document' };
  if (checks?.status === 'unavailable' || issue?.association?.status === 'unavailable') return null;
  if (sourceContent) {
    if (typeof issue?.association?.sourceLine === 'string'
      && String(sourceContent).replace(/\r\n?/g, '\n').split('\n')[issue.location?.line - 1] !== issue.association.sourceLine) return null;
    const location = sourceFindingLocation(sourceIndex(String(sourceContent)), issue);
    if (issue?.association?.kind === 'judgment' && (location?.kind !== 'judgment'
      || issue.association.signal !== location.signal || issue.association.line !== location.line)) return null;
    return location;
  }
  // Older callers may retain an explicit structured ordinal without Markdown.
  // Never infer one from prose, a printed heading number, or an invalid line.
  if (!checks?.contentSha256 && !issue?.location?.line && Number.isSafeInteger(issue?.signal) && issue.signal > 0) {
    return { kind: 'judgment', signal: issue.signal, signalId: `S${issue.signal}` };
  }
  return null;
}

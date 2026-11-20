// Provider-independent presentation from captured identities and authored action
// facts. Run before validation and persistence, never while reading an archive.
import { normalizeConvergenceOpening, stampBriefFormat } from './brief-schema.js';
import { normalizeBriefCitations } from './validation.js';
import { protectedSpans, renderBriefCitations } from './brief-citations.js';
import { composeBriefActions, captureBriefActionRecords } from './brief-composition.js';
import { renderBriefDeadlines } from './brief-deadlines.js';

export { BRIEF_COMPOSITION_VERSION } from './brief-schema.js';

// Normalize the known section spelling during preparation. Archive reads and
// text inside examples, HTML or prose retain the author's punctuation.
export function normalizeNarrativeHeadings(value) {
  const text = String(value ?? '');
  const heading = /^##[ \t]+TODAY[‘’]S PICTURE[ \t]*(?=\r?$)/gim;
  if (!heading.test(text)) return text;
  const protectedRanges = protectedSpans(text);
  return text.replace(heading, (match, offset) =>
    protectedRanges.some(([start, end]) => start <= offset && offset < end) ? match : match.replace(/[‘’]/, "'"));
}

export function assembleBrief(value, { groundingManifest = {}, kevTiming = {}, briefFormatVersion = 1 } = {}) {
  if (briefFormatVersion === 2) {
    const citations = renderBriefCitations(stampBriefFormat(normalizeNarrativeHeadings(value), 2), groundingManifest);
    const content = normalizeBriefCitations(citations.content, groundingManifest);
    return { content, actions: { text: content, actions: [] }, actionRecords: captureBriefActionRecords(content),
      deadlines: [], citations: citations.references, issues: citations.issues };
  }
  const citations = renderBriefCitations(normalizeConvergenceOpening(String(value ?? '')), groundingManifest);
  const actions = composeBriefActions(normalizeBriefCitations(citations.content, groundingManifest));
  const deadlines = renderBriefDeadlines(actions.text, { grounding: groundingManifest, kevTiming });
  return { content: deadlines.content, actions, actionRecords: captureBriefActionRecords(deadlines.content), deadlines: deadlines.deadlines,
    citations: citations.references, issues: citations.issues };
}

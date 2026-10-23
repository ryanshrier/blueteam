// Provider-independent presentation from captured identities and authored action
// facts. Run before validation and persistence, never while reading an archive.
import { normalizeConvergenceOpening } from './brief-schema.js';
import { normalizeBriefCitations } from './validation.js';
import { renderBriefCitations } from './brief-citations.js';
import { composeBriefActions, captureBriefActionRecords } from './brief-composition.js';
import { renderBriefDeadlines } from './brief-deadlines.js';

export { BRIEF_COMPOSITION_VERSION } from './brief-schema.js';

export function assembleBrief(value, { groundingManifest = {}, kevTiming = {} } = {}) {
  const citations = renderBriefCitations(normalizeConvergenceOpening(String(value ?? '')), groundingManifest);
  const actions = composeBriefActions(normalizeBriefCitations(citations.content, groundingManifest));
  const deadlines = renderBriefDeadlines(actions.text, { grounding: groundingManifest, kevTiming });
  return { content: deadlines.content, actions, actionRecords: captureBriefActionRecords(deadlines.content), deadlines: deadlines.deadlines,
    citations: citations.references, issues: citations.issues };
}

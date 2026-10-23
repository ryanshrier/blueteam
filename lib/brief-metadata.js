// Small generated bookkeeping envelope, kept outside reader-facing prose.
// Its assertions are untrusted: editorial and coverage validators verify them.
import { rebindExecutiveActions } from './brief-editorial.js';
import { rebindCoverageDispositions } from './brief-coverage.js';

export const BRIEF_METADATA_VERSION = 1;
const MAX_BYTES = 24576;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const shortString = (value, max) => typeof value === 'string' && value.length <= max;
const strings = (value, count, length) => Array.isArray(value) && value.length <= count && value.every(item => shortString(item, length));
const invalid = () => ({ code: 'BRIEF_METADATA_INVALID', severity: 'note',
  message: 'Optional action/coverage bookkeeping was ignored because it was malformed or exceeded its limits. The visible briefing is checked directly; no hidden record is needed to publish.' });

// Older retained drafts may carry the previous blocking diagnostic. Preserve
// the captured artifact, but apply today's auxiliary-record policy on recheck.
export const normalizeBriefMetadataIssues = issues => (Array.isArray(issues) ? issues : [])
  .map(issue => issue?.code === 'BRIEF_METADATA_INVALID' ? { ...issue, ...invalid() } : issue);

export function sanitizeBriefMetadata(value) {
  if (!plainObject(value) || value.schemaVersion !== BRIEF_METADATA_VERSION
    || !Array.isArray(value.executiveActions) || value.executiveActions.length > 24
    || !Array.isArray(value.coverage) || value.coverage.length > 16) throw new Error('Invalid briefing metadata');
  const executiveActions = value.executiveActions.map(item => {
    if (!plainObject(item) || !Number.isSafeInteger(item.decision) || item.decision < 1 || item.decision > 24
      || !strings(item.actionIds, 12, 32)) throw new Error('Invalid executive action mapping');
    return { decision: item.decision, actionIds: [...item.actionIds] };
  });
  const coverage = value.coverage.map(item => {
    if (!plainObject(item) || !shortString(item.priorityId, 32) || !shortString(item.status, 32)
      || (item.section !== undefined && !shortString(item.section, 32))
      || (item.index !== undefined && (!Number.isSafeInteger(item.index) || item.index < 1 || item.index > 100))
      || (item.sourceIds !== undefined && !strings(item.sourceIds, 30, 128))
      || (item.coveredBy !== undefined && !shortString(item.coveredBy, 32))
      || (item.reason !== undefined && !shortString(item.reason, 2000))) throw new Error('Invalid coverage disposition');
    return { priorityId: item.priorityId, status: item.status,
      ...(item.section !== undefined ? { section: item.section } : {}),
      ...(item.index !== undefined ? { index: item.index } : {}),
      ...(item.sourceIds !== undefined ? { sourceIds: [...item.sourceIds] } : {}),
      ...(item.coveredBy !== undefined ? { coveredBy: item.coveredBy } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}) };
  });
  return { schemaVersion: BRIEF_METADATA_VERSION, executiveActions, coverage };
}

export function extractBriefMetadata(value, fallback = null) {
  const text = String(value ?? '');
  const pattern = /<!--\s*briefing-metadata\b([\s\S]*?)(?:-->|$)/gi;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return { content: text, metadata: fallback, issues: [] };
  const content = text.replace(pattern, '').trimEnd();
  try {
    if (matches.length !== 1 || !matches[0][0].endsWith('-->') || Buffer.byteLength(matches[0][1]) > MAX_BYTES) throw new Error('Invalid envelope');
    return { content, metadata: sanitizeBriefMetadata(JSON.parse(matches[0][1].trim())), issues: [] };
  } catch { return { content, metadata: null, issues: [invalid()] }; }
}

/** Keep only bindings whose decision/action or rendered entry stayed in place. */
export function rebindBriefMetadata(value, previousText, nextText) {
  let metadata;
  try { metadata = sanitizeBriefMetadata(value); } catch { return null; }
  if (previousText === nextText) return metadata;
  const executiveActions = rebindExecutiveActions(previousText, nextText, metadata.executiveActions);
  const coverage = rebindCoverageDispositions(previousText, nextText, metadata.coverage);
  return executiveActions.length || coverage.length
    ? { schemaVersion: BRIEF_METADATA_VERSION, executiveActions, coverage } : null;
}

export const BRIEF_METADATA_INSTRUCTIONS = `Optional coverage bookkeeping: the application checks coverage from the visible report. You may append one HTML comment with auxiliary coverage mappings, but this is not required for publication. Omit uncertain mappings rather than inventing them. The application derives executive action summaries directly; do not supply action mappings. If supplying coverage, use this JSON shape after the final report section; it is removed from the published prose:
<!-- briefing-metadata
{"schemaVersion":1,"executiveActions":[],"coverage":[]}
-->
If a priority coverage list is supplied, any optional dispositions belong in the same JSON record, following its supplied schema. The record is checked against the actual report; it is not evidence and cannot override a failed check. Do not put this comment inside a code fence.`;

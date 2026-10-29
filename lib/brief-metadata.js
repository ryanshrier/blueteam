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

// Parsing retained auxiliary records remains supported. New generations need
// no model-authored mapping: the application derives coverage and summaries.
export const BRIEF_METADATA_INSTRUCTIONS = `Write only the reader-facing briefing. The application derives executive action summaries and priority coverage from its visible discussion, actions and captured citations. Do not supply auxiliary coverage mappings, duplicate declarations, action mappings or hidden JSON comments. A priority-event list guides editorial selection; it does not require a bookkeeping record. If an evidence gap or editorial deferral changes the reader's interpretation, explain it concisely in the visible report. Missing hidden metadata does not prevent publication or waive any factual source check.`;

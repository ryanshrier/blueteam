// Small generated bookkeeping envelope, kept outside reader-facing prose.
// Its assertions are untrusted: editorial and coverage validators verify them.
export const BRIEF_METADATA_VERSION = 1;
const MAX_BYTES = 24576;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const shortString = (value, max) => typeof value === 'string' && value.length <= max;
const strings = (value, count, length) => Array.isArray(value) && value.length <= count && value.every(item => shortString(item, length));
const invalid = () => ({ code: 'BRIEF_METADATA_INVALID', severity: 'structure',
  message: 'The briefing action/coverage record is malformed or exceeds its limits. Repair the record before publishing.' });

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

export const BRIEF_METADATA_INSTRUCTIONS = `After the final report section, append exactly one HTML comment containing an action/coverage record. It is removed from the published prose. Use this JSON shape:
<!-- briefing-metadata
{"schemaVersion":1,"executiveActions":[{"decision":1,"actionIds":["S1.A1","S1.A2"]}],"coverage":[]}
-->
Number Required decisions clauses from 1 in their authored order. Give each clause one executiveActions entry. S1.A1 means the first Recommended actions bullet in Signal 1; S1.A2 is its second bullet. Reference only the actions actually summarized. Use their exact owners and targets. Actions with different target dates need separate summary clauses, even when they share an owner. Preserve initiation, conditions, and paired investigation/recovery work in the summary. Do not print these IDs in the report itself.
If a priority coverage list is supplied, put one coverage disposition per priority item in the same JSON record, following its supplied schema. The record is checked against the actual report; it is not evidence and cannot override a failed check. Do not put this comment inside a code fence.`;

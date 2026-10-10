import { normalizeFeedTimestamp } from './intelligence-context.js';
import { classifySourceEvidence } from './evidence-quality.js';

const tokens = value => String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:[.+-][\p{L}\p{N}]+)*/gu) || [];
export const sameFeedText = (a, b) => JSON.stringify(tokens(a)) === JSON.stringify(tokens(b));

/** Admit a revision candidate, not an asserted new incident. A source timestamp
 * alone, first observation, cosmetic edit or newly expanded truncated capture
 * cannot reopen the publication window. The exact baseline remains inspectable. */
export function revisedFeedAdmission(item, previous, maxAgeMs, now = Date.now()) {
  const updatedAt = normalizeFeedTimestamp(item.sourceUpdatedAt);
  const updated = Date.parse(updatedAt), observed = Date.parse(previous?.lastObservedAt);
  const published = Date.parse(normalizeFeedTimestamp(item.date));
  if (!previous?.revisionId || !Number.isFinite(updated) || !Number.isFinite(observed) || !Number.isFinite(published)
    || updated <= observed || updated <= published || now - updated >= maxAgeMs || updated - now > 3_600_000) return null;
  if (item.passageTruncated || previous.passageTruncated || !previous.passage || /(?:\.{3}|…)\s*$/.test(previous.passage)
    || !classifySourceEvidence({ title: item.title, passage: item.passage }).substantive) return null;
  const before = tokens(previous.passage), after = tokens(item.passage);
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  const changed = [...before.slice(start, before.length - end), ...after.slice(start, after.length - end)].join(' ');
  if (!changed || !/\bCVE-\d{4}-\d{4,7}\b|\b\d+\.\d+|\b(?:exploit\w*|attack\w*|compromis\w*|fix(?:ed|es)?|patch\w*|mitigat\w*|withdraw\w*|retract\w*|affected|unaffected|vulnerable|not|no|now|confirmed|observed|detected|requires?|reset|rotate|revok\w*)\b/i.test(changed)) return null;
  return { basis: 'changed-operational-text', materiality: 'candidate-not-verified', updatedAt,
    previousRevisionId: previous.revisionId };
}

export function retainedRevisionAdmission(value) {
  if (value?.basis !== 'changed-operational-text' || value.materiality !== 'candidate-not-verified'
    || !/^rev_[a-f0-9]{64}$/.test(value.previousRevisionId || '') || !normalizeFeedTimestamp(value.updatedAt)) return null;
  return { basis: value.basis, materiality: value.materiality, updatedAt: normalizeFeedTimestamp(value.updatedAt), previousRevisionId: value.previousRevisionId };
}

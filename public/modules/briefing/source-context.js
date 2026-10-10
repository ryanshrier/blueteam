import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';

// Earlier source prose remains inspectable without joining current source parts,
// citation identities, evidence counts, or the accepted-capture presentation.
export function historicalSourceContextHtml(source = {}) {
  const captures = (Array.isArray(source.historicalCaptures) ? source.historicalCaptures : [])
    .filter(capture => capture && typeof capture.passage === 'string' && capture.passage.trim()).slice(0, 1);
  if (!captures.length) return '';
  return `<details class="brief-historical-context"><summary>Earlier captured source context</summary><p>Historical context only · not refreshed for this edition. Use it to inspect earlier qualifications; it does not establish current facts or add independent supporting evidence.</p>${captures.map(capture => `<section><p class="brief-input-source-meta">Originally published ${escapeHtml(formatEventTime(capture.publishedAt) || 'date not recorded')} · Retrieved ${escapeHtml(formatEventTime(capture.retrievedAt) || 'time not recorded')}</p><blockquote>${escapeHtml(capture.passage)}</blockquote><p class="brief-input-source-meta">Retained from the input receipt captured ${escapeHtml(formatEventTime(capture.retainedFrom?.capturedAt) || 'at an unrecorded time')}${capture.retainedFrom?.sourceId ? ` · Earlier source ${escapeHtml(capture.retainedFrom.sourceId)}` : ''}</p></section>`).join('')}</details>`;
}

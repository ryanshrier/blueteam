import { escapeHtml } from './sanitize.js';

const text = value => value == null ? '' : String(value).trim();

/** Only authored HTTP(S) destinations are source links. Deduplicate without
 * promoting a reporting count into evidence confidence. */
export function assessmentSources(sources = []) {
  const seen = new Set();
  return (Array.isArray(sources) ? sources : []).flatMap(source => {
    const href = text(source?.href);
    if (!/^https?:\/\//i.test(href)) return [];
    try {
      const url = new URL(href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ href, label: text(source?.label) || url.hostname.replace(/^www\./, '') }];
    } catch { return []; }
  });
}

function warningLevel(value) {
  if (['danger', 'critical'].includes(value)) return 'danger';
  if (['warning', 'warn', 'high'].includes(value)) return 'warning';
  return '';
}

/** A shared presentation contract, never an analytical scoring function.
 * Callers supply the meaning of dates, severity, and certainty. Missing fields
 * remain explicit; dates and confidence are never inferred from sources. */
export function renderAssessmentMeta({ sources = [], time = {}, severity = {}, certainty = {}, compact = false, omitUnavailable = false } = {}) {
  const cited = assessmentSources(sources);
  const dateTime = text(time?.dateTime);
  const hasDate = /^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(dateTime) && Number.isFinite(Date.parse(dateTime));
  const timeValue = text(time?.value);
  const level = warningLevel(severity?.level);
  const item = (field, label, value, warning = '') => `<div class="assessment-meta__item" data-field="${field}"${warning ? ` data-level="${warning}"` : ''}><dt class="assessment-meta__label">${escapeHtml(label)}</dt><dd class="assessment-meta__value">${value}</dd></div>`;
  const sourceHtml = cited.length
    ? cited.map(source => `<a class="assessment-meta__source" href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a>`).join('<span aria-hidden="true"> · </span>')
    : 'Not available';
  return `<dl class="assessment-meta${compact ? ' assessment-meta--compact' : ''}">${[
    item('sources', 'Sources', sourceHtml),
    omitUnavailable && (!timeValue || /^Not (?:available|recorded)$/i.test(timeValue)) ? '' : item('time', text(time?.label) || 'Published', timeValue ? (hasDate ? `<time datetime="${escapeHtml(dateTime)}">${escapeHtml(timeValue)}</time>` : escapeHtml(timeValue)) : 'Not available'),
    omitUnavailable && (!text(severity?.value) || /^Not assessed$/i.test(text(severity?.value))) ? '' : item('severity', text(severity?.label) || 'Severity', escapeHtml(text(severity?.value) || 'Not assessed'), text(severity?.value) ? level : ''),
    item('certainty', text(certainty?.label) || 'Assessment confidence', escapeHtml(text(certainty?.value) || 'Not assessed')),
  ].join('')}</dl>`;
}

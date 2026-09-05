import { escapeHtml } from '../core/sanitize.js';

// Match literal user text before escaping; a query can never introduce markup.
export function highlightWireText(value, query = '') {
  const text = String(value ?? '');
  const needle = String(query).trim();
  if (!needle) return escapeHtml(text);
  // Match the original string: Unicode lowercasing can change its length and
  // make offsets from a lowercased copy point at the wrong source characters.
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let start = 0;
  let result = '';
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    result += escapeHtml(text.slice(start, index));
    result += `<mark class="wire-match">${escapeHtml(match[0])}</mark>`;
    start = index + match[0].length;
  }
  return result + escapeHtml(text.slice(start));
}

export function renderWireDescription(value, { id, key, expanded = false, query = '' }) {
  if (!value) return '';
  return `<div class="wire-summary"><p id="${escapeHtml(id)}" class="wire-item-desc${expanded ? ' is-expanded' : ''}">${highlightWireText(value, query)}</p><button type="button" class="wire-summary-toggle" data-summary="${escapeHtml(key)}" aria-controls="${escapeHtml(id)}" aria-expanded="${expanded}"${expanded ? '' : ' hidden'}>${expanded ? 'Show less' : 'Read full summary'}</button></div>`;
}

const paths = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  read: '<path d="m5 12 4 4L19 6"/><path d="M20 12v7H4V3h10"/>',
  unread: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  hide: '<path d="M3 4h18v4H3zM5 8v12h14V8M9 12h6"/>',
};

export function wireIcon(name) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

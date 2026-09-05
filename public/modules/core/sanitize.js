// BlueTeam.News — HTML sanitization (DOMPurify, served from /vendor).

import DOMPurify from '/vendor/purify.es.mjs';

export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'hr', 'br', 'span', 'div', 'a', 'mark',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section',
  ],
  // Model/search HTML never needs to supply application classes or element IDs.
  // Semantic styling adds its trusted classes/IDs only after this boundary; letting
  // untrusted markup keep them enables UI spoofing and unsafe second-order reuse
  // (for example, a heading ID later interpolated into the generated TOC).
  ALLOWED_ATTR: ['href', 'title'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

export const sanitize = (html) => DOMPurify.sanitize(html, SANITIZE_CONFIG);

// Streaming and connection-lost drafts have not crossed the server's grounding
// gate yet. Keep their readable markup, but never expose a live model-supplied
// link until an explicit `briefComplete` replaces the draft with validated HTML.
export const DRAFT_SANITIZE_CONFIG = {
  ...SANITIZE_CONFIG,
  ALLOWED_ATTR: [],
  FORBID_ATTR: ['href'],
};

export const sanitizeDraft = (html) => DOMPurify.sanitize(html, DRAFT_SANITIZE_CONFIG);

// FTS snippets are inserted inside a result <button>; they need only the server's
// <mark> hit wrapper. A separate narrow policy prevents archived raw HTML from
// creating nested links/headings or other interactive/structural content there.
export const SEARCH_SNIPPET_CONFIG = {
  ALLOWED_TAGS: ['mark'],
  ALLOWED_ATTR: [],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};
// Search indexes the original Markdown. Remove document furniture from excerpts
// without removing a highlighted hit; the mark-only sanitizer remains last.
export function cleanSearchExcerpt(value) {
  return String(value ?? '').split(/\r?\n/)
    .filter(line => /<mark\b/i.test(line) || !/^\s*#{1,6}\s*(?:BlueTeam\.News|Threat Landscape Briefing(?:\s*[·—–|:-].*)?)\s*#*\s*$/i.test(line))
    .join('\n')
    .replace(/(^|\n)\s{0,3}#{1,6}[ \t]+/g, '$1')
    .replace(/(^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/g, '$1')
    .replace(/!?\[([^\]\n]+)\]\([^\n]*?\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ').trim();
}
export const sanitizeSearchSnippet = (html) => DOMPurify.sanitize(cleanSearchExcerpt(html), SEARCH_SNIPPET_CONFIG);

export function escapeHtml(str) {
  // Guard on null/undefined, NOT falsiness: a numeric 0 (a score or count of
  // zero) must render as "0", not vanish to an empty string.
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

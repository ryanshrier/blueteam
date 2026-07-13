// BlueTeam.News — markdown rendering (marked → DOMPurify, served from /vendor).
// renderMarkdown returns SANITIZED HTML so the safe path is the only path: a
// caller can drop the result straight into innerHTML with no separate sanitize.

import { marked } from '/vendor/marked.esm.js';
import { sanitize, sanitizeDraft } from './sanitize.js';

marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdown(text) {
  return sanitize(marked.parse(text || ''));
}

/** Render an unvalidated in-flight/connection-lost draft with no live hrefs. */
export function renderDraftMarkdown(text) {
  return sanitizeDraft(marked.parse(text || ''));
}

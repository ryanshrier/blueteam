import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';

/** Annotations never mutate the original Markdown or pretend to be citations. */
export function attachEditorialReview(content, brief) {
  const disposition = brief?.disposition;
  if (disposition && ['review-required', 'superseded'].includes(disposition.status)) {
    const notice = content.ownerDocument.createElement('aside');
    notice.className = 'brief-disposition-notice';
    const replacement = /^brief-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(disposition.replacementFilename || '') ? disposition.replacementFilename : '';
    notice.innerHTML = `<strong>${disposition.status === 'superseded' ? 'Superseded edition' : 'Editorial review required'}</strong><p>${escapeHtml(disposition.reason || 'This edition is excluded from Latest and automatic Wall rotation.')}</p>${replacement ? `<a data-brief-route href="/briefing/${encodeURIComponent(replacement)}">Open corrected edition</a>` : ''}<details><summary>Archive status</summary><p>The original edition and its captured inputs are preserved. This status is separate from its generation-time source checks.</p></details>`;
    content.prepend(notice);
  }
  const review = brief?.review;
  if (!review) return;
  const banner = content.ownerDocument.createElement(review.status === 'editorially-corrected' ? 'details' : 'aside');
  banner.id = 'editorial-review';
  banner.className = 'brief-review-summary';
  if (review.status !== 'editorially-corrected') {
    banner.setAttribute('role', 'alert');
    banner.textContent = review.message || 'Editorial review unavailable; original text displayed.';
    content.prepend(banner);
    return;
  }
  const groups = new Map();
  for (const note of review.notes || []) groups.set(note.anchor, [...(groups.get(note.anchor) || []), note]);
  const targets = [...content.querySelectorAll('[id]')];
  const annotations = [...groups].map(([anchor, notes]) => {
    const target = targets.find(node => node.id === anchor) || (anchor === 'section-bluf' ? content.querySelector('.bluf') : null);
    const heading = /^H[23]$/.test(target?.tagName || '') ? target : target?.querySelector?.('h2, h3');
    const label = anchor === 'section-bluf' ? 'Bottom line up front' : heading?.textContent?.trim() || (/^judgment-(\d+)$/.test(anchor || '') ? `Judgment ${anchor.match(/\d+$/)[0]}` : 'Edition corrections');
    const location = target?.id ? `<a href="#${escapeHtml(encodeURIComponent(target.id))}">${escapeHtml(label)}</a>` : escapeHtml(label);
    return `<section class="brief-review-note"><p class="brief-review-section-label">${location}</p><ul>${notes.map(note => `<li id="${escapeHtml(note.id)}"><strong>${escapeHtml(note.label)}</strong> — ${escapeHtml(note.reason)}</li>`).join('')}</ul></section>`;
  }).join('');
  const count = (review.notes || []).length;
  banner.innerHTML = `<summary>Editorial review · ${count} ${count === 1 ? 'correction' : 'corrections'}</summary><p>${escapeHtml(review.reviewer)} · ${escapeHtml(formatEventTime(review.reviewedAt))}</p><p>${escapeHtml(review.scope)}</p><button type="button" class="btn-ghost-sm" data-review-original>View original generated edition</button><details><summary>Original revision identity</summary><p>SHA-256: <code>${escapeHtml(review.originalSha256)}</code></p></details>${annotations}`;
  const history = brief.originalWarnings || [];
  if (history.length) banner.insertAdjacentHTML('beforeend', `<details><summary>${history.length} original generation findings</summary><p>These describe the preserved original, before corrections.</p><ul>${history.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul></details>`);
  if (brief.readingChecks) banner.insertAdjacentHTML('beforeend', `<p>Corrected copy: ${brief.readingChecks.status === 'checked' ? `${brief.readingChecks.warnings?.length || 0} remaining supported-check findings` : 'checks unavailable'}. Automated checks do not establish every claim.</p>`);
  content.prepend(banner);
}

export function openOriginalEdition(brief, opener) {
  const dialog = document.createElement('dialog');
  dialog.className = 'brief-original-dialog';
  dialog.setAttribute('aria-labelledby', 'briefOriginalTitle');
  dialog.innerHTML = `<header><h2 id="briefOriginalTitle">Original generated edition — uncorrected</h2><button type="button" class="btn-ghost">Close</button></header><p>The original is preserved for provenance. Use the corrected reading copy for the editorial review.</p><pre>${escapeHtml(brief.originalContent || brief.content || '')}</pre>`;
  document.body.appendChild(dialog);
  const close = () => { dialog.close(); dialog.remove(); opener?.focus?.(); };
  dialog.querySelector('button').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.showModal();
  return close;
}

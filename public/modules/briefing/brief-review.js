import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';
import { readerIssueIdentity, readerIssueAcknowledged } from './brief-renderer.js';

/** Read the server's current-copy contract, without turning historical checks
 * into a claim about this revision. The fallback supports older saved editions. */
export function readerPresentation(brief = {}) {
  if (brief.presentation?.schemaVersion === 1) return brief.presentation;
  const corrected = brief.review?.status === 'editorially-corrected';
  const checked = corrected ? brief.readingChecks : brief.inputManifest?.validation;
  const status = brief.inputManifest?.integrity === 'invalid' ? 'unavailable' : corrected ? checked?.status === 'checked' ? 'checked' : 'unavailable'
    : ['passed-supported-checks', 'checked-supported-forms', 'findings'].includes(brief.sourceCheckStatus) || checked ? 'checked'
      : 'not-recorded';
  return { schemaVersion: 1, copy: { kind: corrected ? 'editorially-corrected' : 'published' },
    currentChecks: { status, basis: corrected ? 'corrected-copy' : 'publication', issues: checked?.issues || [],
      warnings: checked?.warnings || brief.warnings || [] },
    history: corrected && brief.originalWarnings?.length ? [{ kind: 'original-publication', label: 'Original publication', warnings: brief.originalWarnings }] : [],
    approval: { status: brief.editorialReviewStatus === 'reviewed' || brief.disposition?.editorialReviewStatus === 'reviewed' ? 'recorded' : 'not-recorded' },
    operationalNotes: [],
  };
}

/** Only a material exception belongs above both reading modes. Eligibility is
 * the server's decision; absence of optional human review is not a warning. */
export function editionNotice(brief = {}) {
  const disposition = brief.disposition;
  const replacement = /^brief-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(disposition?.replacementFilename || '') ? disposition.replacementFilename : '';
  if (disposition?.status === 'superseded') return { title: 'Superseded edition',
    reason: disposition.reason || 'A replacement edition is available. This copy remains in the archive.',
    href: replacement ? `/briefing/${encodeURIComponent(replacement)}` : '/briefing?latest=1', action: replacement ? 'Open replacement' : 'Open current briefing' };
  if (brief.inputManifest?.integrity === 'invalid') return { title: 'Source record could not be verified',
    reason: disposition?.reason || 'This edition is excluded from Latest and Wall while its saved source record is checked.' };
  if (brief.review?.status === 'unavailable') return { title: 'Corrected copy unavailable',
    reason: brief.review.message || 'The saved correction could not be verified. The original edition is displayed.' };
  if (disposition?.status === 'review-required' || disposition?.eligibleForLatest === false) return { title: 'This edition needs review',
    reason: disposition.reason || 'Unresolved checks exclude this edition from Latest and Wall.' };
  return null;
}

export function editionNoticeHtml(brief) {
  const notice = editionNotice(brief);
  return notice ? `<strong>${escapeHtml(notice.title)}</strong><p>${escapeHtml(notice.reason)}</p>${notice.href ? `<a data-brief-route href="${escapeHtml(notice.href)}">${escapeHtml(notice.action)}</a>` : ''}<a href="#edition-record" data-open-edition-record>View edition record</a>` : '';
}

function locatedTarget(content, brief, issue) {
  const line = Number(issue?.location?.line);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const heading = String(brief.content || '').split('\n').slice(0, line).findLast(value => /^#{2,3}\s/.test(value));
  const signal = /^###\s+Signal\s+(\d+)\b/.exec(heading || '');
  if (signal) return content.querySelector(`#judgment-${signal[1]}`);
  const label = (heading || '').replace(/^#{2,3}\s+/, '').replace(/\*\*/g, '').trim();
  return [...content.querySelectorAll('h2, h3')].find(node => node.textContent.trim() === label) || null;
}

export function readerEvidenceLimits(brief = {}, signal = null) {
  const lines = String(brief.content || '').split('\n');
  const seen = new Set();
  const presentation = readerPresentation(brief);
  return (presentation.currentChecks?.issues || []).filter(issue => {
    const identity = readerIssueIdentity(issue);
    if (issue.audience !== 'reader' || readerIssueAcknowledged(issue, presentation) || !issue.message || seen.has(identity)) return false;
    const line = Number(issue.location?.line);
    const heading = Number.isSafeInteger(line) && line > 0 && line <= lines.length ? lines.slice(0, line).findLast(value => /^#{2,3}\s/.test(value)) : '';
    const locatedSignal = Number(/^###\s+Signal\s+(\d+)\b/.exec(heading || '')?.[1]) || null;
    if (signal !== null && locatedSignal !== signal) return false;
    seen.add(identity); return true;
  });
}

export function attachReaderLimits(content, brief) {
  for (const issue of readerEvidenceLimits(brief)) {
    const target = locatedTarget(content, brief, issue);
    const identity = readerIssueIdentity(issue);
    if (!target || [...content.querySelectorAll('[data-reader-issue-id]')].some(node => node.dataset.readerIssueId === identity)) continue;
    const note = (content.ownerDocument || globalThis.document).createElement('p');
    note.className = 'brief-evidence-limit';
    note.dataset.readerIssueId = identity;
    note.innerHTML = `<strong>Evidence limit:</strong> ${escapeHtml(issue.message)}`;
    target.after?.(note);
  }
}

function findingsHtml(content, brief, checks, { current = false } = {}) {
  const issues = checks?.issues || [];
  const messages = [...new Set([...(checks?.warnings || []), ...issues.map(issue => issue.message)].filter(Boolean))];
  return messages.length ? `<ul>${messages.map(message => {
    const issue = issues.find(item => item.message === message);
    const target = current && locatedTarget(content, brief, issue);
    return `<li data-issue-message="${escapeHtml(message)}">${escapeHtml(message)}${current && readerIssueAcknowledged(issue, readerPresentation(brief)) ? ' <span>Specific review recorded</span>' : ''}${target?.id ? ` <a href="#${escapeHtml(target.id)}" data-record-passage>View passage</a>` : ''}${issue?.location?.excerpt ? `<blockquote>${escapeHtml(issue.location.excerpt)}</blockquote>` : ''}</li>`;
  }).join('')}</ul>` : '';
}

/** The edition record is one optional disclosure shared by both reading modes.
 * Its detailed findings never become an edition-wide warning by their count. */
export function attachEditorialReview(content, brief = {}, { recordHost = null, extraNotes = [] } = {}) {
  const document = content.ownerDocument || globalThis.document;
  const record = document.createElement('details');
  record.id = 'edition-record';
  record.className = 'brief-review-summary brief-edition-record';
  const presentation = readerPresentation(brief);
  const checks = presentation.currentChecks || {};
  const current = findingsHtml(content, brief, checks, { current: true });
  const review = brief.review;
  const groups = new Map();
  for (const note of review?.notes || []) groups.set(note.anchor, [...(groups.get(note.anchor) || []), note]);
  const targets = [...content.querySelectorAll('[id]')];
  const annotations = [...groups].map(([anchor, notes]) => {
    const target = targets.find(node => node.id === anchor) || (anchor === 'section-bluf' ? content.querySelector('.bluf') : null);
    const heading = /^H[23]$/.test(target?.tagName || '') ? target : target?.querySelector?.('h2, h3');
    const label = anchor === 'section-bluf' ? 'Bottom line up front' : heading?.textContent?.trim() || (/^judgment-(\d+)$/.test(anchor || '') ? `Judgment ${anchor.match(/\d+$/)[0]}` : 'Edition corrections');
    const location = target?.id ? `<a href="#${escapeHtml(encodeURIComponent(target.id))}" data-record-passage>${escapeHtml(label)}</a>` : escapeHtml(label);
    return `<section class="brief-review-note"><p class="brief-review-section-label">${location}</p><ul>${notes.map(note => `<li id="${escapeHtml(note.id)}"><strong>${escapeHtml(note.label)}</strong> — ${escapeHtml(note.reason)}</li>`).join('')}</ul></section>`;
  }).join('');
  const checkLabel = checks.status === 'checked' ? 'Automated source checks recorded for this copy.'
    : checks.status === 'unavailable' ? 'Checks for this copy are unavailable.' : 'No saved source-check record for this edition.';
  const approval = presentation.approval || {};
  const approvalHtml = approval.status === 'recorded' ? `<section><h3>${approval.scope === 'security-control-change' ? 'Specific security-control review' : approval.scope === 'briefing-editorial' ? 'Specific editorial review' : 'Publication decision recorded'}</h3><p>${escapeHtml([approval.reviewer, formatEventTime(approval.reviewedAt)].filter(Boolean).join(' · '))}</p>${approval.reason ? `<p>${escapeHtml(approval.reason)}</p>` : ''}${approval.scope === 'briefing-editorial' ? '<p>This approval applies only to the findings marked with a specific review in this copy.</p>' : ''}</section>`
    : ['stale', 'unavailable'].includes(approval.status) ? '<p>A previous approval could not be applied to this copy.</p>' : '';
  const history = (presentation.history || []).map(item => `<details><summary>${escapeHtml(item.label || 'Earlier edition record')}</summary>${findingsHtml(content, brief, item)}<p>These records describe an earlier revision or historical metadata.</p></details>`).join('');
  record.innerHTML = `<summary>Edition record</summary><span id="editorial-review" aria-hidden="true"></span><p>${checkLabel}</p>${current ? `<section><h3>Notes for this copy</h3>${current}</section>` : ''}${extraNotes.length ? `<section><h3>Display notes</h3>${findingsHtml(content, brief, { warnings: extraNotes })}</section>` : ''}
    ${review?.status === 'editorially-corrected' ? `<section><h3>Correction record</h3><p>${escapeHtml([review.reviewer, formatEventTime(review.reviewedAt)].filter(Boolean).join(' · '))}</p><p>${escapeHtml(review.scope || '')}</p>${annotations}<button type="button" class="btn-ghost-sm" data-review-original>View original edition</button></section>` : ''}
    ${approvalHtml}${history}${presentation.operationalNotes?.length ? `<details><summary>Publication processing</summary><ul>${presentation.operationalNotes.map(note => `<li>${escapeHtml(note.message || '')}</li>`).join('')}</ul></details>` : ''}
    ${presentation.copy?.contentSha256 || review?.originalSha256 ? `<details><summary>Revision identity</summary>${presentation.copy?.contentSha256 ? `<p>Displayed copy SHA-256: <code>${escapeHtml(presentation.copy.contentSha256)}</code></p>` : ''}${presentation.copy?.originalSha256 || review?.originalSha256 ? `<p>Original edition SHA-256: <code>${escapeHtml(presentation.copy?.originalSha256 || review.originalSha256)}</code></p>` : ''}</details>` : ''}`;
  if (recordHost) { recordHost.innerHTML = ''; recordHost.appendChild(record); }
  else content.prepend(record);
  return record;
}

export function openOriginalEdition(brief, opener) {
  const dialog = document.createElement('dialog');
  dialog.className = 'brief-original-dialog';
  dialog.setAttribute('aria-labelledby', 'briefOriginalTitle');
  dialog.innerHTML = `<header><h2 id="briefOriginalTitle">Original published edition</h2><button type="button" class="btn-ghost">Close</button></header><p>Preserved before the displayed correction.</p><pre>${escapeHtml(brief.originalContent || brief.content || '')}</pre>`;
  document.body.appendChild(dialog);
  const close = () => { dialog.close(); dialog.remove(); opener?.focus?.(); };
  dialog.querySelector('button').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.showModal();
  return close;
}

import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';
import { renderDraftMarkdown } from '../core/markdown.js';

// Unsaved repairs survive closing the dialog during this app session.
const workingCopies = new Map();
export const MAX_REPAIR_BYTES = 80_000;

export function draftPreviewHtml(content) {
  return `<p class="draft-preview-note">Preview · unpublished · source links disabled</p>${renderDraftMarkdown(content)}`;
}

export function draftValidation(artifact) {
  const revision = artifact?.revisions?.at(-1);
  const check = artifact?.lastCheck;
  return check?.revision === revision?.number && check?.contentSha256 === revision?.sha256
    ? check.validation || {} : revision?.validation || {};
}

export function rememberRepair(copies = [], revision, content) {
  const preserved = copies.filter(copy => copy.baseRevision !== revision.number);
  if (content !== revision.content) preserved.push({ content, baseRevision: revision.number });
  return preserved.slice(-8);
}

export function repairRequest(artifact, content) {
  const revision = artifact?.revisions?.at(-1);
  if (!revision || !Number.isInteger(revision.number)) throw new Error('Reload the draft before saving a repair.');
  if (!String(content || '').trim()) throw new Error('A repaired draft cannot be empty.');
  if (new TextEncoder().encode(content).length > MAX_REPAIR_BYTES) throw new Error('This repair is too large to submit. Keep it below 80 KB.');
  return { content, baseRevision: revision.number };
}

export function draftCheckLabel(validation = {}, decision) {
  if (decision?.blockers?.length) return 'Draft saved · fixes needed before publication';
  if (decision?.requiresReview) return 'Draft saved · specific control review required';
  if (decision?.canPublish) return 'Draft saved · ready to publish';
  if (validation.valid === false || validation.sourceCheckStatus === 'findings') return 'Draft saved · checks need attention';
  if (validation.valid === true) return 'Draft saved · supported checks passed · unpublished';
  return 'Checks unavailable';
}

export function publicationRequest(artifact, content, review = null) {
  const patch = repairRequest(artifact, content);
  if (!/^[a-f\d]{64}$/.test(artifact.manifestSha256 || '')) throw new Error('Reload the draft to verify its saved inputs before publishing.');
  const request = { ...patch, inputSha256: artifact.manifestSha256 };
  if (review) {
    const revision = artifact.revisions.at(-1);
    if (content !== revision.content || !/^[a-f\d]{64}$/.test(revision.sha256 || '')) throw new Error('The draft changed. Publish to recheck this text before reviewing its control changes.');
    if (!review.confirmed || !review.reviewer?.trim() || !review.reason?.trim()) throw new Error('Complete the specific security-control review before publishing.');
    request.securityControlReview = { reviewer: review.reviewer.trim(), reason: review.reason.trim(), contentSha256: revision.sha256 };
  }
  return request;
}

export function draftPublicationLabel(result) {
  return result.isCurrent === true ? 'Briefing published · now current in Latest and Wall'
    : result.isCurrent === false ? 'Briefing published · available in the archive'
      : 'Briefing published · current display status unavailable';
}

function draftFindingsHtml(issues, decision) {
  const groups = decision ? [
    { label: 'Fix before publishing', items: decision.blockers || [], open: true },
    { label: 'Specific control review', items: decision.reviewIssues || [], open: true },
    { label: 'Editorial notes', items: decision.notes || [], open: false },
  ] : [{ label: 'Checks need attention', items: issues, open: true }];
  let index = 0;
  return groups.filter(group => group.items.length).map(group => `<details class="draft-findings"${group.open ? ' open' : ''}><summary>${group.label} · ${group.items.length}</summary><ol>${group.items.map(issue => `<li><button type="button" data-draft-line="${Number(issue.location?.line) || 1}" data-draft-issue="${index++}">${escapeHtml(issue.message || '')}<span>${group.label === 'Editorial notes' ? 'Editorial note · optional' : group.label}${issue.location?.line ? ` · Line ${Number(issue.location.line)}` : ''}</span></button>${issue.location?.excerpt ? `<blockquote>${escapeHtml(issue.location.excerpt)}</blockquote>` : ''}</li>`).join('')}</ol></details>`).join('') || '<p>No required changes. Ready to publish.</p>';
}

function capturedEvidenceHtml(artifact) {
  const sources = artifact?.manifest?.grounding?.sources || [];
  return `<details class="draft-captured-evidence"><summary>Captured evidence · ${sources.length} sources</summary>${sources.map(source => {
    const passage = source.evidenceText || source.passage?.text || source.passage || '';
    let link = '';
    try { const url = new URL(source.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) link = url.href; } catch { /* An unavailable URL stays plain text. */ }
    return `<details data-draft-source="${escapeHtml(source.id || '')}"><summary>${escapeHtml(source.label || source.source || source.title || 'Captured source')}</summary><p>${escapeHtml(source.title || '')}</p><p>${escapeHtml(source.publishedAt || source.date || 'Publication date unavailable')}</p><blockquote>${escapeHtml(typeof passage === 'string' ? passage : '')}</blockquote>${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open captured source ↗</a>` : ''}</details>`;
  }).join('')}</details>`;
}

async function draftApi(path, signal, body) {
  const response = await fetch(`/api/brief/drafts${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || (response.status === 413 ? 'This repair exceeds the server request limit.' : `Draft request failed (${response.status}).`)), {
    code: data.code, status: response.status, artifact: data.artifact, validation: data.validation, reviewableIssues: data.reviewableIssues,
  });
  return data;
}

export function openDraftReview({ id = '', opener, onPublished, onSaved } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'brief-draft-dialog';
  dialog.setAttribute('aria-labelledby', 'draftReviewTitle');
  dialog.innerHTML = `<header><div><h2 id="draftReviewTitle">Review draft</h2><p>Save or publish using captured evidence. No additional model call.</p></div><button type="button" class="btn-ghost" data-draft-close>Close</button></header><div class="draft-review-body" aria-live="polite"></div>`;
  document.body.appendChild(dialog);
  const body = dialog.querySelector('.draft-review-body');
  let artifact = null;
  let request = null;
  let active = true;
  let serial = 0;
  const remember = () => {
    const editor = body.querySelector('#draftRepair');
    if (artifact && editor) {
      workingCopies.set(artifact.id, rememberRepair(workingCopies.get(artifact.id), artifact.revisions.at(-1), editor.value));
      if (workingCopies.size > 20) workingCopies.delete(workingCopies.keys().next().value);
    }
  };
  const close = () => {
    if (!active) return;
    remember(); active = false; serial++; request?.abort(); dialog.close(); dialog.remove(); opener?.focus?.();
  };
  function begin() { request?.abort(); request = new AbortController(); return { token: ++serial, signal: request.signal }; }
  function error(message, retry) {
    body.classList.remove('is-reviewing');
    body.innerHTML = `<p class="draft-request-error" role="alert">${escapeHtml(message)}</p><button type="button" class="btn-ghost" data-draft-retry>Retry</button>`;
    body.querySelector('[data-draft-retry]').addEventListener('click', retry);
  }
  async function list() {
    remember(); artifact = null;
    body.classList.remove('is-reviewing');
    const { token, signal } = begin();
    body.innerHTML = '<p role="status">Loading saved drafts…</p>';
    try {
      const data = await draftApi('', signal);
      if (!active || token !== serial) return;
      const items = data.items || [];
      body.innerHTML = items.length ? `<ul class="draft-list">${items.map(item => `<li><button type="button" data-draft-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.editionDate || 'Briefing draft')}</strong><span>${item.status === 'published' ? 'Published' : 'Unpublished draft'} · ${escapeHtml(formatEventTime(item.updatedAt || item.createdAt) || 'Time unavailable')}${item.status !== 'published' ? ` · ${Number(item.issueCount) || 0} findings` : ''}</span></button></li>`).join('')}</ul>` : '<p>No drafts need attention. Briefings that cannot publish automatically appear here for recovery.</p>';
    } catch (e) { if (active && token === serial) error(e.message, list); }
  }
  function showDraft(note = '') {
    const latest = artifact.revisions.at(-1);
    const copies = workingCopies.get(artifact.id) || [];
    const pending = copies.find(copy => copy.baseRevision === latest.number);
    const conflicts = copies.filter(copy => copy.baseRevision !== latest.number);
    const value = pending ? pending.content : latest.content;
    const validation = draftValidation(artifact);
    const decision = artifact.publicationDecision;
    const issues = decision ? [...(decision.blockers || []), ...(decision.reviewIssues || []), ...(decision.notes || [])] : validation.issues || [];
    // Resolve non-overridable failures first; approval must never suggest it can
    // waive an unrelated trust or structural failure.
    const securityIssues = decision?.blockers?.length ? [] : issues.filter(issue => issue.code === 'SECURITY_CONTROL_CHANGE');
    if (artifact.status === 'published' && artifact.publication?.filename) {
      body.classList.remove('is-reviewing');
      body.innerHTML = `<p class="draft-review-note">This draft was published. Its saved revisions and captured evidence are preserved.</p><a class="btn-primary" href="/briefing/${encodeURIComponent(artifact.publication.filename)}">Open published briefing</a>`;
      return;
    }
    const wide = globalThis.matchMedia?.('(min-width: 901px)').matches ?? true;
    body.classList.add('is-reviewing');
    body.innerHTML = `<div class="draft-review-meta"><div class="draft-review-folio"><button type="button" class="btn-ghost" data-draft-list>All drafts</button><strong>${escapeHtml(artifact.editionDate || 'Unpublished draft')} · Revision ${latest.number}</strong><span>${escapeHtml(draftCheckLabel(validation, decision))}</span></div>
      <p class="draft-review-note">${escapeHtml(note || 'Publish saves this text, checks it, and publishes only if the required checks pass. Save draft keeps your work unpublished.')}</p>
      ${artifact.contentRedacted ? '<p class="draft-request-error">Sensitive text was redacted in the retained artifact. Review the saved inputs before repairing it.</p>' : ''}</div>
      <div class="draft-review-workspace"><div class="draft-working-document">
      <div class="draft-view-switch" role="group" aria-label="Draft working view"><button type="button" class="btn-ghost" data-draft-view="preview" aria-pressed="true">Read draft</button><button type="button" class="btn-ghost" data-draft-view="edit" aria-pressed="false">Edit Markdown</button></div>
      <div data-draft-editor hidden><label class="draft-editor-label" for="draftRepair">Repair this revision</label><textarea id="draftRepair" maxlength="80000" spellcheck="false">${escapeHtml(value)}</textarea></div>
      <article class="draft-preview" aria-label="Unpublished draft preview" tabindex="-1">${draftPreviewHtml(value)}</article>
      </div><details class="draft-reference-panel"${wide ? ' open' : ''}><summary>Checks and saved inputs</summary><div class="draft-reference-content">
      ${draftFindingsHtml(issues, decision)}
      ${capturedEvidenceHtml(artifact)}
      ${securityIssues.length ? `<form class="draft-control-review" data-control-review><h3>Review these security-control changes</h3><p>Approval applies only to these changes in the saved text below. Other publication checks still apply.</p><ul>${securityIssues.map(issue => `<li>${escapeHtml(issue.location?.excerpt || issue.message)}</li>`).join('')}</ul><label>Reviewer<input name="reviewer" maxlength="200" required autocomplete="name"></label><label>Why is this change appropriate for this evidence and scope?<textarea name="reason" maxlength="4000" required rows="3"></textarea></label><label class="draft-control-confirm"><input type="checkbox" name="confirmed" required> I reviewed these specific control changes against the captured evidence.</label><p data-control-changed${pending ? '' : ' hidden'}>Your text changed. Publish to recheck it before approving its control changes.</p></form>` : ''}
      <details class="draft-revision-history"><summary>Saved revisions and technical details</summary><p>${artifact.operatorSavedAt ? 'Your saved work is protected from automatic recovery cleanup.' : 'Recovered attempts are retained temporarily. Save draft to keep this work.'} The original and recent saved revisions remain available.</p>${artifact.revisions.map(revision => `<details><summary>Revision ${revision.number} · ${escapeHtml(formatEventTime(revision.createdAt))}</summary><pre>${escapeHtml(revision.content)}</pre></details>`).join('')}<details><summary>Captured input receipt</summary><p>SHA-256: <code>${escapeHtml(artifact.manifestSha256 || 'Unavailable')}</code></p><pre>${escapeHtml(JSON.stringify(artifact.manifest, null, 2))}</pre></details></details>
      </div></details></div>
      <div class="draft-repair-actions"><button type="button" class="btn-primary" data-draft-publish>Publish briefing</button><button type="button" class="btn-ghost" data-draft-save>Save draft</button><span role="status" id="draftRepairStatus">${pending ? 'Unsaved changes restored from this tab.' : `Saved ${escapeHtml(formatEventTime(artifact.lastCheck?.checkedAt || latest.createdAt) || '')} · unpublished`}</span></div>`;
    body.querySelector('#draftRepair').addEventListener('input', () => {
      remember(); body.querySelector('#draftRepairStatus').textContent = 'Unsaved changes · save or publish to keep them.';
      const review = body.querySelector('[data-control-review]');
      if (review) {
        review.querySelector('[name="confirmed"]').checked = false;
        review.querySelector('[data-control-changed]').hidden = editorMatchesSaved();
      }
    });
    if (conflicts.length) {
      const saved = document.createElement('details');
      saved.className = 'draft-revision-conflict';
      saved.innerHTML = `<summary>A newer revision exists. ${conflicts.length} earlier unsaved ${conflicts.length === 1 ? 'repair is' : 'repairs are'} preserved here.</summary>${conflicts.map(copy => `<p>Based on revision ${copy.baseRevision}</p><pre>${escapeHtml(copy.content)}</pre>`).join('')}`;
      body.querySelector('.draft-reference-content').prepend(saved);
    }
  }
  function editorMatchesSaved() { return body.querySelector('#draftRepair')?.value === artifact?.revisions?.at(-1)?.content; }
  function setDraftView(view) {
    const previewing = view === 'preview';
    const editor = body.querySelector('[data-draft-editor]');
    const preview = body.querySelector('.draft-preview');
    if (!editor || !preview) return;
    if (previewing) preview.innerHTML = draftPreviewHtml(body.querySelector('#draftRepair').value);
    editor.hidden = previewing; preview.hidden = !previewing;
    if (globalThis.matchMedia?.('(max-width: 900px)').matches) body.querySelector('.draft-reference-panel').open = false;
    body.querySelectorAll('[data-draft-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.draftView === view)));
  }
  async function load(draftId) {
    remember();
    body.classList.remove('is-reviewing');
    const { token, signal } = begin();
    body.innerHTML = '<p role="status">Loading captured draft and findings…</p>';
    try {
      const data = await draftApi(`/${encodeURIComponent(draftId)}`, signal);
      if (!active || token !== serial) return;
      if (!data.revisions?.length) throw new Error('This draft has no retained revision.');
      artifact = data; showDraft();
    } catch (e) { if (active && token === serial) error(e.message, () => load(draftId)); }
  }
  async function save(publish = false) {
    const editor = body.querySelector('#draftRepair');
    const status = body.querySelector('#draftRepairStatus');
    const buttons = [...body.querySelectorAll('[data-draft-save], [data-draft-publish]')];
    let patch;
    try {
      const form = body.querySelector('[data-control-review]');
      let review = null;
      if (publish && form && editorMatchesSaved()) {
        body.querySelector('.draft-reference-panel').open = true;
        form.scrollIntoView?.({ block: 'nearest' });
        if (!form.reportValidity()) return;
        review = { reviewer: form.elements.reviewer.value, reason: form.elements.reason.value, confirmed: form.elements.confirmed.checked };
      }
      patch = publish ? publicationRequest(artifact, editor.value, review) : repairRequest(artifact, editor.value);
    } catch (e) { status.textContent = e.message; return; }
    remember();
    const { token, signal } = begin();
    buttons.forEach(button => { button.disabled = true; }); editor.readOnly = true; status.textContent = publish ? 'Saving, checking, and publishing…' : 'Saving draft and checking captured evidence…';
    try {
      const data = await draftApi(`/${encodeURIComponent(artifact.id)}/${publish ? 'publish' : 'revalidate'}`, signal, patch);
      if (!active || token !== serial) return;
      workingCopies.set(artifact.id, (workingCopies.get(artifact.id) || []).filter(copy => copy.baseRevision !== patch.baseRevision));
      if (publish && data.published && data.filename) {
        // Closing must not restore the just-published editor as an unsaved copy.
        artifact = null;
        if (onPublished) { close(); onPublished(data); }
        else { body.classList.remove('is-reviewing'); body.innerHTML = `<p>${escapeHtml(draftPublicationLabel(data))}.</p>${data.warnings?.length ? `<ul role="status">${data.warnings.map(warning => `<li>${escapeHtml(String(warning))}</li>`).join('')}</ul>` : ''}<a class="btn-primary" href="/briefing/${encodeURIComponent(data.filename)}">Open published briefing</a>`; }
        return;
      }
      artifact = data;
      onSaved?.(artifact);
      showDraft('Draft saved. Your work is retained and remains unpublished. Publish briefing will run the required checks again.');
    } catch (e) {
      if (active && token === serial) {
        if (e.status === 422 && e.code === 'E_DRAFT_BLOCKED' && e.artifact?.revisions?.length) {
          artifact = e.artifact;
          workingCopies.set(artifact.id, (workingCopies.get(artifact.id) || []).filter(copy => copy.baseRevision !== patch.baseRevision));
          onSaved?.(artifact);
          showDraft(`Draft saved · not published. ${e.message}`);
        } else {
          buttons.forEach(button => { button.disabled = false; }); editor.readOnly = false;
          status.textContent = `${e.message} Your changes remain in this tab. ${e.status === 409 ? 'Reopen this draft to load its latest saved revision; your unsaved repair will remain available.' : publish ? 'If the connection was interrupted, retry Publish briefing with the same text to recover its outcome.' : ''}`;
        }
      }
    }
  }
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-draft-close]')) close();
    const row = event.target.closest('[data-draft-id]');
    if (row) void load(row.dataset.draftId);
    if (event.target.closest('[data-draft-list]')) void list();
    if (event.target.closest('[data-draft-save]')) void save();
    if (event.target.closest('[data-draft-publish]')) void save(true);
    const view = event.target.closest('[data-draft-view]');
    if (view) setDraftView(view.dataset.draftView);
    const issue = event.target.closest('[data-draft-line]');
    if (issue) {
      setDraftView('edit');
      const editor = body.querySelector('#draftRepair');
      const policy = artifact.publicationDecision;
      const findings = policy ? [...(policy.blockers || []), ...(policy.reviewIssues || []), ...(policy.notes || [])] : draftValidation(artifact).issues || [];
      const finding = findings[Number(issue.dataset.draftIssue)];
      if (finding?.sourceIds?.length) {
        body.querySelector('.draft-captured-evidence').open = true;
        body.querySelectorAll('[data-draft-source]').forEach(source => { source.open = finding.sourceIds.includes(source.dataset.draftSource); });
      }
      const prefix = editor.value.split('\n').slice(0, Number(issue.dataset.draftLine) - 1).join('\n');
      const start = prefix.length ? prefix.length + 1 : 0;
      editor.focus(); editor.setSelectionRange(start, editor.value.indexOf('\n', start) < 0 ? editor.value.length : editor.value.indexOf('\n', start));
    }
  });
  dialog.addEventListener('submit', event => { event.preventDefault(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.showModal();
  void (id ? load(id) : list());
  return close;
}

import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';
import { renderDraftMarkdown } from '../core/markdown.js';

// Unsaved repairs survive closing the dialog during this app session.
const workingCopies = new Map();
export const MAX_REPAIR_BYTES = 80_000;

export function draftPreviewHtml(content) {
  return `<p class="draft-preview-note">Preview · unpublished · source links disabled</p>${renderDraftMarkdown(content)}`;
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

export function draftCheckLabel(validation = {}) {
  if (validation.valid === false || validation.sourceCheckStatus === 'findings') return 'Checks need attention';
  if (validation.valid === true) return 'Supported checks passed · editorial review required';
  return 'Checks unavailable';
}

async function draftApi(path, signal, body) {
  const response = await fetch(`/api/brief/drafts${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || (response.status === 413 ? 'This repair exceeds the server request limit.' : `Draft request failed (${response.status}).`));
  return data;
}

export function openDraftReview({ id = '', opener } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'brief-draft-dialog';
  dialog.setAttribute('aria-labelledby', 'draftReviewTitle');
  dialog.innerHTML = `<header><div><h2 id="draftReviewTitle">Draft review</h2><p>Unpublished · rechecks use saved inputs, without a model call.</p></div><button type="button" class="btn-ghost" data-draft-close>Close</button></header><div class="draft-review-body" aria-live="polite"></div>`;
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
    body.innerHTML = `<p class="draft-request-error" role="alert">${escapeHtml(message)}</p><button type="button" class="btn-ghost" data-draft-retry>Retry</button>`;
    body.querySelector('[data-draft-retry]').addEventListener('click', retry);
  }
  async function list() {
    remember(); artifact = null;
    const { token, signal } = begin();
    body.innerHTML = '<p role="status">Loading saved drafts…</p>';
    try {
      const data = await draftApi('', signal);
      if (!active || token !== serial) return;
      const items = data.items || [];
      body.innerHTML = items.length ? `<ul class="draft-list">${items.map(item => `<li><button type="button" data-draft-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.editionDate || 'Unpublished draft')}</strong><span>${escapeHtml(formatEventTime(item.updatedAt || item.createdAt) || 'Time unavailable')} · ${Number(item.issueCount) || 0} findings · ${Number(item.revisionCount) || 1} revisions</span></button></li>`).join('')}</ul>` : '<p>No retained drafts. Rejected generations will appear here when a draft is available.</p>';
    } catch (e) { if (active && token === serial) error(e.message, list); }
  }
  function showDraft(note = '') {
    const latest = artifact.revisions.at(-1);
    const copies = workingCopies.get(artifact.id) || [];
    const pending = copies.find(copy => copy.baseRevision === latest.number);
    const conflicts = copies.filter(copy => copy.baseRevision !== latest.number);
    const value = pending ? pending.content : latest.content;
    const issues = latest.validation?.issues || [];
    body.innerHTML = `<div class="draft-review-folio"><button type="button" class="btn-ghost" data-draft-list>All drafts</button><strong>${escapeHtml(artifact.editionDate || 'Unpublished draft')} · Revision ${latest.number}</strong><span>${escapeHtml(draftCheckLabel(latest.validation))}</span></div>
      <p class="draft-review-note">${escapeHtml(note || 'Save a repair to recheck the evidence. Rechecking does not publish the draft.')}</p>
      ${artifact.contentRedacted ? '<p class="draft-request-error">Sensitive text was redacted in the retained artifact. Review the saved inputs before repairing it.</p>' : ''}
      <details class="draft-findings"${issues.length && !globalThis.matchMedia?.('(max-width: 600px)').matches ? ' open' : ''}><summary>${issues.length} findings · select one to inspect its line</summary><ol>${issues.map(issue => `<li><button type="button" data-draft-line="${Number(issue.location?.line) || 1}">${escapeHtml(issue.message || '')}<span>${escapeHtml(issue.code || 'Check')} · ${escapeHtml(issue.severity || 'review')}${issue.location?.line ? ` · Line ${Number(issue.location.line)}` : ''}</span></button></li>`).join('')}</ol></details>
      <div class="draft-view-switch" role="group" aria-label="Draft working view"><button type="button" class="btn-ghost" data-draft-view="edit" aria-pressed="true">Edit Markdown</button><button type="button" class="btn-ghost" data-draft-view="preview" aria-pressed="false">Preview</button></div>
      <div data-draft-editor><label class="draft-editor-label" for="draftRepair">Repair this revision</label><textarea id="draftRepair" maxlength="80000" spellcheck="false">${escapeHtml(value)}</textarea></div>
      <article class="draft-preview" aria-label="Unpublished draft preview" tabindex="-1" hidden></article>
      <div class="draft-repair-actions"><button type="button" class="btn-primary" data-draft-save>Save revision &amp; recheck</button><span role="status" id="draftRepairStatus">${pending ? 'Unsaved repair restored from this tab.' : 'No unsaved changes.'}</span></div>
      <details class="draft-revision-history"><summary>Captured inputs and ${artifact.revisions.length} saved revisions</summary><p>Input receipt SHA-256: <code>${escapeHtml(artifact.manifestSha256 || 'Unavailable')}</code></p><p>Review storage follows the server's retention policy. Original inputs and saved revisions are preserved separately from your unsaved edits.</p>${artifact.revisions.map(revision => `<details><summary>Revision ${revision.number} · ${escapeHtml(revision.kind || 'draft')} · ${escapeHtml(formatEventTime(revision.createdAt))}</summary><pre>${escapeHtml(revision.content)}</pre></details>`).join('')}<details><summary>Inspect captured input receipt</summary><pre>${escapeHtml(JSON.stringify(artifact.manifest, null, 2))}</pre></details></details>`;
    body.querySelector('#draftRepair').addEventListener('input', () => {
      remember(); body.querySelector('#draftRepairStatus').textContent = 'Unsaved repair · retained in this open app until saved.';
    });
    if (conflicts.length) {
      const saved = document.createElement('details');
      saved.className = 'draft-revision-conflict';
      saved.innerHTML = `<summary>A newer revision exists. ${conflicts.length} earlier unsaved ${conflicts.length === 1 ? 'repair is' : 'repairs are'} preserved here.</summary>${conflicts.map(copy => `<p>Based on revision ${copy.baseRevision}</p><pre>${escapeHtml(copy.content)}</pre>`).join('')}`;
      body.querySelector('.draft-review-folio').after(saved);
    }
  }
  function setDraftView(view) {
    const previewing = view === 'preview';
    const editor = body.querySelector('[data-draft-editor]');
    const preview = body.querySelector('.draft-preview');
    if (!editor || !preview) return;
    if (previewing) preview.innerHTML = draftPreviewHtml(body.querySelector('#draftRepair').value);
    editor.hidden = previewing; preview.hidden = !previewing;
    body.querySelectorAll('[data-draft-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.draftView === view)));
  }
  async function load(draftId) {
    remember();
    const { token, signal } = begin();
    body.innerHTML = '<p role="status">Loading captured draft and findings…</p>';
    try {
      const data = await draftApi(`/${encodeURIComponent(draftId)}`, signal);
      if (!active || token !== serial) return;
      if (!data.revisions?.length) throw new Error('This draft has no retained revision.');
      artifact = data; showDraft();
    } catch (e) { if (active && token === serial) error(e.message, () => load(draftId)); }
  }
  async function save() {
    const editor = body.querySelector('#draftRepair');
    const status = body.querySelector('#draftRepairStatus');
    const button = body.querySelector('[data-draft-save]');
    let patch;
    try { patch = repairRequest(artifact, editor.value); } catch (e) { status.textContent = e.message; return; }
    remember();
    const { token, signal } = begin();
    button.disabled = true; editor.readOnly = true; status.textContent = 'Saving revision and rechecking captured evidence…';
    try {
      const data = await draftApi(`/${encodeURIComponent(artifact.id)}/revalidate`, signal, patch);
      if (!active || token !== serial) return;
      artifact = data;
      workingCopies.set(artifact.id, (workingCopies.get(artifact.id) || []).filter(copy => copy.baseRevision !== patch.baseRevision));
      showDraft('Revision saved and rechecked. Editorial review remains required before publication.');
    } catch (e) {
      if (active && token === serial) { button.disabled = false; editor.readOnly = false; status.textContent = `${e.message} Your unsaved repair is preserved in this tab.`; }
    }
  }
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-draft-close]')) close();
    const row = event.target.closest('[data-draft-id]');
    if (row) void load(row.dataset.draftId);
    if (event.target.closest('[data-draft-list]')) void list();
    if (event.target.closest('[data-draft-save]')) void save();
    const view = event.target.closest('[data-draft-view]');
    if (view) setDraftView(view.dataset.draftView);
    const issue = event.target.closest('[data-draft-line]');
    if (issue) {
      setDraftView('edit');
      const editor = body.querySelector('#draftRepair');
      const prefix = editor.value.split('\n').slice(0, Number(issue.dataset.draftLine) - 1).join('\n');
      const start = prefix.length ? prefix.length + 1 : 0;
      editor.focus(); editor.setSelectionRange(start, editor.value.indexOf('\n', start) < 0 ? editor.value.length : editor.value.indexOf('\n', start));
    }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.showModal();
  void (id ? load(id) : list());
  return close;
}

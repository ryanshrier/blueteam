import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';

// Read only the bounded server accounting record. Never recover a draft or start
// provider work from a navigation, status refresh, or interrupted browser stream.
export async function fetchGenerationStatus({ signal } = {}) {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch('/api/brief/status', {
    cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok && response.status !== 503) throw new Error('Generation status unavailable');
  const data = await response.json();
  if (!data || !['ok', 'error'].includes(data.persistence)
    || (response.status === 503 && data.persistence !== 'error')) throw new Error('Generation status unavailable');
  return data;
}

export function generationStatusModel(data, generationId = '') {
  if (!data || data.persistence !== 'ok') return {
    kind: 'unavailable', message: 'Generation accounting is unavailable. Check System health before starting another attempt.',
  };
  const pending = (data.draftRecovery?.items || [data.draftRecovery?.latest]).filter(item => item?.id && item.status !== 'published');
  const pendingDraft = generationId ? pending.find(item => item.id === generationId) : pending[0];
  const jobs = (data.jobs || [data.latest]).filter(Boolean);
  const activeJob = jobs.find(item => item.status === 'running');
  const job = generationId ? jobs.find(item => item?.id === generationId) : activeJob || data.latest;
  // Older servers can report the active lock before its durable job is visible.
  // Do not present the previous completion as the currently running attempt.
  if (!generationId && data.active === true && job?.status !== 'running') return {
    kind: 'running', active: true, poll: true, pendingDraft,
    message: 'Preparing a new briefing. Waiting for generation details.',
  };
  if (generationId && !job) return { kind: 'unavailable', pendingDraft, message: 'The interrupted attempt is not available in generation accounting. Check History before starting another attempt.' };
  if (!job) return pendingDraft ? { kind: 'draft', pendingDraft, message: 'A saved draft remains unpublished.', poll: Boolean(data.active) } : null;
  const attempt = generationId ? 'This attempt' : 'Latest attempt';
  const phases = {
    collecting: 'Collecting current source evidence…', preparing: 'Preparing saved evidence and briefing context…',
    generating: 'Writing the briefing…', validating: 'Checking evidence, coverage, and actions…', publishing: 'Saving the checked edition…',
  };
  const messages = {
    running: phases[job.phase] || 'Generation is running. The archive updates after publication.',
    complete: `${attempt} published an edition.`,
    failed: job.code === 'E006'
      ? `${attempt} failed publication checks. No edition was published.`
      : `${attempt} did not publish an edition.`,
    interrupted: job.billing === 'no-provider-attempt-recorded'
      ? `${attempt} was interrupted before a provider attempt was recorded. Check History before retrying.`
      : `${attempt} was interrupted. Check History before retrying; final usage is unknown.`,
  };
  if (!messages[job.status]) return { kind: 'unavailable', message: 'Latest generation status could not be confirmed.' };
  const cost = Number.isFinite(job.costUsd) && job.costUsd >= 0 ? `$${job.costUsd.toFixed(4)}` : null;
  const unknownUsage = job.billing !== 'no-provider-attempt-recorded'
    && (job.billing === 'unknown-final-usage' || job.status === 'interrupted');
  const billing = job.billing === 'no-provider-attempt-recorded'
    ? 'No provider attempt recorded.'
    : unknownUsage
      ? `${cost ? `Recorded estimate ${cost}; ` : ''}final usage is unknown.`
      : cost ? `Estimated API cost ${cost}.` : 'Estimated API cost unavailable.';
  const stamp = job.completedAt || job.startedAt;
  const date = formatEventTime(stamp);
  return {
    kind: job.status, active: data.active === true || Boolean(activeJob), phase: phases[job.phase] ? job.phase : '', jobId: job.id || '', targeted: Boolean(generationId), message: messages[job.status], billing, date, pendingDraft,
    edition: /^\d{4}-\d{2}-\d{2}$/.test(job.editionDate || '') ? job.editionDate : '',
    code: typeof job.code === 'string' ? job.code.slice(0, 128) : '',
    filename: job.status === 'complete' && typeof job.filename === 'string' ? job.filename : '',
    poll: job.status === 'running' || (!generationId && data.active === true),
  };
}

function statusHtml(model) {
  if (!model) return '';
  const details = [model.edition ? `Requested edition ${model.edition}` : '', model.date, model.code ? `Status ${model.code}` : ''].filter(Boolean);
  if (model.pendingDraft && model.kind !== 'running') return `<div class="brief-attempt-summary"><strong>New draft awaiting review${model.pendingDraft.editionDate ? ` · ${escapeHtml(model.pendingDraft.editionDate)}` : ''}</strong><p>Your saved work is unpublished. Latest and Wall continue using the current published briefing.</p></div><div class="brief-attempt-actions"><button type="button" class="btn-primary" data-review-draft="${escapeHtml(model.pendingDraft.id)}">Review draft</button><details><summary>Generation details</summary><p>${escapeHtml(model.message || '')}</p>${model.billing ? `<p>${escapeHtml(model.billing)}</p>` : ''}<p>${details.map(escapeHtml).join(' · ')}</p>${model.kind === 'unavailable' ? '<button type="button" class="btn-ghost-sm" data-refresh-generation>Retry status check</button>' : ''}</details></div>`;
  const body = `<div class="brief-attempt-summary"><strong>${model.targeted ? 'Interrupted generation attempt' : 'Latest generation attempt'}</strong><p>${escapeHtml(model.message)}</p>
    ${model.billing ? `<p class="brief-attempt-billing">${escapeHtml(model.billing)}</p>` : ''}</div>
    <div class="brief-attempt-actions">
      ${model.filename ? `<a href="/briefing/${encodeURIComponent(model.filename)}">Open published briefing →</a>` : ''}
      ${model.kind === 'unavailable' ? '<a href="/settings#systemHealth">System health →</a><button type="button" class="btn-ghost-sm" data-refresh-generation>Retry status check</button>' : ''}
      ${details.length ? `<details><summary>Attempt details</summary><p>${details.map(escapeHtml).join(' · ')}</p></details>` : ''}
    </div>`;
  return model.kind === 'complete'
    ? `<details class="brief-attempt-complete"><summary>Last publication${model.date ? ` · ${escapeHtml(model.date)}` : ''}</summary>${body}</details>`
    : body;
}

export function mountGenerationStatus(host, { load = fetchGenerationStatus, isGenerating = () => false, getGenerationId = () => '', onState = () => {}, onReviewDraft = () => {}, watchIdle = false, visibility = globalThis.document, focusTarget = globalThis.window } = {}) {
  if (!host) return { refresh() {}, stop() {} };
  let stopped = false;
  let request = 0;
  let controller = null;
  let timer = null;
  let lastHtml = null;
  let consecutiveFailures = 0;
  let lastPendingDraft;
  const visible = () => visibility?.visibilityState !== 'hidden';
  const schedule = delay => {
    if (!stopped && visible()) timer = setTimeout(() => refresh({ automatic: true }), delay);
  };
  const rememberedDraft = () => lastPendingDraft && (!getGenerationId() || lastPendingDraft.id === getGenerationId()) ? lastPendingDraft : undefined;
  const setChecking = checking => {
    host.setAttribute?.('aria-busy', String(checking));
    const button = host.querySelector?.('[data-refresh-generation]');
    if (button) {
      button.disabled = checking;
      button.textContent = checking ? 'Checking status…' : 'Retry status check';
    }
  };
  const paint = (model, data) => {
    const html = statusHtml(model);
    host.hidden = !html;
    host.dataset.state = model?.pendingDraft && model.kind !== 'running' ? 'draft' : model?.kind || '';
    // Polling must not collapse an open details disclosure or move focus.
    if (html !== lastHtml) { host.innerHTML = html; lastHtml = html; }
    onState(model, data);
  };
  const refresh = async ({ automatic = false } = {}) => {
    if (stopped) return;
    if (automatic && !visible()) return;
    if (!automatic) consecutiveFailures = 0;
    const token = ++request;
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    if (lastHtml === null) paint({ kind: 'checking', message: 'Checking latest generation status…' });
    setChecking(true);
    try {
      const data = await load({ signal: controller.signal });
      if (stopped || token !== request) return;
      consecutiveFailures = 0;
      const model = generationStatusModel(data, getGenerationId());
      if (model?.kind === 'unavailable' && !model.pendingDraft) model.pendingDraft = rememberedDraft();
      else lastPendingDraft = model?.pendingDraft;
      paint(model, data);
      if (model?.poll || isGenerating()) schedule(10_000);
      else if (watchIdle && model?.kind !== 'unavailable') schedule(30_000);
    } catch {
      if (stopped || token !== request) return;
      consecutiveFailures++;
      const retrying = consecutiveFailures <= 2;
      paint({ kind: 'unavailable', pendingDraft: rememberedDraft(), message: retrying
        ? 'Latest generation status could not be checked. Checking again shortly; no new generation will be started.'
        : 'Latest generation status could not be checked. Retry the status check before starting another attempt.' });
      // A brief connectivity failure must not leave a running or just-finished
      // attempt stuck behind a stale status error. These bounded retries only
      // read accounting; they never retry provider work or recover a draft.
      if (retrying) schedule(consecutiveFailures * 5_000);
    } finally {
      if (!stopped && token === request) setChecking(false);
    }
  };
  const click = event => {
    const draft = event.target.closest('[data-review-draft]');
    if (draft?.dataset?.reviewDraft) onReviewDraft(draft.dataset.reviewDraft, draft);
    const button = event.target.closest('[data-refresh-generation]');
    if (button && !button.disabled) refresh();
  };
  host.addEventListener('click', click);
  const resumed = () => {
    clearTimeout(timer);
    if (visible()) refresh();
  };
  if (watchIdle) {
    visibility?.addEventListener?.('visibilitychange', resumed);
    focusTarget?.addEventListener?.('focus', resumed);
  }
  return {
    refresh,
    stop() {
      stopped = true;
      request++;
      clearTimeout(timer);
      controller?.abort();
      host.removeEventListener('click', click);
      if (watchIdle) {
        visibility?.removeEventListener?.('visibilitychange', resumed);
        focusTarget?.removeEventListener?.('focus', resumed);
      }
    },
  };
}

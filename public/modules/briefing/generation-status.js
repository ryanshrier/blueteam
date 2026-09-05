import { escapeHtml } from '../core/sanitize.js';

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

export function generationStatusModel(data) {
  if (!data || data.persistence !== 'ok') return {
    kind: 'unavailable', message: 'Generation accounting is unavailable. Check System health before starting another attempt.',
  };
  const job = data.latest;
  if (!job) return null;
  const messages = {
    running: 'Generation is running. The archive updates after publication.',
    complete: 'Latest attempt published an edition.',
    failed: job.code === 'E006'
      ? 'Latest attempt failed publication checks. No edition was published.'
      : 'Latest attempt did not publish an edition.',
    interrupted: 'Latest attempt was interrupted. Check History before retrying; final usage is unknown.',
  };
  if (!messages[job.status]) return { kind: 'unavailable', message: 'Latest generation status could not be confirmed.' };
  const cost = Number.isFinite(job.costUsd) && job.costUsd >= 0 ? `$${job.costUsd.toFixed(4)}` : null;
  const unknownUsage = job.billing === 'unknown-final-usage' || job.status === 'interrupted';
  const billing = job.billing === 'no-provider-attempt-recorded'
    ? 'No provider attempt recorded.'
    : unknownUsage
      ? `${cost ? `Recorded estimate ${cost}; ` : ''}final usage is unknown.`
      : cost ? `Estimated API cost ${cost}.` : 'Estimated API cost unavailable.';
  const stamp = job.completedAt || job.startedAt;
  const date = stamp && Number.isFinite(Date.parse(stamp))
    ? new Date(stamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return {
    kind: job.status, message: messages[job.status], billing, date,
    edition: /^\d{4}-\d{2}-\d{2}$/.test(job.editionDate || '') ? job.editionDate : '',
    code: typeof job.code === 'string' ? job.code.slice(0, 128) : '',
    filename: job.status === 'complete' && typeof job.filename === 'string' ? job.filename : '',
    poll: data.active === true || job.status === 'running',
  };
}

function statusHtml(model) {
  if (!model) return '';
  const details = [model.edition ? `Requested edition ${model.edition}` : '', model.date, model.code ? `Status ${model.code}` : ''].filter(Boolean);
  return `<div class="brief-attempt-summary"><strong>Latest generation attempt</strong><p>${escapeHtml(model.message)}</p>
    ${model.billing ? `<p class="brief-attempt-billing">${escapeHtml(model.billing)}</p>` : ''}</div>
    <div class="brief-attempt-actions">
      ${model.filename ? `<a href="/briefing/${encodeURIComponent(model.filename)}">Open saved edition →</a>` : ''}
      ${model.kind === 'unavailable' ? '<a href="/settings#systemHealth">System health →</a><button type="button" class="btn-ghost-sm" data-refresh-generation>Retry status check</button>' : ''}
      ${details.length ? `<details><summary>Attempt details</summary><p>${details.map(escapeHtml).join(' · ')}</p></details>` : ''}
    </div>`;
}

export function mountGenerationStatus(host, { load = fetchGenerationStatus, isGenerating = () => false } = {}) {
  if (!host) return { refresh() {}, stop() {} };
  let stopped = false;
  let request = 0;
  let controller = null;
  let timer = null;
  let lastHtml = null;
  const paint = model => {
    const html = statusHtml(model);
    host.hidden = !html;
    host.dataset.state = model?.kind || '';
    // Polling must not collapse an open details disclosure or move focus.
    if (html !== lastHtml) { host.innerHTML = html; lastHtml = html; }
  };
  const refresh = async () => {
    if (stopped) return;
    const token = ++request;
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    try {
      const data = await load({ signal: controller.signal });
      if (stopped || token !== request) return;
      const model = generationStatusModel(data);
      paint(model);
      if (model?.poll || isGenerating()) timer = setTimeout(refresh, 10_000);
    } catch {
      if (stopped || token !== request) return;
      paint({ kind: 'unavailable', message: 'Latest generation status could not be checked. Retry the status check before starting another attempt.' });
    }
  };
  const click = event => { if (event.target.closest('[data-refresh-generation]')) refresh(); };
  host.addEventListener('click', click);
  return {
    refresh,
    stop() {
      stopped = true;
      request++;
      clearTimeout(timer);
      controller?.abort();
      host.removeEventListener('click', click);
    },
  };
}

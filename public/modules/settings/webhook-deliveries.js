import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';

const states = new Set(['pending', 'ambiguous', 'failed', 'paused']);
export function safeDeliveryList(value) {
  if (!Array.isArray(value?.items) || value.items.length > 100) throw new Error('Delivery review unavailable.');
  return value.items.map(item => {
    if (!/^[a-f0-9]{64}$/.test(item?.id || '') || !['alerts', 'brief'].includes(item.kind) || !states.has(item.state)
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('Delivery review unavailable.');
    return { id: item.id, kind: item.kind, state: item.state, attempts: item.attempts,
      createdAt: new Date(item.createdAt).toISOString(), canRetry: item.canRetry === true,
      errorCode: /^[A-Z0-9_]{1,64}$/.test(item.errorCode || '') ? item.errorCode : null };
  });
}

async function request(path, options = {}) {
  const res = await fetch('/api/webhook-deliveries' + path, { cache: 'no-store', signal: AbortSignal.timeout(15_000), ...options });
  const body = await res.json();
  if (!res.ok) {
    const messages = {
      E_OUTBOX_ACKNOWLEDGEMENT: 'Check the recipient and acknowledge duplicate risk before retrying.',
      E_OUTBOX_CONFLICT: 'Delivery state or destination changed. Refresh the list and check the original destination.',
      E_EXPOSED: 'Delivery review requires an authenticated connection.',
    };
    throw new Error(messages[body?.code] || 'Delivery review is unavailable. Queued work has been preserved.');
  }
  return body;
}

export function createWebhookReviewController({
  load = () => request(''),
  resolve = (id, action, acknowledgeDuplicateRisk) => request('/' + id + '/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, acknowledgeDuplicateRisk }),
  }),
  onChange = () => {},
} = {}) {
  let active = true, generation = 0;
  let state = { busy: false, items: [], feedback: '' };
  const publish = patch => { if (active) { state = { ...state, ...patch }; onChange(state); } };
  async function refresh() {
    if (!active || state.busy) return;
    const current = ++generation;
    publish({ busy: true, feedback: '' });
    try {
      const items = safeDeliveryList(await load());
      if (active && current === generation) publish({ items, busy: false, feedback: items.length ? '' : 'No queued deliveries need review.' });
    } catch { if (active && current === generation) publish({ busy: false, feedback: 'Delivery review unavailable. Check the connection and retry.' }); }
  }
  async function reconcile(id, action, acknowledgement = false) {
    if (!active || state.busy || !state.items.some(item => item.id === id)) return;
    if (action === 'retry' && acknowledgement !== true) {
      publish({ feedback: 'Check the recipient and acknowledge duplicate risk before retrying.' }); return;
    }
    const current = ++generation;
    publish({ busy: true, feedback: '' });
    try {
      await resolve(id, action, acknowledgement);
      const items = safeDeliveryList(await load());
      if (active && current === generation) publish({ busy: false, items,
        feedback: action === 'retry' ? 'Original delivery queued for a bounded retry. The recipient may receive a duplicate.'
          : action === 'delivered' ? 'Delivery marked delivered. Queue capacity restored.' : 'Delivery abandoned. Queue capacity restored.' });
    } catch {
      if (active && current === generation) publish({ busy: false, feedback: 'Resolution could not be confirmed. Refresh the list before trying again.' });
    }
  }
  return { refresh, reconcile, getState: () => state, dispose() { active = false; generation++; } };
}

export function mountWebhookDeliveryReview(container) {
  container.innerHTML = `<details class="profile-details"><summary>Review queued webhook deliveries</summary>
    <p class="settings-help">Check the receiving service using the delivery ID before resolving uncertain work. Mark delivered or abandon to free capacity. A deliberate retry keeps the original payload and ID and may duplicate a delivery already accepted. Restoring the original destination and event type is required for retry.</p>
    <button type="button" class="btn-ghost-sm" data-delivery-refresh>Load deliveries</button>
    <p data-delivery-feedback role="status" aria-live="polite"></p><div data-delivery-list></div></details>`;
  const refresh = container.querySelector('[data-delivery-refresh]');
  const feedback = container.querySelector('[data-delivery-feedback]');
  const list = container.querySelector('[data-delivery-list]');
  let renderedStates = new Map();
  const controller = createWebhookReviewController({ onChange(state) {
    const choices = new Map([...list.querySelectorAll('[data-delivery-id]')].map(row => [row.dataset.deliveryId, {
      action: row.querySelector('[data-delivery-action]').value, acknowledgement: row.querySelector('[data-delivery-ack]').checked,
    }]));
    refresh.disabled = state.busy; feedback.textContent = state.feedback;
    list.innerHTML = state.items.map(item => {
      const choice = renderedStates.get(item.id) === item.state ? choices.get(item.id) : null;
      const selected = action => choice?.action === action ? ' selected' : '';
      return `<div class="system-health-delivery" data-delivery-id="${item.id}">
      <p><strong>${item.kind === 'brief' ? 'Briefing' : 'Signal alerts'} · ${escapeHtml(item.state)}</strong> · ${item.attempts} attempts · ${escapeHtml(formatEventTime(item.createdAt) || item.createdAt)}</p>
      <p class="settings-help">Delivery ID <code>${item.id}</code>${item.errorCode ? ` · ${escapeHtml(item.errorCode)}` : ''}</p>
      <label>Resolution <select data-delivery-action><option value="delivered"${selected('delivered')}>Recipient confirms delivered</option><option value="abandon"${selected('abandon')}>Abandon delivery</option><option value="retry"${item.canRetry ? '' : ' disabled'}${selected('retry')}>Retry original delivery</option></select></label>
      <label><input type="checkbox" data-delivery-ack${choice?.acknowledgement ? ' checked' : ''}> I checked the recipient and accept duplicate risk if I retry.</label>
      <button type="button" class="btn-ghost-sm" data-delivery-resolve${state.busy ? ' disabled' : ''}>Apply resolution</button></div>`;
    }).join('');
    renderedStates = new Map(state.items.map(item => [item.id, item.state]));
    for (const element of list.querySelectorAll('select,input')) element.disabled = state.busy;
  } });
  const handleRefresh = () => { void controller.refresh(); };
  const handleResolve = event => {
    const button = event.target.closest('[data-delivery-resolve]');
    if (!button || !container.contains(button)) return;
    const row = button.closest('[data-delivery-id]');
    void controller.reconcile(row.dataset.deliveryId, row.querySelector('[data-delivery-action]').value,
      row.querySelector('[data-delivery-ack]').checked);
  };
  refresh.addEventListener('click', handleRefresh); list.addEventListener('click', handleResolve);
  return () => { controller.dispose(); refresh.removeEventListener('click', handleRefresh); list.removeEventListener('click', handleResolve); };
}

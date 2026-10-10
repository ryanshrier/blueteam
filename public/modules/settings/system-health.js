import { fetchDiagnostics } from '../core/api.js';
import { escapeHtml } from '../core/sanitize.js';
import { formatEventTime } from '../core/brief-date.js';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const FEED_REASONS = {
  'ok (stale)': 'Using cached data after a failed refresh',
  'circuit-open': 'Temporarily paused after repeated failures',
  'rate-limited': 'Rate limited by the source',
  'parse-error': 'Source response could not be read',
  failed: 'Source request failed',
};
const reachable = new Set(['ok', 'ok (cached)', 'empty']);
function feedReason(value) {
  if (Object.hasOwn(FEED_REASONS, value)) return value;
  if (typeof value === 'string' && /^http-[1-5]\d{2}$/.test(value)) return value;
  return reachable.has(value) ? null : 'unknown';
}

// Construct a new allowlisted object. Never spread an API payload into a report:
// feed keys, configuration errors, profile text, and arbitrary future fields can
// contain credentials or source URLs even when the endpoint itself is trusted.
export function sanitizeDiagnostics(data) {
  if (!data || !['ok', 'degraded'].includes(data.status)) throw new TypeError('Invalid diagnostics');
  const result = { status: data.status };
  if (typeof data.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|dev)(?:[.-]\d{1,4})?)?$/i.test(data.version)) result.version = data.version;
  if (number(data.uptime) !== null) result.uptimeSeconds = data.uptime;
  if (data.pipeline && typeof data.pipeline === 'object') result.pipeline = {
    lastRefreshAt: timestamp(data.pipeline.lastRun),
    ageSeconds: number(data.pipeline.ageSeconds),
    headlines: number(data.pipeline.headlines),
    stale: typeof data.pipeline.stale === 'boolean' ? data.pipeline.stale : null,
    lastAttemptFailed: data.pipeline.lastAttemptFailed === true,
  };
  if (data.feeds && typeof data.feeds === 'object') {
    const issueCounts = {};
    for (const value of Object.values(data.feeds.health || {})) {
      const reason = feedReason(value);
      if (reason) issueCounts[reason] = (issueCounts[reason] || 0) + 1;
    }
    result.feeds = {
      reachable: number(data.feeds.ok), total: number(data.feeds.total),
      configured: number(data.feeds.configured), fresh: number(data.feeds.fresh), issueCounts,
    };
  }
  if (Object.hasOwn(data, 'configReloadError')) result.configReloadRejected = Boolean(data.configReloadError);
  if (data.settings && typeof data.settings === 'object') result.settings = {
    status: ['ok', 'missing', 'error'].includes(data.settings.status) ? data.settings.status : 'unknown',
    operation: ['read', 'write'].includes(data.settings.operation) ? data.settings.operation : null,
  };
  if (data.configWatch && typeof data.configWatch === 'object') result.configWatch = {
    status: ['watching', 'stopped', 'error'].includes(data.configWatch.status) ? data.configWatch.status : 'unknown',
  };
  if (data.rankingBenchmark && typeof data.rankingBenchmark === 'object') result.rankingBenchmark = {
    enabled: data.rankingBenchmark.enabled === true,
    state: ['disabled', 'ready', 'capturing', 'captured', 'skipped', 'unavailable'].includes(data.rankingBenchmark.state) ? data.rankingBenchmark.state : 'unavailable',
    lastCaptureAt: timestamp(data.rankingBenchmark.lastCaptureAt),
  };
  if (data.webhookDelivery && typeof data.webhookDelivery === 'object') result.webhookDelivery = {
    status: ['ok', 'paused', 'error'].includes(data.webhookDelivery.status) ? data.webhookDelivery.status : 'unknown',
    ...Object.fromEntries(['pending', 'retrying', 'paused', 'failed', 'ambiguous', 'active']
      .map(key => [key, number(data.webhookDelivery[key])])),
  };
  if (data.database && typeof data.database === 'object') result.database = {
    sizeMb: number(data.database.size_mb),
    status: ['ok', 'growing', 'warning', 'missing', 'error'].includes(data.database.status) ? data.database.status : 'unknown',
  };
  if (data.briefingReadiness && typeof data.briefingReadiness === 'object') result.briefingReadiness = {
    status: ['ready', 'limited', 'blocked'].includes(data.briefingReadiness.status) ? data.briefingReadiness.status : 'unknown',
    usableHeadlines: number(data.briefingReadiness.usableHeadlines),
    substantiveSources: number(data.briefingReadiness.substantiveSources),
  };
  if (data.briefingDelivery && typeof data.briefingDelivery === 'object') result.briefingDelivery = {
    status: ['unknown', 'disabled', 'scheduled', 'running', 'published', 'awaiting-review', 'failed', 'missed', 'reconciliation-pending'].includes(data.briefingDelivery.status) ? data.briefingDelivery.status : 'unknown',
    needsAttention: data.briefingDelivery.needsAttention === true,
    nextAttemptAt: timestamp(data.briefingDelivery.nextAttemptAt),
    lastSuccessAt: timestamp(data.briefingDelivery.lastSuccessAt),
    draftAvailable: data.briefingDelivery.draftAvailable === true,
    attempts: number(data.briefingDelivery.attempts),
  };
  return result;
}

export function feedIssues(data) {
  return Object.entries(data?.feeds?.health || {}).flatMap(([name, value], index) => {
    const reason = feedReason(value);
    if (!reason) return [];
    // Labels help the local operator identify a source, but are never copied.
    // A URL or suspicious label is replaced, not partially redacted.
    let label = /^[\p{L}\p{N} .,&()'’_+\/-]{1,80}$/u.test(name) && !name.includes('://') ? name : `Source ${index + 1}`;
    if (/^https?:\/\//i.test(name)) {
      try { label = new URL(name).hostname; } catch { /* safe numbered identity */ }
    }
    return [{ label, reason: FEED_REASONS[reason] || (reason.startsWith('http-') ? `Source returned HTTP ${reason.slice(5)}` : 'Source status unavailable') }];
  });
}

export function groupFeedIssues(issues = []) {
  const groups = new Map();
  for (const issue of issues) {
    if (!groups.has(issue.reason)) groups.set(issue.reason, []);
    groups.get(issue.reason).push(issue.label);
  }
  return [...groups].map(([reason, sources]) => ({ reason, sources })).sort((a, b) => b.sources.length - a.sources.length);
}

export function createDiagnosticsController({
  load = fetchDiagnostics,
  writeClipboard = text => navigator.clipboard.writeText(text),
  now = () => new Date().toISOString(),
  onChange = () => {},
} = {}) {
  let active = true;
  let generation = 0;
  let copyGeneration = 0;
  let request = null;
  let state = { phase: 'loading', snapshot: null, issues: [], checkedAt: null, feedback: '' };
  const publish = patch => { state = { ...state, ...patch }; if (active) onChange(state); };
  async function refresh() {
    if (!active) return;
    const current = ++generation;
    request?.abort();
    request = new AbortController();
    publish({ phase: 'loading', feedback: '' });
    try {
      const data = await load({ signal: request.signal });
      if (!active || current !== generation) return;
      publish({ snapshot: sanitizeDiagnostics(data), issues: feedIssues(data), checkedAt: timestamp(now()),
        phase: data.status === 'ok' ? 'healthy' : 'degraded', feedback: '' });
    } catch {
      if (!active || current !== generation) return;
      publish({ phase: 'unavailable', feedback: '' });
    }
  }
  async function copy() {
    if (!active || !state.snapshot || state.phase === 'loading') return;
    const current = generation;
    const thisCopy = ++copyGeneration;
    const report = JSON.stringify({ application: 'BlueTeam.News', diagnosticsState: state.phase,
      lastSuccessfulCheckAt: state.checkedAt, ...state.snapshot }, null, 2);
    try {
      await writeClipboard(report);
      if (active && current === generation && thisCopy === copyGeneration) publish({ feedback: 'Sanitized diagnostics copied.' });
    } catch {
      if (active && current === generation && thisCopy === copyGeneration) publish({ feedback: 'Clipboard unavailable. Select and copy the sanitized report below.' });
    }
    if (!active || current !== generation || thisCopy !== copyGeneration) return;
    return report;
  }
  return { refresh, copy, getState: () => state, dispose() { active = false; generation++; request?.abort(); } };
}

function at(value) {
  return formatEventTime(value) || 'Not available';
}
function uptime(value) {
  if (value === undefined) return 'Not available';
  const minutes = Math.floor(value / 60);
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h ${minutes % 60}m`;
}

export function operationalNotices(d) {
  return [
    d.settings?.status === 'error' ? d.settings.operation === 'write'
      ? 'Settings could not be saved. Check storage permissions and free space, then retry the save.'
      : 'Saved settings could not be read or validated. Restore valid settings; unattended briefing generation is paused.' : '',
    d.configWatch?.status === 'error' ? 'Configuration watching stopped. Check file access and restart the server to restore automatic reloads.' : '',
    d.webhookDelivery?.retrying > 0 ? 'Webhook delivery failed and is queued for a bounded retry. Check the receiving service and server connectivity.' : '',
    d.webhookDelivery?.failed > 0 ? 'Some webhook deliveries stopped after rejection, expiry, or repeated failure. Check the destination and server logs before arranging another delivery.' : '',
    d.webhookDelivery?.ambiguous > 0 ? 'Webhook delivery confirmation is unavailable. Check the receiving service before arranging another delivery to avoid duplicates.' : '',
    d.webhookDelivery?.paused > 0 ? 'Queued webhook deliveries are paused. Check the original destination, enabled event types, and briefing publication status.' : '',
    d.webhookDelivery?.status === 'error' && !['retrying', 'failed', 'ambiguous'].some(key => d.webhookDelivery[key] > 0)
      ? 'Webhook delivery storage needs attention. Check database access and server logs.' : '',
  ].filter(Boolean);
}

export function mountSystemHealth(section) {
  if (!section) return () => {};
  section.innerHTML = `<div class="settings-section-heading"><h2 id="set-health">System health</h2><button class="btn-ghost-sm" id="refreshDiagnostics" type="button">Refresh diagnostics</button></div>
    <p class="settings-note">Check collection, storage, settings, and briefing delivery on this server.</p>
    <div id="systemHealthStatus" class="settings-status system-health-status" data-state="loading" role="status" aria-live="polite">Loading diagnostics…</div>
    <div id="systemHealthDetails"></div>
    <div class="system-health-actions"><button class="btn-ghost-sm" id="copyDiagnostics" type="button" disabled>Copy diagnostics</button></div>
    <details class="profile-details"><summary>About copied diagnostics</summary><p class="settings-help">Includes health counts, version, timing, and database size. Source names, URLs, secrets, organization settings, and raw error messages are excluded.</p></details>
    <p id="diagnosticsFeedback" class="settings-feedback" role="status" aria-live="polite"></p>
    <textarea id="diagnosticsCopyFallback" class="settings-input system-health-copy" readonly hidden aria-label="Sanitized diagnostics to copy"></textarea>`;
  const status = section.querySelector('#systemHealthStatus');
  const details = section.querySelector('#systemHealthDetails');
  const refresh = section.querySelector('#refreshDiagnostics');
  const copy = section.querySelector('#copyDiagnostics');
  const feedback = section.querySelector('#diagnosticsFeedback');
  const fallback = section.querySelector('#diagnosticsCopyFallback');
  const controller = createDiagnosticsController({ onChange(state) {
    status.dataset.state = state.phase;
    status.textContent = state.phase === 'loading' ? 'Loading diagnostics…'
      : state.phase === 'healthy' ? 'Server operations · Healthy'
        : state.phase === 'degraded' ? 'Degraded — server operations need attention.'
          : 'Diagnostics unavailable — check the server connection and retry.';
    refresh.disabled = state.phase === 'loading';
    copy.disabled = state.phase === 'loading' || !state.snapshot;
    feedback.textContent = state.feedback;
    fallback.hidden = true;
    const d = state.snapshot;
    if (!d) { details.innerHTML = ''; return; }
    const retained = ['unavailable', 'loading'].includes(state.phase);
    const age = d.pipeline?.ageSeconds;
    const ageLabel = typeof age === 'number' ? age < 60 ? 'Less than a minute ago' : age < 3600 ? `${Math.floor(age / 60)} min ago` : age < 86400 ? `${Math.floor(age / 3600)} hr ago` : `${Math.floor(age / 86400)} days ago` : '';
    const rows = [
      ['Sources reachable', d.feeds?.reachable !== null && d.feeds?.total !== null && d.feeds ? `${d.feeds.reachable} / ${d.feeds.total}` : 'Not available'],
      ['Fresh source observations', typeof d.feeds?.fresh === 'number' ? `${d.feeds.fresh} / ${d.feeds.configured ?? d.feeds.total ?? 'unknown'}` : 'Not available'],
      ['Collection age at check', ageLabel || 'Not available'], ['Uptime', uptime(d.uptimeSeconds)],
      ['Last collection', at(d.pipeline?.lastRefreshAt)], ['Version', d.version || 'Not available'],
    ];
    if (d.database) rows.push(['Database', `${d.database.sizeMb === null ? 'Size unavailable' : d.database.sizeMb + ' MB'} · ${d.database.status}`]);
    if (d.settings) rows.push(['Settings', d.settings.status]);
    if (d.configWatch) rows.push(['Configuration watching', d.configWatch.status]);
    if (d.rankingBenchmark?.enabled) rows.push(['Ranking evaluation capture', d.rankingBenchmark.state], ['Last ranking capture', at(d.rankingBenchmark.lastCaptureAt)]);
    if (d.webhookDelivery) rows.push(['Webhook delivery', `${d.webhookDelivery.status} · ${d.webhookDelivery.pending ?? 'unknown'} pending · ${d.webhookDelivery.paused ?? 'unknown'} paused · ${d.webhookDelivery.failed ?? 'unknown'} failed · ${d.webhookDelivery.ambiguous ?? 'unknown'} unconfirmed`]);
    if (d.briefingReadiness) rows.push(['Briefing evidence', `${d.briefingReadiness.status} · ${d.briefingReadiness.usableHeadlines ?? 'unknown'} usable headlines`]);
    if (d.briefingDelivery) rows.push(['Scheduled briefing', d.briefingDelivery.status], ['Next scheduled attempt', at(d.briefingDelivery.nextAttemptAt)], ['Last scheduled publication', at(d.briefingDelivery.lastSuccessAt)]);
    const notices = [
      ...operationalNotices(d),
      d.briefingReadiness?.status === 'limited' ? 'The current evidence supports a limited briefing. A small evidence set does not establish that no threats exist.' : '',
      d.briefingReadiness?.status === 'blocked' ? 'A new briefing needs fresh, substantive evidence and sufficient reachable source coverage. Refresh collection or inspect the Wire.' : '',
      d.briefingDelivery?.status === 'awaiting-review' ? 'The scheduled briefing is retained for review. Open Draft review in Briefings; no further generation is queued for that edition.' : '',
      ['failed', 'missed'].includes(d.briefingDelivery?.status) ? 'The scheduled briefing has not been published. Check generation status and the next attempt in Settings before retrying.' : '',
      d.briefingDelivery?.status === 'reconciliation-pending' ? 'A scheduled publication needs state reconciliation. Inspect the saved edition before generating again.' : '',
      d.pipeline?.lastAttemptFailed ? 'The last collection attempt failed. The previous successful collection is retained; check the collection logs and configuration before retrying.' : '',
      d.pipeline?.stale ? 'Collection is overdue. Check server connectivity and the collection logs.' : '',
      d.rankingBenchmark?.enabled && d.rankingBenchmark.state === 'unavailable' ? 'Ranking evaluation capture is unavailable. Collection can continue; inspect capture limits and storage before using these runs for evaluation.' : '',
      d.configReloadRejected ? 'The last configuration update was rejected. The previous configuration remains active; check server logs before editing again.' : '',
      d.database && ['warning', 'growing', 'missing', 'error'].includes(d.database.status)
        ? ['missing', 'error'].includes(d.database.status) ? 'Database access needs attention. Check server logs and storage permissions.' : 'Database storage is growing. Review retention and available disk space.' : '',
    ].filter(Boolean);
    const factRows = list => list.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    details.innerHTML = `<p class="system-health-checked${retained ? ' retained' : ''}">${retained ? 'Showing the last successful check from ' : 'Checked '}${escapeHtml(at(state.checkedAt))}</p>
      ${notices.length ? `<div class="system-health-attention"><ul>${notices.map(notice => `<li>${escapeHtml(notice)}</li>`).join('')}</ul></div>` : ''}
      <dl class="system-health-facts">${factRows(rows.slice(0, 3))}</dl>
      <details class="profile-details"><summary>Collection and storage details</summary><dl class="system-health-facts system-health-facts--secondary">${factRows(rows.slice(3))}</dl></details>
      ${!d.pipeline && !d.feeds && !d.database ? '<p class="system-health-notice"><strong>Limited diagnostics.</strong> Detailed diagnostics are not available to this client.</p>' : ''}
      ${state.issues.length ? `<div class="system-health-issues"><h3>${state.issues.length} ${state.issues.length === 1 ? 'source needs' : 'sources need'} attention</h3>${groupFeedIssues(state.issues).map(group => `<details${group.sources.length <= 3 ? ' open' : ''}><summary>${group.sources.length} · ${escapeHtml(group.reason)}</summary><ul>${group.sources.map(source => `<li>${escapeHtml(source)}</li>`).join('')}</ul></details>`).join('')}<p class="settings-help">When many sources fail together, inspect server connectivity, proxy configuration, and logs at the collection time. For isolated failures, check that source’s URL and response status. Cached availability does not mean the source was reached.</p><a href="https://github.com/ryanshrier/blueteam/blob/main/docs/operations.md#network-behavior" target="_blank" rel="noopener noreferrer">Collection troubleshooting and network behavior</a></div>` : ''}`;
  } });
  const handleRefresh = () => { void controller.refresh(); };
  const handleCopy = async () => {
    const report = await controller.copy();
    if (section.isConnected && report && controller.getState().feedback.startsWith('Clipboard unavailable')) {
      fallback.value = report; fallback.hidden = false; fallback.focus(); fallback.select();
    }
  };
  refresh.addEventListener('click', handleRefresh);
  copy.addEventListener('click', handleCopy);
  void controller.refresh();
  return () => { controller.dispose(); refresh.removeEventListener('click', handleRefresh); copy.removeEventListener('click', handleCopy); };
}

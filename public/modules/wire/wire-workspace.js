import { escapeHtml } from '../core/sanitize.js';
import { sigKey, signalUrl, parseCveData } from './wire-format.js';
import { renderAssessmentMeta } from '../core/assessment-meta.js';
import { formatEventTime } from '../core/brief-date.js';
import { signalSeverity } from '../core/signal-facts.js';
export { signalSeverity } from '../core/signal-facts.js';
import { decisionEvidence, decisionReviewState } from './decision-evidence.js';
export { decisionEvidence, decisionReviewState } from './decision-evidence.js';

export function signalAssessmentMeta(headline = {}, compact = false) {
  const severity = signalSeverity(headline);
  const sources = [{ label: headline.source || 'Unknown publisher', href: headline.link }];
  for (const source of Array.isArray(headline.evidence) ? headline.evidence : []) {
    if (!sources.some(item => item.href && item.href === source.canonicalUrl)) sources.push({ label: source.source || 'Retained source', href: source.canonicalUrl });
  }
  if (severity.scope) sources.push({ label: `NVD · ${severity.scope}`, href: `https://nvd.nist.gov/vuln/detail/${severity.scope}` });
  const dateTime = !headline.dateUnknown && headline.date && Number.isFinite(Date.parse(headline.date)) ? new Date(headline.date).toISOString() : '';
  return renderAssessmentMeta({ sources, compact,
    time: { label: 'Published', value: dateTime ? formatEventTime(dateTime) : 'Not available', dateTime },
    severity: { ...severity, value: `${severity.value}${severity.scope ? ` · ${severity.scope} (NVD lookup)` : ''}` },
    certainty: { label: 'Assessment confidence', value: 'Not assessed' } });
}

export const DECISION_STATES = Object.freeze({ unreviewed: 'Not assessed', investigate: 'Investigating', affected: 'Affected', unaffected: 'Not affected', mitigated: 'Mitigated' });
export const DECISION_STORAGE_KEY = 'wire.decisions.v1';
export const DECISION_LIMIT = 2000;

export function normalizeDecision(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const text = (key, cap) => typeof value[key] === 'string' ? value[key].trim().slice(0, cap) : '';
  return { state: Object.hasOwn(DECISION_STATES, value.state) ? value.state : 'unreviewed',
    owner: text('owner', 100), nextReview: /^\d{4}-\d{2}-\d{2}$/.test(value.nextReview || '') ? value.nextReview : '',
    note: text('note', 2000), evidence: text('evidence', 6000), recordedAt: text('recordedAt', 40),
    ...(Array.isArray(value.evidenceBinding) ? { evidenceBinding: decisionEvidence({ evidence: value.evidenceBinding }) } : {}) };
}

export function readDecisions(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(DECISION_STORAGE_KEY) || '{}');
    return new Map(Object.entries(parsed).filter(([key, value]) => key && value && typeof value === 'object').map(([key, value]) => [key, normalizeDecision(value)]));
  } catch { return new Map(); }
}

// Merge against storage at the point of use: another tab may have saved while
// this view was unmounted. Keep newer session-only records after a failed write.
export function mergeDecisions(current, storage) {
  const merged = new Map(current);
  for (const [key, value] of readDecisions(storage)) {
    if (!merged.has(key) || (value.recordedAt || '') >= (merged.get(key).recordedAt || '')) merged.set(key, value);
  }
  return merged;
}

export function saveDecisionRecord(storage, current, key, value, expected = current.get(key) || null) {
  const merged = mergeDecisions(current, storage);
  const existing = merged.get(key) || null;
  const signature = record => record ? JSON.stringify(normalizeDecision(record)) : null;
  if (signature(existing) !== signature(expected)) {
    return { decisions: merged, persisted: false, conflict: true, existing };
  }
  // Assessments are authored records, not an LRU cache. Never make room by
  // silently deleting another investigation, including one still unresolved.
  if (!existing && merged.size >= DECISION_LIMIT) {
    return { decisions: merged, persisted: false, limitReached: true };
  }
  merged.delete(key);
  merged.set(key, normalizeDecision(value));
  let persisted = false;
  try { storage.setItem(DECISION_STORAGE_KEY, JSON.stringify(Object.fromEntries(merged))); persisted = true; } catch { /* preserve the session copy */ }
  return { decisions: merged, persisted };
}

export function exportDecisionRecords(decisions, { origin = '', capturedAt = new Date().toISOString() } = {}) {
  return [...decisions].map(([key, value]) => ({ signal: key,
    signalUrl: signalUrl({ link: key }, origin), exportedAt: capturedAt, decision: normalizeDecision(value) }));
}

// Import is additive. Divergent local decisions are left intact for the user to
// reconcile using the exported record; timestamps alone do not resolve intent.
export function importDecisionRecords(storage, current, records) {
  if (!Array.isArray(records) || records.length > 2000) throw new Error('Expected a decisions export containing at most 2,000 records');
  const decisions = mergeDecisions(current, storage);
  let imported = 0, conflicts = 0, invalid = 0, unchanged = 0;
  for (const record of records) {
    const value = record?.decision;
    if (typeof record?.signal !== 'string' || !record.signal.trim() || record.signal.length > 8192 ||
        !value || typeof value !== 'object' || !Object.hasOwn(DECISION_STATES, value.state) ||
        typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) { invalid++; continue; }
    const normalized = normalizeDecision(value);
    const existing = decisions.get(record.signal);
    if (existing) {
      if (JSON.stringify(normalizeDecision(existing)) === JSON.stringify(normalized)) unchanged++;
      else conflicts++;
    } else if (decisions.size >= 2000) invalid++;
    else { decisions.set(record.signal, normalized); imported++; }
  }
  let persisted = imported === 0;
  if (imported) {
    try { storage.setItem(DECISION_STORAGE_KEY, JSON.stringify(Object.fromEntries(decisions))); persisted = true; } catch { /* session remains usable */ }
  }
  return { decisions, imported, conflicts, invalid, unchanged, persisted };
}

export function decisionLabel(headline, value) {
  const d = normalizeDecision(value);
  const review = decisionReviewState(headline, d);
  return `${review.needsReview ? 'Previous assessment' : 'Your assessment'}: ${DECISION_STATES[d.state]}${review.needsReview ? ` · ${review.reasons.join('; ')}; review needed` : ''}`;
}

export function decisionForm(headline, value = {}, { conflict = null, limitReached = false, limitMessage = '', saving = false, saveError = '', record = value, serverPhase = 'ready' } = {}) {
  const d = normalizeDecision(value);
  const review = decisionReviewState(headline, d);
  return `<details class="wire-outcome"${d.state !== 'unreviewed' || d.note || conflict || limitReached ? ' open' : ''}><summary>Decision record · ${escapeHtml(DECISION_STATES[d.state])}${review.needsReview ? ' · Review needed' : ''}</summary>
    <p class="wire-retention-note">${record?.localOnly ? 'Original browser record · not yet saved on this server. Copy browser records above, or save this assessment to the server.' : `Operator assessment, saved on this server. The shared server records revisions without identifying an individual author.${serverPhase !== 'ready' ? ' Server status is unavailable; displayed values may be cached.' : ''}`}</p>
    <p class="wire-retention-note">Unsaved drafts stay in this tab across reloads when browser storage is available. Export your draft before closing the tab.</p>
    ${review.needsReview ? `<p class="wire-retention-note">${escapeHtml(review.reasons.join('; '))}. The previous assessment is preserved. Save after reviewing to associate it with the evidence currently shown.</p>` : ''}
    <form data-decision-form="${escapeHtml(sigKey(headline))}"${saving ? ' inert aria-busy="true"' : ''}>
      <label>Assessment<select name="state">${Object.entries(DECISION_STATES).map(([key, label]) => `<option value="${key}"${d.state === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Owner<input name="owner" maxlength="100" value="${escapeHtml(d.owner)}" autocomplete="off"></label>
      <label class="wire-outcome-note">Next review<input name="nextReview" type="date" value="${escapeHtml(d.nextReview)}"></label>
      <label class="wire-outcome-note">Basis / local evidence<textarea name="note" maxlength="2000" rows="3" placeholder="What was checked, where, and the result">${escapeHtml(d.note)}</textarea></label>
      <label class="wire-outcome-note">Evidence or revision link<input name="evidence" maxlength="6000" value="${escapeHtml(d.evidence)}" placeholder="Paste the exact evidence link or local reference"></label>
      ${conflict ? `<div class="wire-outcome-note" role="alert"><p>A newer decision is saved on the server. Your edits remain here. Review the saved assessment and merge any changes before replacing it.</p><details open><summary>Latest saved decision · ${escapeHtml(DECISION_STATES[conflict.state])} · Revision ${Number(conflict.revision) || 'unknown'}</summary><p>Owner: ${escapeHtml(conflict.owner || 'Unassigned')} · Review: ${escapeHtml(conflict.nextReview || 'Not set')}</p><p>${escapeHtml(conflict.note || 'No basis recorded')}</p><p>${escapeHtml(conflict.evidence || '')}</p></details><button type="button" class="btn-ghost-sm" data-decision-rebase>I reviewed the latest decision; keep my edits</button></div>` : ''}
      ${limitReached ? `<div class="wire-outcome-note" role="alert"><p>${escapeHtml(limitMessage || 'Decision capacity reached.')} No saved assessment was removed. Your draft remains available; export it before clearing browser data.</p><button type="button" class="btn-ghost-sm" data-decision-export-all>Export all saved decisions (JSON)</button></div>` : ''}
      ${saveError ? `<p class="wire-outcome-note" role="alert">${escapeHtml(saveError)} Your draft is retained. Retry the same save to check an uncertain result.</p>` : ''}
      <div class="wire-decision-save"><button type="submit" class="btn-primary"${conflict ? ' disabled' : ''}>Save decision</button><button type="button" class="btn-ghost-sm" data-decision-draft-export>Export my draft (JSON)</button>${record?.serverId ? '<button type="button" class="btn-ghost-sm" data-decision-history>History and evidence</button>' : ''}<span class="wire-decision-status" role="status">${record?.revision ? `Revision ${record.revision} · ` : ''}${d.recordedAt ? `Recorded ${escapeHtml(formatEventTime(d.recordedAt) || d.recordedAt)}` : ''}</span></div>
    </form></details>`;
}

// The same signal has inline and adjacent forms across the responsive breakpoint.
// Keep their values synchronized without replacing the editor or moving focus.
export function reflectDecisionDraft(forms, key, values, origin) {
  for (const form of forms) {
    if (form === origin || form.dataset.decisionForm !== key) continue;
    for (const [name, value] of Object.entries(values)) {
      const field = form.elements.namedItem(name);
      if (field && field.value !== value) field.value = value;
    }
  }
}

export function filterChips(filters, sort, tiers = {}) {
  const chips = [];
  if (filters.signal) chips.push({ key: 'signal', label: 'Linked signal' });
  if (filters.cluster) chips.push({ key: 'cluster', label: `Group: ${filters.cluster.slice(filters.cluster.indexOf(':') + 1)}` });
  if (filters.horizon !== 'all' && filters.horizon) chips.push({ key: 'horizon', label: tiers[filters.horizon] || `Tier ${filters.horizon}` });
  for (const [key, label] of Object.entries({ critical: 'Critical urgency', kev: 'KEV', unread: 'Unread', watch: 'Watch match', changed: 'Retained source changed', alert: 'Alert match', hidden: 'Hidden' })) {
    if (filters[key]) chips.push({ key, label });
  }
  if (filters.q) chips.push({ key: 'q', label: `Search: ${filters.q}` });
  if (sort === 'newest') chips.push({ key: 'sort', label: 'Newest first' });
  return chips;
}

export function scanIdentity(headline) {
  const records = Array.isArray(headline.kevRecords) ? headline.kevRecords : [];
  const cves = [...new Set([...records.map(record => record.cve), headline.kevCVE,
    ...(`${headline.title || ''} ${headline.description || ''} ${headline.cveData || ''}`.match(/CVE-\d{4}-\d{4,7}/gi) || [])].filter(Boolean))];
  const products = [...new Set(records.map(record => record.product).filter(Boolean))];
  const hasProductAssessment = headline.editorialContext && Object.hasOwn(headline.editorialContext, 'product');
  const product = products.length > 2 ? `${products.slice(0, 2).join(' · ')} +${products.length - 2} products`
    : hasProductAssessment ? headline.editorialContext.product || ''
      : products.join(', ') || parseCveData(headline.cveData).affects || '';
  const vendors = (headline.vendors || []).map(v => typeof v === 'string' ? v : v?.name).filter(Boolean).join(', ');
  return { cves, product: product || (hasProductAssessment ? '' : vendors) };
}

export function scanFacts(headline) {
  const identity = scanIdentity(headline);
  const severity = signalSeverity(headline);
  // Keep the scored vulnerability visible and attach its score to that ID.
  // A report without a named CVE does not need a CVSS placeholder in the index.
  const cves = [...new Set([severity.scope, ...identity.cves].filter(Boolean))];
  return { product: identity.product, cves: cves.slice(0, 2), remainingCves: Math.max(0, cves.length - 2), severity };
}

export function exportContext(headline, { read = false, decision = {}, filters = {}, sort = 'relevance', capturedAt = '', origin = '' } = {}) {
  return { ...headline, read, signalUrl: signalUrl(headline, origin), exportedAt: capturedAt,
    filterDefinition: JSON.stringify({ ...filters, sort }),
    watchReasons: headline.applicability?.matches || [], retainedSourceChanged: Boolean(headline.evidence?.some(source => source.changed)),
    evidenceLinks: (headline.evidence || []).map(source => `${signalUrl(headline, origin)}&source=${encodeURIComponent(source.sourceId || '')}&revision=${encodeURIComponent(source.revisionId || '')}`),
    decision: normalizeDecision(decision), decisionReview: decisionReviewState(headline, decision) };
}

export function captureScrollAnchor(list, viewportTop = 0) {
  const row = [...(list?.querySelectorAll?.('.wire-item') || [])].find(item => item.getBoundingClientRect().bottom > viewportTop);
  return row ? { key: row.dataset.key, top: row.getBoundingClientRect().top } : null;
}

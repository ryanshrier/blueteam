import { escapeHtml } from '../core/sanitize.js';
import { sigKey, signalUrl, parseCveData } from './wire-format.js';
import { renderAssessmentMeta } from '../core/assessment-meta.js';
import { formatEventTime } from '../core/brief-date.js';

// CVSS belongs to a named vulnerability, not to the report as a whole. Match
// within each CVE entry so a later entry's score cannot attach to the first CVE.
export function signalSeverity(headline = {}) {
  const raw = Array.isArray(headline.cveDetails) ? headline.cveDetails.filter(value => typeof value === 'string').join(' · ')
    : typeof headline.cveData === 'string' ? headline.cveData : '';
  const entries = raw.match(/CVE-\d{4}-\d{4,7}[^]*?(?=CVE-\d{4}-\d{4,7}|$)/gi) || [];
  const scores = entries.flatMap(entry => {
    const match = entry.match(/^(CVE-\d{4}-\d{4,7})[^]*?CVSS\s+(?:(?:[234]\.\d)\s+)?(\d+(?:\.\d+)?)\s*(?:\((critical|high|medium|low|none)\))?/i);
    if (!match || Number(match[2]) > 10) return [];
    return [{ cve: match[1].toUpperCase(), score: Number(match[2]), band: match[3]?.toLowerCase() || '' }];
  }).sort((a, b) => b.score - a.score);
  if (!scores.length) return { label: 'CVSS severity', value: 'Not available', scope: '' };
  const highest = scores[0];
  const severity = highest.band ? `${highest.band[0].toUpperCase()}${highest.band.slice(1)}` : '';
  return { label: scores.length > 1 ? 'Highest CVSS severity' : 'CVSS severity',
    value: `${highest.score.toFixed(1)}${severity ? ` ${severity}` : ''}`, scope: highest.cve,
    level: ['critical', 'high'].includes(highest.band) ? highest.band : undefined };
}

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
    severity: { ...severity, value: `${severity.value}${severity.scope ? ` · ${severity.scope} (NVD)` : ''}` },
    certainty: { label: 'Assessment confidence', value: 'Not assessed' } });
}

export const DECISION_STATES = Object.freeze({ unreviewed: 'Not assessed', investigate: 'Investigating', affected: 'Affected', unaffected: 'Not affected', mitigated: 'Mitigated' });
export const DECISION_STORAGE_KEY = 'wire.decisions.v1';

export function normalizeDecision(value = {}) {
  const text = (key, cap) => typeof value[key] === 'string' ? value[key].trim().slice(0, cap) : '';
  return { state: Object.hasOwn(DECISION_STATES, value.state) ? value.state : 'unreviewed',
    owner: text('owner', 100), nextReview: /^\d{4}-\d{2}-\d{2}$/.test(value.nextReview || '') ? value.nextReview : '',
    note: text('note', 2000), evidence: text('evidence', 6000), recordedAt: text('recordedAt', 40) };
}

export function readDecisions(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(DECISION_STORAGE_KEY) || '{}');
    return new Map(Object.entries(parsed).filter(([key, value]) => key && value && typeof value === 'object').slice(-2000).map(([key, value]) => [key, normalizeDecision(value)]));
  } catch { return new Map(); }
}

export function decisionForm(headline, value = {}) {
  const d = normalizeDecision(value);
  return `<details class="wire-outcome"${d.state !== 'unreviewed' || d.note ? ' open' : ''}><summary>Decision record · ${escapeHtml(DECISION_STATES[d.state])}</summary>
    <p class="wire-retention-note">Your assessment, saved in this browser. It is separate from source reporting and is not shared with your team. Export it for handoff.</p>
    <form data-decision-form="${escapeHtml(sigKey(headline))}">
      <label>Assessment<select name="state">${Object.entries(DECISION_STATES).map(([key, label]) => `<option value="${key}"${d.state === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Owner<input name="owner" maxlength="100" value="${escapeHtml(d.owner)}" autocomplete="off"></label>
      <label class="wire-outcome-note">Next review<input name="nextReview" type="date" value="${escapeHtml(d.nextReview)}"></label>
      <label class="wire-outcome-note">Basis / local evidence<textarea name="note" maxlength="2000" rows="3" placeholder="What was checked, where, and the result">${escapeHtml(d.note)}</textarea></label>
      <label class="wire-outcome-note">Evidence or revision link<input name="evidence" maxlength="6000" value="${escapeHtml(d.evidence)}" placeholder="Paste the exact evidence link or local reference"></label>
      <div class="wire-decision-save"><button type="submit" class="btn-primary">Save decision</button><span class="wire-decision-status" role="status">${d.recordedAt ? `Saved ${escapeHtml(formatEventTime(d.recordedAt) || d.recordedAt)}` : ''}</span></div>
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
    decision: normalizeDecision(decision) };
}

export function captureScrollAnchor(list, viewportTop = 0) {
  const row = [...(list?.querySelectorAll?.('.wire-item') || [])].find(item => item.getBoundingClientRect().bottom > viewportTop);
  return row ? { key: row.dataset.key, top: row.getBoundingClientRect().top } : null;
}

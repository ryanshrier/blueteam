// Retained source evidence is separate from scoring, enrichment and analyst judgment.
import { escapeHtml } from '../core/sanitize.js';
import * as api from '../core/api.js';
import { formatEventTime } from '../core/brief-date.js';
import { sigKey, signalUrl } from './wire-format.js';
import { showToast } from '../core/toast.js';
import { signalAssessmentMeta } from './wire-workspace.js';

let current = null;
let requestId = 0;
const rememberedSources = new Map();

export function getEvidenceTabbables(dialog) {
  const firstSummary = details => [...details.children].find(child => child.tagName === 'SUMMARY');
  const controls = [...dialog.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
    .filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
      if (!element.getClientRects().length) return false;
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (element.tagName === 'SUMMARY' && !element.hasAttribute('tabindex')
        && (element.parentElement?.tagName !== 'DETAILS' || firstSummary(element.parentElement) !== element)) return false;
      // Chromium can report a nonempty rect for a nested summary hidden by a
      // closed ancestor. Only that ancestor's first summary subtree is exposed.
      for (let parent = element.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open) {
          const summary = firstSummary(parent);
          if (!summary || (summary !== element && !summary.contains(element))) return false;
        }
      }
      return true;
    });
  // Match the native sequential order if a future control uses positive tabindex.
  return controls.sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

export function trapEvidenceTab(event, dialog, activeElement = document.activeElement) {
  if (event.key !== 'Tab') return;
  const controls = getEvidenceTabbables(dialog);
  const index = controls.indexOf(activeElement);
  if (!controls.length) {
    event.preventDefault();
    dialog.focus();
  } else if (index < 0 || (!event.shiftKey && index === controls.length - 1) || (event.shiftKey && index === 0)) {
    event.preventDefault();
    controls[event.shiftKey ? controls.length - 1 : 0].focus();
  }
}

function time(value) {
  return formatEventTime(value) || 'Unknown';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function renderEvidenceContext(headline) {
  const applicability = headline?.applicability;
  const changed = headline?.evidence?.some(item => item.changed);
  const matched = applicability?.state === 'declared-match';
  const kind = headline?.evidence?.find(source => source.changed)?.changeKind || headline?.editorialContext?.changeKind;
  const reason = [changed ? kind === 'capture-expanded' ? 'More source context retained' : 'Retained source changed' : '', matched ? 'Watch profile match' : headline?.applicability?.questionMatches?.length ? 'Intelligence question match' : ''].filter(Boolean).join(' · ');
  return `${reason ? `<p class="wire-attention">${escapeHtml(reason)}</p>` : ''}`;
}

export function renderApplicability(applicability) {
  if (!applicability) return '<p>Exposure unknown. Configure a watch profile in <a href="/settings">Settings</a> to identify declared relevance.</p>';
  return `<p>${escapeHtml(applicability.explanation || 'Exposure unknown; check local applicability.')}</p>
    ${applicability.matches?.length ? `<ul>${applicability.matches.map(match => `<li>${escapeHtml(match.term)} · ${escapeHtml(match.field)} · literal match in ${escapeHtml((match.in || []).join(', '))}</li>`).join('')}</ul>` : ''}
    ${applicability.questionMatches?.length ? `<p>Questions connected to this reporting:</p><ul>${applicability.questionMatches.map(match => `<li>${escapeHtml(typeof match === 'string' ? match : match.term || match.question || '')}</li>`).join('')}</ul><p>A question match identifies material to review; it does not establish an answer or local exposure.</p>` : ''}
    <p>Declared context is not an inventory check. Local exposure and mitigation remain unverified.</p>`;
}

export function describeEvidenceChange(revision, previous) {
  if (revision.changeKind === 'capture-expanded') return 'More source context retained';
  if (revision.changeKind === 'capture-shortened') return 'Less source context retained';
  const changes = revision.changes;
  if (changes?.added && changes?.removed) return 'Retained wording changed';
  if (changes?.added) return 'Additional text retained';
  if (changes?.removed) return 'Text removed from the retained excerpt';
  if (!revision.changed) return '';
  if (previous && revision.title !== previous.title) return 'Source title changed; excerpt unchanged';
  if (previous && revision.passageTruncated !== previous.passageTruncated) return 'Retention detail changed; excerpt unchanged';
  return 'Retained observation changed; excerpt unchanged';
}

export function renderEvidenceSources(evidence) {
  return evidence.map((source, index) => `<button type="button" class="evidence-source-choice" data-evidence-source="${index}" aria-pressed="${index === 0}"><strong>${escapeHtml(source.source || 'Unknown publisher')}</strong><span>${escapeHtml(source.title || source.canonicalUrl || 'Source')}</span><small>${source.publishedAt ? 'Published' : 'Captured'} ${escapeHtml(time(source.publishedAt || source.retrievedAt))}${source.changed ? source.changeKind === 'capture-expanded' ? ' · More source context retained' : ' · Retained source changed' : ''}</small></button>`).join('');
}

export function renderEvidenceTimeline(record, revision) {
  if (!revision) return '';
  const revisions = Array.isArray(record?.revisions) ? record.revisions : [];
  const events = [
    { label: 'Published', value: revision.publishedAt, note: 'Publication time supplied by this source observation.' },
    { label: 'Publisher updated', value: revision.sourceUpdatedAt, note: 'Update time supplied by this source observation.' },
    { label: 'Captured', value: revision.retrievedAt, note: 'When this source excerpt was retrieved.' },
    ...revisions.map(item => ({ label: item.changed ? describeEvidenceChange(item, revisions.find(other => other.revisionId === item.previousRevisionId)) : 'Retained observation', value: item.firstObservedAt,
      note: `${item.revisionId === revision.revisionId ? 'Reference revision' : 'Retained revision'} · ${item.revisionId || 'Identifier unavailable'}` })),
  ];
  const valid = value => Boolean(value) && Number.isFinite(Date.parse(value));
  events.sort((a, b) => (valid(a.value) ? Date.parse(a.value) : Infinity) - (valid(b.value) ? Date.parse(b.value) : Infinity));
  return `<details class="evidence-timeline"><summary>Source observation timeline</summary>
    <p class="evidence-meta">Publisher and capture times refer to revision ${escapeHtml(revision.revisionId || 'unknown')}; observation entries cover retained history. A retained change does not establish a new threat event.</p>
    <ol>${events.map(event => `<li><time${valid(event.value) ? ` datetime="${escapeHtml(new Date(event.value).toISOString())}"` : ''}>${escapeHtml(valid(event.value) ? time(event.value) : 'Time unknown')}</time><div><strong>${escapeHtml(event.label)}</strong><span>${escapeHtml(event.note)}</span></div></li>`).join('')}</ol>
  </details>`;
}

// Only literal identifiers in this retained observation form report edges.
// Feed clusters, heuristic tags and source counts cannot establish relationships.
export function renderEvidenceRelationships(record, revision) {
  if (!revision) return '';
  const cves = [...new Set((`${revision.title || ''} ${revision.passage || ''}`.match(/\bCVE-\d{4}-\d{4,7}\b/gi) || []).map(value => value.toUpperCase()))];
  const url = safeUrl(record?.canonicalUrl);
  const title = escapeHtml(revision.title || 'Retained report');
  return `<details class="evidence-relationships"><summary>Source and report relationships</summary>
    ${cves.length ? `<ol class="evidence-relationship-path"><li><span class="evidence-node-label">Source</span><strong>${escapeHtml(revision.source || record?.source || 'Unknown publisher')}</strong></li><li class="evidence-edge"><span>Publishes →</span></li><li><span class="evidence-node-label">Report</span>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<strong>${title}</strong>`}</li><li class="evidence-edge"><span>Mentions →</span></li><li><span class="evidence-node-label">Named identifiers</span>${cves.map(cve => `<span class="evidence-related-cve">${escapeHtml(cve)}</span>`).join('')}</li></ol><p class="evidence-meta">Basis: literal CVE references in this retained title or excerpt. Mention does not establish affected products, attribution, or a causal relationship.</p>` : '<p class="evidence-meta">No CVE references are retained in this title or excerpt. No relationship diagram is inferred from topic grouping or publisher counts.</p>'}
  </details>`;
}

export function renderEvidenceRecord(record, selectedRevisionId, { changesOnly = false } = {}) {
  const revisions = Array.isArray(record?.revisions) ? record.revisions : [];
  const selected = revisions.find(revision => revision.revisionId === selectedRevisionId);
  const ordered = selected ? [selected, ...revisions.filter(revision => revision !== selected)] : revisions;
  const url = safeUrl(record?.canonicalUrl);
  return `<p class="evidence-source-link">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open original source <span>${escapeHtml(new URL(url).hostname)} ↗</span></a>` : '<span class="evidence-notice">Original source URL unavailable.</span>'}</p>
    ${selectedRevisionId && !selected ? '<p class="evidence-notice" role="status">The revision attached to this feed snapshot is no longer retained. The available observations below may be newer.</p>' : ''}
    ${ordered.length ? ordered.map((revision, index) => {
      const changes = revision.changes;
      const changed = changes && (changes.removed || changes.added);
      const publisher = revision.source || record.source || 'Unknown publisher';
      const passageKind = revision.passageKind === 'title-only' ? 'Source title only; no excerpt available.' : 'Source reporting · retained feed excerpt; not the full article.';
      const passage = (text, label = '') => `<figure class="evidence-quotation">${label ? `<h5>${label}</h5>` : ''}<blockquote class="evidence-passage">${text}</blockquote><figcaption>${escapeHtml(publisher)} · ${escapeHtml(passageKind)}</figcaption></figure>`;
      const previous = revisions.find(item => item.revisionId === revision.previousRevisionId);
      const changeSummary = describeEvidenceChange(revision, previous);
      const changeBlocks = changed ? `<section class="evidence-changes" aria-label="Passage changes"><p class="evidence-change-summary">${escapeHtml(changeSummary)}</p><div class="evidence-diff">
        ${passage(`${changesOnly ? '' : escapeHtml(changes.before || '')}${changes.added ? `<ins aria-label="Added text">${escapeHtml(changes.added)}</ins>` : changesOnly ? 'No added text' : ''}${changesOnly ? '' : escapeHtml(changes.after || '')}`, 'Current · added text')}
        ${passage(`${changesOnly ? '' : escapeHtml(changes.before || '')}${changes.removed ? `<del aria-label="Removed text">${escapeHtml(changes.removed)}</del>` : changesOnly ? 'No removed text' : ''}${changesOnly ? '' : escapeHtml(changes.after || '')}`, 'Previous · removed text')}
      </div></section>` : passage(escapeHtml(revision.passage || 'No source passage retained.'));
      return `<details class="evidence-revision" data-evidence-revision="${escapeHtml(revision.revisionId)}"${revision.revisionId === selectedRevisionId || (!selected && index === 0) ? ' open' : ''}>
        <summary><span>${revision.revisionId === selectedRevisionId ? 'Selected source revision' : revision === revisions[0] ? 'Latest retained revision' : 'Earlier retained revision'}</span><time>${escapeHtml(time(revision.firstObservedAt))}</time></summary>
        ${revision.passageTruncated ? '<p class="evidence-notice">Excerpt was clipped at the retention limit.</p>' : ''}
        ${changeBlocks}
        <div class="evidence-revision-actions"><button type="button" data-copy-evidence-revision="${escapeHtml(revision.revisionId)}">Copy evidence link</button><button type="button" data-copy-citation="${escapeHtml(revision.revisionId)}">Copy citation and excerpt</button></div>
        ${changed && changesOnly ? '<p class="evidence-meta">Unchanged context omitted here. Observation details contains both complete retained excerpts.</p>' : ''}
        ${!changed && revision.changed ? (revision.previousPassage == null ? '<p class="evidence-notice">The preceding observation is no longer retained; its passage comparison is unavailable.</p>' : `<p class="evidence-meta">${escapeHtml(changeSummary)}.</p>`) : ''}
        <details class="evidence-observation"><summary>Observation details</summary>
          <h4>${escapeHtml(revision.title || 'Untitled source')}</h4>
          ${revision.feedUrl ? `<p class="evidence-meta">Collected from ${escapeHtml(revision.feedUrl)}</p>` : ''}
          <dl class="evidence-times"><dt>Published</dt><dd>${escapeHtml(time(revision.publishedAt))}</dd><dt>Source updated</dt><dd>${escapeHtml(time(revision.sourceUpdatedAt))}</dd><dt>Retrieved</dt><dd>${escapeHtml(time(revision.retrievedAt))}</dd><dt>First observed</dt><dd>${escapeHtml(time(record?.firstObservedAt))}</dd><dt>Last observed</dt><dd>${escapeHtml(time(record?.lastObservedAt))}</dd></dl>
          <p class="evidence-id">Revision ${escapeHtml(revision.revisionId)}</p>
          ${changed ? `<h5>Current full excerpt</h5><blockquote class="evidence-passage">${escapeHtml(revision.passage || '')}</blockquote><h5>Previous full excerpt</h5><blockquote class="evidence-passage">${escapeHtml(revision.previousPassage || '')}</blockquote>` : ''}
        </details>
        ${renderEvidenceRelationships(record, revision)}
      </details>`;
    }).join('') : '<div class="evidence-state"><h4>No retained revisions</h4><p>No retained revisions available.</p></div>'}
    ${renderEvidenceTimeline(record, selected || revisions[0])}
    <details class="evidence-retention"><summary>About this comparison and retention</summary><p>A changed excerpt is not proof of a substantive threat change or a publisher correction. Additional text may reflect a more complete capture. Confirm the meaning with the source.</p><p><strong>Local retention</strong> ${escapeHtml(record?.retention?.days ?? 30)} days · up to ${escapeHtml(record?.retention?.maxRevisionsPerSource ?? 8)} revisions per source.</p></details>`;
}

export function closeEvidenceInspector() {
  requestId++;
  if (!current) return;
  const { dialog, trigger, keyHandler } = current;
  current = null;
  dialog.removeEventListener('keydown', keyHandler);
  dialog.close();
  dialog.remove();
  if (trigger?.isConnected) trigger.focus();
  else if (trigger?.dataset?.evidence) {
    const replacement = [...document.querySelectorAll('[data-evidence]')].find(item => item.dataset.evidence === trigger.dataset.evidence);
    (replacement || document.getElementById('wireSearch'))?.focus();
  }
}

export function openEvidenceInspector(headline, trigger, selection = {}) {
  closeEvidenceInspector();
  const evidence = Array.isArray(headline.evidence) ? [...headline.evidence] : [];
  if (selection.sourceId && !evidence.some(source => source.sourceId === selection.sourceId)) evidence.push({ sourceId: selection.sourceId, revisionId: selection.revisionId, source: 'Linked retained source' });
  const remembered = rememberedSources.get(sigKey(headline));
  const desired = selection.sourceId || remembered?.sourceId;
  const initialIndex = Math.max(0, evidence.findIndex(source => source.sourceId === desired));
  let currentIndex = initialIndex;
  let loadedRecord = null;
  const requestedRevision = selection.revisionId || (!selection.sourceId ? remembered?.revisionId : '') || evidence[initialIndex]?.revisionId;
  const revisionChoices = new Map(evidence.map(source => [source.sourceId, source.revisionId]));
  if (evidence[initialIndex]) revisionChoices.set(evidence[initialIndex].sourceId, requestedRevision);
  let selectedRevision = requestedRevision;
  let changesOnly = false;
  const dialog = document.createElement('dialog');
  dialog.className = 'evidence-dialog';
  dialog.setAttribute('aria-labelledby', 'evidenceHeading');
  dialog.innerHTML = `<div class="evidence-dialog-head"><h2 id="evidenceHeading">Source evidence</h2><button type="button" class="btn-ghost-sm" data-evidence-close autofocus>Close</button></div>
    <h3 class="evidence-signal-title">${escapeHtml(headline.title || 'Signal')}</h3>
    <section aria-label="Retained evidence">
    <div class="evidence-controls">${evidence.length > 1 ? `<details class="evidence-source-picker"><summary>Change source · ${evidence.length} retained sources</summary><div class="evidence-source-list" role="group" aria-label="Choose retained source">${renderEvidenceSources(evidence)}</div></details>` : ''}
    <label class="evidence-compare-control"><input type="checkbox" data-changes-only> Show changes only</label></div>
    <div id="evidenceRecord" aria-live="polite"></div></section>
    <details class="evidence-signal-context"><summary>Signal sources and assessment context</summary>${signalAssessmentMeta(headline, true)}</details>
    <details class="evidence-context"><summary>${headline.applicability?.state === 'declared-match' ? `Watch profile match${headline.applicability.matches?.[0]?.term ? ` · ${escapeHtml(headline.applicability.matches[0].term)}` : ''}` : 'Local relevance and source context'}</summary>${renderApplicability(headline.applicability)}<p class="evidence-meta">Grouping and publisher counts do not establish independent confirmation.</p></details>`;
  document.body.appendChild(dialog);
  const keyHandler = event => {
    event.stopPropagation();
    trapEvidenceTab(event, dialog);
  };
  current = { dialog, trigger, keyHandler };
  dialog.addEventListener('keydown', keyHandler);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeEvidenceInspector(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeEvidenceInspector();
  });
  dialog.querySelector('[data-evidence-close]').addEventListener('click', closeEvidenceInspector);
  const host = dialog.querySelector('#evidenceRecord');
  const remember = (sourceId, revisionId) => {
    revisionChoices.set(sourceId, revisionId);
    rememberedSources.set(sigKey(headline), { sourceId, revisionId });
    while (rememberedSources.size > 2000) rememberedSources.delete(rememberedSources.keys().next().value);
  };
  host.addEventListener('toggle', event => {
    const revisionId = event.target.dataset?.evidenceRevision;
    if (revisionId && event.target.open) { selectedRevision = revisionId; remember(evidence[currentIndex]?.sourceId, revisionId); }
  }, true);
  dialog.querySelector('[data-changes-only]').addEventListener('change', event => {
    changesOnly = event.target.checked;
    if (loadedRecord) host.innerHTML = renderEvidenceRecord(loadedRecord, selectedRevision, { changesOnly });
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-evidence-revision], [data-copy-citation]');
    if (!button) return;
    const revisionId = button.dataset.copyEvidenceRevision || button.dataset.copyCitation;
    const link = signalUrl(headline, location.origin, { sourceId: evidence[currentIndex]?.sourceId, revisionId });
    const revision = loadedRecord?.revisions?.find(item => item.revisionId === revisionId);
    const citation = button.dataset.copyCitation ? `${revision?.source || loadedRecord?.source || 'Source'} — ${revision?.title || headline.title}\nObserved ${time(revision?.firstObservedAt)}\n${revision?.passage || 'No retained excerpt'}\n${link}` : link;
    try { await navigator.clipboard.writeText(citation); showToast(button.dataset.copyCitation ? 'Citation and retained excerpt copied' : 'Exact evidence link copied', 'success'); }
    catch { showToast('Clipboard unavailable. Use your browser to copy the text.', 'error'); }
  });
  async function load(index) {
    currentIndex = index;
    loadedRecord = null;
    const source = evidence[index];
    const id = ++requestId;
    if (!source) { host.innerHTML = '<div class="evidence-state"><h4>No retained evidence</h4><p>No retained source observation is attached to this signal. Evidence starts with the first collection after this upgrade.</p></div>'; return; }
    host.setAttribute('aria-busy', 'true');
    host.innerHTML = '<div class="evidence-state"><p role="status">Loading retained source evidence…</p></div>';
    try {
      const record = await api.fetchEvidence(source.sourceId);
      if (current?.dialog !== dialog || id !== requestId) return;
      loadedRecord = record;
      selectedRevision = revisionChoices.get(source.sourceId) || source.revisionId;
      remember(source.sourceId, selectedRevision);
      host.innerHTML = renderEvidenceRecord(record, selectedRevision, { changesOnly });
      host.setAttribute('aria-busy', 'false');
    } catch {
      if (current?.dialog !== dialog || id !== requestId) return;
      host.setAttribute('aria-busy', 'false');
      host.innerHTML = '<div class="evidence-state"><h4>Retained evidence unavailable</h4><p role="status">The feed remains available. Retry this source check to load the retained observation.</p><button type="button" class="btn-ghost-sm" data-evidence-retry>Retry source check</button></div>';
      host.querySelector('[data-evidence-retry]').addEventListener('click', () => load(index));
    }
  }
  dialog.querySelector('.evidence-source-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-evidence-source]');
    if (!button) return;
    const index = Number(button.dataset.evidenceSource);
    remember(evidence[index]?.sourceId, revisionChoices.get(evidence[index]?.sourceId) || evidence[index]?.revisionId);
    dialog.querySelectorAll('[data-evidence-source]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    const picker = dialog.querySelector('.evidence-source-picker');
    picker.open = false;
    picker.querySelector('summary').textContent = `Change source · ${evidence[index]?.source || 'Unknown publisher'} · ${evidence.length} retained sources`;
    picker.querySelector('summary').focus();
    load(index);
  });
  dialog.showModal();
  dialog.querySelectorAll('[data-evidence-source]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.evidenceSource) === initialIndex)));
  load(initialIndex);
}

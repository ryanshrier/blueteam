// Retained source evidence is separate from scoring, enrichment and analyst judgment.
import { escapeHtml } from '../core/sanitize.js';
import * as api from '../core/api.js';

let current = null;
let requestId = 0;

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
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Unknown';
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
  const reason = [changed ? 'Source text changed' : '', matched ? 'Watch profile match' : ''].filter(Boolean).join(' · ');
  return `${reason ? `<p class="wire-attention">${escapeHtml(reason)}</p>` : ''}`;
}

export function renderApplicability(applicability) {
  if (!applicability) return '<p>Exposure unknown. Configure a watch profile in <a href="/settings">Settings</a> to identify declared relevance.</p>';
  return `<p>${escapeHtml(applicability.explanation || 'Exposure unknown; check local applicability.')}</p>
    ${applicability.matches?.length ? `<ul>${applicability.matches.map(match => `<li>${escapeHtml(match.term)} · ${escapeHtml(match.field)} · literal match in ${escapeHtml((match.in || []).join(', '))}</li>`).join('')}</ul>` : ''}
    <p>Declared context is not an inventory check. Local exposure and mitigation remain unverified.</p>`;
}

export function renderEvidenceRecord(record, selectedRevisionId) {
  const revisions = Array.isArray(record?.revisions) ? record.revisions : [];
  const selected = revisions.find(revision => revision.revisionId === selectedRevisionId);
  const url = safeUrl(record?.canonicalUrl);
  return `<p class="evidence-source-link">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open original source <span>${escapeHtml(new URL(url).hostname)} ↗</span></a>` : '<span class="evidence-notice">Original source URL unavailable.</span>'}</p>
    ${selectedRevisionId && !selected ? '<p class="evidence-notice" role="status">The revision attached to this feed snapshot is no longer retained. The available observations below may be newer.</p>' : ''}
    ${revisions.length ? revisions.map((revision, index) => {
      const changes = revision.changes;
      const changed = changes && (changes.removed || changes.added);
      const publisher = revision.source || record.source || 'Unknown publisher';
      const passageKind = revision.passageKind === 'title-only' ? 'Source title only; no excerpt available.' : 'Source reporting · retained feed excerpt; not the full article.';
      const passage = (text, label = '') => `<figure class="evidence-quotation">${label ? `<h5>${label}</h5>` : ''}<blockquote class="evidence-passage">${text}</blockquote><figcaption>${escapeHtml(publisher)} · ${escapeHtml(passageKind)}</figcaption></figure>`;
      const changeBlocks = changed ? `<section class="evidence-changes" aria-label="Passage changes"><h4>Changed passage</h4><p class="evidence-meta">Text difference from the previous retained observation of this feed. Confirm the meaning with the source.</p><div class="evidence-diff">
        ${passage(`${escapeHtml(changes.before || '')}${changes.removed ? `<del aria-label="Removed text">${escapeHtml(changes.removed)}</del>` : ''}${escapeHtml(changes.after || '')}`, 'Previous · removed text')}
        ${passage(`${escapeHtml(changes.before || '')}${changes.added ? `<ins aria-label="Added text">${escapeHtml(changes.added)}</ins>` : ''}${escapeHtml(changes.after || '')}`, 'Current · added text')}
      </div></section>` : passage(escapeHtml(revision.passage || 'No source passage retained.'));
      return `<details class="evidence-revision"${revision.revisionId === selectedRevisionId || (!selected && index === 0) ? ' open' : ''}>
        <summary><span>${revision.revisionId === selectedRevisionId ? 'Feed snapshot revision' : index === 0 ? 'Latest retained revision' : 'Earlier retained revision'}</span><time>${escapeHtml(time(revision.firstObservedAt))}</time></summary>
        <h4>${escapeHtml(revision.title || 'Untitled source')}</h4>
        ${revision.passageTruncated ? '<p class="evidence-notice">Excerpt was clipped at the retention limit.</p>' : ''}
        ${changeBlocks}
        ${!changed && revision.changed ? (revision.previousPassage == null ? '<p class="evidence-notice">The preceding observation is no longer retained; its passage comparison is unavailable.</p>' : '<p class="evidence-meta">The title changed; the retained passage is unchanged.</p>') : ''}
        <details class="evidence-observation"><summary>Observation details</summary>
          ${revision.feedUrl ? `<p class="evidence-meta">Collected from ${escapeHtml(revision.feedUrl)}</p>` : ''}
          <dl class="evidence-times"><dt>Published</dt><dd>${escapeHtml(time(revision.publishedAt))}</dd><dt>Source updated</dt><dd>${escapeHtml(time(revision.sourceUpdatedAt))}</dd><dt>Retrieved</dt><dd>${escapeHtml(time(revision.retrievedAt))}</dd><dt>First observed</dt><dd>${escapeHtml(time(record?.firstObservedAt))}</dd><dt>Last observed</dt><dd>${escapeHtml(time(record?.lastObservedAt))}</dd></dl>
          <p class="evidence-id">Revision ${escapeHtml(revision.revisionId)}</p>
          ${changed ? `<h5>Current full excerpt</h5><blockquote class="evidence-passage">${escapeHtml(revision.passage || '')}</blockquote><h5>Previous full excerpt</h5><blockquote class="evidence-passage">${escapeHtml(revision.previousPassage || '')}</blockquote>` : ''}
        </details>
      </details>`;
    }).join('') : '<div class="evidence-state"><h4>No retained revisions</h4><p>No retained revisions available.</p></div>'}
    <footer class="evidence-retention"><strong>Local retention</strong> ${escapeHtml(record?.retention?.days ?? 30)} days · up to ${escapeHtml(record?.retention?.maxRevisionsPerSource ?? 8)} revisions per source.<br>A changed excerpt is not proof of a substantive threat change.</footer>`;
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

export function openEvidenceInspector(headline, trigger) {
  closeEvidenceInspector();
  const evidence = Array.isArray(headline.evidence) ? headline.evidence : [];
  const dialog = document.createElement('dialog');
  dialog.className = 'evidence-dialog';
  dialog.setAttribute('aria-labelledby', 'evidenceHeading');
  dialog.innerHTML = `<div class="evidence-dialog-head"><h2 id="evidenceHeading">Source evidence</h2><button type="button" class="btn-ghost-sm" data-evidence-close autofocus>Close</button></div>
    <h3 class="evidence-signal-title">${escapeHtml(headline.title || 'Signal')}</h3>
    <details class="evidence-applicability"><summary>Why it matters here <span>Exposure unknown</span></summary>${renderApplicability(headline.applicability)}</details>
    <section aria-label="Retained evidence">
    ${evidence.length ? `<label for="evidenceSource">Source in this group · ${evidence.length} ${evidence.length === 1 ? 'source' : 'sources'}</label><select id="evidenceSource">${evidence.map((source, index) => `<option value="${index}">${escapeHtml(source.source || 'Unknown publisher')} — ${escapeHtml(source.title || source.canonicalUrl || 'Source')}</option>`).join('')}</select>` : ''}
    <p class="evidence-meta">Grouping and publisher counts do not establish independent confirmation.</p>
    <div id="evidenceRecord" aria-live="polite"></div></section>`;
  document.body.appendChild(dialog);
  const keyHandler = event => {
    event.stopPropagation();
    trapEvidenceTab(event, dialog);
  };
  current = { dialog, trigger, keyHandler };
  dialog.addEventListener('keydown', keyHandler);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeEvidenceInspector(); });
  dialog.querySelector('[data-evidence-close]').addEventListener('click', closeEvidenceInspector);
  const host = dialog.querySelector('#evidenceRecord');
  async function load(index) {
    const source = evidence[index];
    const id = ++requestId;
    if (!source) { host.innerHTML = '<div class="evidence-state"><h4>No retained evidence</h4><p>No retained source observation is attached to this signal. Evidence starts with the first collection after this upgrade.</p></div>'; return; }
    host.setAttribute('aria-busy', 'true');
    host.innerHTML = '<div class="evidence-state"><p role="status">Loading retained source evidence…</p></div>';
    try {
      const record = await api.fetchEvidence(source.sourceId);
      if (current?.dialog !== dialog || id !== requestId) return;
      host.innerHTML = renderEvidenceRecord(record, source.revisionId);
      host.setAttribute('aria-busy', 'false');
    } catch {
      if (current?.dialog !== dialog || id !== requestId) return;
      host.setAttribute('aria-busy', 'false');
      host.innerHTML = '<div class="evidence-state"><h4>Retained evidence unavailable</h4><p role="status">The feed remains available. Retry this source check to load the retained observation.</p><button type="button" class="btn-ghost-sm" data-evidence-retry>Retry source check</button></div>';
      host.querySelector('[data-evidence-retry]').addEventListener('click', () => load(index));
    }
  }
  dialog.querySelector('#evidenceSource')?.addEventListener('change', event => load(Number(event.target.value)));
  dialog.showModal();
  load(0);
}

import { escapeHtml } from '../core/sanitize.js';
import { formatBriefLabel, formatBriefPublishedAt, formatEventTime } from '../core/brief-date.js';

export function safeSourceUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  }
  catch { return ''; }
}

export function receiptSources(data = {}) {
  const bindings = new Map();
  const reviewed = Array.isArray(data.review?.evidenceBindings);
  for (const item of (reviewed ? data.review.evidenceBindings : data.judgmentEvidence) || []) {
    if (!Number.isSafeInteger(item.signal) || item.signal < 1) continue;
    for (const id of item.sourceIds || []) bindings.set(id, [...new Set([...(bindings.get(id) || []), item.signal])]);
  }
  const records = Array.isArray(data.grounding?.sources) ? [...data.grounding.sources] : (data.selectedEvidence || []).flatMap((item, index) => [item, ...(item.groupMembers || [])].map(member => ({ ...member, index })));
  const passage = item => typeof item.passage === 'string' ? item.passage : item.passage?.text || item.evidenceText || '';
  const publisher = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const identity = item => `${publisher(item.label || item.source)}\n${safeSourceUrl(item.url)}`;
  const existing = new Set(records.map(item => `${identity(item)}\n${passage(item)}`));
  const additional = [];
  if (Array.isArray(data.grounding?.sources)) for (const [groupIndex, group] of (data.selectedEvidence || []).entries()) {
    for (const [memberIndex, member] of (group.groupMembers || []).entries()) {
      const text = passage(member);
      const key = `${identity(member)}\n${text}`;
      if (!text || existing.has(key)) continue;
      existing.add(key);
      // Prefer the member's own references. A group-level fallback is usable
      // only when the same publisher and URL identify one exact revision.
      // Multiple matching revisions cannot be attributed to a passage by order.
      const refs = member.sourceRevisions?.length ? member.sourceRevisions : group.sourceRevisions || [];
      const matches = new Map(refs.filter(ref => safeSourceUrl(member.url)
        && safeSourceUrl(ref.canonicalUrl) === safeSourceUrl(member.url)
        && publisher(ref.source) === publisher(member.source || member.label)
        && /^src_[a-f0-9]{64}$/i.test(ref.sourceId || '') && /^rev_[a-f0-9]{64}$/i.test(ref.revisionId || ''))
        .map(ref => [`retained:${ref.sourceId}:${ref.revisionId}`, ref]));
      const [bindingId, ref] = matches.size === 1 ? [...matches][0] : [];
      additional.push({ ...member, id: bindingId || `retained-unbound:${groupIndex}:${memberIndex}`,
        index: Number.isSafeInteger(group.index) ? group.index : groupIndex,
        label: member.source || member.label, retainedMember: true, revisionBinding: bindingId ? 'exact-member-reference' : 'unavailable',
        sourceRevisions: ref ? [{ ...ref }] : [], passageKind: ref?.passageKind || '',
        retrievedAt: ref?.retrievedAt || member.retrievedAt, quality: member.quality || null });
    }
  }
  // If a receipt assigns different texts to the same reference, retain both
  // texts for inspection but refuse to present either as the exact bound one.
  const uses = new Map();
  for (const item of additional) uses.set(item.id, (uses.get(item.id) || 0) + 1);
  for (const [index, item] of additional.entries()) if (uses.get(item.id) > 1) {
    item.id = `retained-unbound:ambiguous:${index}`;
    item.revisionBinding = 'unavailable';
    item.sourceRevisions = [];
  }
  records.push(...additional);
  return records.map((item, index) => ({ ...item, id: item.id || `input-${index + 1}`, judgments: bindings.get(item.id) || [], bindingKind: reviewed ? 'reviewed' : 'original', passageText: passage(item) }));
}

export function inputReceiptHtml(data = {}) {
  const evidence = receiptSources(data);
  const reviewed = Array.isArray(data.review?.evidenceBindings);
  const moved = new Map((reviewed ? [] : data.review?.notes || []).filter(note => /^### Signal (\d+)\b/.test(note.original || '') && !/^### Signal (\d+)\b/.test(note.replacement || '')).map(note => [Number(note.original.match(/^### Signal (\d+)\b/)[1]), note.anchor || 'editorial-review']));
  const judgmentLabel = number => `${reviewed ? 'Reviewed' : 'Original'} judgment ${number}${moved.has(number) ? ' (moved to Developing)' : ''}`;
  const delta = data.inputDelta;
  const deltaLabel = delta?.kind === 'unchanged-inputs' ? 'Unchanged retained source inputs' : delta?.kind === 'source-input-change' ? 'Retained source inputs changed' : 'No preceding receipt available';
  const profile = data.promptWatchProfile || {};
  const names = { technologies: 'Technology interests', sectors: 'Sectors', regions: 'Regions', intelligenceQuestions: 'Intelligence questions', exclusions: 'Exclusions', preferredHorizons: 'Preferred horizons' };
  const accounting = `<details class="brief-input-accounting"><summary>Capture details and edition context</summary><p class="brief-input-intro">Inputs retained at generation time. ${reviewed ? 'Citation bindings below were assigned by the editorial review to the reviewed judgments. Original generation bindings remain in the unchanged saved-input download.' : `Citation bindings refer to the original generated judgments${moved.size ? '; moved judgments link to their reviewed follow-up section' : ''}.`} Inclusion alone does not establish support or independent confirmation.</p>
    <dl class="brief-input-facts"><div><dt>Selected signal groups</dt><dd>${data.selectedEvidence?.length || 0}</dd></div><div><dt>Retained passages</dt><dd>${evidence.length}</dd></div><div><dt>Cited in judgments</dt><dd>${evidence.filter(item => item.judgments.length).length}</dd></div>
      <div><dt>Captured</dt><dd>${escapeHtml(formatEventTime(data.capturedAt) || 'Time unavailable')}</dd></div><div><dt>Model</dt><dd>${escapeHtml(data.responseModel || data.modelUsed || 'Not recorded')}</dd></div></dl>
    <details class="brief-input-continuity"><summary>Edition continuity · ${escapeHtml(delta ? deltaLabel : 'not recorded for this edition')}</summary>${delta ? `<p>${['added', 'changed', 'removed', 'unchanged'].map(key => `${Number.isSafeInteger(delta[key]) && delta[key] >= 0 ? delta[key] : 'Unknown'} ${key}`).join(' · ')}</p><p>${escapeHtml(delta.explanation || 'Counts compare retained publisher passages, not independently established threat developments.')}</p>` : '<p>This legacy receipt does not record an input comparison. A new publication time alone does not establish new intelligence.</p>'}</details>
    <details class="brief-input-profile"><summary>Effective profile for this edition</summary><p>${escapeHtml(profile.teamProfile || 'Team context not recorded')}</p><dl>${Object.entries(names).map(([key, label]) => `<dt>${label}</dt><dd>${escapeHtml((profile[key] || []).join(', ') || 'None recorded')}${profile.provenance?.[key] ? ` · ${escapeHtml(typeof profile.provenance[key] === 'string' ? profile.provenance[key] : JSON.stringify(profile.provenance[key]))}` : ''}</dd>`).join('')}</dl><p>Interests do not establish deployed assets. ${profile.provenance ? 'Recorded origins are shown above.' : 'Legacy receipt: configuration origins were not recorded; terms may include inherited defaults.'}</p></details>
    </details>`;
  return `<p class="brief-input-summary">${evidence.filter(item => item.judgments.length).length} cited · ${evidence.length} retained passages</p><form class="brief-input-filter" role="search"><label class="brief-input-field"><span>Find a retained source</span><input type="search" data-input-search placeholder="Publisher, topic, CVE, or evidence ID"></label><label class="brief-input-field"><span>${reviewed ? 'Reviewed' : 'Original generation'} judgment</span><select data-input-judgment><option value="">All ${reviewed ? 'reviewed' : 'original'} judgments</option>${[...new Set(evidence.flatMap(item => item.judgments))].sort((a,b) => a-b).map(value => `<option value="${value}">${judgmentLabel(value)}</option>`).join('')}</select></label><label class="brief-input-cited"><input type="checkbox" data-input-cited> Cited in ${reviewed ? 'reviewed' : 'original'} judgments only</label></form><p data-input-count role="status"></p>
    <h3>Retained source passages</h3><ol class="brief-input-sources">${evidence.map(item => {
      const url = safeSourceUrl(item.url);
      const title = String(item.title || item.label || item.source || 'Source title unavailable');
      const quality = item.quality?.status || (!item.passageText || item.passageText.trim() === title.trim() ? 'title-only' : 'legacy quality not recorded');
      const rowLabel = item.retainedMember ? (item.passageKind === 'feed-excerpt' ? 'Retained feed capture' : 'Retained source capture') : (/^S\d+\.\d+$/.test(item.id) ? item.id : 'Retained input');
      const captureIdentity = `<dl class="brief-input-capture"><div><dt>Evidence ID</dt><dd><code>${escapeHtml(item.id)}</code></dd></div>${(item.sourceRevisions || []).map((ref, index) => `<div><dt>Source${item.sourceRevisions.length > 1 ? ` ${index + 1}` : ''}</dt><dd><code>${escapeHtml(ref.sourceId || 'Not recorded')}</code></dd></div><div><dt>Revision${item.sourceRevisions.length > 1 ? ` ${index + 1}` : ''}</dt><dd><code>${escapeHtml(ref.revisionId || 'Not recorded')}</code></dd></div>`).join('')}</dl>`;
      return `<li data-input-source data-input-text="${escapeHtml([item.id, title, item.label, item.source, item.passageText].join(' ').toLowerCase())}" data-input-judgments="${item.judgments.join(',')}"><p class="brief-input-source-label">${escapeHtml(rowLabel)} · ${Number.isInteger(item.index) ? `Signal group ${item.index + 1}` : 'Catalog input'}</p>${url ? `<a class="brief-input-source-title" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)} ↗</a>` : `<strong class="brief-input-source-title">${escapeHtml(title)}</strong>`}
        <p class="brief-input-source-meta">${escapeHtml([item.label || item.source, formatEventTime(item.publishedAt), item.passageKind || item.passage?.kind, quality, item.collectionStale && 'Retained from earlier collection'].filter(Boolean).join(' · '))}</p>
        <p class="brief-input-source-meta">${item.judgments.length ? `Cited in ${item.judgments.map(number => `<a href="/briefing/${encodeURIComponent(data.filename || '')}#${escapeHtml(moved.get(number) || `judgment-${number}`)}" data-close-receipt>${judgmentLabel(number)}</a>`).join(', ')}` : 'Considered input; no judgment citation binding recorded'}</p>
        <details><summary>Retained passage and capture</summary>${item.passageText ? `<blockquote>${escapeHtml(item.passageText)}</blockquote>` : '<p>No substantive passage retained.</p>'}<p class="brief-input-source-meta">Retrieved ${escapeHtml(formatEventTime(item.retrievedAt) || 'time not recorded')} · ${item.sourceRevisions?.length || 0} recorded source revisions${item.retainedMember ? ` · Retained group-member passage${item.revisionBinding === 'unavailable' ? '; exact revision binding unavailable' : ''}` : ''}</p>${captureIdentity}</details></li>`;
    }).join('')}</ol>${accounting}`;
}

export function filterReceiptSources(root) {
  const query = root.querySelector('[data-input-search]')?.value.toLowerCase().trim() || '';
  const cited = root.querySelector('[data-input-cited]')?.checked;
  const judgment = root.querySelector('[data-input-judgment]')?.value || '';
  let count = 0;
  root.querySelectorAll('[data-input-source]').forEach(row => {
    const judgments = (row.dataset.inputJudgments || '').split(',').filter(Boolean);
    row.hidden = !row.dataset.inputText.includes(query) || (cited && !judgments.length) || (judgment && !judgments.includes(judgment));
    if (!row.hidden) count++;
  });
  const status = root.querySelector('[data-input-count]');
  if (status) status.textContent = `${count} retained ${count === 1 ? 'passage' : 'passages'} shown`;
}

// Add known article titles to the existing source appendix without rewriting
// authored prose or introducing any new source links.
export function enrichCitationTitles(content, receipt) {
  const byUrl = new Map();
  for (const item of receipt?.selectedEvidence || []) {
    for (const candidate of [item, ...(item.groupMembers || [])]) {
      const url = safeSourceUrl(candidate.url);
      if (url && candidate.title) byUrl.set(url, candidate);
    }
  }
  content.querySelectorAll('.brief-sources-appendix .source-link').forEach(link => {
    const item = byUrl.get(safeSourceUrl(link.getAttribute('href')));
    if (!item) return;
    link.textContent = item.title;
    link.parentElement.querySelector('.brief-cite-host')?.remove();
    const meta = link.parentElement.querySelector('.brief-source-detail') || content.ownerDocument.createElement('span');
    meta.className = 'brief-source-detail';
    meta.textContent = [item.source, item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? formatBriefPublishedAt(new Date(item.publishedAt).toISOString()) : ''].filter(Boolean).join(' · ');
    if (!meta.parentElement) link.after(meta);
  });
}

export async function fetchInputReceipt(filename) {
  const response = await fetch(`/api/brief/${encodeURIComponent(filename)}/manifest`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Object.assign(new Error(response.status === 403 ? 'Saved inputs require a local or authenticated connection.' : response.status === 404 ? 'No saved input manifest exists for this edition.' : 'Saved inputs could not be loaded'), { status: response.status });
  return response.json();
}

export function openInputReceipt({ filename, receipt = null, opener = null, judgment = null, review = null }) {
  const dialog = document.createElement('dialog');
  const request = { active: true };
  dialog.className = 'brief-input-dialog';
  const topic = opener?.closest?.('.brief-judgment-card')?.querySelector('h3')?.textContent?.split(':')[0]?.trim();
  dialog.setAttribute('aria-labelledby', 'briefInputTitle');
  dialog.innerHTML = `<header><div><h2 id="briefInputTitle">${escapeHtml(judgment ? `Evidence · ${topic || `Judgment ${judgment}`}` : 'Edition sources and inputs')}</h2><p>${escapeHtml(formatBriefLabel(filename))}</p></div><button class="btn-ghost" type="button" data-close-inputs>Close</button></header>
    <div class="brief-input-body" aria-live="polite"><p>Loading saved inputs…</p></div>
    <details class="brief-input-download"><summary>Advanced</summary><a href="/api/brief/${encodeURIComponent(filename)}/manifest" download="${escapeHtml(filename.replace(/\.md$/, '.inputs.json'))}">Download saved inputs (JSON)</a></details>`;
  document.body.appendChild(dialog);
  const body = dialog.querySelector('.brief-input-body');
  const close = () => { request.active = false; dialog.close(); dialog.remove(); opener?.focus?.(); };
  dialog.querySelector('[data-close-inputs]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  const load = async () => {
    body.innerHTML = '<p role="status">Loading saved inputs…</p>';
    try {
      const data = receipt || await fetchInputReceipt(filename);
      if (request.active) {
        body.innerHTML = inputReceiptHtml({ ...data, filename, review });
        if (judgment) body.querySelector('[data-input-judgment]').value = String(judgment);
        body.querySelector('form')?.addEventListener('submit', event => event.preventDefault());
        body.querySelector('form')?.addEventListener('input', () => filterReceiptSources(body));
        body.querySelector('form')?.addEventListener('change', () => filterReceiptSources(body));
        body.querySelectorAll('[data-close-receipt]').forEach(link => link.addEventListener('click', close));
        filterReceiptSources(body);
        if (judgment) {
          body.querySelectorAll('[data-input-source]:not([hidden]) > details').forEach(node => { node.open = true; });
        }
      }
    } catch (error) {
      if (!request.active) return;
      const retry = ![403, 404].includes(error.status);
      body.innerHTML = `<p role="alert">${escapeHtml(error.message)}</p>${retry ? '<button class="btn-ghost" type="button" data-retry-inputs>Retry</button>' : ''}`;
      body.querySelector('[data-retry-inputs]')?.addEventListener('click', load);
    }
  };
  dialog.showModal();
  void load();
  return close;
}

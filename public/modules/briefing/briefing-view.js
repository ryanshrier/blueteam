// BlueTeam.News — briefing view: generate, stream, read, history, search.

import { getState, setState, on, emit } from '../core/store.js';
import { escapeHtml, sanitizeSearchSnippet } from '../core/sanitize.js';
import { renderDraftMarkdown, renderMarkdown } from '../core/markdown.js';
import { showToast } from '../core/toast.js';
import { applySemanticStyling, extractSections, decisionCardContent, decisionCopyText } from './brief-renderer.js';
import * as briefRenderer from './brief-renderer.js';
import { exportBriefNewspaper } from './brief-export.js';
import { mountGenerationStatus } from './generation-status.js';
import { fetchBriefs, fetchBrief, searchBriefs, fetchSettings } from '../core/api.js';
import * as briefingApi from '../core/api.js';
import { renderOverview, mountRecentDevelopments } from './brief-overview.js';
import { navigate, resolveLocation, setPageTitle } from '../core/router.js';
import { formatBriefLabel, formatBriefPublication, archivePublishedAt, formatEventTime } from '../core/brief-date.js';
import { archiveLocation, archiveRoute, fetchArchivePage, archiveListHtml } from './brief-archive.js';
import { fetchInputReceipt, enrichCitationTitles, openInputReceipt } from './brief-inputs.js';
import { attachEditorialReview, openOriginalEdition } from './brief-review.js';
import { formatEditionIdentity } from '../core/brief-date.js';
import { openDraftReview } from './brief-drafts.js';

let initialized = false;
let contentRenderToken = 0;
let showingGeneration = false; // only the action route owns stream/completion paints
let aiEnabled = true; // refreshed from /api/settings; gates the no-key guided path
let aiKnown = false;
let settingsLoading = false;
let settingsRequest = 0;
let settingsReady = Promise.resolve(); // resolves once aiEnabled is known, so the cold-start empty state never races to the wrong CTA
let searchTimer = null; // module-scoped so route changes/unmount can cancel a pending archive search
let recoveredBriefTimer = null; // a recovered generation must never pull the operator away after leaving Briefing
let generationStatus = null;
let closeInputReceipt = null;
let closeOriginalEdition = null;
let closeDraftReview = null;
let closePrintPreview = null;
const receiptCache = new Map();
const archiveScrollPositions = new Map();
let latestFilename = null;
let readingMode = 'overview';
let stopRecentDevelopments = null;
try { const saved = localStorage.getItem('briefing.readingMode'); if (['overview', 'scan', 'read'].includes(saved)) readingMode = saved === 'scan' ? 'read' : saved; } catch { /* browser storage is optional */ }

export function briefGenerateModel({ enabled, known, loading, generating }) {
  if (generating) return { label: 'Generating…', disabled: true, action: '' };
  if (loading) return { label: 'Checking AI availability…', disabled: true, action: '' };
  if (!known) return { label: 'Check AI settings', disabled: false, action: 'settings' };
  return enabled
    ? { label: 'Generate briefing', disabled: false, action: 'generate' }
    : { label: 'Enable AI in Settings', disabled: false, action: 'settings' };
}

function generationControlState() {
  return briefGenerateModel({ enabled: aiEnabled, known: aiKnown, loading: settingsLoading, generating: getState().isGenerating });
}

function reflectBriefGenerate() {
  const button = document.getElementById('briefGenerate');
  if (!button) return;
  const state = generationControlState();
  button.textContent = state.label;
  button.disabled = state.disabled;
  const helper = document.getElementById('briefGenerateInput');
  if (helper) helper.textContent = state.action === 'settings'
    ? 'Configure AI access in Settings to generate a briefing.'
    : 'Input: latest collected signals';
  reflectDocumentActions();
}

function reflectDocumentActions() {
  const content = document.getElementById('briefContent');
  const { currentBrief, isGenerating } = getState();
  const ready = isBriefReadyForExport(content, currentBrief, isGenerating);
  const print = document.getElementById('briefExport');
  if (print) print.disabled = !ready;
  const copy = document.getElementById('briefCopyLink');
  if (copy) copy.disabled = !ready || !currentBrief?.filename;
  const modes = document.querySelector?.('.brief-document-bar');
  if (modes) modes.hidden = !ready;
}

function disposePrintPreview() {
  const close = closePrintPreview;
  closePrintPreview = null;
  close?.({ restoreFocus: false });
}

function leaveDocument(content) {
  disposePrintPreview();
  stopRecentDevelopments?.();
  stopRecentDevelopments = null;
  const overview = document.getElementById('briefOverview');
  if (overview) { overview.hidden = true; overview.innerHTML = ''; }
  const layout = document.querySelector?.('.briefing-layout');
  if (layout) layout.hidden = false;
  document.querySelector?.('.briefing-view')?.classList.toggle('briefing-view--overview', false);
  if (content._streamTimer) { clearTimeout(content._streamTimer); content._streamTimer = null; }
  content._validatedBriefContent = null;
  const toc = document.getElementById('briefToc');
  if (toc) toc.innerHTML = '';
  tocObserver?.disconnect();
  tocScrollCleanup?.();
  tocScrollCleanup = null;
  refreshTocCurrent = null;
  tocBreakpointCleanup?.();
  tocBreakpointCleanup = null;
  for (const id of ['briefMeta', 'briefInputManifest', 'briefGenerationMeta', 'briefPublicationState']) {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  }
  reflectDocumentActions();
}

function renderLoadError(content, data) {
  leaveDocument(content);
  content.removeAttribute('aria-busy');
  content.innerHTML = `<div class="error-message brief-load-error" role="alert">
    <h2>Briefing could not load</h2>
    <p>The saved edition is unavailable right now. Retry to request it again.</p>
    <button type="button" class="btn-ghost" id="briefLoadRetry">Retry loading</button>
  </div>`;
  document.getElementById('briefLoadRetry')?.addEventListener('click', () => handleRoute(data));
}

function requestBriefGeneration() {
  const state = generationControlState();
  if (state.disabled) return;
  if (state.action === 'settings') navigate('/settings');
  else if (state.action === 'generate') {
    const tools = document.getElementById('briefEditionTools');
    if (tools) tools.open = false;
    emit('generate-brief');
  }
}

/** Normalize the string and object forms accepted by the generation-error event. */
export function generationFailureModel(payload) {
  const structured = payload !== null && typeof payload === 'object';
  const draft = structured && typeof payload.recoverableDraft === 'string'
    ? payload.recoverableDraft
    : '';
  return {
    message: structured ? (payload.message || '') : payload,
    aiDisabled: Boolean(structured && payload.aiDisabled),
    code: structured ? (payload.code || '') : '',
    streamLost: Boolean(structured && payload.streamLost),
    accumulatedText: structured ? (payload.accumulatedText || '') : '',
    recoverableDraft: draft.trim() ? draft : '',
    draftArtifact: structured && payload.draftArtifact?.id ? payload.draftArtifact : null,
  };
}

/** Keep local collection/request failures distinct from provider failures. */
export function generationErrorMessage({ message, code }) {
  if (code === 'E_EVIDENCE') {
    // The server rejects inadequate evidence before any provider call. A new
    // API key cannot repair collection, so point to the source-health surface.
    return `${message || 'Current source evidence is unavailable.'} No AI generation was started. Check System health in Settings for source connectivity, then retry.`;
  }
  // Structured publication and local request-limit messages already identify
  // their cause. Generic rate/network heuristics would erase that distinction.
  if (code === 'E006' || code === 'E_API_RATE' || [
    'E_GENERATION_ACTIVE', 'E_GENERATION_COOLDOWN',
    'E_GENERATION_RATE', 'E_GENERATION_DAILY_LIMIT',
  ].includes(code)) return message || 'The Briefing request could not proceed.';
  if (/E001|in progress|already running|already generating/i.test(message)) return 'A briefing is already generating — wait for it to finish, then retry.';
  if (/429|rate.?limit|overloaded|529/i.test(message)) return 'The model is rate-limited or overloaded right now. Wait a moment and retry.';
  if (/timed out|timeout/i.test(message)) return 'Generation timed out. Retry, or reduce the brief size in config.';
  if (/\b5\d\d\b|unavailable|network|failed to fetch/i.test(message)) return 'The briefing service is temporarily unavailable. Retry shortly.';
  return message || 'Generation failed. Retry, or check the server logs.';
}

export function render(main) {
  main.innerHTML = `
    <div class="briefing-view">
      <div class="brief-progress" id="briefProgress" aria-hidden="true"></div>
      <header class="briefing-masthead">
        <div>
          <h1 class="view-title">Briefing</h1>
          <p class="view-sub" id="briefMeta"></p>
        </div>
        <span class="sr-only" id="briefSrLive" aria-live="polite"></span>
        <details class="brief-edition-tools" id="briefEditionTools">
          <summary>Edition tools <span aria-hidden="true">⌄</span></summary>
          <div class="brief-tools-panel">
            <div class="brief-tools-heading"><strong>Edition tools</strong><button type="button" class="btn-ghost" id="briefToolsClose" data-close-edition-tools>Close</button></div>
            <section class="brief-tools-group" aria-label="Browse editions">
            <nav class="brief-reader-nav" aria-label="Briefing navigation"><a data-brief-route href="/briefing?latest=1">Latest</a><a data-brief-route href="/briefing?archive=1">Archive</a><button type="button" class="btn-ghost" id="briefDrafts">Drafts</button></nav>
            <label class="brief-toolbar-field">Edition
              <select class="history-select" id="briefHistory"><option value="">Choose edition</option></select>
            </label>
            </section>
            <section class="brief-tools-group" aria-label="Share and inspect">
            <p class="brief-tools-label">Share and inspect</p>
            <div class="brief-tool-actions">
              <button class="btn-ghost brief-copylink-btn" id="briefCopyLink" type="button" aria-label="Copy link to this briefing">Copy link</button>
              <button class="btn-ghost brief-export-btn" id="briefExport" type="button" aria-label="Open print edition preview">Print edition</button>
            </div>
            <div id="briefInputManifest"></div>
            <p id="briefReviewState" class="brief-tool-review"></p>
            </section>
            <div class="brief-generate-control">
              <button class="btn-primary" id="briefGenerate" type="button" aria-describedby="briefGenerateInput" disabled>Checking AI availability…</button>
              <p id="briefGenerateInput">Input: latest collected signals</p>
              <p class="brief-generation-cost">Uses this server's configured model and may incur API charges.</p>
            </div>
            <div class="brief-edition-provenance"><span id="briefGenerationMeta"></span></div>
            <div id="briefSuccessStatus"></div>
          </div>
        </details>
      </header>
      <div class="brief-document-bar" role="group" aria-label="Reading mode">
        <button type="button" class="btn-ghost" id="briefOverviewMode" data-reading-mode="overview" aria-pressed="${readingMode === 'overview'}">Overview</button>
        <button type="button" class="btn-ghost" id="briefReadingMode" data-reading-mode="read" aria-pressed="${readingMode === 'read'}">Full report</button>
      </div>
      <p class="brief-publication-state" id="briefPublicationState" hidden></p>
      <section class="brief-overview" id="briefOverview" aria-label="Briefing overview" hidden></section>

      <div id="briefAttemptSlot"><section class="brief-attempt-status" id="briefAttemptStatus" role="status" aria-live="polite" aria-label="Latest generation attempt" hidden></section></div>
      <div class="briefing-layout">
        <aside class="briefing-toc" id="briefToc" aria-label="Briefing sections"></aside>
        <article class="briefing-sheet">
          <div class="briefing-status" id="genStatus" role="status" aria-live="polite" aria-busy="false"></div>
          <div class="brief-content" id="briefContent"></div>
        </article>
      </div>
    </div>
  `;

  // Links retain native new-tab/context-menu behavior. Only an ordinary click
  // is routed in-app; save archive position before leaving a result list.
  main.addEventListener?.('click', handleBriefRouteLink);

  document.getElementById('briefHistory')?.addEventListener('change', (e) => {
    if (e.target.value) navigate(`/briefing/${encodeURIComponent(e.target.value)}`);
  });

  document.getElementById('briefExport')?.addEventListener('click', handleExport);
  for (const [id, mode] of [['briefOverviewMode', 'overview'], ['briefReadingMode', 'read'], ['briefSummaryMode', 'scan']]) {
    document.getElementById(id)?.addEventListener('click', () => selectReadingMode(mode));
  }
  document.getElementById('briefOverview')?.addEventListener('click', event => {
    const link = event.target.closest('[data-overview-open]');
    if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destination = new URL(link.getAttribute('href'), location.origin);
    if (destination.origin !== location.origin) return;
    event.preventDefault();
    selectReadingMode('read');
    const target = document.getElementById(decodeURIComponent(destination.hash.slice(1))) || document.getElementById('briefContent');
    target?.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: 'auto', block: 'start' });
    history.replaceState(history.state, '', destination.pathname + destination.search + destination.hash);
  });
  document.getElementById('briefEditionTools')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
  });
  document.getElementById('briefToolsClose')?.addEventListener('click', closeEditionTools);
  document.getElementById('briefGenerate')?.addEventListener('click', requestBriefGeneration);
  document.getElementById('briefDrafts')?.addEventListener('click', event => {
    closeDraftReview?.(); closeDraftReview = openDraftReview({ opener: event.currentTarget });
  });
  document.getElementById('briefContent')?.addEventListener('click', handleCopyDecision);
  document.getElementById('briefContent')?.addEventListener('click', event => {
    const citation = event.target.closest('.brief-cite-link, .brief-cite-back');
    if (citation && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      const target = document.getElementById((citation.getAttribute('href') || '').slice(1));
      if (target) {
        event.preventDefault();
        for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS') ancestor.open = true;
        target.scrollIntoView({ behavior: 'auto', block: 'center' });
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        history.replaceState(history.state, '', citation.getAttribute('href'));
      }
      return;
    }
    const original = event.target.closest('[data-review-original]');
    const sources = event.target.closest('[data-judgment-inputs]');
    const brief = getState().currentBrief;
    if (original) { closeOriginalEdition?.(); closeOriginalEdition = openOriginalEdition(brief, original); }
    if (sources && brief?.filename) { closeInputReceipt?.(); closeInputReceipt = openInputReceipt({ filename: brief.filename, receipt: receiptCache.get(brief.filename), opener: sources, judgment: Number(sources.dataset.judgmentInputs), review: brief.review }); }
  });
  document.getElementById('briefInputManifest')?.addEventListener('click', event => {
    const opener = event.target.closest('[data-open-inputs]');
    const filename = getState().currentBrief?.filename;
    if (!opener || !filename) return;
    closeInputReceipt?.();
    closeInputReceipt = openInputReceipt({ filename, receipt: receiptCache.get(filename), opener, review: getState().currentBrief?.review });
  });

  // Copy a permalink to the current briefing (expected for a doc that may reach leadership).
  document.getElementById('briefCopyLink')?.addEventListener('click', async () => {
    const fn = getState().currentBrief?.filename;
    const url = fn ? `${location.origin}/briefing/${encodeURIComponent(fn)}` : location.href;
    try { await navigator.clipboard.writeText(url); showToast('Link copied', 'success'); }
    catch { showToast('Could not copy link', 'error'); }
  });

  if (!initialized) {
    setupStoreListeners();
    // Reading-progress bar — a thin fill tracking scroll through the sheet. Bound
    // once; it reads the elements each tick and no-ops when the view isn't mounted.
    window.addEventListener('scroll', updateReadingProgress, { passive: true });
    window.addEventListener('resize', updateReadingProgress, { passive: true });
    initialized = true;
  }

  // Know whether the Generate CTA can succeed; if not, the empty state guides to Settings.
  // Keep the promise so handleRoute() can await it before the cold-start CTA decision.
  const request = ++settingsRequest;
  settingsLoading = true;
  reflectBriefGenerate();
  settingsReady = fetchSettings().then(s => {
    if (request !== settingsRequest) return;
    aiKnown = typeof s?.ai?.enabled === 'boolean';
    if (aiKnown) aiEnabled = s.ai.enabled;
  }).catch(() => {
    if (request === settingsRequest) aiKnown = false;
  }).finally(() => {
    if (request !== settingsRequest) return;
    settingsLoading = false;
    reflectBriefGenerate();
  });

  generationStatus?.stop();
  generationStatus = mountGenerationStatus(document.getElementById('briefAttemptStatus'), {
    isGenerating: () => getState().isGenerating,
    onState: model => {
      const host = document.getElementById('briefAttemptStatus');
      const destination = document.getElementById(model?.kind === 'complete' ? 'briefSuccessStatus' : 'briefAttemptSlot');
      if (host && destination && host.parentElement !== destination) destination.appendChild(host);
    },
  });
  handleRoute();
  loadHistoryDropdown();
}

function handleBriefRouteLink(event) {
  const link = event.target.closest?.('a[data-brief-route]');
  if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
  const href = link.getAttribute('href');
  if (!href?.startsWith('/briefing')) return;
  const current = `${window.location.pathname}${window.location.search || ''}`;
  if (archiveRoute(window.location.search).active) archiveScrollPositions.set(current, window.scrollY || 0);
  event.preventDefault();
  navigate(href);
}

function restoreArchiveScroll(token) {
  const key = `${window.location.pathname}${window.location.search || ''}`;
  const top = archiveScrollPositions.get(key) || 0;
  window.requestAnimationFrame?.(() => {
    if (token === contentRenderToken && archiveRoute(window.location.search).active) window.scrollTo?.({ top, behavior: 'auto' });
  });
}

function archiveSearchForm(query = '') {
  return `<form class="archive-search-form" id="archiveSearchForm" role="search"><label for="archiveQuery">Search saved briefings</label>
    <div><input id="archiveQuery" name="q" class="search-input" type="search" minlength="2" maxlength="200" value="${escapeHtml(query)}" placeholder="CVE, vendor, or topic…"><button class="btn-primary" type="submit">Search</button></div><label class="archive-sort-label"${query ? '' : ' hidden'}>Result order <select id="archiveSort"><option value="relevance">Best match</option><option value="newest">Newest edition</option></select></label></form>`;
}

function archiveResultsRegion(content, query = '') {
  if (!content.querySelector('#archiveSearchForm')) {
    content.innerHTML = `${archiveSearchForm(query)}<div id="archiveResults" aria-live="polite"></div>`;
    bindArchiveSearch();
  }
  const input = content.querySelector('#archiveQuery');
  if (input && document.activeElement !== input) input.value = query;
  const order = content.querySelector('#archiveSort');
  if (order) order.value = archiveRoute(window.location.search).sort;
  const sortLabel = content.querySelector('.archive-sort-label');
  if (sortLabel) sortLabel.hidden = !query;
  return content.querySelector('#archiveResults');
}

function bindArchiveSearch() {
  const form = document.getElementById('archiveSearchForm');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';
  form.addEventListener('submit', event => {
    event.preventDefault();
    const query = document.getElementById('archiveQuery')?.value.trim() || '';
    if (query.length === 1) return;
    navigate(archiveLocation(query, 1, document.getElementById('archiveSort')?.value));
  });
  document.getElementById('archiveSort')?.addEventListener('change', () => form.requestSubmit());
}

async function runArchive(page) {
  const content = document.getElementById('briefContent');
  if (!content) return;
  const token = ++contentRenderToken;
  showingGeneration = false;
  leaveDocument(content);
  setGenStatus('');
  content.setAttribute('aria-busy', 'true');
  const resultsRegion = archiveResultsRegion(content);
  resultsRegion.innerHTML = '<p role="status">Loading saved editions…</p>';
  const meta = document.getElementById('briefMeta');
  if (meta) meta.textContent = 'Archive';
  setPageTitle('Briefing archive');
  bindArchiveSearch();
  try {
    const data = await fetchArchivePage(page);
    if (token !== contentRenderToken) return;
    if (data.page !== page) history.replaceState(history.state, '', archiveLocation('', data.page));
    resultsRegion.innerHTML = archiveListHtml(data);
    content.removeAttribute('aria-busy');
    bindArchiveSearch();
    restoreArchiveScroll(token);
    announce(`${data.total} saved editions`);
  } catch {
    if (token !== contentRenderToken) return;
    content.removeAttribute('aria-busy');
    resultsRegion.innerHTML = '<div class="error-message" role="alert"><p>Saved editions could not load. Your archive is unchanged.</p><button type="button" class="btn-ghost" id="archiveRetry">Retry archive</button></div>';
    bindArchiveSearch();
    document.getElementById('archiveRetry')?.addEventListener('click', () => runArchive(page));
  }
}

// ── Store event wiring (bound once — DOM is re-queried per event) ──
function setupStoreListeners() {
  on('generation-started', () => generationStatus?.refresh());
  on('generating-changed', reflectBriefGenerate);
  on('ai-status-changed', ai => {
    // A newly saved/cleared key wins over an older settings request.
    settingsRequest++;
    settingsLoading = false;
    aiKnown = typeof ai?.enabled === 'boolean';
    if (aiKnown) aiEnabled = ai.enabled;
    reflectBriefGenerate();
  });
  on('route-changed', (data) => {
    if (data.mode === 'briefing') {
      // A pending debounced archive search belongs to the route it started on.
      // Cancel it before opening another briefing so a late search cannot replace
      // the newly-selected document with stale results.
      clearTimeout(searchTimer);
      searchTimer = null;
      try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }
      catch { window.scrollTo(0, 0); }
      handleRoute(data);
    }
  });

  on('brief-stream-reset', () => {
    const content = document.getElementById('briefContent');
    if (!content || !showingGeneration) return;
    // The server discarded its previous provider attempt. Cancel a coalesced
    // paint before it can restore that draft while the replacement starts.
    contentRenderToken++;
    leaveDocument(content);
    content._streamPending = '';
    showProgressSkeleton(content, 'Starting replacement draft…');
    announce('Previous draft replaced. Generating a new attempt.');
  });

  // Render the latest streamed snapshot through the same semantic formatter used by
  // completed briefs. Rebuilding on every token is needlessly expensive, so rapid
  // chunks are coalesced into one paint; each paint reads _streamPending to ensure it
  // uses the newest text rather than the chunk that happened to start the timer.
  on('brief-streaming', ({ accumulated, chunk }) => {
    const content = document.getElementById('briefContent');
    if (!content || !showingGeneration) return;
    // First chunk of a run (or a torn-down scaffold) → set up a document region plus
    // the cursor. Keeping the cursor outside the formatted snapshot prevents semantic
    // transforms (especially the final judgment card) from swallowing it.
    if (accumulated.length === chunk.length || !content.querySelector('#streamDocument')) {
      leaveDocument(content);
      content.innerHTML = '<p class="brief-draft-label">Draft · generating · not yet saved</p><div id="streamDocument"></div><span class="streaming-cursor"></span>';
      content.setAttribute('aria-busy', 'true');
      announce('Briefing generating');
    }
    content._streamPending = accumulated;
    if (!content._streamTimer) {
      const token = contentRenderToken;
      content._streamTimer = setTimeout(() => {
        content._streamTimer = null;
        if (!showingGeneration || token !== contentRenderToken) return;
        renderStreamSnapshot(content, content._streamPending || '');
      }, 300);   // smooth enough to read while bounding full-document DOM rebuilds
    }
  });

  on('generation-progress', ({ progressMsg }) => {
    if (showingGeneration) setGenStatus(progressMsg);
  });

  on('brief-generated', ({ brief, filename, text, timestamp, partial, validation, model, tokens, costUsd }) => {
    generationStatus?.refresh();
    // Generation runs in the background while the user may be browsing the
    // Wire, so #briefContent can be unmounted on completion. State (content, model,
    // warnings), history refresh, and the "saved" toast must land regardless — only
    // the actual DOM paint below needs the element to exist. Without this, a brief
    // that failed validation off-view re-renders clean later (warnings never stored),
    // and the operator never learns the save happened at all.
    const generatedBrief = brief || {
      filename,
      content: text,
      timestamp,
      generatedAt: timestamp,
      wordCount: countWords(text),
      model: model || null,
      costUsd: costUsd ?? null,
      warnings: validation?.warnings || [],
      sourceCheckStatus: 'passed-supported-checks',
      editorialReviewStatus: 'not-reviewed',
    };
    setState({ lastGeneratedBrief: generatedBrief });
    loadHistoryDropdown({ force: true });
    showToast('Briefing saved', 'success');
    const content = document.getElementById('briefContent');
    if (!content || !showingGeneration) return;
    contentRenderToken++;
    showingGeneration = false;
    setState({ currentBrief: generatedBrief });
    // Move the URL off /briefing/new once the brief has a real filename, so a
    // reload (or a copied/shared link) lands on the finished brief instead of the
    // now-stale "generating" route. replaceState (not navigate/pushState): this is a
    // URL correction for the SAME view, not a new navigation — no extra history entry,
    // no re-render of an already-rendered brief.
    const generatedFilename = getState().currentBrief?.filename;
    if (generatedFilename && window.location.pathname === '/briefing/new') {
      try { history.replaceState(history.state, '', `/briefing/${encodeURIComponent(generatedFilename)}`); } catch { /* non-critical */ }
    }
    if (content._streamTimer) { clearTimeout(content._streamTimer); content._streamTimer = null; }
    setGenStatus('');

    closeEditionTools();

    renderBriefContent(content, text, { hardFail: validation?.hardFail });   // the one full semantic render, on completion
    announce('Briefing ready');
    const prov = `· AI-generated${model ? ` · ${formatModelLabel(model)}` : ''}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}${Number.isFinite(costUsd) ? ` · ${formatCost(costUsd)}` : ''}`;
    setMeta(`${formatBriefPublication(getState().currentBrief)}${partial ? ' · partial (generation timed out)' : ''} · ${readingTime(text)} ${prov}`);
  });

  on('generation-error', (payload) => {
    generationStatus?.refresh();
    // A failure must surface even when the operator has navigated away from
    // the Briefing view; silently swallowing it left them discovering the failure
    // (or worse, a stale/empty state with no explanation) only when they returned.
    // Payload is a string for transient errors, or a structured failure. The
    // recoverable draft, when present, is the server-selected final attempt —
    // never substitute the SSE accumulator, which may contain multiple retries.
    const failure = generationFailureModel(payload);
    const {
      aiDisabled, streamLost, accumulatedText, recoverableDraft,
    } = failure;
    const msg = generationErrorMessage(failure);
    announce(aiDisabled ? 'AI Briefing is off'
      : streamLost ? 'Connection lost — generation may still complete on the server'
      : failure.code === 'E_EVIDENCE' ? 'Briefing did not start'
      : 'Draft not published');

    // A dropped stream connection does not mean the server-side run failed; it
    // typically keeps generating and archives the brief. Poll once, ~30s out, and
    // auto-navigate to the newly-appeared brief if it shows up — so the operator
    // isn't left believing a completed brief simply vanished.
    const content = document.getElementById('briefContent');
    if (!content || !showingGeneration) {
      // Off-view: no DOM to paint an inline error into — a toast is the only signal
      // the operator gets until they return to the Briefing.
      showToast(aiDisabled ? 'AI Briefing is off — add a key in Settings.' : msg, 'error');
      return;
    }
    leaveDocument(content);
    content.removeAttribute('aria-busy');
    if (streamLost) pollForRecoveredBrief();
    if (content._streamTimer) { clearTimeout(content._streamTimer); content._streamTimer = null; }
    setGenStatus('');
    if (aiDisabled) {
      renderAiOffState(content);
      return;
    }
    if (streamLost) {
      // Keep the accumulated text visible (rendered plainly, no semantic styling —
      // it's an in-progress fragment, not a finished brief) instead of discarding a
      // possibly-almost-complete brief. Retry is deliberately withheld here: the
      // server-side run is likely still in flight, and a Retry would just hit the
      // in-progress lock ("already generating"), compounding the confusion.
      content.innerHTML = `
        <div class="error-message stream-lost">
          <span>Connection lost — the brief may still complete on the server. Checking History in about 30 seconds…</span>
        </div>
        <p class="brief-draft-label">Draft · connection interrupted · not yet saved</p>
        ${accumulatedText ? renderDraftMarkdown(accumulatedText) : ''}
      `;
      return;
    }
    if (recoverableDraft) {
      // This draft failed the server's all-or-nothing publication gate. Render
      // it through the no-live-links draft sanitizer, label it unmistakably,
      // and keep it out of currentBrief/export/history state.
      content.innerHTML = `
        <div class="error-message recoverable-draft-notice" role="alert">
          <strong>Draft not published</strong>
          <p>${escapeHtml(msg)}</p>
          <p class="recoverable-draft-caution">Unvalidated draft · review only. No edition was published.</p>
          ${failure.draftArtifact ? '<button class="btn-primary" id="reviewDraft">Review saved draft</button>' : ''}
          <button class="btn-ghost" id="retryGen">Generate again</button>
        </div>
        <section class="recoverable-draft" aria-label="Unpublished briefing draft">
          <p class="recoverable-draft-label brief-draft-label">Unpublished draft · review only</p>
          ${renderDraftMarkdown(recoverableDraft)}
        </section>
      `;
      document.getElementById('retryGen')?.addEventListener('click', () => emit('generate-brief'));
      document.getElementById('reviewDraft')?.addEventListener('click', event => {
        closeDraftReview?.(); closeDraftReview = openDraftReview({ id: failure.draftArtifact.id, opener: event.currentTarget });
      });
      return;
    }
    content.innerHTML = `
      <div class="error-message">
        <span>${escapeHtml(msg)}</span>
        <button class="btn-ghost" id="retryGen">Retry</button>
      </div>
    `;
    document.getElementById('retryGen')?.addEventListener('click', () => emit('generate-brief'));
  });
}

async function handleRoute(data = resolveLocation(window.location.pathname).data) {
  disposePrintPreview();
  const content = document.getElementById('briefContent');
  if (!content) return;
  generationStatus?.refresh();

  const archive = archiveRoute(window.location.search);
  const archiveView = archive.active && !data?.action && !data?.filename;
  document.querySelector?.('.briefing-view')?.classList.toggle('briefing-view--archive', archiveView);
  if (archiveView) {
    const tools = document.getElementById('briefEditionTools');
    if (tools) tools.open = false;
    const search = document.getElementById('briefSearch');
    if (search) search.value = archive.query;
    if (archive.query.length >= 2) await runSearch(archive.query);
    else await runArchive(archive.page);
    return;
  }

  contentRenderToken++;
  const token = contentRenderToken;
  announce('');
  showingGeneration = data?.action === 'generate' && getState().isGenerating;
  clearTimeout(recoveredBriefTimer);
  recoveredBriefTimer = null;
  leaveDocument(content);
  const search = document.getElementById('briefSearch');
  if (search) search.value = '';

  // Generation in progress / requested → progress skeleton
  if (data?.action === 'generate') {
    // /briefing/new is an action URL, not a durable document. Generation sets its
    // state before navigating here; a pasted or reloaded action URL safely falls
    // back to the briefing desk instead of leaving a permanent loading skeleton.
    if (!getState().isGenerating) {
      navigate('/briefing');
      return;
    }
    setGenStatus('Collecting landscape data…');
    showProgressSkeleton(content);
    return;
  }

  // Any non-generation view clears a lingering generation status.
  setGenStatus('');

  // Resume the selected reading document, but always refresh its mutable review
  // metadata. A newly excluded edition must not become the desk's default.
  const selected = getState().currentBrief;
  const resuming = !data?.filename && !data?.skipResume && selected?.filename && eligibleEdition(selected)
    && new URLSearchParams(window.location.search || '').get('latest') !== '1';
  if (data?.filename || resuming) {
    const filename = data?.filename || selected.filename;
    showProgressSkeleton(content, 'Loading briefing…');
    try {
      const briefData = await fetchBrief(filename);
      if (token !== contentRenderToken) return;
      if (resuming && !eligibleEdition(briefData)) {
        await handleRoute({ skipResume: true });
        return;
      }
      const originalWarnings = Array.isArray(briefData.meta?.warnings) ? briefData.meta.warnings : [];
      const warnings = briefData.reviewedContent
        ? briefData.readingChecks?.warnings || ['Checks for this corrected copy are unavailable. Original generation notes remain in the review record.']
        : Array.isArray(briefData.meta?.warnings) ? originalWarnings : null;
      const displayedContent = briefData.reviewedContent || briefData.content;
      setState({ currentBrief: {
        filename,
        content: displayedContent,
        originalContent: briefData.content,
        review: briefData.review || null,
        readingChecks: briefData.readingChecks || null,
        originalWarnings,
        disposition: briefData.disposition || null,
        sourceCheckStatus: briefData.sourceCheckStatus || 'unavailable',
        editorialReviewStatus: briefData.editorialReviewStatus || 'not-reviewed',
        timestamp: null,
        generatedAt: archivePublishedAt(briefData),
        wordCount: briefData.reviewedContent ? displayedContent.trim().split(/\s+/).length : briefData.meta?.word_count ?? null,
        model: briefData.meta?.model_used || null,
        costUsd: briefData.meta?.estimated_cost_usd ?? null,
        inputManifest: briefData.inputManifest || null,
        warnings,
      } });
      renderBriefContent(content, displayedContent, { checkStructure: true });
      setMeta(`${formatBriefPublication(getState().currentBrief)} · ${readingTime(displayedContent, getState().currentBrief.wordCount)}${briefData.meta?.model_used ? ` · ${formatModelLabel(briefData.meta.model_used)}` : ''}${Number.isFinite(briefData.meta?.estimated_cost_usd) ? ` · ${formatCost(briefData.meta.estimated_cost_usd)}` : ''}`);
      syncHistoryDropdown(filename);
    } catch {
      if (token !== contentRenderToken) return;
      renderLoadError(content, data);
    }
    return;
  }

  // No eligible selected document: resolve the current eligible edition.
  showProgressSkeleton(content, 'Loading archive…');
  try {
    const briefs = await fetchBriefs({ fresh: true });
    if (token !== contentRenderToken) return;
    const latest = briefs?.find(eligibleEdition);
    if (latest) {
      navigate(`/briefing/${encodeURIComponent(latest.filename)}`);
      return;
    }
    if (briefs?.length) {
      content.removeAttribute('aria-busy');
      content.innerHTML = '<div class="empty-state"><h2>No edition available for Latest</h2><p>Saved editions require review or have been superseded. They remain available in the archive with their review status.</p><a data-brief-route href="/briefing?archive=1">Open archive</a></div>';
      return;
    }
  } catch {
    if (token === contentRenderToken) renderLoadError(content, data);
    return;
  }
  content.removeAttribute('aria-busy');

  // Wait for the real AI-enabled answer before choosing the cold-start CTA,
  // so a fresh server with no key never flashes "Generate" (which can't succeed)
  // before settling on "Add a key in Settings".
  await settingsReady;
  if (token !== contentRenderToken) return;
  if (aiKnown && !aiEnabled) {
    renderAiOffState(content);
    return;
  }
  content.innerHTML = `
    <div class="empty-state">
      <p class="empty-kicker">Daily Threat Landscape</p>
      <h2>No briefing yet</h2>
      <p>Generate the first threat landscape briefing from the latest scored signals.</p>
      <button class="btn-primary" id="emptyGenerate">${escapeHtml(generationControlState().label)}</button>
    </div>
  `;
  document.getElementById('emptyGenerate')?.addEventListener('click', requestBriefGeneration);
}

// No-key guided setup: a Generate that 503s is a dead end. Send the operator to
// Settings to add a key instead of offering a Retry that re-fails.
function renderAiOffState(content) {
  aiEnabled = false;
  aiKnown = true;
  reflectBriefGenerate();
  content.innerHTML = `
    <div class="empty-state">
      <p class="empty-kicker">Daily Threat Landscape</p>
      <h2>AI Briefing is off</h2>
      <p>Add an Anthropic API key in Settings to generate briefings. The Wire and the Wall keep running without one.</p>
      <button class="btn-primary" id="aiOffSettings">Add a key in Settings →</button>
    </div>
  `;
  document.getElementById('aiOffSettings')?.addEventListener('click', () => navigate('/settings'));
}

function renderBriefContent(content, text, { hardFail = false, checkStructure = false } = {}) {
  // This private identity is set only after a completed/history brief survives
  // the full sanitized + semantic render. Export uses it to distinguish that
  // document from an in-flight draft that happens to contain the same classes.
  content._validatedBriefContent = null;
  content.innerHTML = renderMarkdown(text);
  applySemanticStyling(content, { decisionControls: Boolean(getState().currentBrief?.filename) });
  const judgments = [...content.querySelectorAll('.brief-judgment-card > h3[id]')];
  const executive = content.querySelector('.brief-exec-panel');
  if (executive && judgments.length) {
    const index = content.ownerDocument.createElement('nav');
    index.className = 'brief-priority-index';
    index.setAttribute('aria-label', 'All assessments and complete responses');
    index.innerHTML = `<p>All ${judgments.length} assessments · complete responses</p><ol>${judgments.map(heading => `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.textContent)}</a></li>`).join('')}</ol>`;
    executive.before(index);
  }
  attachEditorialReview(content, getState().currentBrief);
  const persistedWarnings = getState().currentBrief?.warnings;
  const visibleWarnings = Array.isArray(persistedWarnings) && persistedWarnings.length
    ? persistedWarnings : checkStructure ? structuralWarnings(content) : [];
  if (visibleWarnings.length) renderValidationBanner(content, visibleWarnings, hardFail);
  content.querySelectorAll('.brief-judgment-card').forEach(card => {
    const number = card.querySelector('h3')?.id.match(/^judgment-(\d+)$/)?.[1];
    const tools = card.querySelector('.brief-judgment-tools');
    if (number && tools) { const button = content.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'btn-ghost-sm'; button.dataset.judgmentInputs = number; button.textContent = 'Evidence'; tools.prepend(button); }
  });
  const overview = document.getElementById('briefOverview');
  stopRecentDevelopments?.();
  stopRecentDevelopments = null;
  if (overview) {
    const judgmentMetadata = [...content.querySelectorAll('.brief-judgment-card')].map(card => briefRenderer.briefAssessmentMetadata?.(card));
    overview.innerHTML = renderOverview({ ...getState().currentBrief, warnings: visibleWarnings }, { judgmentMetadata });
    stopRecentDevelopments = mountRecentDevelopments(overview.querySelector('[data-overview-recent]'), briefingApi.fetchHeadlines);
  }
  if (new URLSearchParams(window.location.search || '').get('view') === 'report' || findBriefFragmentHeading(content, location.hash)) readingMode = 'read';
  applyReadingMode();
  buildTOC(content);
  content._validatedBriefContent = text;
  content.removeAttribute('aria-busy');
  reflectDocumentActions();
  const brief = getState().currentBrief;
  if (brief?.inputManifest?.status === 'available' && brief.filename) {
    const filename = brief.filename;
    const token = contentRenderToken;
    const cached = receiptCache.get(filename);
    const load = cached ? Promise.resolve(cached) : fetchInputReceipt(filename);
    load.then(receipt => {
      receiptCache.set(filename, receipt);
      if (receiptCache.size > 8) receiptCache.delete(receiptCache.keys().next().value);
      if (token === contentRenderToken && content._validatedBriefContent === text) enrichCitationTitles(content, receipt);
    }).catch(() => { /* The input dialog has an explicit retry; the saved brief stays readable. */ });
  }
}

function closeEditionTools() {
  const tools = document.getElementById('briefEditionTools');
  if (!tools) return;
  const summary = tools.querySelector('summary');
  const restoreFocus = document.activeElement !== summary && tools.contains?.(document.activeElement);
  tools.open = false;
  if (restoreFocus) summary?.focus();
}

function selectReadingMode(mode) {
  readingMode = mode === 'overview' ? 'overview' : 'read';
  try { localStorage.setItem('briefing.readingMode', readingMode); } catch { /* optional */ }
  const params = new URLSearchParams(window.location.search || '');
  const removeReportQuery = mode !== 'read' && params.get('view') === 'report';
  if (removeReportQuery) params.delete('view');
  if (removeReportQuery || (mode === 'overview' && location.hash)) {
    const query = params.toString();
    history.replaceState(history.state, '', window.location.pathname + (query ? `?${query}` : '') + (mode === 'overview' ? '' : location.hash || ''));
  }
  closeEditionTools();
  applyReadingMode();
  // Overview hides the document; update the section label only after it has a
  // real layout again, including when switching without a scroll gesture.
  window.requestAnimationFrame?.(() => refreshTocCurrent?.());
}

function applyReadingMode() {
  document.querySelectorAll('#briefContent .brief-judgment-support, #briefContent .brief-confidence-detail').forEach(node => { node.open = readingMode === 'read'; });
  const overview = document.getElementById('briefOverview');
  const showOverview = readingMode === 'overview' && Boolean(overview?.innerHTML);
  if (overview) overview.hidden = !showOverview;
  const layout = document.querySelector?.('.briefing-layout');
  if (layout) layout.hidden = showOverview;
  document.querySelector?.('.briefing-view')?.classList.toggle('briefing-view--overview', showOverview);
  for (const [id, mode] of [['briefOverviewMode', 'overview'], ['briefReadingMode', 'read'], ['briefSummaryMode', 'scan']]) {
    document.getElementById(id)?.setAttribute('aria-pressed', String(readingMode === mode));
  }
}

// A streaming snapshot is intentionally rebuilt from source markdown before each
// semantic pass. The formatter moves nodes into BLUF/judgment wrappers, so mutating
// previously formatted fragments in place would strand later chunks outside their
// section. The 300ms coalescing above keeps this bounded while preserving fidelity.
function renderStreamSnapshot(content, accumulated) {
  const documentRegion = content.querySelector('#streamDocument');
  if (!documentRegion) return;
  content._validatedBriefContent = null;
  documentRegion.innerHTML = renderDraftMarkdown(accumulated);
  applySemanticStyling(documentRegion);
}

// Flag a structurally-incomplete briefing so a reader never silently receives
// one missing its BLUF or a whole section. Warnings are server-computed.
function renderValidationBanner(content, warnings, hardFail = false) {
  const current = getState().currentBrief;
  const issues = current?.readingChecks?.issues || [];
  const sourceLines = String(current?.content || '').split('\n');
  const items = warnings.map(warning => {
    const issue = issues.find(item => item.message === warning);
    const at = Math.max(0, (issue?.location?.line || 1) - 1);
    const heading = sourceLines.slice(0, at + 1).findLast(line => /^#{2,3}\s/.test(line));
    const signal = /^###\s+Signal\s+(\d+)\b/.exec(heading || '');
    const label = (heading || '').replace(/^#{2,3}\s+/, '').replace(/\*\*/g, '').trim();
    const target = signal ? content.querySelector(`#judgment-${signal[1]}`)
      : [...content.querySelectorAll('h2, h3')].find(node => node.textContent.trim() === label);
    if (target && !target.id) target.id = `review-location-${at + 1}`;
    return `<li>${escapeHtml(warning)}${target ? ` <a href="#${escapeHtml(target.id)}">View passage</a>` : ''}${issue?.location?.excerpt ? `<p>${escapeHtml(issue.location.excerpt)}</p>` : ''}</li>`;
  }).join('');
  const banner = document.createElement(hardFail ? 'div' : 'details');
  banner.className = 'brief-validation-warning' + (hardFail ? ' hard-fail' : '');
  if (hardFail) {
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <strong>This briefing is missing a required section.</strong>
      <ul>${items}</ul>
      <button class="btn-ghost" id="briefRetry">Regenerate</button>
    `;
  } else {
    const editorial = warnings.filter(w => /^QA review:/i.test(w)).length;
    const automatic = warnings.length - editorial;
    const noteLabel = [automatic && `${automatic} automated ${automatic === 1 ? 'check' : 'checks'}`, editorial && `${editorial} later editorial ${editorial === 1 ? 'note' : 'notes'} (author/time not recorded)`].filter(Boolean).join(' · ');
    banner.innerHTML = `
      <summary><strong>Edition notes</strong><span>${noteLabel}</span></summary>
      <ul>${items}</ul>
    `;
  }
  content.prepend(banner);
  if (hardFail) banner.querySelector('#briefRetry')?.addEventListener('click', () => emit('generate-brief'));
}

// A brief opened from History never carried its generation-time validation
// warnings (they aren't persisted), so a brief that was incomplete at generation
// re-rendered as a clean, authoritative memo. Re-derive a lightweight structural
// check on load and re-flag it (soft — no Regenerate CTA on an archived brief) so
// the surface never asserts a completeness it can't verify.
function structuralWarnings(content) {
  const warnings = [];
  if (!content.querySelector('.bluf')) warnings.push('Missing the BLUF (bottom-line-up-front) section.');
  const hasKeyJudgments = [...content.querySelectorAll('h2')].some(h => /key judgment/i.test(h.textContent));
  if (!hasKeyJudgments) warnings.push('Missing the Key Judgments section.');
  return warnings;
}

let tocObserver = null;
let refreshTocCurrent = null;
let tocBreakpointCleanup = null;
let tocScrollCleanup = null;

// Intersection changes can stop before a smooth scroll reaches its final
// offset. Observe the actual scroll frames too, with one layout read per frame.
export function bindTocScroll(view, update) {
  let frame = null;
  let stopped = false;
  const schedule = () => {
    if (stopped || frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (!stopped) update();
    });
  };
  view.addEventListener('scroll', schedule, { passive: true });
  view.addEventListener('resize', schedule, { passive: true });
  schedule();
  return () => {
    stopped = true;
    view.removeEventListener('scroll', schedule);
    view.removeEventListener('resize', schedule);
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
  };
}

// Keep the disclosure's open state aligned with the same breakpoint CSS uses.
// The returned cleanup prevents route-to-route renders from retaining listeners
// bound to detached <details> nodes. Exported for a DOM-light regression test.
export function bindTocBreakpoint(mediaQuery, disclosure) {
  if (!mediaQuery || !disclosure) return () => {};
  const sync = event => {
    disclosure.open = !Boolean(event?.matches ?? mediaQuery.matches);
  };
  sync(mediaQuery);

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', sync);
    return () => mediaQuery.removeEventListener?.('change', sync);
  }
  if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(sync);
    return () => mediaQuery.removeListener?.(sync);
  }
  return () => {};
}

/**
 * Move both viewport and keyboard/screen-reader focus to one TOC destination.
 * Click navigation and a fragment restored after asynchronous Briefing loading
 * share this path; URL mutation remains the caller's responsibility.
 */
export function activateTocLink({
  link,
  target,
  toc = null,
  disclosure = null,
  compact = false,
  behavior = 'smooth',
} = {}) {
  if (!link || !target) return false;
  if (compact && disclosure) disclosure.open = false;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS') ancestor.open = true;
  }
  target.scrollIntoView?.({ behavior, block: 'start' });
  target.setAttribute?.('tabindex', '-1');
  target.focus?.({ preventScroll: true });
  setActiveTocLink(link, toc);
  return true;
}

/** Resolve only a fragment owned by this Briefing TOC. */
export function findTocFragmentLink(links = [], hash = '') {
  try {
    const targetId = decodeURIComponent(String(hash || '').replace(/^#/, ''));
    if (!targetId) return null;
    return links.find(link => link?.dataset?.target === targetId) || null;
  } catch {
    return null;
  }
}

// A copied judgment is intentionally absent from the compact section index.
// Restore any heading owned by this document, independently of TOC membership.
export function findBriefFragmentHeading(content, hash = '') {
  try {
    const id = decodeURIComponent(String(hash).replace(/^#/, ''));
    if (!id) return null;
    return [...content.querySelectorAll('h2[id], h3[id]'), ...content.querySelectorAll('.brief-cite-link[id], .brief-sources-appendix > li[id]')].find(heading => heading.id === id) || null;
  } catch { return null; }
}

// Prefer the most recent heading at the reading edge, then the first heading
// below it. Observer entries are only changes, not the full set in the viewport.
export function currentTocHeading(targets = [], readingEdge = 110) {
  const positions = targets.map(target => ({ target, top: target.getBoundingClientRect().top }))
    .filter(item => Number.isFinite(item.top));
  return positions.filter(item => item.top <= readingEdge).at(-1)?.target
    || positions[0]?.target || null;
}

function buildTOC(content) {
  const toc = document.getElementById('briefToc');
  if (!toc) return;
  tocScrollCleanup?.();
  tocScrollCleanup = null;
  if (tocBreakpointCleanup) {
    tocBreakpointCleanup();
    tocBreakpointCleanup = null;
  }
  const sections = extractSections(content);
  if (sections.length === 0) {
    toc.innerHTML = '';
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    return;
  }

  const link = (s, cls = '') => {
    const id = String(s.id || '');
    return `<a href="#${escapeHtml(encodeURIComponent(id))}" data-target="${escapeHtml(id)}" class="${cls}${s.secondary ? ' toc-secondary' : ''}">${escapeHtml(s.label)}</a>`;
  };
  // Keep the rail editorial, not exhaustive. Every signal remains deep-linkable,
  // but listing six long judgment headlines here turned navigation into a second,
  // cramped copy of the brief.
  const compactQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 900px)')
    : null;
  toc.innerHTML = `
    <details class="briefing-toc-disclosure">
      <summary class="briefing-toc-label">
        <span class="toc-label-wide">In this briefing</span>
        <span class="toc-label-compact">Jump to section</span>
        <span class="toc-current-label" aria-hidden="true"></span>
      </summary>
      <ul>
        ${sections.map(s => `<li>${link(s)}${s.children?.length ? `<details class="toc-judgments"><summary>${s.children.length} judgments</summary><ul>${s.children.map(child => `<li>${link(child)}</li>`).join('')}</ul></details>` : ''}</li>`).join('')}
      </ul>
    </details>
  `;

  const disclosure = toc.querySelector('.briefing-toc-disclosure');
  if (compactQuery) tocBreakpointCleanup = bindTocBreakpoint(compactQuery, disclosure);
  else if (disclosure) disclosure.open = true;

  const links = [...toc.querySelectorAll('a')];
  const navigateLink = (a, { updateHash = false, behavior = 'smooth' } = {}) => {
    const target = document.getElementById(a?.dataset?.target || '');
    const activated = activateTocLink({
      link: a,
      target,
      toc,
      disclosure,
      compact: Boolean(compactQuery?.matches),
      behavior,
    });
    if (!activated || !updateHash) return activated;
    try { history.replaceState(history.state, '', `#${encodeURIComponent(a.dataset.target)}`); } catch { /* non-critical */ }
    return true;
  };
  links.forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigateLink(a, { updateHash: true });
    });
  });
  let initialLink = links[0];
  const fragmentLink = findTocFragmentLink(links, location.hash);
  const fragmentHeading = findBriefFragmentHeading(content, location.hash);
  initialLink = fragmentLink || initialLink;
  if (fragmentHeading) {
    // Direct history routes load the article after the browser's one-shot
    // fragment pass. Once the matching heading exists, perform that navigation
    // ourselves without rewriting a valid (or unrelated) URL fragment.
    const token = contentRenderToken;
    const activate = () => {
      if (token !== contentRenderToken || content.isConnected === false) return;
      let sectionLink = fragmentLink;
      if (!sectionLink) {
        for (const heading of content.querySelectorAll('h2[id], h3[id]')) {
          if (heading.tagName === 'H2') sectionLink = links.find(a => a.dataset.target === heading.id) || sectionLink;
          if (heading === fragmentHeading) break;
        }
      }
      activateTocLink({ link: sectionLink || initialLink, target: fragmentHeading, toc, disclosure, compact: Boolean(compactQuery?.matches), behavior: 'auto' });
    };
    // Publication notes are inserted after semantic rendering; wait one frame
    // so their height is included in the restored fragment position.
    if (window.requestAnimationFrame) window.requestAnimationFrame(activate);
    else activate();
  } else {
    setActiveTocLink(initialLink, toc);
  }

  // Scrollspy — track the section in view, not just the last click.
  if (tocObserver) tocObserver.disconnect();
  const byId = new Map(links.map(a => [a.dataset.target, a]));
  const targets = [...content.querySelectorAll('h2[id], h3[id]')].filter(el => byId.has(el.id));
  const updateCurrentSection = () => {
    if (content.closest?.('.briefing-layout')?.hidden) return;
    const headerHeight = document.querySelector('.app-header')?.getBoundingClientRect().height || 86;
    const current = currentTocHeading(targets, headerHeight + 25);
    if (current) setActiveTocLink(byId.get(current.id));
  };
  refreshTocCurrent = updateCurrentSection;
  if (targets.length) tocScrollCleanup = bindTocScroll(window, updateCurrentSection);
  if ('IntersectionObserver' in window && targets.length) {
    tocObserver = new IntersectionObserver(updateCurrentSection, { rootMargin: '-90px 0px -65% 0px', threshold: 0 });
    targets.forEach(t => tocObserver.observe(t));
  }
}

function setActiveTocLink(a, toc = document.getElementById('briefToc')) {
  if (!a) return;
  toc?.querySelectorAll('a').forEach(x => {
    x.classList.remove('active');
    x.removeAttribute('aria-current');
  });
  a.classList.add('active');
  a.setAttribute('aria-current', 'location');
  const label = toc?.querySelector?.('.toc-current-label');
  if (label) label.textContent = a.textContent;
}

// Reading-progress fill — fraction of the briefing sheet scrolled past.
function updateReadingProgress() {
  const sheet = document.querySelector('.briefing-sheet');
  const bar = document.getElementById('briefProgress');
  if (!sheet || !bar) return;
  const rect = sheet.getBoundingClientRect();
  const scrollable = rect.height - window.innerHeight;
  const progress = scrollable > 0 ? Math.min(1, Math.max(0, -rect.top / scrollable)) : 0;
  bar.style.transform = `scaleX(${progress})`;
  // The final section can be shorter than the observer's top reading band.
  // Reaching the document foot should still identify Sources as current.
  if (rect.bottom <= window.innerHeight + 8 && rect.top < 0) {
    const links = document.getElementById('briefToc')?.querySelectorAll('a');
    if (links?.length) setActiveTocLink(links[links.length - 1]);
  }
}

function showProgressSkeleton(content, label = '') {
  // Status text lives in the persistent #genStatus sibling (above #briefContent)
  // so it survives the innerHTML reset when the first streamed chunk lands.
  content.setAttribute('aria-busy', 'true');
  content.innerHTML = `${label ? `<p class="gen-progress-status" role="status">${escapeHtml(label)}</p>` : ''}
    <div class="gen-progress" aria-hidden="true">
      <div class="skeleton-line" style="width: 45%"></div>
      <div class="skeleton-line" style="width: 92%"></div>
      <div class="skeleton-line" style="width: 88%"></div>
      <div class="skeleton-line" style="width: 60%"></div>
      <div class="skeleton-line" style="width: 90%; margin-top: 18px"></div>
      <div class="skeleton-line" style="width: 84%"></div>
      <div class="skeleton-line" style="width: 40%"></div>
    </div>
  `;
}

export async function runSearch(query) {
  const content = document.getElementById('briefContent');
  if (!content) return;
  // Capture the token BEFORE the await and bail if it's stale afterward,
  // mirroring handleRoute()'s guard (lines above). Without this, two overlapping
  // searches render last-response-wins instead of last-typed-wins, and a slow
  // search can land after the user has already opened a different brief from
  // History and clobber it with stale search results.
  const token = ++contentRenderToken;
  showingGeneration = false;
  leaveDocument(content);
  setGenStatus('');
  content.setAttribute('aria-busy', 'true');
  const resultsRegion = archiveResultsRegion(content, query);
  resultsRegion.innerHTML = `<p class="gen-progress-status" role="status">Searching archive for “${escapeHtml(query)}”…</p>`;
  const sort = archiveRoute(window.location.search).sort;
  const meta = document.getElementById('briefMeta');
  if (meta) meta.textContent = `Archive search · ${query}`;
  setPageTitle(`Briefing archive · ${query}`);
  try {
    const results = await searchBriefs(query, sort);
    if (token !== contentRenderToken) return;
    const count = results.length;
    content.removeAttribute('aria-busy');
    const countLabel = count >= 20 ? 'First 20 matches' : `${count} ${count === 1 ? 'result' : 'results'}`;
    if (meta) meta.textContent = `${countLabel} · ${query}`;
    // Announce the result count to assistive tech — a silent content swap otherwise.
    announce(`${count} ${count === 1 ? 'match' : 'matches'} for ${query}`);
    const head = `<p class="archive-count">Ordered by ${sort === 'newest' ? 'newest edition' : 'best match'} · ${countLabel}</p>
      <div class="search-head">
        <button class="btn-ghost-sm search-clear" id="searchClear">← Back to briefing</button>
        <a data-brief-route href="/briefing?archive=1">Browse all editions</a>
      </div>${count >= 20 ? '<p class="archive-count">Showing the first 20 matches. Add a more specific term to narrow the results.</p>' : ''}`;
    if (!count) {
      resultsRegion.innerHTML = `${head}<div class="empty-state"><p class="empty-kicker">Search</p><h2>No matches</h2><p>No briefings match “${escapeHtml(query)}”.</p></div>`;
    } else {
      // Show the formatted DATE (not the raw filename) + the matched snippet.
      resultsRegion.innerHTML = `${head}
        <div class="search-results">
          ${results.map(r => `
            <a class="search-result" data-brief-route href="/briefing/${encodeURIComponent(r.filename)}">
              <span class="search-result-date">${escapeHtml(formatBriefLabel(r.filename))}</span>
              <span class="search-result-snippet">${sanitizeSearchSnippet(r.snippet)}</span>
              ${r.snippetVersion === 'original-generated-edition' ? `<span class="archive-edition-review">Match in original generated edition · ${r.reviewStatus === 'editorially-corrected' ? 'opens corrected reading copy' : 'review could not be verified'}</span>` : ''}
              <span class="archive-edition-meta">${escapeHtml([formatEventTime(r.generatedAt), Number.isFinite(r.wordCount) && `${Math.max(1, Math.round(r.wordCount / 220))} min read`].filter(Boolean).join(' · '))}</span>
              <span class="brief-search-open">Open edition →</span>
            </a>`).join('')}
        </div>`;
    }
    bindArchiveSearch();
    restoreArchiveScroll(token);
    // A way back: clear the field and re-render the current/last brief.
    document.getElementById('searchClear')?.addEventListener('click', clearSearch);
  } catch {
    if (token !== contentRenderToken) return;
    content.removeAttribute('aria-busy');
    resultsRegion.innerHTML = `<div class="error-message brief-search-error" role="alert">
      <strong>Archive search could not finish</strong>
      <p>Your query “${escapeHtml(query)}” is still in the search field. Try again or return to the briefing.</p>
      <div class="brief-search-error-actions"><button type="button" class="btn-ghost" id="searchRetry">Retry search</button>
      <button type="button" class="btn-ghost" id="searchClear">Back to briefing</button></div>
    </div>`;
    document.getElementById('searchRetry')?.addEventListener('click', () => runSearch(query));
    document.getElementById('searchClear')?.addEventListener('click', clearSearch);
    bindArchiveSearch();
  }
}

function clearSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  const input = document.getElementById('briefSearch');
  if (input) input.value = '';
  const filename = getState().currentBrief?.filename;
  navigate(filename ? `/briefing/${encodeURIComponent(filename)}` : '/briefing?latest=1');
}

// Push a short message to the briefing's polite live region (search counts, etc.).
function announce(msg) {
  const live = document.getElementById('briefSrLive');
  if (live) live.textContent = msg;
}

// Open the print edition of the brief currently on screen (an in-app preview
// with an explicit Print / Save PDF action). Guards on a real rendered
// brief (a BLUF or a judgment) so a search-results / empty / progress view never
// exports as a blank paper. Model provenance is passed explicitly from state.
export function isBriefReadyForExport(content, currentBrief, isGenerating = false) {
  // startGeneration flips state before the first network chunk arrives. During
  // that gap the previous completed DOM/state can still match, so generation
  // itself is an explicit veto in addition to the draft-node checks below.
  if (isGenerating && !currentBrief?.filename) return false;
  if (!content || typeof currentBrief?.content !== 'string' || !currentBrief.content) return false;
  if (content._validatedBriefContent !== currentBrief.content) return false;
  if (content.querySelector('#streamDocument, .streaming-cursor, .error-message.stream-lost')) return false;
  return Boolean(content.querySelector('.bluf, .brief-judgment-card'));
}

export async function handleCopyDecision(event) {
  const button = event.target.closest('[data-copy-decision]');
  if (!button || button.disabled) return;
  const content = document.getElementById('briefContent');
  const card = button.closest('.brief-judgment-card');
  const { currentBrief, isGenerating } = getState();
  if (!card || !content?.contains(card) || !currentBrief?.filename || !isBriefReadyForExport(content, currentBrief, isGenerating)) {
    showToast('Open a saved briefing before copying a decision', 'error');
    return;
  }
  const headingId = card.querySelector('h3')?.id;
  const editionUrl = `${location.origin}/briefing/${encodeURIComponent(currentBrief.filename)}${headingId ? `#${encodeURIComponent(headingId)}` : ''}`;
  const text = decisionCopyText({ ...decisionCardContent(card), editionUrl, editionLabel: formatBriefPublication(currentBrief) });
  if (!text) return;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '✓ Decision copied';
    clearTimeout(button._copyFeedbackTimer);
    if (button.isConnected) button._copyFeedbackTimer = setTimeout(() => {
      if (button.isConnected) button.textContent = 'Copy decision';
    }, 1800);
    showToast('Decision copied with its edition link', 'success');
  } catch {
    showToast('Could not copy decision. Select the authored actions to copy them manually.', 'error');
  } finally {
    button.disabled = false;
  }
}

function handleExport(event) {
  const content = document.getElementById('briefContent');
  const { currentBrief, isGenerating } = getState();
  if (!isBriefReadyForExport(content, currentBrief, isGenerating)) {
    showToast('Generate or open a briefing before opening its print edition', 'error');
    return;
  }
  try {
    disposePrintPreview();
    closePrintPreview = exportBriefNewspaper({
      contentEl: content,
      opener: event?.currentTarget || document.getElementById('briefExport'),
      filename: currentBrief.filename || null,
      metaText: document.getElementById('briefMeta')?.textContent || '',
      model: currentBrief.model || '',
      generatedAt: currentBrief.generatedAt || currentBrief.timestamp || null,
      readMins: readingMinutes(
        currentBrief.content,
        currentBrief.wordCount,
      ),
      // Carry the persisted validation warnings so the printable edition can
      // note them in the colophon instead of silently stripping the on-screen banner.
      warnings: currentBrief.warnings || [],
      review: currentBrief.review || null,
    });
  } catch {
    showToast('Could not open print edition', 'error');
  }
}

function setMeta(text) {
  const el = document.getElementById('briefMeta');
  const host = document.getElementById('briefInputManifest');
  const brief = getState().currentBrief;
  if (el) el.textContent = brief?.content
    ? `${brief.filename === latestFilename ? 'Latest edition' : latestFilename ? 'Archived edition' : 'Saved edition'} · ${formatEditionIdentity(brief.filename)}`
    : text;
  const generationMeta = document.getElementById('briefGenerationMeta');
  if (generationMeta) { const previous = [brief?.model && formatModelLabel(brief.model), Number.isFinite(brief?.costUsd) && formatCost(brief.costUsd)].filter(Boolean).join(' · '); generationMeta.textContent = previous ? `Previous generation · ${previous}` : ''; }
  setPageTitle(brief?.filename ? `Briefing · ${formatBriefLabel(brief.filename)}` : 'Briefing');
  if (host) host.innerHTML = brief?.filename
    ? brief.inputManifest?.status === 'available'
      ? '<button type="button" class="btn-ghost-sm" data-open-inputs>Sources and saved inputs</button>'
      : 'Saved generation inputs unavailable for this edition.'
    : '';
  const publicationState = document.getElementById('briefPublicationState');
  if (publicationState) {
    publicationState.textContent = brief?.filename ? publicationStateLabel(brief) : '';
    publicationState.hidden = !(brief?.filename && (!eligibleEdition(brief) || brief.editorialReviewStatus === 'review-required' || brief.review?.status === 'unavailable' || brief.sourceCheckStatus === 'findings'));
  }
  const reviewState = document.getElementById('briefReviewState');
  if (reviewState) reviewState.textContent = brief?.filename ? publicationStateLabel(brief) : '';
  const reviewDisclosure = document.getElementById('briefContent')?.querySelector('.brief-review-summary');
  if (reviewDisclosure && brief?.review?.status === 'editorially-corrected' && !reviewDisclosure.querySelector('.brief-original-check-state')) {
    const original = document.createElement('p');
    original.className = 'brief-original-check-state';
    original.textContent = `Original generation source checks: ${brief.sourceCheckStatus === 'passed-supported-checks' ? 'supported checks passed' : brief.sourceCheckStatus === 'findings' ? 'findings recorded' : 'record unavailable'}. These checks describe the original generation, not a new validation of the corrected reading copy.`;
    reviewDisclosure.appendChild(original);
  }
}

export function publicationStateLabel(brief = {}) {
  const checks = brief.sourceCheckStatus === 'passed-supported-checks' ? 'Supported source checks passed'
    : brief.sourceCheckStatus === 'findings' ? 'Source checks have findings' : 'Source-check record unavailable';
  const reviewed = brief.editorialReviewStatus === 'reviewed' || brief.disposition?.editorialReviewStatus === 'reviewed';
  const editorial = brief.disposition?.status === 'superseded' ? 'Superseded edition'
    : brief.disposition?.status === 'review-required' || brief.editorialReviewStatus === 'review-required' ? 'Editorial review required'
      : brief.review?.status === 'editorially-corrected' ? 'Editorially corrected reading copy'
        : brief.review?.status === 'unavailable' ? 'Editorial review could not be verified'
          : reviewed ? 'Editorial review recorded' : 'Editorial review not recorded';
  if (brief.review?.status === 'editorially-corrected' && brief.disposition?.eligibleForLatest === true) return `${editorial} · Eligible for latest edition`;
  return `${editorial} · ${checks}${brief.review?.status === 'editorially-corrected' ? ' for the original generated revision' : ''}`;
}

export function eligibleEdition(brief) {
  return brief?.disposition?.eligibleForLatest !== false && !['review-required', 'superseded'].includes(brief?.disposition?.status);
}

// Persistent generation status (sibling of #briefContent). Survives the content
// reset on first stream chunk and drives screen-reader feedback for the whole
// run via role="status" + aria-live + aria-busy.
function setGenStatus(msg) {
  const el = document.getElementById('genStatus');
  if (el) {
    el.textContent = msg || '';
    el.classList.toggle('active', Boolean(msg));
    el.setAttribute('aria-busy', msg ? 'true' : 'false');
  }
  const content = document.getElementById('briefContent');
  if (content) content.setAttribute('aria-busy', msg ? 'true' : 'false');
}

// One reading-time estimator — trusts a server-computed word_count when present
// (the /briefs meta carries it) rather than re-splitting the whole text each time.
function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function readingMinutes(text, words) {
  const n = Number.isFinite(words) ? words : countWords(text);
  return Math.max(1, Math.round(n / 220));
}

function readingTime(text, words) {
  return `${readingMinutes(text, words)} min read`;
}

function formatModelLabel(model) {
  const raw = String(model || '');
  const m = raw.match(/claude-(sonnet|haiku|opus|fable|mythos)-(\d+)(?:-(\d+))?/i);
  if (!m) return raw;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

function formatCost(costUsd) {
  const digits = costUsd < 0.01 ? 4 : costUsd < 1 ? 3 : 2;
  return `est. $${costUsd.toFixed(digits)}`;
}

async function loadHistoryDropdown({ force = false } = {}) {
  const dropdown = document.getElementById('briefHistory');
  if (!dropdown && !force) return;
  if (!force && dropdown.options.length > 1) return;

  try {
    const briefs = await fetchBriefs({ fresh: true });
    latestFilename = briefs?.find(eligibleEdition)?.filename || null;
    if (getState().currentBrief?.content) setMeta('');
    // Refresh the archive cache after off-view completion too, but never paint
    // a dropdown belonging to a detached mount.
    if (!dropdown || dropdown !== document.getElementById('briefHistory')) return;
    if (!Array.isArray(briefs) || briefs.length === 0) return;
    const current = getState().currentBrief?.filename || '';
    // /briefs' `date` field has the sequence suffix stripped (routes/brief.js),
    // so same-day regenerations were indistinguishable ("2026-06-22" × 5). Render the
    // filename-derived label instead — it carries the "· brief N" suffix formatBriefLabel
    // already uses for the meta line and search results.
    dropdown.innerHTML = '<option value="">Past editions</option>' + briefs.map(b =>
      `<option value="${escapeHtml(b.filename)}"${b.filename === current ? ' selected' : ''}>${escapeHtml(formatBriefLabel(b.filename))}${eligibleEdition(b) ? '' : ` · ${b.disposition?.status === 'superseded' ? 'Superseded' : 'Review required'}`}</option>`
    ).join('');
  } catch { /* non-critical */ }
}

function syncHistoryDropdown(filename) {
  const dropdown = document.getElementById('briefHistory');
  if (!dropdown) return;
  for (const opt of dropdown.options) {
    opt.selected = opt.value === filename;
  }
}

// After a mid-stream connection drop, the server-side generation typically
// keeps running and archives the brief on its own; the client just lost the SSE
// connection, not the run itself. Snapshot the known filenames now, then re-check
// once ~30s out (a bypass fetch — the 20s cache TTL would otherwise mask a brief
// that lands mid-window) and auto-navigate to whichever filename is new, so a run
// that actually succeeded doesn't get filed as "failed" by the operator.
async function pollForRecoveredBrief() {
  clearTimeout(recoveredBriefTimer);
  const token = contentRenderToken;
  let before = [];
  try { before = (await fetchBriefs()) || []; } catch { /* best-effort */ }
  if (token !== contentRenderToken || !showingGeneration) return;
  const knownFilenames = new Set(before.map(b => b.filename));

  recoveredBriefTimer = setTimeout(async () => {
    recoveredBriefTimer = null;
    let after;
    try { after = await fetchBriefs({ fresh: true }); } catch { return; }
    if (token !== contentRenderToken || !showingGeneration) return;
    if (!Array.isArray(after)) return;
    const recovered = after.find(b => !knownFilenames.has(b.filename));
    if (!recovered) return;   // still nothing new — leave the "connection lost" state as-is
    loadHistoryDropdown({ force: true });
    showToast('The briefing completed after all — opening it now');
    navigate(`/briefing/${encodeURIComponent(recovered.filename)}`);
  }, 30_000);
}

// Invalidate work tied to the detached briefing DOM. The store listeners stay
// bound once for background generation events, but route/search requests started
// by this mount must not repaint or replace state after the operator leaves.
export function unmount() {
  disposePrintPreview();
  stopRecentDevelopments?.();
  stopRecentDevelopments = null;
  closeDraftReview?.();
  closeDraftReview = null;
  closeOriginalEdition?.();
  closeOriginalEdition = null;
  closeInputReceipt?.();
  closeInputReceipt = null;
  tocScrollCleanup?.();
  tocScrollCleanup = null;
  generationStatus?.stop();
  generationStatus = null;
  showingGeneration = false;
  clearTimeout(searchTimer);
  searchTimer = null;
  clearTimeout(recoveredBriefTimer);
  recoveredBriefTimer = null;
  const content = document.getElementById('briefContent');
  if (content?._streamTimer) {
    clearTimeout(content._streamTimer);
    content._streamTimer = null;
  }
  contentRenderToken++;
  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  refreshTocCurrent = null;
  if (tocBreakpointCleanup) {
    tocBreakpointCleanup();
    tocBreakpointCleanup = null;
  }
}

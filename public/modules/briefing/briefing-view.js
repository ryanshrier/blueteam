// BlueTeam.News — briefing view: generate, stream, read, history, search.

import { getState, setState, on, emit } from '../core/store.js';
import { escapeHtml, sanitizeSearchSnippet } from '../core/sanitize.js';
import { renderMarkdown } from '../core/markdown.js';
import { showToast } from '../core/toast.js';
import { applySemanticStyling, extractSections } from './brief-renderer.js';
import { exportBriefNewspaper } from './brief-export.js';
import { fetchBriefs, fetchBrief, searchBriefs, fetchSettings } from '../core/api.js';
import { navigate, resolveLocation } from '../core/router.js';

let initialized = false;
let contentRenderToken = 0;
let aiEnabled = true; // refreshed from /api/settings; gates the no-key guided path
let settingsReady = Promise.resolve(); // resolves once aiEnabled is known, so the cold-start empty state never races to the wrong CTA
let searchTimer = null; // module-scoped so route changes/unmount can cancel a pending archive search
let recoveredBriefTimer = null; // a recovered generation must never pull the operator away after leaving Briefing

export function render(main) {
  const firstMount = !initialized;   // animate the entrance once, not on every re-render
  main.innerHTML = `
    <div class="briefing-view">
      <div class="brief-progress" id="briefProgress" aria-hidden="true"></div>
      <header class="briefing-masthead">
        <div>
          <p class="view-kicker">Daily Threat Landscape</p>
          <h1 class="view-title">Briefing</h1>
          <p class="view-sub" id="briefMeta"></p>
          <p class="brief-provenance">AI-synthesized from sourced signals — verify CVE IDs, vendor names, dates, and links before acting</p>
        </div>
        <span class="sr-only" id="briefSrLive" aria-live="polite"></span>
        <div class="briefing-toolbar">
          <input class="search-input" id="briefSearch" type="search" placeholder="Search archive…" aria-label="Search briefings">
          <select class="history-select" id="briefHistory" aria-label="Previous briefings">
            <option value="">Past editions</option>
          </select>
          <button class="btn-ghost brief-copylink-btn" id="briefCopyLink" type="button" title="Copy a link to this briefing" aria-label="Copy link to this briefing">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
          </button>
          <button class="btn-ghost brief-export-btn" id="briefExport" type="button" title="Open the newspaper edition" aria-label="Open newspaper edition">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9V2h12v7"></path>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
              <rect x="6" y="14" width="12" height="8"></rect>
            </svg>
            Edition
          </button>
        </div>
      </header>

      <div class="briefing-layout">
        <aside class="briefing-toc" id="briefToc" aria-label="Briefing sections"></aside>
        <article class="briefing-sheet${firstMount ? ' briefing-sheet--enter' : ''}">
          <div class="briefing-status" id="genStatus" role="status" aria-live="polite" aria-busy="false"></div>
          <div class="brief-content" id="briefContent"></div>
        </article>
      </div>
    </div>
  `;

  document.getElementById('briefHistory')?.addEventListener('change', (e) => {
    if (e.target.value) navigate(`/briefing/${encodeURIComponent(e.target.value)}`);
  });

  document.getElementById('briefSearch')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    // Emptying the field restores the current/last brief immediately; a 1-char
    // fragment is a mid-type transient (below the server's 2-char floor), so hold.
    if (q.length === 0) { clearSearch(); return; }
    if (q.length < 2) return;   // align with the server's 2-char minimum
    searchTimer = setTimeout(() => runSearch(q), 350);
  });

  document.getElementById('briefExport')?.addEventListener('click', handleExport);

  // Copy a permalink to the current briefing (expected for a doc that may reach leadership).
  document.getElementById('briefCopyLink')?.addEventListener('click', async () => {
    const fn = getState().currentBrief?.filename;
    const url = fn ? `${location.origin}/briefing/${encodeURIComponent(fn)}` : location.href;
    try { await navigator.clipboard.writeText(url); showToast('Link copied'); }
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
  settingsReady = fetchSettings().then(s => { aiEnabled = s?.ai?.enabled !== false; }).catch(() => {});

  handleRoute();
  loadHistoryDropdown();
}

// ── Store event wiring (bound once — DOM is re-queried per event) ──
function setupStoreListeners() {
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

  // Render the latest streamed snapshot through the same semantic formatter used by
  // completed briefs. Rebuilding on every token is needlessly expensive, so rapid
  // chunks are coalesced into one paint; each paint reads _streamPending to ensure it
  // uses the newest text rather than the chunk that happened to start the timer.
  on('brief-streaming', ({ accumulated, chunk }) => {
    const content = document.getElementById('briefContent');
    if (!content) return;
    // First chunk of a run (or a torn-down scaffold) → set up a document region plus
    // the cursor. Keeping the cursor outside the formatted snapshot prevents semantic
    // transforms (especially the final judgment card) from swallowing it.
    if (accumulated.length === chunk.length || !content.querySelector('#streamDocument')) {
      content.innerHTML = '<div id="streamDocument"></div><span class="streaming-cursor"></span>';
      content.setAttribute('aria-busy', 'true');
      announce('Briefing generating');
    }
    content._streamPending = accumulated;
    if (!content._streamTimer) {
      content._streamTimer = setTimeout(() => {
        content._streamTimer = null;
        renderStreamSnapshot(content, content._streamPending || '');
      }, 300);   // smooth enough to read while bounding full-document DOM rebuilds
    }
  });

  on('generation-progress', ({ progressMsg }) => {
    setGenStatus(progressMsg);
  });

  on('brief-generated', ({ text, timestamp, partial, validation, model, tokens, costUsd }) => {
    // Generation runs in the background while the user may be browsing the
    // Wire, so #briefContent can be unmounted on completion. State (content, model,
    // warnings), history refresh, and the "saved" toast must land regardless — only
    // the actual DOM paint below needs the element to exist. Without this, a brief
    // that failed validation off-view re-renders clean later (warnings never stored),
    // and the operator never learns the save happened at all.
    const wordCount = countWords(text);
    setState({ currentBrief: {
      ...getState().currentBrief,
      content: text,
      timestamp,
      generatedAt: timestamp,
      wordCount,
      model: model || null,
      costUsd: costUsd ?? null,
      warnings: validation?.warnings || [],
    } });
    // Move the URL off /briefing/new once the brief has a real filename, so a
    // reload (or a copied/shared link) lands on the finished brief instead of the
    // now-stale "generating" route. replaceState (not navigate/pushState): this is a
    // URL correction for the SAME view, not a new navigation — no extra history entry,
    // no re-render of an already-rendered brief.
    const generatedFilename = getState().currentBrief?.filename;
    if (generatedFilename && window.location.pathname === '/briefing/new') {
      try { history.replaceState(history.state, '', `/briefing/${encodeURIComponent(generatedFilename)}`); } catch { /* non-critical */ }
    }
    loadHistoryDropdown({ force: true });
    showToast('Briefing saved');

    const content = document.getElementById('briefContent');
    if (!content) return;   // off-view: state is saved above; nothing left to paint
    if (content._streamTimer) { clearTimeout(content._streamTimer); content._streamTimer = null; }
    setGenStatus('');

    renderBriefContent(content, text);   // the one full semantic render, on completion
    announce('Briefing ready');
    if (validation?.warnings?.length) renderValidationBanner(content, validation.warnings, validation.hardFail);
    const prov = `· AI-generated${model ? ` · ${formatModelLabel(model)}` : ''}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}${Number.isFinite(costUsd) ? ` · ${formatCost(costUsd)}` : ''}`;
    setMeta(`${timestamp}${partial ? ' · partial (generation timed out)' : ''} · ${readingTime(text)} ${prov}`);
  });

  on('generation-error', (payload) => {
    // A failure must surface even when the operator has navigated away from
    // the Briefing view; silently swallowing it left them discovering the failure
    // (or worse, a stale/empty state with no explanation) only when they returned.
    // Payload is a string for transient errors, or { message, aiDisabled, streamLost, accumulatedText }.
    const aiDisabled = typeof payload === 'object' && payload?.aiDisabled;
    const streamLost = typeof payload === 'object' && payload?.streamLost;
    const accumulatedText = (typeof payload === 'object' && payload?.accumulatedText) || '';
    let msg = typeof payload === 'object' ? (payload?.message || '') : payload;
    // Map common failures to plain, actionable language.
    if (/E001|in progress|already running|already generating/i.test(msg)) msg = 'A briefing is already generating — wait for it to finish, then retry.';
    else if (/429|rate.?limit|overloaded|529/i.test(msg)) msg = 'The model is rate-limited or overloaded right now. Wait a moment and retry.';
    else if (/timed out|timeout/i.test(msg)) msg = 'Generation timed out. Retry, or reduce the brief size in config.';
    else if (/5\d\d|unavailable|network|failed to fetch/i.test(msg)) msg = 'The briefing service is temporarily unavailable. Retry shortly.';
    else if (!msg) msg = 'Generation failed. Retry, or check the server logs.';

    // A dropped stream connection does not mean the server-side run failed; it
    // typically keeps generating and archives the brief. Poll once, ~30s out, and
    // auto-navigate to the newly-appeared brief if it shows up — so the operator
    // isn't left believing a completed brief simply vanished.
    const content = document.getElementById('briefContent');
    if (!content) {
      // Off-view: no DOM to paint an inline error into — a toast is the only signal
      // the operator gets until they return to the Briefing.
      showToast(aiDisabled ? 'AI Briefing is off — add a key in Settings.' : msg, 'error');
      return;
    }
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
        ${accumulatedText ? renderMarkdown(accumulatedText) : ''}
      `;
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
  const content = document.getElementById('briefContent');
  if (!content) return;

  contentRenderToken++;
  const token = contentRenderToken;

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

  // Specific briefing
  if (data?.filename) {
    const filename = data.filename;
    const state = getState();
    if (state.currentBrief?.filename === filename && state.currentBrief?.content) {
      renderBriefContent(content, state.currentBrief.content);
      surfaceLoadedWarnings(content, state.currentBrief.warnings);
      setMeta(`${formatBriefLabel(filename)} · ${readingTime(state.currentBrief.content, state.currentBrief.wordCount)}${state.currentBrief.model ? ` · ${formatModelLabel(state.currentBrief.model)}` : ''}${Number.isFinite(state.currentBrief.costUsd) ? ` · ${formatCost(state.currentBrief.costUsd)}` : ''}`);
      return;
    }
    content.innerHTML = '<div class="gen-progress"><span class="gen-progress-status">Loading briefing…</span></div>';
    try {
      const briefData = await fetchBrief(filename);
      if (token !== contentRenderToken) return;
      const warnings = Array.isArray(briefData.meta?.warnings) ? briefData.meta.warnings : null;
      setState({ currentBrief: {
        filename,
        content: briefData.content,
        timestamp: null,
        generatedAt: briefData.generatedAt || briefData.meta?.generated_at || null,
        wordCount: briefData.meta?.word_count ?? null,
        model: briefData.meta?.model_used || null,
        costUsd: briefData.meta?.estimated_cost_usd ?? null,
        warnings,
      } });
      renderBriefContent(content, briefData.content);
      surfaceLoadedWarnings(content, warnings);
      setMeta(`${formatBriefLabel(filename)} · ${readingTime(briefData.content, briefData.meta?.word_count)}${briefData.meta?.model_used ? ` · ${formatModelLabel(briefData.meta.model_used)}` : ''}${Number.isFinite(briefData.meta?.estimated_cost_usd) ? ` · ${formatCost(briefData.meta.estimated_cost_usd)}` : ''}`);
      syncHistoryDropdown(filename);
    } catch {
      if (token !== contentRenderToken) return;
      content.innerHTML = '<div class="error-message"><span>Failed to load this briefing.</span></div>';
    }
    return;
  }

  // No specific briefing — show current or latest, else empty state
  const state = getState();
  if (state.currentBrief?.content) {
    renderBriefContent(content, state.currentBrief.content);
    setMeta(state.currentBrief.timestamp || '');
    return;
  }

  try {
    const briefs = await fetchBriefs();
    if (token !== contentRenderToken) return;
    if (briefs?.length > 0) {
      navigate(`/briefing/${encodeURIComponent(briefs[0].filename)}`);
      return;
    }
  } catch { /* fall through to empty state */ }

  // Wait for the real AI-enabled answer before choosing the cold-start CTA,
  // so a fresh server with no key never flashes "Generate" (which can't succeed)
  // before settling on "Add a key in Settings".
  await settingsReady;
  if (token !== contentRenderToken) return;
  if (!aiEnabled) {
    renderAiOffState(content);
    return;
  }
  content.innerHTML = `
    <div class="empty-state">
      <p class="empty-kicker">Daily Threat Landscape</p>
      <h2>No briefing yet</h2>
      <p>Generate the first threat landscape briefing from the latest scored signals.</p>
      <button class="btn-primary" id="emptyGenerate">Generate Briefing</button>
    </div>
  `;
  document.getElementById('emptyGenerate')?.addEventListener('click', () => emit('generate-brief'));
}

// No-key guided setup: a Generate that 503s is a dead end. Send the operator to
// Settings to add a key instead of offering a Retry that re-fails.
function renderAiOffState(content) {
  aiEnabled = false;
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

function renderBriefContent(content, text) {
  content.innerHTML = renderMarkdown(text);
  applySemanticStyling(content);
  buildTOC(content);
}

// A streaming snapshot is intentionally rebuilt from source markdown before each
// semantic pass. The formatter moves nodes into BLUF/judgment wrappers, so mutating
// previously formatted fragments in place would strand later chunks outside their
// section. The 300ms coalescing above keeps this bounded while preserving fidelity.
function renderStreamSnapshot(content, accumulated) {
  const documentRegion = content.querySelector('#streamDocument');
  if (!documentRegion) return;
  documentRegion.innerHTML = renderMarkdown(accumulated);
  applySemanticStyling(documentRegion);
}

// Flag a structurally-incomplete briefing so a reader never silently receives
// one missing its BLUF or a whole section. Warnings are server-computed.
function renderValidationBanner(content, warnings, hardFail = false) {
  const banner = document.createElement(hardFail ? 'div' : 'details');
  banner.className = 'brief-validation-warning' + (hardFail ? ' hard-fail' : '');
  if (hardFail) {
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <strong>This briefing is missing a required section.</strong>
      <ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      <button class="btn-ghost" id="briefRetry">Regenerate</button>
    `;
  } else {
    const noteLabel = `${warnings.length} automated ${warnings.length === 1 ? 'check needs' : 'checks need'} review`;
    banner.innerHTML = `
      <summary><strong>Edition notes</strong><span>${noteLabel}</span></summary>
      <ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
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
function revalidateLoaded(content) {
  const warnings = [];
  if (!content.querySelector('.bluf')) warnings.push('Missing the BLUF (bottom-line-up-front) section.');
  const hasKeyJudgments = [...content.querySelectorAll('h2')].some(h => /key judgment/i.test(h.textContent));
  if (!hasKeyJudgments) warnings.push('Missing the Key Judgments section.');
  if (warnings.length) renderValidationBanner(content, warnings, false);
}

// On load, prefer the brief's PERSISTED generation-time warnings (richer — they include
// ungrounded-CVE / banned-phrase flags the client can't re-derive). Fall back to the
// lightweight structural check for legacy briefs that predate persisted warnings.
function surfaceLoadedWarnings(content, persisted) {
  if (Array.isArray(persisted) && persisted.length) {
    // Soft only — a loaded/archived brief gets no Regenerate CTA (that would generate a
    // NEW brief, not fix this one); the warnings surface as a quiet notice.
    renderValidationBanner(content, persisted, false);
  } else {
    revalidateLoaded(content);
  }
}

let tocObserver = null;

function buildTOC(content) {
  const toc = document.getElementById('briefToc');
  if (!toc) return;
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
  toc.innerHTML = `
    <div class="briefing-toc-label">In this briefing</div>
    <ul>
      ${sections.map(s => `<li>${link(s)}</li>`).join('')}
    </ul>
  `;

  const links = [...toc.querySelectorAll('a')];
  links.forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(a.dataset.target);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Move focus to the destination so keyboard/SR users land there, not just visually.
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      setActiveTocLink(a);
      try { history.replaceState(history.state, '', `#${encodeURIComponent(a.dataset.target)}`); } catch { /* non-critical */ }
    });
  });

  // Scrollspy — track the section in view, not just the last click.
  if (tocObserver) tocObserver.disconnect();
  const byId = new Map(links.map(a => [a.dataset.target, a]));
  const targets = [...content.querySelectorAll('h2[id], h3[id]')].filter(el => byId.has(el.id));
  if ('IntersectionObserver' in window && targets.length) {
    tocObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter(en => en.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActiveTocLink(byId.get(visible[0].target.id));
    }, { rootMargin: '-90px 0px -65% 0px', threshold: 0 });
    targets.forEach(t => tocObserver.observe(t));
  }
}

function setActiveTocLink(a) {
  if (!a) return;
  const toc = document.getElementById('briefToc');
  toc?.querySelectorAll('a').forEach(x => x.classList.remove('active'));
  a.classList.add('active');
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
}

function showProgressSkeleton(content) {
  // Status text lives in the persistent #genStatus sibling (above #briefContent)
  // so it survives the innerHTML reset when the first streamed chunk lands.
  content.innerHTML = `
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

async function runSearch(query) {
  const content = document.getElementById('briefContent');
  if (!content) return;
  // Capture the token BEFORE the await and bail if it's stale afterward,
  // mirroring handleRoute()'s guard (lines above). Without this, two overlapping
  // searches render last-response-wins instead of last-typed-wins, and a slow
  // search can land after the user has already opened a different brief from
  // History and clobber it with stale search results.
  const token = ++contentRenderToken;
  try {
    const results = await searchBriefs(query);
    if (token !== contentRenderToken) return;
    const count = results.length;
    // Announce the result count to assistive tech — a silent content swap otherwise.
    announce(`${count} ${count === 1 ? 'match' : 'matches'} for ${query}`);
    const head = `
      <div class="search-head">
        <button class="btn-ghost-sm search-clear" id="searchClear">← Back to briefing</button>
        <span class="search-count">${count} ${count === 1 ? 'result' : 'results'} for “${escapeHtml(query)}”</span>
      </div>`;
    if (!count) {
      content.innerHTML = `${head}<div class="empty-state"><p class="empty-kicker">Search</p><h2>No matches</h2><p>No briefings match “${escapeHtml(query)}”.</p></div>`;
    } else {
      // Show the formatted DATE (not the raw filename) + the matched snippet.
      content.innerHTML = `${head}
        <div class="search-results">
          ${results.map(r => `
            <button class="search-result" data-filename="${escapeHtml(r.filename)}">
              <span class="search-result-date">${escapeHtml(formatBriefLabel(r.filename))}</span>
              ${sanitizeSearchSnippet(r.snippet)}
            </button>`).join('')}
        </div>`;
      content.querySelectorAll('.search-result').forEach(btn => {
        btn.addEventListener('click', () => navigate(`/briefing/${encodeURIComponent(btn.dataset.filename)}`));
      });
    }
    // A way back: clear the field and re-render the current/last brief.
    document.getElementById('searchClear')?.addEventListener('click', clearSearch);
  } catch {
    showToast('Search failed', 'error');
  }
}

function clearSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  const input = document.getElementById('briefSearch');
  if (input) input.value = '';
  handleRoute();
}

// Push a short message to the briefing's polite live region (search counts, etc.).
function announce(msg) {
  const live = document.getElementById('briefSrLive');
  if (live) live.textContent = msg;
}

// Open the printable newspaper edition of the brief currently on screen (an in-app
// preview with explicit Print/PDF and HTML-download actions). Guards on a real rendered
// brief (a BLUF or a judgment) so a search-results / empty / progress view never
// exports as a blank paper. Model provenance is passed explicitly from state.
function handleExport() {
  const content = document.getElementById('briefContent');
  if (!content || !content.querySelector('.bluf, .brief-judgment-card')) {
    showToast('Generate or open a briefing before exporting', 'error');
    return;
  }
  try {
    exportBriefNewspaper({
      contentEl: content,
      filename: getState().currentBrief?.filename || null,
      metaText: document.getElementById('briefMeta')?.textContent || '',
      model: getState().currentBrief?.model || '',
      generatedAt: getState().currentBrief?.generatedAt || getState().currentBrief?.timestamp || null,
      readMins: readingMinutes(
        getState().currentBrief?.content || '',
        getState().currentBrief?.wordCount,
      ),
      // Carry the persisted validation warnings so the printable edition can
      // note them in the colophon instead of silently stripping the on-screen banner.
      warnings: getState().currentBrief?.warnings || [],
    });
  } catch {
    showToast('Export failed', 'error');
  }
}

function setMeta(text) {
  const el = document.getElementById('briefMeta');
  if (el) el.textContent = text;
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

// One date formatter for the meta line and history — an archived filename slug
// ("brief-2026-06-29-01.md" → "2026-06-29-01") and a raw ISO date both render the
// same way: "Jun 29, 2026", with a "· brief N" suffix when more than one ran that day.
function formatBriefLabel(filename) {
  const m = (filename || '').match(/(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?/);
  if (!m) return (filename || '').replace(/^brief-/, '').replace(/\.md$/, '');
  const [, y, mo, d, seq] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  const date = Number.isNaN(dt.getTime())
    ? `${y}-${mo}-${d}`
    : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return seq && Number(seq) > 1 ? `${date} · brief ${Number(seq)}` : date;
}

async function loadHistoryDropdown({ force = false } = {}) {
  const dropdown = document.getElementById('briefHistory');
  if (!dropdown) return;
  if (!force && dropdown.options.length > 1) return;

  try {
    const briefs = await fetchBriefs();
    if (!Array.isArray(briefs) || briefs.length === 0) return;
    const current = getState().currentBrief?.filename || '';
    // /briefs' `date` field has the sequence suffix stripped (routes/brief.js),
    // so same-day regenerations were indistinguishable ("2026-06-22" × 5). Render the
    // filename-derived label instead — it carries the "· brief N" suffix formatBriefLabel
    // already uses for the meta line and search results.
    dropdown.innerHTML = '<option value="">Past editions</option>' + briefs.map(b =>
      `<option value="${escapeHtml(b.filename)}"${b.filename === current ? ' selected' : ''}>${escapeHtml(formatBriefLabel(b.filename))}</option>`
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
  let before = [];
  try { before = (await fetchBriefs()) || []; } catch { /* best-effort */ }
  const knownFilenames = new Set(before.map(b => b.filename));

  recoveredBriefTimer = setTimeout(async () => {
    recoveredBriefTimer = null;
    let after;
    try { after = await fetchBriefs({ fresh: true }); } catch { return; }
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
}

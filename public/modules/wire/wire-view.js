// BlueTeam.News — wire view: dense scannable list of scored headlines.

import { escapeHtml } from '../core/sanitize.js';
import { captureWireFocus, restoreWireFocus } from './wire-focus.js';
import { bindScoreDismissal, bindDisclosureDismissal } from './wire-popovers.js';
import { fetchHeadlines, fetchLandscape } from '../core/api.js';
import { on, off } from '../core/store.js';
import { navigate, rememberCurrentView } from '../core/router.js';
import { showToast } from '../core/toast.js';
import { TIER_NAMES, TIERS } from '../core/tiers.js';
import { openEvidenceInspector, closeEvidenceInspector, renderEvidenceContext } from './evidence-inspector.js';
import { highlightWireText, wireIcon, reflectReadControl } from './wire-presentation.js';
import { DECISION_STATES, DECISION_STORAGE_KEY, readDecisions, normalizeDecision, decisionForm, reflectDecisionDraft, filterChips, scanFacts, signalAssessmentMeta, exportContext, captureScrollAnchor } from './wire-workspace.js';
import {
  dateMs, parseCveData, filterSignals, parseWireQuery, serializeWireUrl, signalUrl, toCsv, sigKey as fmtSigKey, CSV_COLUMNS, briefingLinkModel, isFeedStale,
} from './wire-format.js';

// Human-readable labels for the scoreComponents breakdown. Keys mirror the
// per-headline h.scoreComponents emitted by scoring.js; unknown keys fall through
// to a humanized form so a new component never silently drops.
// The five normalized evidence axes (0–1) behind the 0–100 score. Order = the
// order they read in the breakdown panel (strongest evidence types first).
const SCORE_LABELS = {
  exploitation: 'Threat activity',
  severity: 'Severity',
  corroboration: 'Cross-source reporting',
  recency: 'Recency',
  relevance: 'Relevance',
};
const SCORE_AXIS_ORDER = ['exploitation', 'severity', 'corroboration', 'recency', 'relevance'];

// Triage is two axes: which horizon (single-select) AND which attributes
// (CRITICAL / KEV / Unread — independent toggles that compose). Sort is its own
// axis. `q` is the free-text filter, composing over everything else.
let filters = { horizon: 'all', critical: false, kev: false, unread: false, hidden: false, q: '' };
let sortMode = 'relevance'; // 'relevance' (server score order) | 'newest'

// Per-signal analyst state (read/dismiss), persisted to localStorage keyed
// by sigKey so it survives reload and composes across sessions. Two Sets, loaded
// once at module init and written back on every mutation:
//   readKeys      — every signal the analyst has opened (via title click or the
//                    score-breakdown affordance) or explicitly marked read.
//   dismissedKeys — signals kept in Hidden until restored, independently of read
//                    state. This browser preference does not change source data.
const LS_READ_KEY = 'wire.readKeys';
const LS_DISMISSED_KEY = 'wire.dismissedKeys';
const LS_SEEN_KEY = 'wire.seenKeys';   // persist the NEW-tag baseline across reloads
const PERSISTED_KEY_CAP = 2000;
let readKeys = loadKeySet(LS_READ_KEY);
let dismissedKeys = loadKeySet(LS_DISMISSED_KEY);
let lastDismissed = [];        // the most recent dismiss batch — feeds the "N hidden" undo chip
let undoChipTimer = null;      // the undo chip is transient; auto-clears so it can't stick around forever

let cachedHeadlines = [];
let convergence = [];     // landscape.convergence — feeds the cross-source triage strip
let lastGoodAt = 0;       // epoch ms of the last successful load — drives the reconnecting banner
// Signal-arrival state, split into two lifetimes. seenKeys is the baseline of
// signal identities; null until the first load so the initial 50 never all pulse.
// flashKeys drive the one-shot background flash (cleared ~1.5s after they render);
// arrivedKeys carry the PERSISTENT "NEW" tag, cleared only when the NEXT load establishes
// a new baseline in detectArrivals (so the tag survives a filter toggle, unlike the flash).
// seenKeys SEEDS from localStorage so the NEW baseline (and therefore which
// signals are "new") survives a page reload, not just a filter toggle within one
// session. A truly first-ever visit (nothing in localStorage) still seeds `null`, so
// the existing "don't flash the initial batch" behavior is unchanged for a new user.
let seenKeys = loadKeySet(LS_SEEN_KEY, null);
const flashKeys = new Set();
const arrivedKeys = new Set();
let arrivedClearTimer = null;
let refreshTimer = null;
let warmupTimer = null;
let warmupAttempts = 0;        // bound the cold-pipeline poll so it can't spin every 20s forever
const WARMUP_MAX = 15;         // ~5 min of 20s polls, then fall back to the 5-min refresh cadence
let arrivedCount = 0;          // how many genuinely-new signals arrived this load (for the AT announce)
let active = false;
// Module-scoped (not render()-local) so unmount() can clear it: a debounced
// keystroke that fires after the view is torn down must not resurrect the hash.
let searchDebounce = null;
// Freshness ticker: recomputes only the "refreshed Xm ago"/STALE meta line
// (and per-row ages) between loads, so the display never freezes for the full
// 5-min refresh interval. lastLoadData holds the last successful load() payload
// so the ticker can re-derive age without a network round-trip.
let freshnessTimer = null;
let lastLoadData = null;
let initialLoadFailed = false;
let scoreDismissalCleanup = null;
let controlDismissalCleanup = null;
const expandedDetails = new Set();
let focusedSignal = null;
let collectionHealth = null;
let selectedSignal = '';
let selectedSnapshot = null;
let inspectorFingerprint = '';
let clusterOpen = false;
let pendingData = null;
let savedScroll = 0;
let savedViewUrl = '';
let restoreScroll = false;
let controlsObserver = null;
const heldReviewed = new Set();
const decisionDrafts = new Map();
let decisions;
try { decisions = readDecisions(localStorage); } catch { decisions = new Map(); }
let density = 'compact';
try { density = localStorage.getItem('wire.density') === 'comfortable' ? 'comfortable' : 'compact'; } catch { /* session default */ }

// localStorage read/write for the persisted key Sets (read/dismissed/seen).
// Guarded: a private-browsing quota error or disabled storage must degrade to
// in-memory-only state, never throw and blank the view.
function loadKeySet(storageKey, fallback = new Set()) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return fallback;
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter(key => typeof key === 'string' && key).slice(-PERSISTED_KEY_CAP))
      : fallback;
  } catch {
    return fallback;
  }
}

function saveKeySet(storageKey, set) {
  try {
    while (set.size > PERSISTED_KEY_CAP) set.delete(set.values().next().value);
    localStorage.setItem(storageKey, JSON.stringify([...set]));
  } catch {
    // Quota exceeded or storage disabled — the session still works, just without
    // cross-reload persistence; not worth interrupting the analyst for.
  }
}

// Mark (or unmark) a signal read; persists immediately so the state survives
// a reload. Does NOT re-render by default — callers that want the dim to apply
// this render (an explicit toggle-click) re-render themselves; passive marks (an
// article click, opening the breakdown) leave the current render alone since the
// row is about to be navigated away from or is already visibly expanded.
function markRead(key, read, passive = true) {
  if (!key) return;
  if (read && passive && filters.unread) heldReviewed.add(key);
  else heldReviewed.delete(key);
  if (read) readKeys.add(key); else readKeys.delete(key);
  saveKeySet(LS_READ_KEY, readKeys);
  // Reflect passive inspection without rebuilding a row or closing its details.
  document.querySelectorAll('#wireList .wire-item').forEach(row => {
    if (row.dataset.key !== key) return;
    row.classList.toggle('is-read', read);
    row.querySelectorAll('[data-mark-read]').forEach(button => {
      reflectReadControl(button, read);
    });
  });
  reflectHeldReviewed();
}

// Hidden signals remain recoverable after the instant Undo expires. The Hidden
// view lists only records still available in the current feed.
function dismissSignal(key) {
  if (!key) return;
  dismissedKeys.add(key);
  saveKeySet(LS_DISMISSED_KEY, dismissedKeys);
  lastDismissed = [key];
  showUndoChip();
  renderList();
}

function restoreSignals(keys) {
  keys.forEach(key => dismissedKeys.delete(key));
  saveKeySet(LS_DISMISSED_KEY, dismissedKeys);
  lastDismissed = lastDismissed.filter(key => dismissedKeys.has(key));
  if (!lastDismissed.length) {
    clearTimeout(undoChipTimer);
    const undo = document.getElementById('wireUndoRow');
    if (undo) undo.innerHTML = '';
  }
  renderList();
}

// A transient "N hidden — Undo" chip above the list, auto-clearing after 8s.
// Uses a stable host so its delegated click handler binds once per mount.
let undoChipBound = false;
function showUndoChip() {
  const host = document.getElementById('wireUndoRow');
  if (!host) return;
  const n = lastDismissed.length;
  host.innerHTML = n
    ? `<button class="wire-qchip wire-undo-chip" type="button">${n} hidden — <span class="wire-qclear">Undo</span></button>`
    : '';
  if (!undoChipBound) {
    host.addEventListener('click', (e) => {
      if (!e.target.closest('.wire-undo-chip')) return;
      restoreSignals(lastDismissed);
    });
    undoChipBound = true;
  }
  clearTimeout(undoChipTimer);
  undoChipTimer = setTimeout(() => {
    lastDismissed = [];
    host.innerHTML = '';
  }, 8000);
}

export function render(main) {
  active = true;
  focusedSignal = null;
  parseQuery(); // Back/Forward and a bare /wire both restore the URL's view.
  main.innerHTML = `
    <div class="wire-view" data-density="${density}">
      <header class="wire-head">
        <div>
          <h1 class="view-title">Wire</h1>
          <p class="view-sub">Scored signals, ranked for defenders.</p>
        </div>
        <div class="wire-head-right">
          <!-- The latest saved edition can predate the current feed. -->
          <a class="wire-brieflink" id="wireBriefLink" href="/briefing" hidden>Latest briefing →</a>
          <span class="wire-meta" id="wireMeta">Loading signals…</span>
          <a class="wire-collection-health" id="wireCollectionHealth" href="/settings#systemHealth" hidden></a>
        </div>
      </header>

      <section class="wire-controls" aria-label="Wire controls">
        <!-- Search is the primary command. Count and export sit beside it instead of
             competing with the triage filters as another row of equal-weight pills. -->
        <div class="wire-command-row">
          <label class="wire-search-wrap" for="wireSearch">
            <span class="wire-sr-only">Filter signals by text</span>
            <input id="wireSearch" class="wire-search" type="search" placeholder="Search signals…" aria-description="Search titles, summaries, CVEs, vendors, actors, and source names" title="Search titles, summaries, CVEs, vendors, actors, and source names" autocomplete="off">
          </label>
          <details class="wire-filter-panel" id="wireFilterPanel">
            <summary class="wire-export-trigger">Filters <span id="wireFilterCount"></span><span aria-hidden="true">▾</span></summary>
            <div class="wire-filter-content">
              <p class="wire-filter-heading">Refine signals</p>
              <div id="wireFilterContent"></div>
            </div>
          </details>
          <details class="wire-view-tools" id="wireViewTools">
            <summary class="wire-export-trigger">View <span class="wire-sr-only">tools</span><span aria-hidden="true">▾</span></summary>
            <div class="wire-view-tools-content">
              <p class="wire-filter-heading">View tools</p>
              <span id="wireSortHost"></span>
              <label class="wire-density"><span>Row density</span><select id="wireDensity" aria-label="Row density"><option value="compact"${density === 'compact' ? ' selected' : ''}>Compact</option><option value="comfortable"${density === 'comfortable' ? ' selected' : ''}>Comfortable</option></select></label>
          <section class="wire-export is-disabled" id="wireExport" aria-label="Export filtered signals">
            <p class="wire-export-label">Export current results</p>
            <div class="wire-export-menu" role="group" aria-label="Export format">
              <button type="button" data-export="csv" disabled title="Download the currently filtered signals as CSV">CSV <small>Spreadsheet</small></button>
              <button type="button" data-export="json" disabled title="Download the currently filtered signals as JSON">JSON <small>Structured data</small></button>
            </div>
          </section>
            </div>
          </details>
        </div>

        <div class="wire-toolbar-status"><span class="wire-shown" id="wireShown">Loading…</span><span id="wireActiveFilters"></span><button type="button" class="wire-clear-control" id="wireClear" hidden>Clear</button></div>
        <div class="wire-update-row"><button type="button" id="wireApplyUpdates" hidden>Updated snapshot available · Apply</button><button type="button" id="wireClearReviewed" hidden></button></div>
        <div class="wire-filter-row" id="wireFilterRows">
          <!-- Tier is SINGLE-SELECT: a radiogroup with roving tabindex and arrow-key
               navigation. The segmented shell makes the four related choices read
               as one filter instead of four unrelated chips. -->
          <div class="wire-filters" id="wireHorizon" role="radiogroup" aria-label="Filter by tier">
            <button type="button" class="wire-filter active" data-horizon="all" role="radio" aria-checked="true" tabindex="0">All</button>
            ${TIERS.map(n => `<button type="button" class="wire-filter f-h${n}" data-horizon="${n}" role="radio" aria-checked="false" tabindex="-1">${TIER_NAMES[n][0]}${TIER_NAMES[n].slice(1).toLowerCase()}</button>`).join('\n            ')}
          </div>
          <span class="wire-control-divider" aria-hidden="true"></span>
          <div class="wire-toggles" id="wireToggles" role="group" aria-label="Filter by attribute">
            <button type="button" class="wire-toggle" data-toggle="critical" aria-pressed="false">Critical urgency</button>
            <button type="button" class="wire-toggle" data-toggle="kev" aria-pressed="false">KEV</button>
            <!-- Read records what has been opened; it does not mean resolved. -->
            <button type="button" class="wire-toggle" data-toggle="unread" aria-pressed="false">Unread</button>
            <button type="button" class="wire-toggle" data-toggle="watch" aria-pressed="false">Watch profile match</button>
            <button type="button" class="wire-toggle" data-toggle="changed" aria-pressed="false">Retained source changed</button>
            <button type="button" class="wire-toggle" data-toggle="alert" aria-pressed="false">Alert match</button>
            <button type="button" class="wire-toggle" id="wireHidden" data-toggle="hidden" aria-pressed="false" title="Show hidden signals still available in the feed">Hidden (0)</button>
          </div>
          <label class="wire-sort" for="wireSort">
            <span class="wire-sort-label">Sort signals</span>
            <select class="wire-sort-select" id="wireSort" aria-label="Sort signals">
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
            </select>
          </label>
        </div>

        <!-- Transient "N hidden — Undo" status for the most recent dismiss batch. -->
        <div class="wire-status-row" id="wireUndoRow" role="status" aria-live="polite"></div>
        <div class="wire-hidden-notice" id="wireHiddenNotice"></div>
      </section>

      <!-- Single screen-reader announcer: speaks the filtered count, the
           active filters, and any new arrivals on each render (the visible count and
           the arrival flash are otherwise silent to assistive tech). -->
      <span class="wire-sr-only" id="wireAnnounce" aria-live="polite" aria-atomic="true"></span>

      <!-- The convergence strip and empty state render into this host, OUTSIDE
           #wireList: ARIA lists (role="list") may only contain listitem/group children,
           so a role="region" strip or a plain message div as a direct child mis-announces
           the item count (or drops the region) to assistive tech. -->
      <div class="wire-workspace"><div class="wire-scan-column">
      <div class="wire-above-list" id="wireAboveList"></div>

      <!-- The list needs its own heading (h1 → h3 skip otherwise); visually hidden. -->
      <h2 class="wire-list-heading sr-only">Signals</h2>
      <!-- Visible column header, aligned to the item grid (styles), decorative to AT. -->
      <div class="wire-colhead" id="wireColumns" aria-hidden="true"><span class="ch-score" title="Priority score · 0–100 ranking">Priority</span><span class="ch-lead">Signal</span><span class="ch-meta">Source · Published</span></div>

      <div class="wire-list" id="wireList" role="list" aria-busy="true" aria-label="Scored signals">
        ${skeletonRows()}
      </div>
      </div><aside class="wire-inspector" id="wireInspector" aria-label="Selected signal inspector" hidden></aside></div>
    </div>
  `;

  const filterRows = document.getElementById('wireFilterRows');
  if (filterRows) document.getElementById('wireFilterContent')?.appendChild(filterRows);
  document.getElementById('wireSortHost')?.appendChild(document.querySelector('.wire-sort'));
  bindWorkspace(main);
  controlDismissalCleanup?.();
  controlDismissalCleanup = bindDisclosureDismissal([
    document.getElementById('wireViewTools'), document.getElementById('wireFilterPanel'),
  ]);

  reflectControls(); // push restored filter/sort state onto the buttons
  document.getElementById('wireClear')?.addEventListener('click', clearFilters);

  const horizonGroup = document.getElementById('wireHorizon');
  const selectHorizon = (btn) => {
    if (!btn) return;
    filters.horizon = btn.dataset.horizon;
    filters.signal = '';
    document.querySelectorAll('#wireHorizon .wire-filter').forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      // Single-select radios: aria-checked + roving tabindex, not aria-pressed.
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    syncUrl();
    renderList();
  };
  horizonGroup?.addEventListener('click', (e) => selectHorizon(e.target.closest('.wire-filter')));
  wireRovingRadios(horizonGroup, '.wire-filter', selectHorizon);

  document.getElementById('wireToggles')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.wire-toggle');
    if (!btn) return;
    const key = btn.dataset.toggle;
    filters.signal = '';
    filters[key] = !filters[key];
    btn.classList.toggle('active', filters[key]);
    btn.setAttribute('aria-pressed', String(filters[key]));
    syncUrl();
    renderList();
  });
  document.getElementById('wireHiddenNotice')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-restore-all]')) {
      restoreSignals(cachedHeadlines.map(sigKey).filter(key => dismissedKeys.has(key)));
      document.getElementById('wireHidden')?.focus();
    }
  });

  const sortSelect = document.getElementById('wireSort');
  sortSelect?.addEventListener('change', () => {
    sortMode = sortSelect.value === 'newest' ? 'newest' : 'relevance';
    syncUrl();
    renderList();
  });

  // Free-text filter, debounced 200ms so keystrokes don't thrash renderList/syncUrl.
  const searchInput = document.getElementById('wireSearch');
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      filters.q = searchInput.value.trim().slice(0, 100);
      filters.signal = '';
      filters.cluster = '';
      syncUrl();
      renderList();
    }, 200);
  });

  document.getElementById('wireExport')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    exportSignals(btn.dataset.export);
    const menu = btn.closest('details');
    if (menu) menu.open = false;
  });

  scoreDismissalCleanup?.();
  scoreDismissalCleanup = bindScoreDismissal(document.getElementById('wireList'));

  // At most one score breakdown open at a time. The panels are absolutely
  // positioned; stacking two overlaps the rows below. ('toggle' doesn't bubble, so
  // we catch it in the capture phase.)
  document.getElementById('wireList')?.addEventListener('toggle', (e) => {
    const opened = e.target;
    if (!(opened instanceof HTMLDetailsElement)) return;
    if (opened.classList.contains('wire-details')) {
      const key = opened.dataset.rowDetails;
      if (opened.open) expandedDetails.add(key); else expandedDetails.delete(key);
      return;
    }
    if (!opened.open) return;
    if (!opened.classList.contains('wire-score')) return;
    document.querySelectorAll('#wireList .wire-score[open]').forEach(d => {
      if (d !== opened) d.open = false;
    });
    const popup = opened.querySelector('.wire-score-breakdown');
    if (popup && window.innerWidth > 700) {
      const bounds = opened.getBoundingClientRect();
      const headerBottom = document.getElementById('appHeader')?.getBoundingClientRect().bottom || 0;
      const below = window.innerHeight - bounds.bottom - 16;
      const above = bounds.top - headerBottom - 16;
      const placeAbove = below < 280 && above > below;
      popup.dataset.placement = placeAbove ? 'above' : 'below';
      popup.style.setProperty('--score-space', `${Math.max(100, placeAbove ? above : below)}px`);
    }
    // Opening the score breakdown is investigating the signal; treat it as
    // read, same as clicking through to the article.
    const row = opened.closest('.wire-item');
    if (row) markRead(row.dataset.key, true);
  }, true);

  // Delegated click-to-copy, mark-read/dismiss, and auto-mark-read-on-open:
  // the CVE id chip, copy-link, mark-read, and dismiss affordances are all rebuilt on
  // every renderList(), so bind once here rather than per-row.
  const onRowAction = (e) => {
    const scoreClose = e.target.closest('[data-score-close]');
    if (scoreClose) {
      const score = scoreClose.closest('.wire-score');
      if (score) { score.open = false; score.querySelector('summary')?.focus({ preventScroll: true }); }
      return;
    }
    const evidenceBtn = e.target.closest('[data-evidence]');
    if (evidenceBtn) {
      const headline = cachedHeadlines.find(item => sigKey(item) === evidenceBtn.dataset.evidence)
        || (sigKey(selectedSnapshot) === evidenceBtn.dataset.evidence ? selectedSnapshot : null);
      if (headline) { markRead(sigKey(headline), true); openEvidenceInspector(headline, evidenceBtn); }
      return;
    }
    const cveBtn = e.target.closest('[data-copy-cve]');
    if (cveBtn) { copyToClipboard(cveBtn.dataset.copyCve, 'CVE copied', cveBtn); return; }
    const linkBtn = e.target.closest('[data-copy-link]');
    if (linkBtn) { copyToClipboard(linkBtn.dataset.copyLink, 'Link copied', linkBtn); return; }
    const sourceBtn = e.target.closest('[data-copy-source]');
    if (sourceBtn) { copyToClipboard(sourceBtn.dataset.copySource, 'Source URL copied', sourceBtn); return; }
    const readBtn = e.target.closest('[data-mark-read]');
    if (readBtn) {
      const key = readBtn.dataset.markRead;
      markRead(key, !readKeys.has(key), false);   // explicit click toggles read/unread
      renderList();
      return;
    }
    const dismissBtn = e.target.closest('[data-dismiss]');
    if (dismissBtn) { dismissSignal(dismissBtn.dataset.dismiss); return; }
    const restoreBtn = e.target.closest('[data-restore]');
    if (restoreBtn) {
      restoreSignals([restoreBtn.dataset.restore]);
      return;
    }
    // Clicking through to the article is investigating the signal; mark read
    // without forcing a re-render (the title link navigates away in a new tab, so
    // the dim state is only relevant on the NEXT render, e.g. after a filter toggle).
    if (e.target.closest('.wire-item-title')) {
      const row = e.target.closest('.wire-item');
      if (row) markRead(row.dataset.key, true);
    }
  };
  document.getElementById('wireList')?.addEventListener('click', onRowAction);
  document.getElementById('wireInspector')?.addEventListener('click', onRowAction);

  // The empty-filter state's "Clear all filters" button lives in
  // #wireAboveList (rebuilt each renderList()); delegate once.
  document.getElementById('wireAboveList')?.addEventListener('click', (e) => {
    const cluster = e.target.closest('.wire-converge-card');
    if (cluster && !e.button && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      navigate(cluster.getAttribute('href'));
      return;
    }
    if (e.target.closest('[data-wire-retry]')) { load(); return; }
    if (e.target.closest('.wire-show-visible')) {
      filters.hidden = false;
      reflectControls();
      syncUrl();
      renderList();
      document.getElementById('wireHidden')?.focus();
      return;
    }
    if (!e.target.closest('.wire-clear-filters')) return;
    clearFilters();
  });

  // j/k (and Down/Up) move focus between rows, one stop per signal, instead
  // of tabbing through every chip inside a row. Bound on the list container so it
  // survives renderList()'s innerHTML rebuilds without re-binding.
  document.getElementById('wireList')?.addEventListener('keydown', (e) => {
    const row = e.target.closest('.wire-item');
    if (!row) return;
    // Ignore navigation keys while focus is inside an interactive descendant of the
    // row (the score breakdown <details>, the CVE-copy button, etc.) — only the row
    // itself (the tab stop) should move focus on j/k.
    if (e.target.closest('input, select, textarea, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target === row && ['Enter', 'i', 'r', 'h', 'c'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Enter' || e.key === 'i') selectSignal(row.dataset.key, true);
      if (e.key === 'r') { markRead(row.dataset.key, !readKeys.has(row.dataset.key), false); renderList(); }
      if (e.key === 'h') dismissSignal(row.dataset.key);
      if (e.key === 'c') copyToClipboard(signalUrl({ link: row.dataset.key }, location.origin), 'Signal link copied', row);
      return;
    }
    if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (e.target !== row && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
    const rows = [...document.querySelectorAll('#wireList .wire-item')];
    const i = rows.indexOf(row);
    if (i === -1) return;
    const next = (e.key === 'j' || e.key === 'ArrowDown') ? rows[i + 1] : rows[i - 1];
    if (next) { e.preventDefault(); next.focus(); if (selectedSignal) selectSignal(next.dataset.key); }
  });

  // Module data survives a route round-trip. Paint that last-good snapshot into
  // the newly-created DOM immediately, before asking the server for a fresher one;
  // otherwise an initial reconnect failure leaves skeletons on screen even though
  // cachedHeadlines still contains usable intelligence.
  if (cachedHeadlines.length || lastLoadData) {
    renderFreshnessMeta();
    renderList();
  }
  load();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(load, 5 * 60_000);

  // Recompute the freshness meta (and per-row ages) every 30s independent
  // of the 5-min load() cadence, so "refreshed Xm ago" and the amber STALE flip
  // never lag reality by up to a full refresh interval on an unattended screen.
  clearInterval(freshnessTimer);
  freshnessTimer = setInterval(tickFreshness, 30_000);

  // React to router-level navigation while mounted (e.g. re-clicking WIRE
  // from the header, which navigates to bare '/wire' without necessarily
  // re-running render()). See onRouteChanged for the reconcile logic.
  off('route-changed', onRouteChanged); // idempotent: never double-bind across remounts
  on('route-changed', onRouteChanged);
}

function reflectHeldReviewed() {
  const button = document.getElementById('wireClearReviewed');
  const count = filters.unread ? heldReviewed.size : 0;
  if (button) { button.hidden = !count; button.textContent = `${count} reviewed, held here · Remove reviewed`; }
}

function selectSignal(key, focus = false) {
  selectedSignal = key;
  selectedSnapshot = cachedHeadlines.find(h => sigKey(h) === key) || selectedSnapshot;
  document.querySelectorAll('#wireList .wire-item').forEach(row => row.classList.toggle('is-selected', row.dataset.key === key));
  markRead(key, true);
  renderInspector();
  const wide = window.matchMedia?.('(min-width: 1000px)').matches;
  if (wide) {
    if (focus) document.getElementById('wireInspectorTitle')?.focus({ preventScroll: true });
  } else {
    const row = [...document.querySelectorAll('#wireList .wire-item')].find(item => item.dataset.key === key);
    const details = row?.querySelector('.wire-details');
    if (details) { details.open = true; expandedDetails.add(key); }
  }
}

function renderInspector() {
  const host = document.getElementById('wireInspector');
  if (!host) return;
  const headline = cachedHeadlines.find(h => sigKey(h) === selectedSignal) || (sigKey(selectedSnapshot) === selectedSignal ? selectedSnapshot : null);
  host.hidden = !headline;
  host.closest?.('.wire-workspace')?.classList.toggle('has-inspector', Boolean(headline));
  if (!headline) { host.innerHTML = ''; delete host.dataset.signal; inspectorFingerprint = ''; return; }
  selectedSnapshot = headline;
  const fingerprint = JSON.stringify([headline, decisions.get(selectedSignal), readKeys.has(selectedSignal), dismissedKeys.has(selectedSignal)]);
  const scope = host.querySelector('.wire-inspector-scope');
  const visible = applyFilters(cachedHeadlines).some(h => sigKey(h) === selectedSignal);
  if (scope) { scope.hidden = visible; scope.textContent = 'Selected snapshot retained here; this signal is outside the current results.'; }
  if (fingerprint === inspectorFingerprint) return;
  const scroll = host.dataset.signal === selectedSignal ? host.scrollTop : 0;
  host.dataset.signal = selectedSignal;
  inspectorFingerprint = fingerprint;
  host.innerHTML = `<div class="wire-inspector-chrome"><header class="wire-inspector-head"><p class="wire-retention-note">Selected signal</p><button type="button" data-inspector-close aria-label="Close selected signal">Close <span aria-hidden="true">×</span></button></header>
    <nav class="wire-inspector-nav" aria-label="Inspect neighboring signals"><button type="button" data-inspector-step="-1">← Previous</button><button type="button" data-inspector-step="1">Next →</button><a href="${escapeHtml(safeHref(headline.link) || signalUrl(headline))}" target="_blank" rel="noopener noreferrer">Source ↗</a></nav></div>
    <h2 id="wireInspectorTitle" tabindex="-1">${escapeHtml(headline.editorialContext?.title || headline.title)}</h2>
    <p class="wire-inspector-scope wire-retention-note"${visible ? ' hidden' : ''}>Selected snapshot retained here; this signal is outside the current results.</p><div class="wire-inspector-content">${signalDetailsHtml(headline)}</div>`;
  host.scrollTop = scroll;
}

function closeSignalInspector() {
  const row = document.querySelector('#wireList .is-selected');
  selectedSignal = ''; selectedSnapshot = null;
  renderInspector();
  row?.classList.remove('is-selected');
  (row?.querySelector('.wire-details > summary') || row || document.getElementById('wireSearch'))?.focus({ preventScroll: true });
}

function onWorkspaceStorage(event) {
  if (![DECISION_STORAGE_KEY, LS_READ_KEY, LS_DISMISSED_KEY].includes(event.key)) return;
  decisions = readDecisions(localStorage);
  readKeys = loadKeySet(LS_READ_KEY);
  dismissedKeys = loadKeySet(LS_DISMISSED_KEY);
  renderList();
}

function bindWorkspace(main) {
  const surface = main.querySelector('.wire-view');
  inspectorFingerprint = '';
  restoreScroll = true;
  const currentUrl = `${window.location.pathname}${window.location.search || ''}`;
  if (savedViewUrl !== currentUrl) savedScroll = 0;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
    if (active && !savedScroll && !filters.signal) window.scrollTo(0, 0);
  });
  const controls = surface.querySelector('.wire-controls');
  const measureControls = () => surface.style.setProperty('--wire-controls-height', `${Math.ceil(controls.getBoundingClientRect().height)}px`);
  measureControls();
  if (typeof ResizeObserver !== 'undefined') { controlsObserver = new ResizeObserver(measureControls); controlsObserver.observe(controls); }
  window.addEventListener('storage', onWorkspaceStorage);
  document.getElementById('wireDensity')?.addEventListener('change', event => {
    density = event.target.value === 'comfortable' ? 'comfortable' : 'compact';
    main.querySelector('.wire-view').dataset.density = density;
    try { localStorage.setItem('wire.density', density); } catch { /* session preference */ }
  });
  document.getElementById('wireApplyUpdates')?.addEventListener('click', () => {
    if (!pendingData) return;
    const data = pendingData; pendingData = null;
    document.getElementById('wireApplyUpdates').hidden = true;
    adoptSnapshot(data);
  });
  document.getElementById('wireClearReviewed')?.addEventListener('click', () => { heldReviewed.clear(); renderList(); document.getElementById('wireSearch')?.focus(); });
  document.getElementById('wireActiveFilters')?.addEventListener('click', event => {
    const key = event.target.closest('[data-remove-filter]')?.dataset.removeFilter;
    if (!key) return;
    if (key === 'sort') sortMode = 'relevance';
    else filters[key] = key === 'horizon' ? 'all' : ['q', 'cluster', 'signal'].includes(key) ? '' : false;
    if (key === 'signal') { filters.source = ''; filters.revision = ''; }
    if (key === 'unread') heldReviewed.clear();
    reflectControls(); syncUrl(); renderList();
    document.getElementById('wireSearch')?.focus();
  });
  document.getElementById('wireAboveList')?.addEventListener('toggle', event => {
    if (event.target.classList.contains('wire-converge')) clusterOpen = event.target.open;
  }, true);
  surface.addEventListener('click', event => {
    const summary = event.target.closest('.wire-details > summary');
    if (summary && window.matchMedia?.('(min-width: 1000px)').matches) { event.preventDefault(); selectSignal(summary.closest('.wire-item').dataset.key, true); return; }
    if (event.target.closest('[data-inspector-close]')) closeSignalInspector();
    const step = event.target.closest('[data-inspector-step]');
    if (step) {
      const items = applyFilters(cachedHeadlines);
      const next = items[items.findIndex(h => sigKey(h) === selectedSignal) + Number(step.dataset.inspectorStep)];
      if (next) selectSignal(sigKey(next), true);
    }
    if (event.target.closest('[data-recover-evidence]')) openLinkedEvidence();
    surface.querySelectorAll('.wire-row-menu[open]').forEach(menu => { if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false; });
  });
  surface.addEventListener('keydown', event => {
    const menu = event.target.closest('.wire-row-menu[open]');
    if (event.key === 'Escape' && menu) { menu.open = false; menu.querySelector('summary')?.focus(); event.stopPropagation(); return; }
    if (event.key === 'Escape' && selectedSignal && event.target.closest('#wireInspector') && !document.querySelector('dialog[open]')) {
      event.preventDefault(); event.stopPropagation(); closeSignalInspector();
    }
  });
  surface.addEventListener('input', event => {
    const form = event.target.closest('[data-decision-form]');
    if (form) {
      const draft = Object.fromEntries(new FormData(form));
      decisionDrafts.set(form.dataset.decisionForm, draft);
      reflectDecisionDraft(surface.querySelectorAll('[data-decision-form]'), form.dataset.decisionForm, draft, form);
    }
  });
  surface.addEventListener('submit', event => {
    const form = event.target.closest('[data-decision-form]');
    if (!form) return;
    event.preventDefault();
    const key = form.dataset.decisionForm;
    const headline = cachedHeadlines.find(h => sigKey(h) === key) || selectedSnapshot;
    const entry = normalizeDecision({ ...Object.fromEntries(new FormData(form)), recordedAt: new Date().toISOString() });
    if (!entry.evidence && headline?.evidence?.[0]) entry.evidence = signalUrl(headline, location.origin, headline.evidence[0]);
    decisions.set(key, entry); decisionDrafts.delete(key);
    while (decisions.size > PERSISTED_KEY_CAP) decisions.delete(decisions.keys().next().value);
    let persisted = true;
    try { localStorage.setItem(DECISION_STORAGE_KEY, JSON.stringify(Object.fromEntries(decisions))); } catch { persisted = false; }
    inspectorFingerprint = ''; renderList();
    [...surface.querySelectorAll('[data-decision-form]')].find(candidate => candidate.dataset.decisionForm === key && candidate.getClientRects().length)?.querySelector('button[type="submit"]')?.focus({ preventScroll: true });
    showToast(persisted ? 'Decision saved in this browser' : 'Decision kept for this session; browser storage unavailable', persisted ? 'success' : 'error');
  });
}

function openLinkedEvidence() {
  if (!filters.source) return;
  focusedSignal = `evidence:${filters.source}:${filters.revision}`;
  const headline = cachedHeadlines.find(h => sigKey(h) === filters.signal) || { title: 'Retained source investigation', link: safeHref(filters.signal) || '', evidence: [] };
  const evidence = headline.evidence?.find(source => source.sourceId === filters.source) || { sourceId: filters.source, revisionId: filters.revision, source: 'Retained source' };
  openEvidenceInspector({ ...headline, evidence: headline.evidence?.length ? headline.evidence : [evidence] }, document.getElementById('wireSearch'), { sourceId: filters.source, revisionId: filters.revision });
}

export function unmount() {
  savedScroll = window.scrollY;
  savedViewUrl = serializeWireUrl(filters, sortMode);
  window.removeEventListener('storage', onWorkspaceStorage);
  controlsObserver?.disconnect(); controlsObserver = null;
  active = false;
  scoreDismissalCleanup?.();
  scoreDismissalCleanup = null;
  controlDismissalCleanup?.();
  controlDismissalCleanup = null;
  closeEvidenceInspector();
  clearInterval(refreshTimer);
  refreshTimer = null;
  clearTimeout(warmupTimer);
  warmupTimer = null;
  warmupAttempts = 0;   // module state survives unmount; reset so a remount re-polls a cold pipeline
  clearTimeout(arrivedClearTimer);
  arrivedClearTimer = null;
  clearTimeout(searchDebounce);   // a pending debounced keystroke must not fire (and rewrite the hash) post-unmount
  searchDebounce = null;
  clearTimeout(freshnessTimer);   // stop the freshness-meta ticker; it targets DOM that's about to be torn down
  freshnessTimer = null;
  flashKeys.clear();
  arrivedKeys.clear();
  clearTimeout(undoChipTimer);   // a pending "N hidden" auto-clear must not touch a torn-down host
  undoChipTimer = null;
  undoChipBound = false;   // the #wireUndoRow host is recreated on remount; re-bind then
  off('route-changed', onRouteChanged); // stop reacting to route events once this view is torn down
}

// Arrow-key navigation for a single-select radiogroup: Left/Up and Right/Down move
// the selection (radio convention: moving focus selects), Home/End jump to the ends.
// Mirrors settings-view.js's wireRovingRadios; kept local so the two views stay decoupled.
function wireRovingRadios(container, itemSelector, select) {
  if (!container) return;
  container.addEventListener('keydown', (e) => {
    const list = [...container.querySelectorAll(itemSelector)];
    const i = list.indexOf(document.activeElement);
    if (i === -1) return;
    let next;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    list[next].focus();
    select(list[next]);
  });
}

// Six loading skeletons that mirror the item grid (ring + two title lines +
// meta), shown before the first load resolves. Decorative to AT (the count announcer and
// #wireMeta "Loading signals…" carry the state).
function skeletonRows() {
  return Array.from({ length: 6 }, () => (
    '<div class="wire-skel-row" aria-hidden="true"><span class="wsk-ring"></span>'
    + '<span class="wsk-lines"><i></i><i></i></span><span class="wsk-meta"></span></div>'
  )).join('');
}

// Deep-link state. Filters/sort live in the query (/wire?h=1&kev=1&sort=newest)
// so a triaged view is shareable and survives reload. Parse is defensive: any unknown
// or malformed param falls back to the default rather than throwing.
function parseQuery() {
  const p = parseWireQuery(window.location.search || '');
  if (p.signal && p.signal !== filters.signal) expandedDetails.add(p.signal);
  filters.horizon = p.horizon;
  filters.critical = p.critical;
  filters.kev = p.kev;
  filters.unread = p.unread;   // restore the deep-linked Unread toggle
  filters.hidden = p.hidden;
  filters.q = p.q;   // restore the deep-linked free-text filter
  sortMode = p.sort;
  filters.watch = !!p.watch;
  filters.changed = !!p.changed;
  filters.alert = !!p.alert;
  filters.signal = p.signal || '';
  filters.source = p.source || '';
  filters.revision = p.revision || '';
  filters.cluster = p.cluster || '';
}

// Serialize current filter/sort into the URL query without a history entry —
// replaceState keeps the back button from filling with every toggle.
function syncUrl() {
  // Belt-and-braces: a debounced/async caller (e.g. the search timeout)
  // firing after unmount() must never rewrite the URL out from under whatever
  // view is on screen now.
  if (!active) return;
  const url = serializeWireUrl(filters, sortMode);
  try {
    history.replaceState(history.state, '', url);
    rememberCurrentView();
  } catch {
    window.location.replace(url);
  }
}

// router.js emits 'route-changed' on every navigation, even when the
// mode doesn't change (e.g. clicking WIRE while already on a filtered Wire sets
// the URL to bare '/wire', which the router resolves but app.js never re-mounts
// since 'mode-changed' only fires on an actual mode transition). Without this,
// that click leaves the URL claiming "no filters" while the on-screen list (and
// this module's `filters`) stays exactly as filtered as before — a reload or a
// copied link then shows different data than the screen did. Reconcile the same
// way render() does: a query on the new URL is authoritative and gets parsed in;
// a bare path means keep in-memory state and re-stamp the URL to match it.
function onRouteChanged(data) {
  if (!active || !data || data.mode !== 'wire') return;
  // The URL is authoritative for Back/Forward and same-view signal links.
  parseQuery();
  focusedSignal = null;
  reflectControls();
  renderList();
  if (filters.source) openLinkedEvidence();
}

// Reflect the in-memory filter/sort state onto the freshly rendered controls so a
// deep-linked view shows the right buttons as active (markup defaults to all/relevance).
function reflectControls() {
  document.querySelectorAll('#wireHorizon .wire-filter').forEach(b => {
    const on = b.dataset.horizon === filters.horizon;
    b.classList.toggle('active', on);
    // Radiogroup: aria-checked + roving tabindex.
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('#wireToggles .wire-toggle').forEach(b => {
    const on = !!filters[b.dataset.toggle];
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on)); // KEV/CRITICAL stay true toggles
  });
  const sortSelect = document.getElementById('wireSort');
  if (sortSelect) sortSelect.value = sortMode;
  // Reflect the free-text filter onto the input for a deep-linked view.
  const searchInput = document.getElementById('wireSearch');
  if (searchInput) searchInput.value = filters.q || '';
}

// Export the CURRENT (filtered) signal set client-side. No server round-trip:
// the data is already in cachedHeadlines, so we re-run applyFilters and serialize.
function exportSignals(format) {
  const filtered = applyFilters(cachedHeadlines);
  if (!filtered.length) return; // nothing to download under the current filters
  // Carry the analyst's read/unread state into the export (a spread copy so
  // the export never mutates the cached headline objects renderList reads from).
  const capturedAt = new Date().toISOString();
  const items = filtered.map(h => exportContext(h, { read: readKeys.has(sigKey(h)), decision: decisions.get(sigKey(h)), filters, sort: sortMode, capturedAt, origin: location.origin }));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (format === 'json') {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `wire-signals-${stamp}.json`);
  } else {
    const blob = new Blob([toCsv(items, [...CSV_COLUMNS, 'read', 'signalUrl', 'exportedAt', 'filterDefinition', 'watchReasons', 'retainedSourceChanged', 'evidenceLinks', 'decision'])], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, `wire-signals-${stamp}.csv`);
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke async so the click has fired before the URL is torn down.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Shared clipboard write for the CVE-copy chip and the per-row copy-link
// button. navigator.clipboard requires a secure context; on failure (denied
// permission, insecure context) surface it rather than silently no-op'ing.
async function copyToClipboard(text, okMessage, trigger) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMessage, 'success');
    if (trigger?.isConnected) {
      const label = trigger.getAttribute('aria-label');
      trigger.classList.add('is-copied');
      trigger.setAttribute('aria-label', okMessage);
      setTimeout(() => {
        if (!trigger.isConnected) return;
        trigger.classList.remove('is-copied');
        if (label) trigger.setAttribute('aria-label', label);
      }, 1800);
    }
  } catch {
    showToast('Could not copy to clipboard', 'error');
  }
}

// Render the "refreshed Xm ago"/STALE meta line from the last load() snapshot,
// deriving current age locally (ageSeconds-at-load + elapsed wall-clock time) rather
// than the frozen value load() captured — so it stays honest between refreshes.
function renderFreshnessMeta() {
  const meta = document.getElementById('wireMeta');
  if (!meta || !lastLoadData) return;
  if (!lastLoadData.generatedAt) {
    meta.textContent = 'Pipeline starting — first signals surface as the feeds respond';
    meta.classList.remove('stale');
    return;
  }
  const generatedAtMs = Date.parse(lastLoadData.generatedAt);
  const reportedAge = lastLoadData.ageSeconds == null ? NaN : Number(lastLoadData.ageSeconds);
  const baseAge = Number.isFinite(reportedAge)
    ? Math.max(0, reportedAge)
    : (Number.isFinite(generatedAtMs) ? Math.max(0, (lastLoadData.loadedAt - generatedAtMs) / 1000) : null);
  if (baseAge == null) {
    meta.textContent = 'Feed refresh time unavailable';
    meta.classList.add('stale');
    return;
  }
  const elapsed = Math.max(0, (Date.now() - lastLoadData.loadedAt) / 1000);
  const ageSeconds = baseAge + elapsed;
  const stale = isFeedStale(ageSeconds, lastLoadData.refreshMinutes);
  meta.textContent = stale
    ? `Snapshot overdue — processed ${formatAge(ageSeconds)}`
    : `Snapshot processed ${formatAge(ageSeconds)}`;
  meta.classList.toggle('stale', stale);
  const health = document.getElementById('wireCollectionHealth');
  if (health) {
    const feeds = collectionHealth;
    const collection = lastLoadData.collection;
    const count = feeds?.total > 0 ? feeds.total : collection?.configuredSources;
    const available = feeds?.total > 0 ? feeds.ok : collection?.freshSources;
    health.hidden = !(Number.isFinite(count) && count > 0 && Number.isFinite(available));
    if (!health.hidden) {
      health.textContent = `${available}/${count} sources ${feeds?.total > 0 ? 'reachable' : 'fresh'}${available < count ? ' · collection needs attention' : ''}`;
      health.classList.toggle('is-degraded', available < count);
    }
  }
}

// The 30s ticker: recompute only the freshness meta and each row's <time>
// text/title/age-band in place. Deliberately NOT a full renderList() — that would
// yank open score breakdowns and scroll position every 30s for a text-only update.
function tickFreshness() {
  if (!active) return;
  renderFreshnessMeta();
  if (document.getElementById('wireReconnect')) showReconnecting();
  document.querySelectorAll('#wireList .wire-item').forEach(item => {
    const key = item.dataset.key;
    const h = cachedHeadlines.find(x => sigKey(x) === key);
    if (!h || h.dateUnknown) return;
    const timeEl = item.querySelector('time.wire-age');
    if (!timeEl) return;
    const age = relativeAge(h.date);
    if (age) timeEl.textContent = age;
    timeEl.dataset.ageBand = ageBand(h.date);
  });
}

function adoptSnapshot(data) {
  cachedHeadlines = data.headlines.filter(h => h && typeof h === 'object');
  for (const key of expandedDetails) if (!cachedHeadlines.some(h => sigKey(h) === key)) expandedDetails.delete(key);
  detectArrivals();
  lastGoodAt = Date.now();
  clearReconnecting();
  lastLoadData = { generatedAt: data?.generatedAt || null, ageSeconds: data?.ageSeconds, loadedAt: Date.now(), refreshMinutes: lastLoadData?.refreshMinutes, collection: data?.stats?.collection || null,
    enrichmentFailures: data.enrichmentFailures || data.stats?.enrichmentFailures || [] };
  renderFreshnessMeta();
  renderList();
  if (filters.source && focusedSignal !== `evidence:${filters.source}:${filters.revision}`) {
    focusedSignal = `evidence:${filters.source}:${filters.revision}`;
    openLinkedEvidence();
  }
}

async function load() {
  if (!lastLoadData) {
    initialLoadFailed = false;
    renderInitialState();
  }
  document.getElementById('wireList')?.setAttribute('aria-busy', 'true'); // announce the swap to AT
  try {
    const data = await fetchHeadlines();
    if (!active) return; // view was torn down mid-request
    if (!Array.isArray(data?.headlines)) throw new TypeError('Malformed headlines response');
    if (lastLoadData && data.generatedAt !== lastLoadData.generatedAt) {
      pendingData = data;
      const button = document.getElementById('wireApplyUpdates');
      if (button) { button.hidden = false; button.textContent = 'Updated snapshot available · Apply'; }
      document.getElementById('wireList')?.setAttribute('aria-busy', 'false');
    } else adoptSnapshot(data);
    // Convergence is decoration over the list — never let its failure or absence
    // block the headlines render. Cached 15s in api.js, so cheap to re-pull.
    fetchLandscape()
      .then(ls => {
        if (!active) return;
        convergence = Array.isArray(ls?.convergence) ? ls.convergence : [];
        collectionHealth = ls?.feeds || null;
        // The same configured refresh cadence drives freshness on Wall. A slow
        // healthy schedule must not read current there and stale in Wire.
        const cadence = Number(ls?.pipeline?.refreshMinutes);
        if (lastLoadData && Number.isFinite(cadence) && cadence > 0) lastLoadData.refreshMinutes = cadence;
        renderFreshnessMeta();
        const briefingLink = briefingLinkModel(ls?.brief);
        const link = document.getElementById('wireBriefLink');
        if (link) {
          link.hidden = !briefingLink;
          if (briefingLink) {
            link.textContent = briefingLink.text;
            link.href = briefingLink.href;
          }
        }
        renderList();
      })
      .catch(() => { collectionHealth = null; renderFreshnessMeta(); });
    if (!data?.generatedAt) {
      // The pipeline is still cold; poll faster than the 5-min refresh, but
      // only for a bounded window so an indefinitely-empty pipeline can't spin a
      // 20s loop forever. After the cap, the standing refreshTimer takes over.
      if (warmupAttempts < WARMUP_MAX) {
        warmupAttempts++;
        clearTimeout(warmupTimer);
        warmupTimer = setTimeout(load, 20_000);
      }
    } else {
      warmupAttempts = 0;   // pipeline warmed — reset so a later cold spell re-polls
    }
  } catch {
    if (!active) return;
    document.getElementById('wireList')?.setAttribute('aria-busy', 'false');
    // Keep the last-good list rather than discarding the intel on a transient blip;
    // overlay a quiet reconnecting banner. Only clear-to-empty if we never had data.
    if (cachedHeadlines.length || lastGoodAt) {
      showReconnecting();
    } else {
      initialLoadFailed = true;
      renderInitialState();
    }
  }
}

function setExportAvailable(available) {
  document.querySelectorAll('#wireExport [data-export]').forEach(btn => {
    btn.disabled = !available;
    btn.setAttribute('aria-disabled', String(!available));
  });
  const menu = document.getElementById('wireExport');
  menu?.classList.toggle('is-disabled', !available);
}

function renderInitialState() {
  const list = document.getElementById('wireList');
  const above = document.getElementById('wireAboveList');
  const meta = document.getElementById('wireMeta');
  const shown = document.getElementById('wireShown');
  const columns = document.getElementById('wireColumns');
  if (list) {
    list.setAttribute('aria-busy', String(!initialLoadFailed));
    list.innerHTML = initialLoadFailed ? '' : skeletonRows();
  }
  if (columns) columns.hidden = initialLoadFailed;
  if (meta) { meta.textContent = initialLoadFailed ? 'Feed unavailable' : 'Loading signals…'; meta.classList.toggle('stale', initialLoadFailed); }
  if (shown) shown.textContent = initialLoadFailed ? 'Unavailable' : 'Loading…';
  if (above) above.innerHTML = initialLoadFailed
    ? '<div class="wire-empty wire-load-error" role="status"><h2>Signals could not be loaded</h2><p>Could not reach the server. Try the feed again.</p><button type="button" class="wire-retry" data-wire-retry>Retry feed</button></div>' : '';
  setExportAvailable(false);
}

function clearFilters() {
  heldReviewed.clear();
  filters = { horizon: 'all', critical: false, kev: false, unread: false, hidden: filters.hidden, q: '' };
  sortMode = 'relevance';
  reflectControls();
  syncUrl();
  renderList();
  document.getElementById('wireSearch')?.focus();
}

// Quiet "reconnecting — last good Xm ago" banner above the kept list.
function showReconnecting() {
  const wrap = document.querySelector('.wire-view');
  if (!wrap) return;
  let banner = document.getElementById('wireReconnect');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'wireReconnect';
    banner.className = 'wire-reconnect';
    banner.setAttribute('role', 'status');
    banner.addEventListener('click', e => { if (e.target.closest('[data-wire-retry]')) load(); });
    const controls = wrap.querySelector('.wire-controls');
    if (controls) controls.insertAdjacentElement('afterend', banner);
    else wrap.prepend(banner);
  }
  const since = lastGoodAt ? formatAge(Math.round((Date.now() - lastGoodAt) / 1000)) : 'unknown';
  banner.innerHTML = `Reconnecting — showing last good signals from ${escapeHtml(since)} <button type="button" class="btn-ghost-sm" data-wire-retry>Retry now</button>`;
}

function clearReconnecting() {
  document.getElementById('wireReconnect')?.remove();
}

// sigKey is now the shared definition exported from wire-format.js (the same
// identity the read/dismissed persistence and filterSignals' unread filtering key
// off of); aliased locally so the rest of this file doesn't need a call-site rename.
const sigKey = fmtSigKey;

// h.link is feed-controlled (any of the ~49 feeds, or the untrusted Google-News
// sweep) and reaches here with no scheme filter upstream (feeds.js extractLink returns
// the raw item.link). escapeHtml only encodes markup, not the URL scheme, so an
// unguarded href could carry data:/blob:/a custom protocol handler. Allowlist http(s)
// before ever rendering the link as an href; anything else renders as plain text.
function safeHref(link) {
  if (!link) return null;
  try {
    const url = new URL(link);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

// Per-row "copy link" affordance: the article URL when the row has a safe
// href, else a `/wire?q=<CVE>` deep link so a colleague still lands on the exact
// signal (via the free-text filter) even when the source item carries no link.
function copyLinkBtn(h, href, cveInfo) {
  return `<button type="button" class="wire-copy-link" data-copy-link="${escapeHtml(signalUrl(h, location.origin))}" title="Copy signal link" aria-label="Copy signal link">${wireIcon('copy')}<span>Signal link</span></button>${href ? `<button type="button" class="wire-copy-source" data-copy-source="${escapeHtml(href)}">Copy source URL</button>` : ''}`;
}

// Diff the new load against the seen baseline. Fresh signals populate BOTH
// arrival sets, on two lifetimes: flashKeys drive a one-shot background pulse (cleared
// ~1.5s after render, so a later filter toggle never re-pulses them); arrivedKeys carry
// the persistent "NEW" tag and are reset HERE — at the next load's baseline — so the tag
// survives filter toggles but clears the moment a newer batch arrives.
// Cap the persisted seenKeys baseline so it can't grow unboundedly across
// months of reloads (a signal that ages out of the feed stays in the Set forever
// otherwise). Insertion order is chronological (Set preserves it), so trimming
// from the front drops the oldest-seen identities first.
function detectArrivals() {
  arrivedCount = 0;
  const keys = new Set(cachedHeadlines.map(sigKey));
  arrivedKeys.clear();   // a new load establishes a new baseline; drop the prior NEW tags
  if (seenKeys === null) { seenKeys = keys; saveKeySet(LS_SEEN_KEY, seenKeys); return; }   // first load is the baseline, no pulse
  const fresh = [...keys].filter(k => k && !seenKeys.has(k));
  let merged = new Set([...seenKeys, ...keys]);
  if (merged.size > PERSISTED_KEY_CAP) merged = new Set([...merged].slice(-PERSISTED_KEY_CAP));
  seenKeys = merged;
  saveKeySet(LS_SEEN_KEY, seenKeys);   // persist the new baseline so NEW survives the next reload
  if (!fresh.length) return;
  arrivedCount = fresh.length;   // surfaced to AT via the live region in renderList
  fresh.forEach(k => { flashKeys.add(k); arrivedKeys.add(k); });
  clearTimeout(arrivedClearTimer);
  arrivedClearTimer = setTimeout(() => { flashKeys.clear(); renderList(); }, 1500); // flash is one-shot; NEW tag persists
}

function applyFilters(headlines) {
  // Hidden selects dismissed records; the ordinary view excludes them. Read is
  // a separate axis, narrowing either view only when Unread is selected.
  const effectiveRead = new Set([...readKeys].filter(key => !heldReviewed.has(key)));
  return filterSignals(headlines, { ...filters, dismissedKeys, readKeys: effectiveRead }, sortMode);
}

// The active filters in words, for the screen-reader announcement (the pills
// carry aria-pressed visually; AT users get them named alongside the count).
function activeFilterSummary() {
  const parts = [];
  if (filters.signal) return 'Linked signal';
  if (filters.cluster) parts.push(`Cluster: ${filters.cluster.slice(filters.cluster.indexOf(':') + 1)}`);
  if (filters.horizon !== 'all') parts.push(TIER_NAMES[filters.horizon] || `tier ${filters.horizon}`);
  if (filters.critical) parts.push('Critical urgency');
  if (filters.kev) parts.push('KEV');
  if (filters.unread) parts.push('Unread');
  if (filters.watch) parts.push('Watch profile match');
  if (filters.changed) parts.push('Retained source changed');
  if (filters.alert) parts.push('Alert match');
  if (filters.q) parts.push(`matching "${filters.q}"`);
  return parts.join(', ');
}

// A one-line AT summary of the row's chip context (KEV/exploit/promoted/
// vendor/actor hedges), read via the row's aria-description so a keyboard/AT user
// gets the same information the (now non-tabbable) chips carried individually,
// without needing a tab stop per chip.
function rowDescription(h, cveInfo) {
  const tier = TIER_NAMES[h.horizon] || `Tier ${h.horizon || 'unknown'}`;
  const parts = [`${tier.toLowerCase()} tier`];
  const sourceCount = Number(h.corroboration) || 1;
  if (sourceCount > 1) parts.push(`reported by ${sourceCount} distinct sources`);
  if (h.isKEV) parts.push('KEV-listed');
  if (h.kevOverdue) parts.push('remediation overdue');
  if (cveInfo && cveInfo.exploit) parts.push('public exploit references exist');
  if (h.alertMatched) parts.push('matched an alert rule');
  else if (Number(h.originalHorizon) && Number(h.originalHorizon) !== h.horizon) parts.push('promoted by the pipeline');
  const vendorNames = (Array.isArray(h.vendors) ? h.vendors : [])
    .map(v => (typeof v === 'string' ? v : v && v.name)).filter(Boolean);
  if (vendorNames.length) parts.push(`affects ${vendorNames.join(', ')} (heuristic)`);
  const actorNames = (Array.isArray(h.actors) ? h.actors : [])
    .map(a => (typeof a === 'string' ? a : a && a.name)).filter(Boolean);
  if (actorNames.length) parts.push(`linked to ${actorNames.join(', ')} (heuristic)`);
  return parts.join('; ');
}

function renderList() {
  const chips = filterChips(filters, sortMode, TIER_NAMES);
  const clearControl = document.getElementById('wireClear');
  if (clearControl) clearControl.hidden = !chips.length;
  const activeSummary = activeFilterSummary();
  const activeLabel = document.getElementById('wireActiveFilters');
  if (activeLabel) activeLabel.innerHTML = chips.map(chip => `<button type="button" data-remove-filter="${chip.key}" aria-label="Remove ${escapeHtml(chip.label)}">${escapeHtml(chip.label)} <span aria-hidden="true">×</span></button>`).join('');
  const count = document.getElementById('wireFilterCount');
  if (count) count.textContent = chips.length ? String(chips.length) : '';
  reflectHeldReviewed();
  if (!lastLoadData) { renderInitialState(); return; }
  const list = document.getElementById('wireList');
  if (!list) return;
  list.setAttribute('aria-busy', 'false'); // the swap is done; release the AT busy state

  const items = applyFilters(cachedHeadlines);
  const hiddenCount = cachedHeadlines.filter(h => dismissedKeys.has(sigKey(h))).length;
  const availableCount = filters.hidden ? hiddenCount : cachedHeadlines.length - hiddenCount;
  const hiddenControl = document.getElementById('wireHidden');
  if (hiddenControl) {
    hiddenControl.textContent = `Hidden (${hiddenCount})`;
    hiddenControl.classList.toggle('active', filters.hidden);
    hiddenControl.setAttribute('aria-pressed', String(filters.hidden));
  }
  const hiddenNotice = document.getElementById('wireHiddenNotice');
  if (hiddenNotice) hiddenNotice.innerHTML = filters.hidden
    ? `<p><strong>Hidden signals</strong><br>Filters apply. Restoring preserves read/unread state.</p>${hiddenCount ? `<div><button type="button" class="btn-ghost-sm wire-restore-all" data-restore-all title="Restore all ${hiddenCount} available hidden ${hiddenCount === 1 ? 'signal' : 'signals'}, regardless of the current filters">Restore all hidden (${hiddenCount})</button><small>Includes signals outside the current filters.</small></div>` : ''}`
    : '';
  list.setAttribute('aria-label', filters.hidden ? 'Hidden scored signals' : 'Scored signals');
  list.classList.toggle('is-hidden-view', filters.hidden);

  // Preserve the analyst's place across the swap (the 5-min auto-refresh, or
  // a filter toggle): remember which score breakdowns were open (by signal key) and
  // the scroll position, then restore them after the innerHTML rebuild.
  const openKeys = new Set(
    [...list.querySelectorAll('.wire-item')]
      .filter(it => it.querySelector('.wire-score[open]'))
      .map(it => it.dataset.key)
      .filter(Boolean),
  );
  const prevScroll = window.scrollY;
  // At the masthead, late-arriving group/freshness controls must not scroll the
  // page to hold its first story in place. Anchor only an existing reading offset.
  const anchor = prevScroll > 0 ? captureScrollAnchor(list, document.querySelector('.wire-controls')?.getBoundingClientRect().bottom || 0) : null;
  const savedFocus = captureWireFocus(list, document.activeElement);

  const shown = document.getElementById('wireShown');
  const countNoun = `${filters.hidden ? 'hidden ' : ''}${availableCount === 1 ? 'signal' : 'signals'}`;
  if (shown) {
    shown.textContent = items.length === availableCount
      ? `${items.length} ${countNoun}` : `${items.length} of ${availableCount} ${countNoun}`;
  }

  // Speak the result: filtered count, active filters, and new arrivals.
  const announce = document.getElementById('wireAnnounce');
  if (announce) {
    const filterWords = activeFilterSummary();
    const parts = [
      `${items.length} of ${availableCount} ${countNoun}`,
      filterWords ? `filtered by ${filterWords}` : '',
      arrivedCount ? `${arrivedCount} new` : '',
    ].filter(Boolean);
    announce.textContent = parts.join(' · ');
  }
  arrivedCount = 0;   // consumed once per load; a later filter render must not re-announce "N new"

  // An export with nothing to write is a dead click; disable the buttons
  // (an honest, visible state) rather than silently no-op'ing on a click.
  const empty = items.length === 0;
  setExportAvailable(!empty);
  const columns = document.getElementById('wireColumns');
  if (columns) columns.hidden = empty;

  // The convergence strip lives OUTSIDE #wireList (see #wireAboveList in the
  // template) so it never appears as a role="list" child.
  const aboveList = document.getElementById('wireAboveList');

  if (items.length === 0) {
    if (aboveList) {
      // Name the active filters (activeFilterSummary was previously fed only
      // to the screen-reader announcer) and offer a one-click reset instead of making
      // the analyst hunt the control row for whatever's still highlighted.
      const summary = activeFilterSummary();
      const message = filters.signal
        ? 'This signal is outside the current selected feed. Its original source and retained evidence may still be available.'
        : filters.hidden && hiddenCount === 0
        ? 'No hidden signals are available in the latest feed.'
        : summary
        ? `No signals found for these filters: ${summary}.`
        : (hiddenCount && !filters.hidden
          ? 'All available signals are hidden. Open Hidden to review or restore them.'
          : lastLoadData?.generatedAt
          ? 'No signals were produced by the latest refresh.'
          : 'No signals yet — waiting for the first pipeline refresh.');
      const sourceEscape = filters.signal && safeHref(filters.signal) ? `<a href="${escapeHtml(safeHref(filters.signal))}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>` : '';
      const retainedEscape = filters.source ? '<button type="button" data-recover-evidence>Open retained source history</button>' : '';
      aboveList.innerHTML = `${filters.hidden || filters.signal ? '' : convergenceStrip()}<div class="wire-empty"><h2>${filters.signal ? 'Signal outside current feed' : summary ? 'No matching signals' : filters.hidden ? 'No hidden signals' : 'No signals yet'}</h2><p>${escapeHtml(message)}</p><div class="wire-empty-actions">${sourceEscape}${retainedEscape}${summary ? '<button class="btn-ghost-sm wire-clear-filters" type="button">Clear filters</button>' : ''}<a href="/briefing?archive=1">Search saved editions</a>${filters.hidden ? '<button class="wire-retry wire-show-visible" type="button">Show visible signals</button>' : ''}</div></div>`;
    }
    list.innerHTML = '';
    restoreWireFocus(list, savedFocus, document.getElementById('wireSearch'));
    renderInspector();
    return;
  }
  if (aboveList) aboveList.innerHTML = filters.hidden || filters.signal ? '' : convergenceStrip();

  list.innerHTML = items.map((h, index) => {
    const age = relativeAge(h.date);
    const urgency = String(h.urgency || '');
    // A pipeline-promoted row earns lead weight too (the tier rail already
    // carries the accent; the title weight is the lead-vs-tail focal cue).
    const promoted = Number(h.originalHorizon) && Number(h.originalHorizon) !== h.horizon;
    // Two arrival lifetimes: `arrived-flash` (one-shot pulse) vs `arrived` (persistent
    // NEW tag). A row can carry both on the arrival load, then just `arrived` after the flash.
    const key = sigKey(h);
    const isFlash = flashKeys.has(key);
    const isArrived = arrivedKeys.has(key);
    const arrived = `${isFlash ? ' arrived-flash' : ''}${isArrived ? ' arrived' : ''}`;
    const titleId = `wire-t${index}`;   // labels the article for AT and the score affordance
    const href = safeHref(h.link);   // http(s)-only; a non-http(s) link renders as plain text below
    // Parsed once per row and threaded into cveCluster/affectsChip below — both
    // read the same CVE payload, and parseCveData runs 4 regex matches per call.
    const cveInfo = parseCveData(h.cveData);
    // The context tags (affected products + heuristic actor/vendor attributions)
    // ride a quiet sub-line under the decision chips, so the right META column is
    // reserved for the provenance/staleness read (source · age) that aligns down
    // the list — glance left for priority, centre for story, right for staleness.
    const submeta = signalSubmeta(h, cveInfo);
    // One keyboard stop per row (rather than one per chip); aria-description
    // folds the chip hedges/context that used to each carry their own tabindex into
    // a single AT-readable summary of the row, reachable with j/k below.
    const rowDesc = rowDescription(h, cveInfo);
    const isRead = readKeys.has(key);   // dims a row the analyst has already opened/marked read
    return `
    <article class="wire-item h${h.horizon}${urgency === 'critical' ? ' critical' : ''}${promoted ? ' promoted' : ''}${h.kevOverdue ? ' kev-overdue' : ''}${isRead ? ' is-read' : ''}${selectedSignal === key ? ' is-selected' : ''}${arrived}" role="listitem" aria-labelledby="${titleId}" data-key="${escapeHtml(key)}" tabindex="0"${rowDesc ? ` aria-description="${escapeHtml(rowDesc)}. Enter inspect. R mark read. H hide. C copy link."` : ''}>
      ${scoreBlock(h)}
      <div class="wire-lead">
        <h3 class="wire-item-h">${href
          ? `<a class="wire-item-title" id="${titleId}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${highlightWireText(h.editorialContext?.title || h.title, filters.q)}</a>`
          : `<span class="wire-item-title" id="${titleId}">${highlightWireText(h.title, filters.q)}</span>`}${isArrived ? '<span class="wire-new" aria-hidden="true">NEW</span>' : ''}</h3>
        <div class="wire-scan-meta"><span class="wire-src">${highlightWireText(h.source || 'Unknown source', filters.q)}</span><span class="wire-published"><span>Published</span> ${ageEl(h, age)}</span>${scanPriorityChip(h)}</div>
        ${scanIdentityHtml(h)}
        <div class="wire-row-tools"><details class="wire-row-menu"><summary aria-label="More actions for ${escapeHtml(h.editorialContext?.title || h.title)}">More <span aria-hidden="true">⋯</span></summary><div class="wire-quick-actions"><button type="button" data-mark-read="${escapeHtml(key)}" data-read-action aria-pressed="${isRead}" aria-label="${isRead ? 'Mark unread' : 'Mark read'}" title="R: toggle read">${isRead ? 'Mark unread' : 'Mark read'}</button><button type="button" ${dismissedKeys.has(key) ? 'data-restore' : 'data-dismiss'}="${escapeHtml(key)}" title="H: hide">${dismissedKeys.has(key) ? 'Restore' : 'Hide'}</button><button type="button" data-copy-link="${escapeHtml(signalUrl(h, location.origin))}" title="C: copy signal link">Copy link</button></div></details>
        <details class="wire-details" data-row-details="${escapeHtml(key)}"${expandedDetails.has(key) ? ' open' : ''}>
        <summary>Inspect<span class="wire-sr-only"> for ${escapeHtml(h.title || 'this signal')}</span></summary>
        <div class="wire-detail-content">
        ${signalDetailsHtml(h, cveInfo, submeta)}
        </div>
        </details>
        </div>
      </div>
    </article>
  `;
  }).join('');

  // Restore the breakdowns that were open before the swap, and the scroll
  // position, so the 5-min auto-refresh never yanks the analyst out of an
  // in-progress investigation.
  if (openKeys.size) {
    list.querySelectorAll('.wire-item').forEach(it => {
      if (openKeys.has(it.dataset.key)) {
        const d = it.querySelector('.wire-score.has-breakdown');
        if (d) d.open = true;
      }
    });
  }
  const replacement = anchor && [...list.querySelectorAll('.wire-item')].find(row => row.dataset.key === anchor.key);
  if (restoreScroll) { restoreScroll = false; window.scrollTo(0, savedScroll); }
  else if (replacement) window.scrollTo(0, prevScroll + replacement.getBoundingClientRect().top - anchor.top);
  else if (prevScroll) window.scrollTo(0, prevScroll);
  restoreWireFocus(list, savedFocus, document.getElementById('wireSearch'));
  renderInspector();
  if (filters.signal && focusedSignal !== filters.signal && !document.querySelector('dialog[open]')) {
    const row = [...list.querySelectorAll('.wire-item')].find(item => item.dataset.key === filters.signal);
    if (row) { focusedSignal = filters.signal; selectedSignal = filters.signal; selectedSnapshot = items.find(h => sigKey(h) === filters.signal); renderInspector(); row.focus({ preventScroll: true }); row.scrollIntoView?.({ block: 'start' }); }
  }
}

// Every tooltip's operational meaning remains readable with keyboard-only use
// in the row's single Details disclosure, without hundreds of chip tab stops.
function labelExplanations(h, cve) {
  const lines = [];
  if (h.isKEV) lines.push(`KEV: catalog-listed exploitation${h.kevDueDate ? `. CISA remediation due ${h.kevDueDate}${h.kevOverdue ? ' (overdue)' : ''}` : ''}.`);
  if (cve.exploit) lines.push('Exploit references: public exploit references exist; inspect the source for scope.');
  if (Number(h.corroboration) > 1) lines.push(`${h.corroboration} source identities report a similar story${h.sources?.length ? `: ${h.sources.join(', ')}` : ''}. This does not establish independent confirmation.`);
  const vendors = (Array.isArray(h.vendors) ? h.vendors : []).map(v => typeof v === 'string' ? v : v?.name).filter(Boolean);
  if (vendors.length) lines.push(`Auto-tagged vendors: ${vendors.join(', ')}. Literal matching; verify applicability with the vendor.`);
  for (const actor of Array.isArray(h.actors) ? h.actors : []) {
    const name = typeof actor === 'string' ? actor : actor?.name;
    if (name) lines.push(`${name}: ${actor?.basis === 'mention' ? 'passing mention, not the subject' : 'named in the report'}; heuristic attribution.`);
  }
  if (h.alertMatched) lines.push('Alert match: a configured alert rule prioritized this signal.');
  if (Number(h.originalHorizon) && Number(h.originalHorizon) !== h.horizon) lines.push(`Promoted from ${TIER_NAMES[h.originalHorizon] || h.originalHorizon} to ${TIER_NAMES[h.horizon] || h.horizon} by the pipeline.`);
  if (h.applicability?.explanation) lines.push(h.applicability.explanation);
  return lines.length ? `<details class="wire-label-explanations"><summary>Labels and ranking context</summary>${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</details>` : '';
}

function scanIdentityHtml(h) {
  const identity = scanFacts(h);
  const decision = decisions.get(sigKey(h));
  const severity = identity.severity;
  return `<div class="wire-scan-identity">${identity.product ? `<span class="wire-product">${escapeHtml(identity.product)}</span>` : ''}${identity.cves.map(cve => `<span class="wire-cve-fact"><button type="button" data-copy-cve="${escapeHtml(cve)}" title="Copy ${escapeHtml(cve)}">${escapeHtml(cve)}</button>${cve === severity.scope ? `<span class="wire-severity"${severity.level ? ` data-level="${severity.level}"` : ''}>CVSS ${escapeHtml(severity.value)}</span>` : ''}</span>`).join('')}${identity.remainingCves ? `<span>+${identity.remainingCves} CVEs</span>` : ''}${identity.cves.length && !severity.scope ? '<span class="wire-severity">CVSS unavailable</span>' : ''}${decision && decision.state !== 'unreviewed' ? `<span class="wire-outcome-chip">Your assessment: ${escapeHtml(DECISION_STATES[decision.state])}</span>` : ''}</div>`;
}

function signalSubmeta(h, cveInfo) {
  const actors = (Array.isArray(h.actors) ? h.actors : []).map(actor => {
    const name = typeof actor === 'string' ? actor : actor?.name;
    if (!name) return '';
    const named = actor?.basis !== 'mention';
    const hedge = named
      ? `${name} — named in this report; attribution is heuristic, verify with vendor reporting`
      : `${name} — a passing mention in the body, not the subject; attribution is heuristic, verify with vendor reporting`;
    return `<span class="wire-actor heuristic${named ? '' : ' mention'}" data-tip="${escapeHtml(hedge)}" aria-label="${escapeHtml(hedge)}">${highlightWireText(name, filters.q)}</span>`;
  }).join('');
  return `${affectsChip(h, cveInfo)}${vendorChips(h.vendors)}${actors}`;
}

// Render from the selected record, not its DOM row: filtering or snapshot
// replacement can remove that row while an investigation remains open.
function signalDetailsHtml(h, cveInfo = parseCveData(h.cveData), submeta = signalSubmeta(h, cveInfo)) {
  const key = sigKey(h);
  const href = safeHref(h.link);
  const isRead = readKeys.has(key);
  const localDecision = decisions.get(key);
  return `${editorialContextHtml(h)}<p class="wire-local-state">${localDecision && localDecision.state !== 'unreviewed' ? `Your assessment · ${escapeHtml(DECISION_STATES[localDecision.state])}` : 'Local exposure · Unknown'}</p>
    <div class="wire-evidence-row">${h.evidence?.length ? `<button type="button" class="wire-inspect" data-evidence="${escapeHtml(key)}">Inspect evidence <span class="wire-evidence-count">${h.evidence.length} retained ${h.evidence.length === 1 ? 'source' : 'sources'}</span></button>` : '<p class="wire-retention-note">No retained excerpt is attached to this signal. Open the source for its reporting.</p>'}</div>
    ${signalAssessmentMeta(h, true)}
    <div class="wire-decision"><span class="wire-tier h${h.horizon}">${TIER_NAMES[h.horizon] || ''}</span>${corroborationGlyph(h)}${cveCluster(h, cveInfo)}</div>
    <details class="wire-source-context"><summary>Reported text and source context</summary>
      ${h.editorialContext?.sourceTitle && h.editorialContext.title !== h.editorialContext.sourceTitle ? `<p class="wire-retention-note">Publisher headline: ${escapeHtml(h.editorialContext.sourceTitle)}</p>` : ''}${renderEvidenceContext(h)}
      ${h.description ? `<p class="wire-detail-description">${highlightWireText(h.description, filters.q)}</p>` : ''}${submeta ? `<div class="wire-submeta">${submeta}</div>` : ''}
    </details>${labelExplanations(h, cveInfo)}${decisionForm(h, decisionDrafts.get(key) || decisions.get(key))}
    <span class="wire-row-actions">${copyLinkBtn(h, href, cveInfo)}
      <button type="button" class="wire-mark-read" data-mark-read="${escapeHtml(key)}" aria-pressed="${isRead}" title="${isRead ? 'Mark unread' : 'Mark read'}" aria-label="${isRead ? 'Mark unread' : 'Mark read'}">${wireIcon(isRead ? 'read' : 'unread')}<span class="wire-read-label">${isRead ? 'Read' : 'Unread'}</span></button>
      ${dismissedKeys.has(key)
        ? `<button type="button" class="wire-restore" data-restore="${escapeHtml(key)}" title="Restore this signal to the visible feed">Restore</button>`
        : `<button type="button" class="wire-dismiss" data-dismiss="${escapeHtml(key)}" title="Hide this signal" aria-label="Hide this signal">${wireIcon('hide')}</button>`}
    </span>`;
}

function editorialContextHtml(h) {
  const context = h.editorialContext || {};
  const text = value => typeof value === 'string' ? value : '';
  const fields = [['Reported consequence', context.consequence], ['Next check', context.nextStep]];
  const records = Array.isArray(h.kevRecords) ? h.kevRecords : [];
  return `${fields.filter(([, value]) => text(value)).map(([label, value]) => `<section class="wire-context-fact"><h4>${label}</h4><p>${escapeHtml(value)}</p></section>`).join('')}
    ${Array.isArray(context.unknowns) && context.unknowns.length ? `<details class="wire-evidence-gaps"><summary>What remains unverified</summary><ul>${context.unknowns.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>` : ''}
    ${records.length > 1 ? `<details class="wire-cve-records"><summary>${records.length} catalog-listed vulnerabilities</summary>${records.map(record => `<section><h4>${escapeHtml(record.cve)} · ${escapeHtml(record.product || record.vendor || '')}</h4><p>${escapeHtml(record.description || record.name || '')}</p><p>CISA deadline: ${escapeHtml(record.dueDate || 'not retained')}${record.overdue ? ' · Past deadline' : ''}</p>${record.requiredAction ? `<p>Catalog action: ${escapeHtml(record.requiredAction)}</p>` : ''}</section>`).join('')}</details>` : ''}
    ${h.enrichmentStatus && Object.entries(h.enrichmentStatus).some(([, value]) => value === 'unavailable') ? '<p class="wire-retention-note">Some structured lookups are unavailable. Ranking has limited enrichment coverage; inspect attributed source reporting.</p>' : ''}`;
}

function scanPriorityChip(h) {
  const changed = Array.isArray(h.evidence) && h.evidence.some(source => source.changed);
  const watched = h.applicability?.state === 'declared-match' || h.applicability?.questionMatches?.length;
  const overdue = h.kevOverdue || h.kevRecords?.some(record => record.overdue);
  const urgent = overdue ? '<span class="wire-priority crit">KEV overdue</span>' : h.isKEV ? '<span class="cl-kev">KEV</span>' : priorityChip(h);
  const kind = h.evidence?.find(source => source.changed)?.changeKind || h.editorialContext?.changeKind;
  const update = kind === 'capture-expanded' ? 'More source context retained' : 'Retained source changed';
  const context = changed ? `<span class="wire-priority changed">${update}</span>` : watched ? `<span class="wire-priority watch">${h.applicability?.state === 'declared-match' ? 'Watch match' : 'Question match'}</span>` : '';
  return `${urgent || ''}${context}`;
}

// Compact cross-source strip above the list, fed by
// landscape.convergence. Only renders when non-empty; never throws on a thin row.
function convergenceStrip() {
  if (!Array.isArray(convergence) || convergence.length === 0) return '';
  const shown = convergence;
  const cards = shown.map(c => {
    const label = escapeHtml(c.label || c.key || 'Cluster');
    const n = Number(c.sourceCount) || 0;
    const title = c.topTitle ? escapeHtml(c.topTitle) : '';
    const hz = c.horizon ? `H${escapeHtml(String(c.horizon))}` : '';
    return `
      <a class="wire-converge-card" href="/wire?cluster=${encodeURIComponent(c.id || `${c.type || 'cve'}:${c.label || c.key || ''}`)}" title="View this cluster">
        <span class="wire-converge-key">${c.type === 'cve' ? 'Related CVE reports' : c.type === 'actor' ? 'Actor topic' : 'Vendor topic'} · ${label}${hz ? ` · ${hz}` : ''}</span>
        ${title ? `<span class="wire-converge-title">${title}</span>` : ''}
        ${n ? `<span class="wire-converge-n">${Number(c.count) || 0} signals · ${n} distinct ${n === 1 ? 'source' : 'sources'}</span>` : ''}
      </a>`;
  }).join('');
  // Honest overflow: the head counts the full cluster set but only 4 cards render;
  // append a "+N more" marker so the visible cards never under-read the stated count.
  const overflow = convergence.length > shown.length
    ? `<span class="wire-converge-more">+${convergence.length - shown.length} more</span>`
    : '';
  return `
    <details class="wire-converge"${clusterOpen ? ' open' : ''} aria-label="Topics and related reporting">
      <summary class="wire-converge-head">Topics and related reporting · ${convergence.length} groups<span class="wire-converge-count">Across full feed</span></summary>
      <div class="wire-converge-row">${cards}${overflow}</div>
    </details>`;
}

// The score block — the 0–100 numeral over an expandable panel that DEFENDS
// the rank: the evidence ledger
// ("KEV-verified · reported by 3 distinct sources · CVSS 9.8") as the
// header, then the five normalized axes as labeled bars. "Why is this an 84?" is
// answerable in one click — the receipt is attached. Degrades to the bare numeral
// when components are absent.
function scoreBlock(h) {
  const numericScore = Number(h.score);
  const score = Number.isFinite(numericScore) ? Math.max(0, Math.min(100, Math.round(numericScore))) : 0;
  // Ranking magnitude is separate from severity and assessment confidence.
  // Source counts and catalog references never change the score's border.
  // Thresholds tuned to the live distribution: the normalised evidence score tops
  // out near ~70 in practice (KEV-verified criticals), so 'hi' opens at 60 — the
  // strongest handful read bright rather than everything washing to mid.
  const band = score >= 60 ? 'hi' : score >= 35 ? 'mid' : 'lo';
  const comps = h.scoreComponents;
  if (!comps || typeof comps !== 'object') {
    return `<div class="wire-score" data-band="${band}" aria-label="Priority score ${score} of 100">${score}<span>Priority</span></div>`;
  }
  const bars = SCORE_AXIS_ORDER
    .filter(k => Number.isFinite(comps[k]))
    .map(k => {
      const pct = Math.round(Math.max(0, Math.min(1, comps[k])) * 100);
      if (k === 'severity' && pct === 0 && !parseCveData(h.cveData).cvss && !parseCveData(h.cveData).sev) {
        return '<li class="wsb-axis wsb-unavailable"><span class="wsb-label">Severity unavailable</span><span>No severity evidence retained · 0 ranking contribution</span></li>';
      }
      const points = Number(h.scoreContributions?.[k]);
      const weight = Number(h.scoreWeights?.[k]);
      return `<li class="wsb-axis"><span class="wsb-label">${escapeHtml(SCORE_LABELS[k] || humanizeKey(k))}</span><span class="wsb-bar"><i style="width:${pct}%"></i></span><span class="wsb-val">${pct}</span>${Number.isFinite(points) ? `<small class="wsb-contribution">${points.toFixed(1)} points${Number.isFinite(weight) ? ` · ${Math.round(weight * 100)}% weight` : ''}</small>` : ''}</li>`;
    }).join('');
  const ledger = h.scoreRationale
    ? `<li class="wsb-ledger">${escapeHtml(h.scoreRationale)}</li>`
    : '';
  const title = h.scoreRationale ? `Priority score ${score}/100 — ${h.scoreRationale}` : `Priority score ${score}/100`;
  return `
    <details class="wire-score has-breakdown" data-band="${band}" title="${escapeHtml(title)}">
      <summary aria-label="Priority score ${score} of 100. Inspect ranking components">${score}<span>Priority</span></summary>
      <ul class="wire-score-breakdown"><li class="wsb-heading"><span>Priority breakdown · ${score}</span><button type="button" data-score-close aria-label="Close priority breakdown">×</button></li>${ledger}<li class="wsb-scale">Evidence axes · 0–100. Weighted points produce the rounded rank.</li>${bars || '<li class="wsb-axis"><span>No components</span></li>'}${h.scoreUnknowns?.length ? `<li class="wsb-ledger">${h.scoreUnknowns.map(escapeHtml).join(' · ')}</li>` : ''}</ul>
    </details>`;
}

function humanizeKey(k) {
  return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

// CVE actions and catalog warnings. Scoped severity is already stated in the
// shared metadata, so a separate catalog CVE cannot inherit another CVE's score.
function cveCluster(h, p = parseCveData(h.cveData)) {
  const data = p.raw;
  const cve = h.kevCVE || p.cve;
  const { exploit } = p;
  const parts = [];
  // The CVE id is the most frequent single exit action from the Wire (into a
  // ticket, a scanner query, Slack); make it a click-to-copy button rather than inert
  // text an analyst has to drag-select across a dense row of links and tooltip chips.
  if (cve) parts.push(`<button type="button" class="cl-cve" data-copy-cve="${escapeHtml(cve)}" title="${escapeHtml(data || cve)}" aria-label="Copy ${escapeHtml(cve)}">${highlightWireText(cve, filters.q)}${wireIcon('copy')}</button>`);
  if (h.isKEV) {
    const kevT = 'On the CISA Known Exploited Vulnerabilities catalog — federal remediation mandated';
    parts.push(`<span class="cl-kev" data-tip="${escapeHtml(kevT)}" aria-label="${escapeHtml(kevT)}">KEV</span>`);
    if (h.kevDueDate) {
      const due = escapeHtml(h.kevDueDate);
      if (h.kevOverdue) {
        const t = `CISA remediation deadline passed — ${due}`;
        parts.push(`<span class="cl-due overdue" data-tip="${t}" aria-label="${t}">OVERDUE</span>`);
      } else {
        const days = daysUntil(h.kevDueDate);
        const f = days == null ? `due ${due}` : (days <= 0 ? 'due today' : `due in ${days}d`);
        const t = `CISA remediation deadline — ${due}`;
        parts.push(`<span class="cl-due" data-tip="${t}" aria-label="${t}">${escapeHtml(f)}</span>`);
      }
    }
  }
  if (exploit) {
    const t = 'Public exploit references exist';
    parts.push(`<span class="cl-exploit" data-tip="${t}" aria-label="${t}">EXPLOIT</span>`);
  }
  if (!parts.length) return '';
  return `<span class="wire-cve-cluster">${parts.join('<span class="cl-sep">·</span>')}</span>`;
}

// KEV deadline as a micro-timeline object: a ~60px line with three markers
// (added · now · due). The "now" dot is positioned by elapsed fraction of the
// remediation window, so runway reads pre-cognitively — a near-due CVE shows the
// dot crowding the right end; an overdue one drives it past the end and reddens
// the whole line (the single allowed escalation). Exact dates live in the title.
// Renders only when BOTH the CISA add-date and due-date are known.
function kevTimeline(h) {
  if (!h.isKEV || !h.kevDueDate || !h.kevDateAdded) return '';
  const added = dateMs(h.kevDateAdded);
  const due = dateMs(h.kevDueDate);
  if (!added || !due || due <= added) return '';
  const frac = (Date.now() - added) / (due - added);
  const pos = Math.max(0, Math.min(1, frac)) * 100;
  const overdue = !!h.kevOverdue;
  const a = shortDate(h.kevDateAdded);
  const d = shortDate(h.kevDueDate);
  const label = `KEV added ${h.kevDateAdded} · remediation due ${h.kevDueDate}${overdue ? ' — OVERDUE' : ''}`;
  return `<span class="kev-timeline${overdue ? ' overdue' : ''}" style="--kev-now:${pos.toFixed(1)}%" data-tip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
    <span class="kt-line"><span class="kt-now"></span></span>
    <span class="kt-ends"><span>${escapeHtml(a)}</span><span>${escapeHtml(d)}</span></span>
  </span>`;
}

// Compact "Mon D" for the timeline ends; full ISO stays in the title. KEV dates are
// date-only (YYYY-MM-DD) → parsed as UTC midnight, so format in UTC to avoid a
// behind-UTC clock rendering the label a day early (it must match the tooltip).
// A two-digit year is appended when the date isn't the current year, so a years-old
// overdue KEV ("Sep 9 '24") never reads as an upcoming September.
function shortDate(dateStr) {
  const t = dateMs(dateStr);
  if (!t) return '';
  try {
    const d = new Date(t);
    const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const yr = d.getUTCFullYear();
    return yr === new Date().getUTCFullYear() ? base : `${base} '${String(yr).slice(-2)}`;
  } catch {
    return '';
  }
}

// Affected products (NVD CPE) — "what is at risk", a metadata-zone chip. Strips
// any secondary "· CVE-…: CVSS …" that bleeds into the freeform affects capture.
function affectsChip(h, p = parseCveData(h.cveData)) {
  const affects = p.affects;
  if (!affects) return '';
  return `<span class="wire-affects" title="Affected products (NVD CPE data)">Affects ${highlightWireText(affects, filters.q)}</span>`;
}

// One priority-reason chip by precedence — replaces the separate promoted / alert
// / critical stamps that could all fire at once. ALERT (your own rule) > PROMOTED
// (escalation) > CRITICAL (condition).
function priorityChip(h) {
  // Infotip on each variant (hover/click-reachable); no per-chip tabindex.
  if (h.alertMatched) {
    const t = 'Prioritized — matched one of your configured alert rules';
    return `<span class="wire-priority alert" data-tip="${t}" aria-label="${t}">ALERT MATCH</span>`;
  }
  const orig = Number(h.originalHorizon);
  if (orig && orig !== h.horizon) {
    const t = `Promoted from H${escapeHtml(String(orig))} to H${escapeHtml(String(h.horizon))} by the pipeline (e.g. actively exploited)`;
    return `<span class="wire-priority promoted" data-tip="${t}" aria-label="${t}">▲ PROMOTED</span>`;
  }
  if (h.urgency === 'critical') {
    const t = 'Critical urgency — flagged by the pipeline for immediate attention';
    return `<span class="wire-priority crit" data-tip="${t}" aria-label="${t}">CRITICAL URGENCY</span>`;
  }
  return '';
}

function daysUntil(dateStr) {
  const t = dateMs(dateStr);
  if (!t) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

// Affected-vendor chips. HEURISTIC: vendors come from substring
// matching, so they carry the same dotted-underline/auto-tagged affordance as actors.
function vendorChips(vendors) {
  if (!Array.isArray(vendors) || vendors.length === 0) return '';
  return vendors.map(v => {
    const name = typeof v === 'string' ? v : (v && v.name);
    if (!name) return '';
    // Infotip carries the same heuristic hedge as the aria-label
    // (hover/click-reachable); no per-chip tabindex.
    const t = `${name} — auto-tagged from headline text; vendor match is heuristic, verify with vendor advisories`;
    return `<span class="wire-vendor heuristic" data-tip="${escapeHtml(t)}" aria-label="${escapeHtml(t)}">${highlightWireText(name, filters.q)}</span>`;
  }).join('');
}

// Undated items read "date unknown" where the age would render, rather
// than silently showing nothing.
// Recency as a material gradient: a data-age-band attribute drives a subtle
// background (fresh reads bright, old fades to nothing) so the eye sorts staleness
// before reading the words. Absolute time stays in the title attr.
function ageEl(h, age) {
  if (h.dateUnknown) {
    return `<time class="wire-age unknown" title="No publication date on the source item — recency is unknown">date unknown</time>`;
  }
  if (!age) return '<span class="wire-age unknown">Not available</span>';
  return `<time class="wire-age" data-age-band="${ageBand(h.date)}" datetime="${escapeHtml(h.date || '')}" title="${escapeHtml(absoluteTime(h.date))}">${escapeHtml(age)}</time>`;
}

// Bucket age into four bands for the recency gradient.
function ageBand(dateStr) {
  const t = dateMs(dateStr);
  if (!t) return 'old';
  const hrs = (Date.now() - t) / 3_600_000;
  if (hrs < 3) return 'fresh';
  if (hrs < 24) return 'recent';
  if (hrs < 72) return 'aging';
  return 'old';
}

// Cross-source reporting as a nested-circle multiplier glyph beside the tier chip
// (decision zone), brand-blue, only when 2+ source identities carry a near-match.
// Replaces the downstream "×N sources" text; source labels live in the title.
function corroborationGlyph(h) {
  // n is the distinct-publisher count (`corroboration`) — the score's basis — so the
  // glyph and the score never disagree. The feed labels behind it ride the tooltip.
  const n = Number(h.corroboration) || 1;
  if (n <= 1) return '';
  // n is the distinct-publisher count (the score's basis). The feed labels are the
  // provenance trail behind it — framed as "via", so they never read as a claim
  // that those exact labels ARE the n publishers (they can differ, e.g. on reload).
  const names = Array.isArray(h.sources) ? h.sources.filter(Boolean) : [];
  const title = names.length
    ? `Reported by ${n} distinct sources · labels seen: ${names.join(', ')}`
    : `Reported by ${n} distinct sources`;
  // Infotip (hover/click-reachable) carries the source trail; no native
  // title, no per-chip tabindex.
  return `<span class="wire-corrob" data-tip="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${n} sources</span>`;
}

function relativeAge(dateStr) {
  const t = dateMs(dateStr);
  if (!t) return null;
  const sec = (Date.now() - t) / 1000;
  if (sec < 90) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function absoluteTime(dateStr) {
  const t = dateMs(dateStr);
  if (!t) return '';
  try {
    return new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function formatAge(seconds) {
  if (seconds == null) return '';
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

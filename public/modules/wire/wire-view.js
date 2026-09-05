// BlueTeam.News — wire view: dense scannable list of scored headlines.

import { escapeHtml } from '../core/sanitize.js';
import { captureWireFocus, restoreWireFocus } from './wire-focus.js';
import { bindScoreDismissal } from './wire-popovers.js';
import { fetchHeadlines, fetchLandscape } from '../core/api.js';
import { on, off } from '../core/store.js';
import { showToast } from '../core/toast.js';
import { TIER_NAMES, TIERS } from '../core/tiers.js';
import { openEvidenceInspector, closeEvidenceInspector, renderEvidenceContext } from './evidence-inspector.js';
import { highlightWireText, renderWireDescription, wireIcon } from './wire-presentation.js';
import {
  dateMs, parseCveData, filterSignals, parseWireQuery, serializeWireUrl, toCsv, sigKey as fmtSigKey, CSV_COLUMNS, briefingLinkModel, isFeedStale,
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
const expandedSummaries = new Set();
let summaryObserver = null;
let scoreDismissalCleanup = null;

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
function markRead(key, read) {
  if (!key) return;
  if (read) readKeys.add(key); else readKeys.delete(key);
  saveKeySet(LS_READ_KEY, readKeys);
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
  // A bare '/wire' (no query) means "no explicit deep-link on the URL",
  // NOT "reset to defaults": filters is module-level state that survives a
  // Wire → Briefing → Wire roundtrip, so a bare path must keep it and just
  // re-serialize the URL to match (below). A path WITH a query is authoritative
  // (a real deep link or a manual edit) and does overwrite in-memory state.
  const hasQuery = Boolean(window.location.search);
  if (hasQuery) parseQuery(); // restore deep-linked filter/sort state before first paint
  main.innerHTML = `
    <div class="wire-view">
      <header class="wire-head">
        <div>
          <p class="view-kicker">Signal Feed</p>
          <h1 class="view-title">Wire</h1>
          <p class="view-sub">Every scored signal from the last pipeline run — ranked by defender relevance.</p>
        </div>
        <div class="wire-head-right">
          <!-- The latest saved edition can predate the current feed. -->
          <a class="wire-brieflink" id="wireBriefLink" href="/briefing" hidden>Latest briefing →</a>
          <span class="wire-meta" id="wireMeta">Loading signals…</span>
        </div>
      </header>

      <section class="wire-controls" aria-label="Wire controls">
        <!-- Search is the primary command. Count and export sit beside it instead of
             competing with the triage filters as another row of equal-weight pills. -->
        <div class="wire-command-row">
          <label class="wire-search-wrap" for="wireSearch">
            <span class="wire-sr-only">Filter signals by text</span>
            <input id="wireSearch" class="wire-search" type="search" placeholder="Search title, CVE, vendor, actor…" autocomplete="off">
          </label>
          <span class="wire-shown" id="wireShown">Loading…</span>
          <details class="wire-export is-disabled" id="wireExport">
            <summary class="wire-export-trigger" aria-label="Export filtered signals" aria-disabled="true" tabindex="-1">Export <span aria-hidden="true">▾</span></summary>
            <div class="wire-export-menu" role="group" aria-label="Export format">
              <button type="button" data-export="csv" disabled title="Download the currently filtered signals as CSV">CSV <small>Spreadsheet</small></button>
              <button type="button" data-export="json" disabled title="Download the currently filtered signals as JSON">JSON <small>Structured data</small></button>
            </div>
          </details>
        </div>

        <div class="wire-filter-row">
          <!-- Tier is SINGLE-SELECT: a radiogroup with roving tabindex and arrow-key
               navigation. The segmented shell makes the four related choices read
               as one filter instead of four unrelated chips. -->
          <div class="wire-filters" id="wireHorizon" role="radiogroup" aria-label="Filter by tier">
            <button type="button" class="wire-filter active" data-horizon="all" role="radio" aria-checked="true" tabindex="0">ALL</button>
            ${TIERS.map(n => `<button type="button" class="wire-filter f-h${n}" data-horizon="${n}" role="radio" aria-checked="false" tabindex="-1">${TIER_NAMES[n]}</button>`).join('\n            ')}
          </div>
          <span class="wire-control-divider" aria-hidden="true"></span>
          <div class="wire-toggles" id="wireToggles" role="group" aria-label="Filter by attribute">
            <button type="button" class="wire-toggle" data-toggle="critical" aria-pressed="false">CRITICAL</button>
            <button type="button" class="wire-toggle" data-toggle="kev" aria-pressed="false">KEV</button>
            <!-- Read records what has been opened; it does not mean resolved. -->
            <button type="button" class="wire-toggle" data-toggle="unread" aria-pressed="false">UNREAD</button>
            <button type="button" class="wire-toggle" id="wireHidden" data-toggle="hidden" aria-pressed="false" title="Show hidden signals still available in the feed">Hidden (0)</button>
          </div>
          <button type="button" class="wire-clear-control" id="wireClear" hidden>Clear filters</button>
          <label class="wire-sort" for="wireSort">
            <span class="wire-sort-label">SORT</span>
            <select class="wire-sort-select" id="wireSort" aria-label="Sort signals">
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
            </select>
          </label>
        </div>

        <!-- Transient "N hidden — Undo" status for the most recent dismiss batch. -->
        <div class="wire-status-row" id="wireUndoRow"></div>
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
      <div class="wire-above-list" id="wireAboveList"></div>

      <!-- The list needs its own heading (h1 → h3 skip otherwise); visually hidden. -->
      <h2 class="wire-list-heading sr-only">Signals</h2>
      <!-- Visible column header, aligned to the item grid (styles), decorative to AT. -->
      <div class="wire-colhead" id="wireColumns" aria-hidden="true"><span class="ch-score" title="0–100 ranking priority">SCORE<small>0–100</small></span><span class="ch-lead">SIGNAL</span><span class="ch-meta">SOURCE · AGE</span></div>

      <div class="wire-list" id="wireList" role="list" aria-busy="true" aria-label="Scored signals">
        ${skeletonRows()}
      </div>
    </div>
  `;

  reflectControls(); // push restored filter/sort state onto the buttons
  document.getElementById('wireClear')?.addEventListener('click', clearFilters);
  // A bare hash means in-memory filters (possibly non-default, carried over
  // from a prior mount) are authoritative; write them back onto the URL so a
  // reload or copied link right after a Wire→Briefing→Wire roundtrip agrees
  // with what's on screen instead of silently reading '/wire' as "all clear".
  if (!hasQuery) syncUrl();

  const horizonGroup = document.getElementById('wireHorizon');
  const selectHorizon = (btn) => {
    if (!btn) return;
    filters.horizon = btn.dataset.horizon;
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
    if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
    if (!opened.classList.contains('wire-score')) return;
    document.querySelectorAll('#wireList .wire-score[open]').forEach(d => {
      if (d !== opened) d.open = false;
    });
    // Opening the score breakdown is investigating the signal; treat it as
    // read, same as clicking through to the article.
    const row = opened.closest('.wire-item');
    if (row) markRead(row.dataset.key, true);
  }, true);

  // Delegated click-to-copy, mark-read/dismiss, and auto-mark-read-on-open:
  // the CVE id chip, copy-link, mark-read, and dismiss affordances are all rebuilt on
  // every renderList(), so bind once here rather than per-row.
  document.getElementById('wireList')?.addEventListener('click', (e) => {
    const summaryBtn = e.target.closest('[data-summary]');
    if (summaryBtn) {
      const key = summaryBtn.dataset.summary;
      const expanded = !expandedSummaries.has(key);
      if (expanded) expandedSummaries.add(key); else expandedSummaries.delete(key);
      const description = document.getElementById(summaryBtn.getAttribute('aria-controls'));
      description?.classList.toggle('is-expanded', expanded);
      summaryBtn.setAttribute('aria-expanded', String(expanded));
      summaryBtn.textContent = expanded ? 'Show less' : 'Read full summary';
      return;
    }
    const evidenceBtn = e.target.closest('[data-evidence]');
    if (evidenceBtn) {
      const headline = cachedHeadlines.find(item => sigKey(item) === evidenceBtn.dataset.evidence);
      if (headline) { markRead(sigKey(headline), true); openEvidenceInspector(headline, evidenceBtn); }
      return;
    }
    const cveBtn = e.target.closest('[data-copy-cve]');
    if (cveBtn) { copyToClipboard(cveBtn.dataset.copyCve, 'CVE copied', cveBtn); return; }
    const linkBtn = e.target.closest('[data-copy-link]');
    if (linkBtn) { copyToClipboard(linkBtn.dataset.copyLink, 'Link copied', linkBtn); return; }
    const readBtn = e.target.closest('[data-mark-read]');
    if (readBtn) {
      const key = readBtn.dataset.markRead;
      markRead(key, !readKeys.has(key));   // explicit click toggles read/unread
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
  });

  // The empty-filter state's "Clear all filters" button lives in
  // #wireAboveList (rebuilt each renderList()); delegate once.
  document.getElementById('wireAboveList')?.addEventListener('click', (e) => {
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
    if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const row = e.target.closest('.wire-item');
    if (!row) return;
    // Ignore navigation keys while focus is inside an interactive descendant of the
    // row (the score breakdown <details>, the CVE-copy button, etc.) — only the row
    // itself (the tab stop) should move focus on j/k.
    if (e.target !== row) return;
    const rows = [...document.querySelectorAll('#wireList .wire-item')];
    const i = rows.indexOf(row);
    if (i === -1) return;
    const next = (e.key === 'j' || e.key === 'ArrowDown') ? rows[i + 1] : rows[i - 1];
    if (next) { e.preventDefault(); next.focus(); }
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
  if (typeof ResizeObserver !== 'undefined') {
    summaryObserver?.disconnect();
    summaryObserver = new ResizeObserver(updateSummaryControls);
    summaryObserver.observe(document.getElementById('wireList'));
  }
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

export function unmount() {
  active = false;
  scoreDismissalCleanup?.();
  scoreDismissalCleanup = null;
  summaryObserver?.disconnect();
  summaryObserver = null;
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
  filters.horizon = p.horizon;
  filters.critical = p.critical;
  filters.kev = p.kev;
  filters.unread = p.unread;   // restore the deep-linked Unread toggle
  filters.hidden = p.hidden;
  filters.q = p.q;   // restore the deep-linked free-text filter
  sortMode = p.sort;
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
  const hasQuery = Boolean(window.location.search);
  if (hasQuery) parseQuery(); else syncUrl();
  reflectControls();
  renderList();
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
  const items = filtered.map(h => ({ ...h, read: readKeys.has(sigKey(h)) }));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (format === 'json') {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `wire-signals-${stamp}.json`);
  } else {
    const blob = new Blob([toCsv(items, [...CSV_COLUMNS, 'read'])], { type: 'text/csv;charset=utf-8' });
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
    ? `Feeds stale — last refresh ${formatAge(ageSeconds)}`
    : `Feeds refreshed ${formatAge(ageSeconds)}`;
  meta.classList.toggle('stale', stale);
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
    const timeEl = item.querySelector('.wire-meta-col time.wire-age');
    if (!timeEl) return;
    const age = relativeAge(h.date);
    if (age) timeEl.textContent = age;
    timeEl.dataset.ageBand = ageBand(h.date);
  });
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
    cachedHeadlines = data.headlines.filter(h => h && typeof h === 'object');
    for (const key of expandedSummaries) {
      if (!cachedHeadlines.some(h => sigKey(h) === key)) expandedSummaries.delete(key);
    }
    detectArrivals();
    lastGoodAt = Date.now();
    clearReconnecting();
    // Snapshot what the freshness ticker needs to re-derive age locally
    // (loadedAt anchors ageSeconds to wall-clock time so tickFreshness can add
    // elapsed seconds without another round-trip).
    lastLoadData = { generatedAt: data?.generatedAt || null, ageSeconds: data?.ageSeconds, loadedAt: Date.now(), refreshMinutes: lastLoadData?.refreshMinutes };
    renderFreshnessMeta();
    renderList();
    // Convergence is decoration over the list — never let its failure or absence
    // block the headlines render. Cached 15s in api.js, so cheap to re-pull.
    fetchLandscape()
      .then(ls => {
        if (!active) return;
        convergence = Array.isArray(ls?.convergence) ? ls.convergence : [];
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
      .catch(() => { /* leave the last-known convergence in place */ });
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
  const trigger = menu?.querySelector('summary');
  if (trigger) {
    trigger.setAttribute('aria-disabled', String(!available));
    trigger.tabIndex = available ? 0 : -1;
  }
  if (!available && menu) menu.open = false;
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
  filters = { horizon: 'all', critical: false, kev: false, unread: false, hidden: filters.hidden, q: '' };
  sortMode = 'relevance';
  reflectControls();
  syncUrl();
  renderList();
  document.getElementById('wireSearch')?.focus();
}

function updateSummaryControls() {
  document.querySelectorAll('#wireList .wire-summary').forEach(summary => {
    const text = summary.querySelector('.wire-item-desc');
    const button = summary.querySelector('[data-summary]');
    if (!text || !button) return;
    button.hidden = !text.classList.contains('is-expanded') && text.scrollHeight <= text.clientHeight + 1;
  });
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
    const controls = wrap.querySelector('.wire-controls');
    if (controls) controls.insertAdjacentElement('afterend', banner);
    else wrap.prepend(banner);
  }
  const since = lastGoodAt ? formatAge(Math.round((Date.now() - lastGoodAt) / 1000)) : 'unknown';
  banner.textContent = `Reconnecting — showing last good signals from ${since}`;
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
    return /^https?:$/.test(new URL(link, window.location.href).protocol) ? link : null;
  } catch {
    return null;
  }
}

// Per-row "copy link" affordance: the article URL when the row has a safe
// href, else a `/wire?q=<CVE>` deep link so a colleague still lands on the exact
// signal (via the free-text filter) even when the source item carries no link.
function copyLinkBtn(h, href, cveInfo) {
  const cve = h.kevCVE || (cveInfo && cveInfo.cve) || '';
  const deepLink = href || (cve ? `${location.origin}/wire?q=${encodeURIComponent(cve)}` : '');
  if (!deepLink) return '';
  return `<button type="button" class="wire-copy-link" data-copy-link="${escapeHtml(deepLink)}" title="Copy link to this signal" aria-label="Copy link to this signal">${wireIcon('copy')}</button>`;
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
  return filterSignals(headlines, { ...filters, dismissedKeys, readKeys }, sortMode);
}

// The active filters in words, for the screen-reader announcement (the pills
// carry aria-pressed visually; AT users get them named alongside the count).
function activeFilterSummary() {
  const parts = [];
  if (filters.horizon !== 'all') parts.push(TIER_NAMES[filters.horizon] || `tier ${filters.horizon}`);
  if (filters.critical) parts.push('Critical');
  if (filters.kev) parts.push('KEV');
  if (filters.unread) parts.push('Unread');
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
  const clearControl = document.getElementById('wireClear');
  if (clearControl) clearControl.hidden = !activeFilterSummary();
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
      const message = filters.hidden && hiddenCount === 0
        ? 'No hidden signals are available in the latest feed.'
        : summary
        ? `No signals found for these filters: ${summary}.`
        : (hiddenCount && !filters.hidden
          ? 'All available signals are hidden. Open Hidden to review or restore them.'
          : lastLoadData?.generatedAt
          ? 'No signals were produced by the latest refresh.'
          : 'No signals yet — waiting for the first pipeline refresh.');
      aboveList.innerHTML = `${filters.hidden ? '' : convergenceStrip()}<div class="wire-empty"><h2>${summary ? 'No matching signals' : filters.hidden ? 'No hidden signals' : 'No signals yet'}</h2><p>${escapeHtml(message)}</p><div class="wire-empty-actions">${summary ? '<button class="btn-ghost-sm wire-clear-filters" type="button">Clear filters</button>' : ''}${filters.hidden ? '<button class="wire-retry wire-show-visible" type="button">Show visible signals</button>' : ''}</div></div>`;
    }
    list.innerHTML = '';
    restoreWireFocus(list, savedFocus, document.getElementById('wireSearch'));
    return;
  }
  if (aboveList) aboveList.innerHTML = filters.hidden ? '' : convergenceStrip();

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
    const submeta = [
      affectsChip(h, cveInfo),
      vendorChips(h.vendors),
      (Array.isArray(h.actors) ? h.actors : []).map(a => {
        const name = typeof a === 'string' ? a : a && a.name;
        if (!name) return '';
        // basis 'title' = named in the headline (the story is about it); 'mention'
        // = a passing body reference (weaker — rendered dimmer). Either way heuristic.
        const named = !a || typeof a !== 'object' || a.basis !== 'mention';
        const hedge = named
          ? `${name} — named in this report; attribution is heuristic, verify with vendor reporting`
          : `${name} — a passing mention in the body, not the subject; attribution is heuristic, verify with vendor reporting`;
        // Infotip carries the heuristic hedge (hover/click-reachable); no native
        // title. No per-chip tabindex: at 200 signals x 3-7 chips/row, that's
        // 600-1400 tab stops between headlines. The row itself is the one keyboard
        // stop (see the <article> tabindex + aria-description below); the hedge is
        // still reachable via mouse hover/tap through the delegated infotip listeners.
        return `<span class="wire-actor heuristic${named ? '' : ' mention'}" data-tip="${escapeHtml(hedge)}" aria-label="${escapeHtml(hedge)}">${highlightWireText(name, filters.q)}</span>`;
      }).join(''),
    ].join('');
    // One keyboard stop per row (rather than one per chip); aria-description
    // folds the chip hedges/context that used to each carry their own tabindex into
    // a single AT-readable summary of the row, reachable with j/k below.
    const rowDesc = rowDescription(h, cveInfo);
    const isRead = readKeys.has(key);   // dims a row the analyst has already opened/marked read
    return `
    <article class="wire-item h${h.horizon}${urgency === 'critical' ? ' critical' : ''}${promoted ? ' promoted' : ''}${h.kevOverdue ? ' kev-overdue' : ''}${isRead ? ' is-read' : ''}${arrived}" role="listitem" aria-labelledby="${titleId}" data-key="${escapeHtml(key)}" tabindex="0"${rowDesc ? ` aria-description="${escapeHtml(rowDesc)}"` : ''}>
      ${scoreBlock(h)}
      <div class="wire-lead">
        ${renderEvidenceContext(h)}
        <h3 class="wire-item-h">${href
          ? `<a class="wire-item-title" id="${titleId}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${highlightWireText(h.title, filters.q)}</a>`
          : `<span class="wire-item-title" id="${titleId}">${highlightWireText(h.title, filters.q)}</span>`}${isArrived ? '<span class="wire-new" aria-hidden="true">NEW</span>' : ''}</h3>
        ${renderWireDescription(h.description, { id: `wire-desc-${index}`, key, expanded: expandedSummaries.has(key), query: filters.q })}
        <div class="wire-decision">
          <span class="wire-tier h${h.horizon}">${TIER_NAMES[h.horizon] || ''}</span>
          ${corroborationGlyph(h)}
          ${cveCluster(h, cveInfo)}
          ${priorityChip(h)}
        </div>
        ${submeta ? `<div class="wire-submeta">${submeta}</div>` : ''}
        <div class="wire-evidence-row"><button type="button" class="wire-inspect${h.evidence?.length ? '' : ' is-legacy'}" data-evidence="${escapeHtml(key)}">${h.evidence?.length ? `Inspect evidence <span class="wire-evidence-count">${h.evidence.length} retained ${h.evidence.length === 1 ? 'source' : 'sources'}</span>` : 'Evidence details'}</button>${h.evidence?.length ? '' : '<span class="wire-retention-note">No retained excerpt</span>'}${h.applicability ? '<span><strong>Exposure unknown</strong> · check applicability</span>' : ''}</div>
      </div>
      <div class="wire-meta-col">
        <span class="wire-src">${highlightWireText(h.source || 'Unknown source', filters.q)}</span>
        ${ageEl(h, age)}
        <span class="wire-row-actions">
          ${copyLinkBtn(h, href, cveInfo)}
          <!-- Read and visibility are independent browser preferences. -->
          <button type="button" class="wire-mark-read" data-mark-read="${escapeHtml(key)}" aria-pressed="${isRead}" title="${isRead ? 'Mark unread' : 'Mark read'}" aria-label="${isRead ? 'Mark unread' : 'Mark read'}">${wireIcon(isRead ? 'read' : 'unread')}<span class="wire-read-label">${isRead ? 'Read' : 'Unread'}</span></button>
          ${filters.hidden
            ? `<button type="button" class="wire-restore" data-restore="${escapeHtml(key)}" title="Restore this signal to the visible feed">Restore</button>`
            : `<button type="button" class="wire-dismiss" data-dismiss="${escapeHtml(key)}" title="Hide this signal" aria-label="Hide this signal">${wireIcon('hide')}</button>`}
        </span>
      </div>
    </article>
  `;
  }).join('');
  updateSummaryControls();

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
  if (prevScroll) window.scrollTo(0, prevScroll);
  restoreWireFocus(list, savedFocus, document.getElementById('wireSearch'));
}

// Compact cross-source strip above the list, fed by
// landscape.convergence. Only renders when non-empty; never throws on a thin row.
function convergenceStrip() {
  if (!Array.isArray(convergence) || convergence.length === 0) return '';
  const shown = convergence.slice(0, 4);
  const cards = shown.map(c => {
    const label = escapeHtml(c.label || c.key || 'Cluster');
    const n = Number(c.sourceCount) || 0;
    const title = c.topTitle ? escapeHtml(c.topTitle) : '';
    const hz = c.horizon ? `H${escapeHtml(String(c.horizon))}` : '';
    return `
      <div class="wire-converge-card" title="${title}">
        <span class="wire-converge-key">${label}${hz ? ` · ${hz}` : ''}</span>
        ${title ? `<span class="wire-converge-title">${title}</span>` : ''}
        ${n ? `<span class="wire-converge-n">${n} distinct ${n === 1 ? 'source' : 'sources'}</span>` : ''}
      </div>`;
  }).join('');
  // Honest overflow: the head counts the full cluster set but only 4 cards render;
  // append a "+N more" marker so the visible cards never under-read the stated count.
  const overflow = convergence.length > shown.length
    ? `<span class="wire-converge-more">+${convergence.length - shown.length} more</span>`
    : '';
  return `
    <div class="wire-converge" role="region" aria-label="Story clusters reported across distinct sources">
      <span class="wire-converge-head">Cross-source<span class="wire-converge-count">${convergence.length} ${convergence.length === 1 ? 'cluster' : 'clusters'}</span><span class="wire-converge-count">Across full feed</span></span>
      <div class="wire-converge-row">${cards}${overflow}</div>
    </div>`;
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
  // Two ORTHOGONAL cues on the score: (1) MAGNITUDE via numeral brightness — a
  // band so a 28 and an 88 don't read identically from the left margin (NOT brand
  // colour: --brand never carries operational meaning); (2) CONFIDENCE via the
  // ring border — cross-reported by 2+ sources OR catalog-verified earns a brighter
  // solid ring. Fill = how big, border = how sure.
  // Thresholds tuned to the live distribution: the normalised evidence score tops
  // out near ~70 in practice (KEV-verified criticals), so 'hi' opens at 60 — the
  // strongest handful read bright rather than everything washing to mid.
  const band = score >= 60 ? 'hi' : score >= 35 ? 'mid' : 'lo';
  const conf = (h.corroboration > 1 || !!h.kevCVE) ? ' corroborated' : '';
  const comps = h.scoreComponents;
  if (!comps || typeof comps !== 'object') {
    return `<div class="wire-score${conf}" data-band="${band}">${score}<span>SCORE</span></div>`;
  }
  const bars = SCORE_AXIS_ORDER
    .filter(k => Number.isFinite(comps[k]))
    .map(k => {
      const pct = Math.round(Math.max(0, Math.min(1, comps[k])) * 100);
      return `<li class="wsb-axis"><span class="wsb-label">${escapeHtml(SCORE_LABELS[k] || humanizeKey(k))}</span><span class="wsb-bar"><i style="width:${pct}%"></i></span><span class="wsb-val">${pct}</span></li>`;
    }).join('');
  const ledger = h.scoreRationale
    ? `<li class="wsb-ledger">${escapeHtml(h.scoreRationale)}</li>`
    : '';
  const title = h.scoreRationale ? `${score}/100 — ${h.scoreRationale}` : `${score}/100`;
  return `
    <details class="wire-score has-breakdown${conf}" data-band="${band}" title="${escapeHtml(title)}">
      <summary aria-label="Score ${score} of 100. Inspect ranking components">${score}<span>SCORE</span></summary>
      <ul class="wire-score-breakdown">${ledger}<li class="wsb-scale">Evidence axes · 0–100</li>${bars || '<li class="wsb-axis"><span>No components</span></li>'}</ul>
    </details>`;
}

function humanizeKey(k) {
  return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

// ── The CVE cluster: one left-leading identity → severity → KEV → due → exploit
// line so a CVE id appears EXACTLY ONCE per row (replaces the old kev-chip,
// kevDueChip and cveChips, which each restamped the CVE). Identity is uncolored;
// only severity / KEV / overdue carry color. Affected products live in the
// metadata zone (affectsChip) — "what is at risk" is a different question.
function cveCluster(h, p = parseCveData(h.cveData)) {
  const data = p.raw;
  const cve = h.kevCVE || p.cve;
  const { cvss, sev, exploit } = p;
  const parts = [];
  // The CVE id is the most frequent single exit action from the Wire (into a
  // ticket, a scanner query, Slack); make it a click-to-copy button rather than inert
  // text an analyst has to drag-select across a dense row of links and tooltip chips.
  if (cve) parts.push(`<button type="button" class="cl-cve" data-copy-cve="${escapeHtml(cve)}" title="${escapeHtml(data || cve)}" aria-label="Copy ${escapeHtml(cve)}">${highlightWireText(cve, filters.q)}${wireIcon('copy')}</button>`);
  if (cvss) {
    parts.push(`<span class="cl-sev sev-${(sev || 'na').toLowerCase()}">CVSS ${escapeHtml(cvss)}${sev ? ' ' + escapeHtml(sev.toUpperCase()) : ''}</span>`);
  } else if (cve && !h.isKEV) {
    // Infotip (hover/click-reachable via the delegated listeners); no
    // per-chip tabindex — see the wire-actor comment above for why.
    const t = 'A CVE is referenced but no CVSS was parsed — severity unknown; treat as unconfirmed, not low';
    parts.push(`<span class="cl-sev sev-unknown" data-tip="${escapeHtml(t)}" aria-label="${escapeHtml(t)}">severity unknown</span>`);
  }
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
  return `<span class="wire-cve-cluster">${parts.join('<span class="cl-sep">·</span>')}</span>${kevTimeline(h)}`;
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
  if (!age) return '';
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

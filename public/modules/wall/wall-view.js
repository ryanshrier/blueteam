// BlueTeam.News — the Wall.
// A passive watchfloor broadsheet for a TV on the operations floor: a nameplate
// masthead (folio · live date · clock) over a rotating set of editorial sections
// that read the daily brief — The Briefing (BLUF + in-brief) and Key Judgments
// (with the "line", confidence, decision window) —
// interleaved with The Wire (live scored signals). Editorial serif headlines,
// warm cream ink, explicit decision timing, and restrained evidence badges.
// Updates and rotates on a timer.

import { escapeHtml } from '../core/sanitize.js';
import { fetchLandscape, fetchBrief, fetchEdition, fetchHealth } from '../core/api.js';
import { setState } from '../core/store.js';
import { archivePublishedAt, formatBriefPublication, formatBriefPublishedAt } from '../core/brief-date.js';
import { readingStops } from './wall-reading.js';
// One brief contract, shared with the server (lib/brief-schema.js, served at
// /vendor/brief-schema.js): the section names, field labels, and parse helpers
// live there so the Wall and the server can never drift. The Wall keeps its own
// rendering; only its parsing sources this module.
import { formatDecisionWindow, judgmentCertainty, parseBrief } from '/vendor/brief-schema.js';

import { TIER_NAMES } from '../core/tiers.js';
// The Wall's own pure rotation/parsing helpers, extracted so they carry no
// DOM dependency and can be unit-tested directly (test/wall-format.test.js), the
// same split already applied to the Wire (wire-format.js). This view keeps only
// the DOM-touching render/timer code; buildPages/splitBluf/relAge/etc. now live
// there as the single source of truth.
import {
  buildPages as buildPagesPure, splitBluf, cvssFrom, cleanSummary, judgmentOverflowNote,
  relAge, isFresh, isBriefStale, staleAfterSec,
  executiveSummaryModel, actionDisplayModel,
} from './wall-format.js';
import { renderKevSection } from './wall-kev.js';
// The broadsheet's terse region labels (its own editorial shortening — the pack's
// entities.regions carry the longer "Russia-attributed" attribution form used in
// the leaderboard). These stay authoritative for cyber's keys; the active pack's
// regions are overlaid (see poll) so a NON-cyber edition's regions render here
// with ZERO view edits. A region with no label falls back to its raw key.
const WALL_REGION_DEFAULTS = {
  RU: 'Russia', CN: 'China', KP: 'DPRK', IR: 'Iran', crime: 'Criminal',
};
let regionLabels = { ...WALL_REGION_DEFAULTS };
const DATA_POLL_MS = 60_000;
const BURN_IN_SHIFT_MS = 5 * 60_000;   // how often the pixel-shift cycles
const QUIET_DIM_START_HOUR = 1;        // overnight dim window, kiosk-only
const QUIET_DIM_END_HOUR = 5;

// Broadsheet rotation. The sequence IS the brief read top-to-bottom as an
// inverted pyramid — thesis → the day's claims → operational judgments one at a
// time → the analyst's status board + connect-the-dots → what to watch — with
// the live wire demoted to a single reference page at the end.
// JUDG_MAX/CONV_MAX (judgment/convergence page caps) now live in wall-format.js
// as the single source of truth used internally by buildPages there.
const WIRE_MAX = 4;         // wire stories on the single demoted wire page
const NEWS_PAGE_MS = 18_000;
// Per-page dwell: a BLUF cover reads in ~12s; a full Key Judgment needs
// ~22s. One constant either rushes the judgment or lingers on the cover, so each
// page kind sits for its own read time. Falls back to NEWS_PAGE_MS for any kind.
const PAGE_DWELL_MS = {
  bluf: 12_000, execsummary: 18_000, judgment: 22_000, convergence: 20_000,
  developing: 18_000, kev: 16_000, wire: 18_000, brieferror: 10_000, empty: 8_000,
};

// The folio slug doubles as the running section label: section identity lives in
// the persistent masthead, so each page's body is pure content with no repeated
// per-page header (and no live/updated line — the masthead is the one indicator).
const SECTION_LABELS = {
  bluf: 'The BLUF', execsummary: 'EXECUTIVE SUMMARY', judgment: 'KEY JUDGMENT',
  developing: 'DEVELOPING SITUATIONS', convergence: 'CONVERGENCE',
  kev: 'KEV · NEWLY ADDED',
  wire: 'THE WIRE', brieferror: 'BRIEFING STATUS', empty: 'Cyber Defense Intelligence',
};
// Page kinds sourced from the parsed brief, i.e. everything that must never
// be read as live-generated: these carry the brief's own as-of date in the slug so
// a weekend-old brief can never rotate under a masthead silently implying "today".
const BRIEF_KINDS = new Set(['bluf', 'execsummary', 'judgment', 'developing', 'convergence']);

let timers = [];
let mounted = false;
let landscape = null;
let newsPage = 0;
let newsTimer = null;      // self-scheduling per-kind page-advance timer
let newsPages = [];        // current rotation of broadsheet sections
let paused = false;        // operator-held rotation (Space); auto-advance frozen while set
let keyHandler = null;     // non-kiosk manual-advance/pause keydown, bound on mount, removed on unmount
let briefDoc = null;       // { bluf, execSummary[], stories[], developing[], convergence[], watchlist[], date }
let briefDocFile = null;   // brief filename currently loaded
let briefLoadError = false; // latest saved Briefing exists but could not be fetched/parsed
let lastFlipAt = 0;        // timestamp of the last renderPage attempt (success or caught failure); updateLiveline watches this for a stalled flip chain
let sourceLoadError = false;
let renderLoadError = false;
let displayedPage = null;  // publication metadata belongs to the held content, never the next poll
let readingOffsets = [0];
let resizeHandler = null;
let mountVersion = 0;      // ignore a response from an earlier mount

export function mount(layer) {
  if (mounted) return;
  mounted = true;
  mountVersion++;
  // /wall is the canonical passive display route; ?operator is the explicit
  // staffed-review escape hatch that keeps the documented arrow/Space controls
  // reachable without weakening unattended kiosk behavior.
  const wallParams = new URLSearchParams(window.location.search);
  if (/^\/wall\/?$/.test(window.location.pathname) && !wallParams.has('operator')) {
    document.body.classList.add('kiosk');
  }
  paused = !document.body.classList.contains('kiosk')
    && !!window.matchMedia?.('(max-width: 760px), (orientation: portrait)').matches;
  mountNews(layer);
  // Manual control for a staffed watchfloor (NOT kiosk: a kiosk is a passive
  // display with no operator at the keys). Arrow keys step pages and freeze the
  // auto-timer; Space holds/resumes the rotation. Bound only while the Wall is
  // mounted and removed in unmount so it never leaks into other views.
  if (!document.body.classList.contains('kiosk')) {
    keyHandler = onWallKey;
    document.addEventListener('keydown', keyHandler);
  }
  resizeHandler = () => { syncWallScale(); refreshReadingStops(true); };
  window.addEventListener('resize', resizeHandler);
  const version = mountVersion;
  document.fonts?.ready.then(() => {
    if (mounted && version === mountVersion) refreshReadingStops(true);
  });
}

export function unmount() {
  if (!mounted) return;
  mounted = false;
  mountVersion++;
  for (const t of timers) clearInterval(t);
  clearTimeout(newsTimer);
  timers = [];
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }   // drop the manual-control listener with the view
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  paused = false;
  landscape = null;
  lastBoardWord = '';   // re-announce board status fresh on a remount
  newsPage = 0;
  newsPages = [];
  briefDoc = null;
  briefDocFile = null;
  briefLoadError = false;
  sourceLoadError = false;
  renderLoadError = false;
  displayedPage = null;
  readingOffsets = [0];
  lastFlipAt = 0;
  lastKnownServerBootMs = null;   // re-baseline on remount rather than reloading against a stale comparison
  lastQuietHourReloadDay = null;
  burnInIdx = 0;
  document.body.classList.remove('kiosk');
  const layer = document.getElementById('wallLayer');
  if (layer) layer.innerHTML = '';
}

async function poll() {
  const version = mountVersion;
  try {
    const nextLandscape = await fetchLandscape();
    if (!mounted || version !== mountVersion) return;
    landscape = nextLandscape;
    sourceLoadError = false;
    // Overlay the active edition's region labels (pack-driven), keeping the Wall's
    // terse defaults authoritative for their own keys. Cached, so this is cheap.
    try {
      const e = await fetchEdition();
      if (!mounted || version !== mountVersion) return;
      if (e?.regions) regionLabels = { ...e.regions, ...WALL_REGION_DEFAULTS };
    } catch { /* keep the defaults */ }
    if (!mounted || version !== mountVersion) return;
    setState({ landscape });
    if (!mounted || version !== mountVersion) return;
    renderNews();
    checkKioskSelfReload();   // after a good landscape fetch, so a reload never races an outage
  } catch {
    if (!mounted || version !== mountVersion) return;
    sourceLoadError = true;
    // Preserve a last-known-good board during a transient refresh failure. On
    // first load there is no such board, so replace loading with the source error.
    if (!landscape && mounted) {
      const body = document.getElementById('nbBody');
      if (body) {
        const fallback = wallStateHtml(
          'Source refresh unavailable',
          'No current landscape has loaded.',
          'The Wall will retry automatically.',
          'error'
        );
        body.innerHTML = fallback;
        body.dataset.pageHtml = fallback;
      }
    }
    updateLiveline();
  }
}

// A kiosk TV loads the SPA once and polls forever; `git pull && restart`
// while the floor TV stays on leaves it running old JS against a new API
// indefinitely, with no version check or reload path anywhere in the Wall. Two
// self-healing triggers, both kiosk-only (a staffed watchfloor with an operator
// at the keys should never be yanked out from under them):
//   1. A server restart, inferred from /api/health's own uptime: if the SERVER's
//      implied boot time (now - uptime) jumps by more than a couple minutes since
//      the last poll, the process restarted underneath us — reload to pick up
//      whatever shipped. (No dedicated boot-id field is exposed; uptime is already
//      served and sufps this purpose, since a monotonically-INCREASING uptime
//      between polls is impossible unless the process restarted; this serves
//      the same purpose without a dedicated boot-id field.)
//   2. An unconditional reload at a quiet hour once every 24h, so long-run
//      renderer drift (compositor memory, font cache) on TV-class hardware gets
//      cleared even absent a server upgrade. Guarded on the poll that just
//      succeeded, so it can never fire against a down server and blank the board.
const KIOSK_QUIET_HOUR = 4;              // 04:00 local — the reload window
const KIOSK_RELOAD_KEY = 'bt-wall-maintenance-day';
// Claim before reloading; sessionStorage survives document reloads in this tab.
// Skip scheduled maintenance if storage is denied instead of risking a reload loop.
export function claimKioskMaintenanceReload(day) {
  try {
    if (sessionStorage.getItem(KIOSK_RELOAD_KEY) === day) return false;
    sessionStorage.setItem(KIOSK_RELOAD_KEY, day);
    return sessionStorage.getItem(KIOSK_RELOAD_KEY) === day;
  } catch { return false; }
}
let lastKnownServerBootMs = null;        // inferred from /api/health's uptime
let lastQuietHourReloadDay = null;       // local calendar day (toDateString) of the last quiet-hour reload, so it fires once per day
async function checkKioskSelfReload() {
  if (!document.body.classList.contains('kiosk')) return;
  const version = mountVersion;
  try {
    const health = await fetchHealth();
    if (!mounted || version !== mountVersion || !document.body.classList.contains('kiosk')) return;
    if (Number.isFinite(health?.uptime)) {
      const impliedBootMs = Date.now() - health.uptime * 1000;
      if (lastKnownServerBootMs !== null && impliedBootMs - lastKnownServerBootMs > 2 * 60_000) {
        location.reload();
        return;
      }
      lastKnownServerBootMs = impliedBootMs;
    }
  } catch { /* health check is best-effort; never block the board on it */ }
  if (!mounted || version !== mountVersion || !document.body.classList.contains('kiosk')) return;

  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() === KIOSK_QUIET_HOUR && lastQuietHourReloadDay !== today) {
    lastQuietHourReloadDay = today;
    if (claimKioskMaintenanceReload(today)) location.reload();
  }
}

// ══════════════════════════════════════════════════════════
// The broadsheet — a passive cyber-defense newspaper for a watchfloor TV.
// A nameplate masthead (folio · live date · clock) over a rotating set of
// editorial sections that fully read the daily brief — The Briefing (BLUF +
// in-brief), Key Judgments (with the punchy "line", confidence, decision
// window), the 72-Hour Watchlist — interleaved with The Wire (live signals).
// Editorial serif headlines, warm cream ink, and explicit decision timing.
// ══════════════════════════════════════════════════════════

export function wallScaleForWidth(width) {
  return Number.isFinite(width) && width >= 2200 ? width / 1920 : 1;
}

function syncWallScale() {
  const wall = document.querySelector('.news-mode');
  if (wall) wall.style.zoom = String(wallScaleForWidth(window.innerWidth));
}

function mountNews(layer) {
  layer.innerHTML = `
    <div class="wall news-mode">
      <h1 class="nb-sr-only">BlueTeam.News Wall</h1>
      <header class="nb-folio">
        <div class="nb-folio-id">
          <span class="nb-wordmark">BLUETEAM.NEWS</span>
        </div>
        <div class="nb-folio-section">
          <span class="nb-folio-slug" id="nbSlug">Cyber Defense Intelligence</span>
          <span class="nb-brief-stamp" id="nbBriefStamp"></span>
        </div>
        <div class="nb-folio-status">
          <span class="nb-folio-live"><span class="nb-live-dot" id="nbLiveDot" data-status="warn"></span><span id="nbLiveWord">FEEDS LOADING</span></span>
          <span class="nb-clock" id="nbClock">--:--</span>
          <span class="nb-integrity" id="nbIntegrity" data-status="live">—</span>
        </div>
      </header>

      <div class="nb-dwell"><i id="nbDwell"></i></div>
      <span class="nb-sr-only" id="nbAnnounce" role="status" aria-live="polite"></span>

      <div class="nb-body" id="nbBody" tabindex="0" aria-label="Wall content">
        <div class="nb-empty nb-opening">
          <span class="nb-opening-kicker">Preparing the watchfloor</span>
          <strong>Loading the latest available information</strong>
          <span>Signals will surface as the feeds respond.</span>
        </div>
      </div>

      <footer class="nb-foot">
        <div class="nb-position"><span class="nb-playback" id="nbPlayback"></span><span class="nb-pager" id="nbPager"></span></div>
        ${document.body.classList.contains('kiosk') ? '' : `<nav class="nb-controls" aria-label="Wall controls">
          <button type="button" id="nbPrev" disabled aria-label="Previous page" title="Previous page (Left arrow)">← Previous</button>
          <button type="button" id="nbPause" disabled title="Pause or resume rotation (Space)">Pause</button>
          <button type="button" id="nbNext" disabled aria-label="Next page" title="Next page (Right arrow)">Next →</button>
          <a href="/wall">Present on display</a>
          <a href="/wire">Exit Wall</a>
          <span class="nb-controls-hint" id="nbControlsHint">←/→ pages · Space pause/resume · Esc exit</span>
        </nav>`}
      </footer>
    </div>
  `;

  syncWallScale();
  startLiveline();
  poll();
  if (!document.body.classList.contains('kiosk')) {
    document.getElementById('nbPrev')?.addEventListener('click', () => stepPage(-1));
    document.getElementById('nbNext')?.addEventListener('click', () => stepPage(1));
    document.getElementById('nbPause')?.addEventListener('click', togglePause);
    // Scrolling is an intentional read: hold the current content before it can
    // advance. Programmatic continuation scrolling never triggers this handler.
    const body = document.getElementById('nbBody');
    body?.addEventListener('wheel', holdReading, { passive: true });
    body?.addEventListener('touchstart', holdReading, { passive: true });
  }
  timers.push(setInterval(poll, DATA_POLL_MS));
  cycleBurnInShift();   // first shift immediately so the board isn't pinned at (0,0) for the first 5 minutes
  timers.push(setInterval(cycleBurnInShift, BURN_IN_SHIFT_MS));
}

// Cycles the static chrome (folio spine, dwell track, footer pager — every
// piece of the Wall that does NOT change with the rotating content) through four
// small transform offsets so no pixel sits at the exact same luminance indefinitely
// on an OLED/plasma panel. The shift lives on .news-mode itself (see wall.css), so
// it moves everything uniformly — content included — meaning it's imperceptible at
// 10 ft, not just applied to the chrome.
const BURN_IN_CLASSES = ['nb-shift-1', 'nb-shift-2', 'nb-shift-3', 'nb-shift-4'];
let burnInIdx = 0;
function cycleBurnInShift() {
  const el = document.querySelector('.news-mode');
  if (!el) return;
  el.classList.remove(...BURN_IN_CLASSES);
  el.classList.add(BURN_IN_CLASSES[burnInIdx]);
  burnInIdx = (burnInIdx + 1) % BURN_IN_CLASSES.length;
}

function renderNews() {
  if (!landscape) return;
  ensureBrief();
  const rebuilt = buildPages();
  // Every successful 60s poll used to call renderPage() unconditionally,
  // which replaces body.innerHTML and force-restarts the entrance animation/
  // stagger, resets the dwell hairline to full (so a page can dwell ~2x its
  // budget), and — worse — swapped a PAUSED page's content out from under the
  // operator, defeating the hold. Only actually re-render when either the ROTATION
  // itself changed shape (a page was added/removed/reordered — the current index
  // may now point somewhere else) or the CURRENT page's own rendered content
  // changed; an unrelated page changing elsewhere in the rotation is invisible to
  // the operator right now and doesn't need to interrupt their read.
  const pagesChanged = JSON.stringify(rebuilt) !== JSON.stringify(newsPages);
  if (displayedPage && !renderLoadError && (paused || readingOffsets.length > 1)) {
    // Hold the entire displayed snapshot while paused or reading continuations.
    // Apply new content at the next section or on resume, without restarting a
    // long page before its final lines have had their turn.
    updateLiveline();
    return;
  }
  newsPages = rebuilt;
  if (newsPage >= newsPages.length) newsPage = 0;
  let currentHtml;
  try {
    currentHtml = newsPages.length ? renderSection(newsPages[newsPage]) : '';
  } catch {
    renderPage(); // the render boundary reports display errors and preserves rotation
    return;
  }
  const body = document.getElementById('nbBody');
  const currentChanged = !body || body.dataset.pageHtml !== currentHtml;
  if (pagesChanged || currentChanged) {
    renderPage();
  }
  updateLiveline();
}

// Load + parse the latest brief once per filename; rebuild pages when it lands.
function ensureBrief() {
  const f = landscape.brief && landscape.brief.filename;
  if (!f) {
    briefDoc = null;
    briefDocFile = null;
    briefLoadError = false;
    return;
  }
  if (f === briefDocFile) return;
  briefDocFile = f;
  const version = mountVersion;
  const briefDate = landscape.brief?.date || '';
  fetchBrief(f).then(d => {
    if (!mounted || version !== mountVersion || briefDocFile !== f) return;
    briefDoc = parseBrief(d.content || '', {
      verifiedKevCves: d.inputManifest?.verification?.selectedKevCves,
    });
    briefDoc.warnings = Array.isArray(d.meta?.warnings) ? [...d.meta.warnings] : [];
    briefLoadError = false;
    briefDoc.filename = f;
    briefDoc.date = briefDate;
    // Only persisted publication metadata proves a generation instant. The
    // archive's generatedAt fallback can be a copied legacy file's mtime.
    briefDoc.generatedAt = archivePublishedAt(d);
    if (!displayedPage || (!paused && readingOffsets.length <= 1)) {
      newsPages = buildPages();
      if (newsPage >= newsPages.length) newsPage = 0;
      renderPage();
    }
    updateLiveline();
  }).catch(() => {
    if (!mounted || version !== mountVersion || briefDocFile !== f) return;
    // Reset briefDocFile too, not just briefDoc: leaving briefDocFile set to
    // the filename that just failed would make the `f === briefDocFile` guard above
    // permanently suppress a retry until a NEW brief filename appears (typically the
    // next day). Rebuild pages + re-render immediately so any brief-derived pages
    // built from the previous (now-stale) briefDoc are dropped from rotation rather
    // than lingering and throwing when renderSection reads a null briefDoc.
    briefDoc = null;
    briefDocFile = null;
    briefLoadError = true;
    if (!displayedPage || (!paused && readingOffsets.length <= 1)) {
      newsPages = buildPages();
      if (newsPage >= newsPages.length) newsPage = 0;
      renderPage();
    }
    updateLiveline();
  });
}

// Thin wrapper over the pure buildPages in wall-format.js, closing over this
// module's own briefDoc/landscape state so every existing call site (renderNews,
// ensureBrief, renderPageUnsafe, togglePause) is unchanged.
function buildPages() {
  return buildPagesPure(briefDoc, landscape, { briefLoadError });
}

// A bare exception anywhere in the render path used to kill the self-scheduling
// flip chain outright (scheduleNextPage at the end never ran), freezing the board on
// stale content while the masthead kept reading LIVE — the one freeze mode the
// integrity readout couldn't see. Wrapped so a poisoned page renders the empty
// fallback, logs, and STILL re-arms the timer: the rotation heals past it next flip.
function renderPage(lastPart = false, preservePosition = false) {
  lastFlipAt = Date.now();   // recorded even on failure: a caught error still counts as "the board tried to turn"
  try {
    renderPageUnsafe(lastPart, preservePosition);
    renderLoadError = false;
  } catch (err) {
    console.error('[wall] renderPage failed — rendering fallback and continuing rotation:', err);
    renderLoadError = true;
    const body = document.getElementById('nbBody');
    if (body) {
      const fallback = wallStateHtml(
        'Display error',
        'This page could not be rendered.',
        'This page will retry on the next refresh.',
        'error'
      );
      body.innerHTML = fallback;
      body.dataset.pageHtml = fallback;   // keep the fingerprint in sync so the next poll's diff isn't comparing against stale content
      body.scrollTop = 0;
      readingOffsets = [0];
    }
    reflectPageMetadata();
    reflectPager();
    resetDwell();
    scheduleNextPage();   // never let a poisoned page stall the rotation permanently
  }
  updateLiveline();
}

function renderPageUnsafe(lastPart, preservePosition) {
  const body = document.getElementById('nbBody');
  if (!body) return;
  if (!newsPages.length) newsPages = buildPages();
  newsPage = newsPage % newsPages.length;
  const page = newsPages[newsPage];
  displayedPage = {
    ...page, index: newsPage, count: newsPages.length,
    briefDate: briefDoc?.date, briefGeneratedAt: briefDoc?.generatedAt,
    briefFile: briefDoc?.filename,
    briefWarnings: [...(briefDoc?.warnings || [])],
    feedGeneratedAt: landscape?.generatedAt,
  };
  const html = renderSection(page);
  const sameContent = body.dataset.pageHtml === html;
  const scrollTop = preservePosition && sameContent ? body.scrollTop : 0;
  body.innerHTML = html;
  body.dataset.pageHtml = html;   // the "is the current page actually different" fingerprint renderNews compares against on each poll
  body.scrollTop = scrollTop;
  body.classList.remove('nb-fade');
  void body.offsetWidth;
  body.classList.add('nb-fade');
  // Publication and feed-snapshot labels describe the displayed content. Feed
  // health can continue updating independently while the operator holds it.
  reflectPageMetadata();
  // While held, the pager carries the PAUSED affordance beside the folio count
  // so the state is legible at 10 ft; the .nb-paused class lets the styles freeze the
  // dwell bar and dim the live tempo without hiding the position in the rotation.
  reflectPaused();
  // Publication and controls can wrap and change the available reading height.
  // Measure only after the complete page chrome describes this exact content.
  readingOffsets = readingStops(body);
  if (lastPart) body.scrollTop = readingOffsets.at(-1);
  reflectPager();
  resetDwell();
  scheduleNextPage();
}

let dwellStartMs = 0;          // for the reduced-motion stepped countdown
let dwellMs = NEWS_PAGE_MS;
let lastBoardWord = '';        // last announced board-status word, so the SR announcer fires on CHANGE only, not every 1s tick

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Restart the dwell-countdown hairline (also a freeze detector) each page.
// Under reduced motion the smooth scaleX transition is replaced by a
// discrete, stepped countdown (see stepDwell): the bar still visibly counts down
// (a non-animated status signal), it just jumps in quarters instead of gliding.
function resetDwell() {
  const d = document.getElementById('nbDwell');
  if (!d) return;
  dwellMs = currentDwellMs();
  // A held rotation freezes the countdown: hold the bar full (no transition,
  // no stepped decay) so the frozen dwell reads unambiguously as "paused, not stuck".
  if (paused) {
    d.style.transition = 'none';
    d.style.transform = 'scaleX(1)';
    dwellStartMs = 0;   // suppress the reduced-motion stepDwell decay while held
    return;
  }
  if (prefersReducedMotion()) {
    d.style.transition = 'none';
    d.style.transform = 'scaleX(1)';
    dwellStartMs = Date.now();
    return;
  }
  d.style.transition = 'none';
  d.style.transform = 'scaleX(1)';
  void d.offsetWidth;
  d.style.transition = `transform ${dwellMs}ms cubic-bezier(0.33, 0, 0.67, 1)`;   /* decelerate toward the turn — deliberate, not a mechanical stopwatch */
  d.style.transform = 'scaleX(0)';
}

// Reduced-motion: step the dwell bar down in discrete quarters (1 · .75 · .5 ·
// .25 · 0) on each 1s liveline tick, so a frozen board is still distinguishable
// from a counting-down one without any continuous motion. No-op when motion is on.
function stepDwell() {
  if (!dwellStartMs || !prefersReducedMotion()) return;
  const d = document.getElementById('nbDwell');
  if (!d) return;
  const frac = Math.max(0, 1 - (Date.now() - dwellStartMs) / dwellMs);
  d.style.transition = 'none';
  d.style.transform = `scaleX(${Math.ceil(frac * 4) / 4})`;
}

// Dwell for the page currently on screen (falls back to the default).
function currentDwellMs() {
  return PAGE_DWELL_MS[displayedPage?.kind || newsPages[newsPage]?.kind] || NEWS_PAGE_MS;
}

// Schedule the next flip for the CURRENT page's dwell. Called from renderPage so
// the flip timer and the dwell-bar (resetDwell) always start together, in sync —
// no gap between the bar emptying and the page turning. Cleared in unmount().
function scheduleNextPage() {
  clearTimeout(newsTimer);
  if (!mounted || paused || (newsPages.length <= 1 && readingOffsets.length <= 1)) return;
  newsTimer = setTimeout(advanceNewsPage, currentDwellMs());
}

function advanceNewsPage() {
  if (!mounted || paused) return;
  turnPage(1);
}

// Manual control on a staffed (non-kiosk) watchfloor. Bound in mount, removed
// in unmount. Arrow keys step the rotation and clear the auto-timer (an operator
// stepping through implies they want to dwell, so we stop the flip); Space holds and
// resumes. We deliberately do NOT touch G (view chord) or Esc (Wall exit) — those
// stay owned by the global shortcuts so this handler never blocks a view change.
function onWallKey(e) {
  if (!mounted) return;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
  if (document.querySelector('dialog[open], [aria-modal="true"], .help-overlay')) return;
  if (e.target?.isContentEditable || e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const interactive = e.target?.closest?.('button, a, [role="button"]');
  const wallArrow = ['ArrowLeft', 'ArrowRight'].includes(e.key) && e.target?.closest?.('.nb-controls');
  if (interactive && !wallArrow) return; // Space activates the focused control natively
  if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) holdReading();
  switch (e.key) {
    case 'ArrowRight': e.preventDefault(); stepPage(+1); break;
    case 'ArrowLeft':  e.preventDefault(); stepPage(-1); break;
    case ' ':          // Space — hold / resume the rotation
    case 'Spacebar':   e.preventDefault(); togglePause(); break;
    default: /* leave every other key (G-chord, Esc, etc.) to the global handlers */
  }
}

// Manual stepping holds the rotation until the operator explicitly resumes.
function stepPage(dir) {
  if (!mounted || !displayedPage || displayedPage.kind === 'empty') return;
  paused = true;
  clearTimeout(newsTimer);
  turnPage(dir);
}

function turnPage(dir) {
  const body = document.getElementById('nbBody');
  if (!body) return;
  refreshReadingStops();
  const current = body.scrollTop;
  const nextOffset = dir > 0
    ? readingOffsets.find(offset => offset > current + 2)
    : [...readingOffsets].reverse().find(offset => offset < current - 2);
  if (nextOffset !== undefined) {
    body.scrollTop = nextOffset;
    lastFlipAt = Date.now();
    reflectPaused();
    reflectPager();
    resetDwell();
    scheduleNextPage();
    updateLiveline();
    return;
  }
  newsPages = buildPages();
  const matched = newsPages.findIndex(page => page.kind === displayedPage?.kind && page.idx === displayedPage?.idx);
  if (matched >= 0) newsPage = matched;
  newsPage = (newsPage + dir + newsPages.length) % newsPages.length;
  renderPage(dir < 0);
}

function refreshReadingStops(rearm = false) {
  const body = document.getElementById('nbBody');
  if (!body) return;
  readingOffsets = readingStops(body);
  reflectPager();
  if (rearm && displayedPage) {
    lastFlipAt = Date.now();
    resetDwell();
    scheduleNextPage();
    updateLiveline();
  }
}

function reflectPager() {
  if (!displayedPage) return;
  const scrollTop = document.getElementById('nbBody')?.scrollTop || 0;
  const index = Math.max(0, readingOffsets.findLastIndex(offset => offset <= scrollTop + 2));
  const part = readingOffsets.length > 1 ? ` · Part ${index + 1} / ${readingOffsets.length}` : '';
  setText('nbPager', `Page ${displayedPage.index + 1} / ${displayedPage.count}${part}`);
}

function holdReading() {
  if (!paused && displayedPage) {
    paused = true;
    clearTimeout(newsTimer);
    reflectPaused();
    resetDwell();
    updateLiveline();
  }
}

// Toggle the operator hold. Pausing freezes the flip timer and the dwell bar; resuming
// re-arms the rotation for the current page's remaining read from the top.
function togglePause() {
  if (!mounted || !displayedPage || displayedPage.kind === 'empty') return;
  paused = !paused;
  if (paused) {
    clearTimeout(newsTimer);
    reflectPaused();
    resetDwell();   // freeze the bar full
  } else {
    // Apply deferred content now, preserving the reading position when the
    // content is unchanged.
    newsPages = buildPages();
    if (newsPage >= newsPages.length) newsPage = 0;
    // Use the same render transaction as an automatic turn: content, section,
    // publication time, position, and continuation offsets update together.
    renderPage(false, true);
  }
  updateLiveline();
}

// Reflect the hold state on the board so the styles can freeze the dwell tempo and
// stamp the paused affordance — kept honest with the `paused` flag, never guessed.
function reflectPaused() {
  document.querySelector('.news-mode')?.classList.toggle('nb-paused', paused);
  const unavailable = !displayedPage || displayedPage.kind === 'empty';
  for (const id of ['nbPrev', 'nbNext', 'nbPause']) {
    const control = document.getElementById(id);
    if (control) control.disabled = unavailable;
  }
  const button = document.getElementById('nbPause');
  if (button) {
    button.textContent = paused ? 'Resume' : 'Pause';
    button.setAttribute('aria-label', paused ? 'Resume rotation' : 'Pause rotation');
  }
}

function reflectPageMetadata() {
  if (!displayedPage) return;
  const slugEl = document.getElementById('nbSlug');
  const briefKind = BRIEF_KINDS.has(displayedPage.kind);
  const stale = briefKind && isBriefStale(displayedPage.briefDate, displayedPage.briefGeneratedAt);
  if (slugEl) {
    slugEl.textContent = SECTION_LABELS[displayedPage.kind] || 'Cyber Defense Intelligence';
    slugEl.dataset.status = 'live'; // Edition age belongs to its dated stamp.
  }
  const stamp = document.getElementById('nbBriefStamp');
  if (stamp) {
    const publication = formatBriefPublication({ generatedAt: displayedPage.briefGeneratedAt, filename: displayedPage.briefFile, date: displayedPage.briefDate });
    const feedTime = formatBriefPublishedAt(displayedPage.feedGeneratedAt);
    const feedStamp = ['wire', 'kev'].includes(displayedPage.kind)
      ? (feedTime ? `Feed snapshot ${feedTime}` : 'Feed snapshot time unavailable') : '';
    stamp.textContent = briefKind
      ? `${publication}${stale ? ' · Older edition' : ''}${briefLoadError ? ' · Refresh unavailable' : ''} · AI-generated · Verify before acting${displayedPage.briefWarnings?.length ? ` · ${displayedPage.briefWarnings.length} automated ${displayedPage.briefWarnings.length === 1 ? 'check needs' : 'checks need'} review` : ''}`
      : [feedStamp, briefLoadError ? 'Briefing unavailable · Retrying automatically'
        : displayedPage.kind === 'brieferror' && briefDoc ? 'Briefing available · Resume or advance to read' : ''].filter(Boolean).join(' · ');
    stamp.title = briefKind ? (displayedPage.briefWarnings || []).join('\n') : '';
    stamp.dataset.status = stale || briefLoadError || (briefKind && displayedPage.briefWarnings?.length) ? 'warn' : 'live';
  }
}

// splitBluf/capitalizeFirst now live in wall-format.js (pure text-splitting,
// no DOM dependency) and are imported above; the doc comment on their rationale
// (the em/en-dash clause-break heuristic) lives with the implementation there.

function renderSection(def) {
  if (!def) return '';
  // Belt-and-braces: buildPages() only emits brief-kind pages when briefDoc
  // is set, but a stale `def` captured just before a failed refetch nulled briefDoc
  // (see ensureBrief's catch) must never reach splitBluf(null.bluf) or similar —
  // fall back to the empty page rather than throwing inside the setTimeout flip chain.
  if (BRIEF_KINDS.has(def.kind) && !briefDoc) {
    return wallStateHtml(
      'Brief unavailable',
      'The saved Briefing could not be loaded.',
      'Feed pages remain in rotation while the Wall retries.',
      'warn'
    );
  }
  switch (def.kind) {
    case 'brieferror':
      return wallStateHtml(
        'Brief unavailable',
        'The saved Briefing could not be loaded.',
        'Feed pages remain in rotation while the Wall retries.',
        'warn'
      );

    // The cover: the day's thesis as a newspaper front-page lead — eyebrow →
    // towering headline (the claim) → standfirst deck (the detail). Splitting the
    // thesis at a natural clause boundary keeps the claim and detail distinct.
    // Unbroken prose stays intact at a smaller headline scale, without clipping.
    case 'bluf': {
      const { headline, deck } = splitBluf(briefDoc.bluf);
      return `
        <section class="nb-section nb-cover-page">
          <div class="nb-cover">
            <span class="nb-cover-kicker">Bottom line up front</span>
            <h2 class="nb-cover-head${headline.length > 150 ? ' is-long' : ''}"><span class="nb-clamp nb-clamp-4">${escapeHtml(headline)}</span></h2>
            ${deck ? `<p class="nb-cover-deck"><span class="nb-clamp nb-clamp-6">${escapeHtml(deck)}</span></p>` : ''}
          </div>
        </section>`;
    }

    // Executive summary: situation on the left, owner queue on the right. A deadline
    // shared by every action is printed once above the queue, not repeated in
    // every row. This changes presentation only; the saved brief stays intact.
    case 'execsummary': {
      const model = executiveSummaryModel(briefDoc.execSummary || []);
      const situation = [model.threat, model.exposure, ...model.context].filter(Boolean);
      const situationClamp = situation.length <= 2 ? 6 : 3;
      const situationHtml = situation.map((item, i) => `
        <div class="nb-exec-fact${i === 0 ? ' is-primary' : ''}">
          <dt>${escapeHtml(item.label)}</dt>
          <dd><span class="nb-clamp nb-clamp-${situationClamp}">${escapeHtml(item.text)}</span></dd>
        </div>`).join('');
      const decisionsHtml = model.decisions.map((item, i) => `
        <li class="nb-exec-decision">
          <span class="nb-exec-index" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
          <div class="nb-exec-task">
            <strong>${escapeHtml(item.owner)}</strong>
            <p><span class="nb-clamp nb-clamp-3">${escapeHtml(item.action)}</span></p>
          </div>
          ${item.deadline && !model.commonDeadline ? `<span class="nb-exec-due">${escapeHtml(item.deadline)}</span>` : ''}
        </li>`).join('');
      const fallback = !situationHtml && !decisionsHtml
        ? '<div class="nb-empty">No executive actions were included in this edition.</div>'
        : '';
      return `
        <section class="nb-section nb-exec-page" aria-label="Executive summary">
          ${fallback || `
          <div class="nb-exec-grid${!situationHtml || !decisionsHtml ? ' is-single' : ''}${model.decisions.length > 4 || model.decisions.some(item => item.action.length > 280) ? ' is-long' : ''}">
            ${situationHtml ? `<section class="nb-exec-situation" aria-labelledby="nbExecSituation">
              <header>
                <h3 id="nbExecSituation">Threat and exposure</h3>
              </header>
              <dl>${situationHtml}</dl>
            </section>` : ''}
            ${decisionsHtml ? `<section class="nb-exec-decisions" aria-labelledby="nbExecDecisions">
              <header>
                <div>
                  <span class="nb-exec-overline">Owner queue</span>
                  <h3 id="nbExecDecisions">Decisions required</h3>
                </div>
                ${model.commonDeadline ? `<div class="nb-exec-shared-due"><span>Shared due</span><strong>${escapeHtml(model.commonDeadline)}</strong></div>` : ''}
              </header>
              ${decisionsHtml ? `<ol>${decisionsHtml}</ol>` : '<p class="nb-exec-none">No owner-specific decision was included.</p>'}
            </section>` : ''}
          </div>`}
        </section>`;
    }

    // One operational judgment, the focal object, with the this-shift action.
    case 'judgment': {
      const s = (briefDoc.stories || [])[def.idx];
      if (!s) return '<div class="nb-empty">—</div>';
      const coverage = judgmentOverflowNote(briefDoc?.stories || []);
      return `<section class="nb-section nb-judgment-page">${coverage ? `<p class="nb-judgment-coverage">${escapeHtml(coverage)}</p>` : ''}${judgmentHtml(s, briefDoc?.date)}</section>`;
    }

    // The live status board: what is moving, which way, and the escalation trigger.
    case 'developing': {
      const rows = (briefDoc.developing || []).filter(d => d && [d.name, d.watch, d.trajectory].some(v => String(v || '').trim())).map(developingHtml).join('');
      return `<section class="nb-section"><div class="nb-devboard">${rows}</div></section>`;
    }

    // Connect-the-dots as a full-height editorial stack: the "X + Y" framing
    // leads, the intersection sets context, the cascade carries the reasoning,
    // and the move closes as a full-width directive. All four parser fields render;
    // is-single simply omits the directive block when the brief has no move.
    case 'convergence': {
      const c = (briefDoc.convergence || [])[def.idx];
      if (!c) return '<div class="nb-empty">—</div>';
      const verb = (c.moveVerb || 'Act').toUpperCase();
      return `
        <section class="nb-section nb-conv${c.move ? '' : ' is-single'}">
          <header class="nb-conv-head">
            <h2 class="nb-conv-title"><span class="nb-clamp nb-clamp-2">${escapeHtml(c.title)}</span></h2>
          </header>
          <div class="nb-conv-stack">
            ${c.intersection ? `<div class="nb-conv-block">
              <span class="nb-conv-label">The intersection</span>
              <p class="nb-conv-intersect"><span class="nb-clamp nb-clamp-6">${escapeHtml(c.intersection)}</span></p>
            </div>` : ''}
            ${c.cascade ? `<div class="nb-conv-block nb-conv-block-lead">
              <span class="nb-conv-label accent">The cascade</span>
              <p class="nb-conv-cascade"><span class="nb-clamp nb-clamp-6">${escapeHtml(c.cascade)}</span></p>
            </div>` : ''}
            ${c.move ? `
            <div class="nb-conv-move c-action">
              <span class="nb-conv-stance">${escapeHtml(verb)}</span>
              <p class="nb-move-text"><span class="nb-clamp nb-clamp-3">${escapeHtml(c.move)}</span></p>
            </div>` : ''}
          </div>
        </section>`;
    }

    // Recently added to CISA KEV — newly confirmed exploited-in-the-wild, newest
    // first, vendor/product shown so an analyst scans for their own stack. We
    // lead with what landed this week, NOT a federal "overdue" count: KEV due
    // dates are ~2-week federal deadlines, so nearly everything older reads
    // "overdue" — a near-constant that isn't this org's clock. New-and-exploited
    // is the actionable read from 10 ft: "check exposure to these now."
    case 'kev': {
      return renderKevSection(landscape.kev || {});
    }

    // The live wire — demoted: one compact page, the evidence the brief is built on.
    case 'wire': {
      return wirePageHtml(landscape.signals || []);
    }

    default:
      return wallStateHtml(
        'Waiting for evidence',
        'No Briefing or scored signals are available yet.',
        'The Wall will update after the next successful refresh.'
      );
  }
}

function wallStateHtml(kicker, title, detail, tone = 'waiting') {
  return `<div class="nb-empty nb-state nb-state-${escapeHtml(tone)}">
    <span class="nb-state-kicker">${escapeHtml(kicker)}</span>
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(detail)}</span>
  </div>`;
}

// One Developing Situation row: color-keyed trajectory token + name + trip-line.
function developingHtml(d) {
  const v = (d.trajectory || '').toLowerCase();
  const cls = v.startsWith('accel') ? 'accel'
    : v.startsWith('decel') ? 'decel'
      : v.startsWith('inflect') ? 'inflect'
        : v.startsWith('stall') ? 'stalled'
          : '';
  const glyph = cls === 'accel' ? '▲'
    : cls === 'decel' ? '▼'
      : cls === 'inflect' ? '◆'
        : cls === 'stalled' ? '■'
          : '•';
  return `
    <div class="nb-dev">
      <span class="nb-traj ${cls}">${glyph} ${escapeHtml(d.trajectory || 'Tracking')}</span>
      <div class="nb-dev-body">
        <h3 class="nb-dev-name"><span class="nb-clamp nb-clamp-2">${escapeHtml(d.name)}</span></h3>
        ${d.trajectoryDetail && d.trajectoryDetail !== d.trajectory ? `<p class="nb-dev-context">${escapeHtml(d.trajectoryDetail)}</p>` : ''}
        ${d.watch ? `<p class="nb-dev-watch"><span class="nb-clamp nb-clamp-2">${escapeHtml(d.watch)}</span></p>` : ''}
      </div>
    </div>`;
}

// The Key-Judgment page as a broadsheet front-page lead: claim + standfirst,
// a compact analytic ledger (horizon / decision / confidence), then the proof
// and directive at the fold. The tier is one fact, not an alert-sized emblem.
// Citation hosts come from the archived judgment, including non-CVE judgments.
export function judgmentSources(s) {
  // Only this judgment's saved links establish citation provenance. Today's
  // feed can discuss the same CVE without having informed an older assessment.
  const names = new Set();
  for (const citation of Array.isArray(s.citations) ? s.citations : []) {
    try {
      const url = new URL(citation.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      names.add(url.hostname.replace(/^www\./i, ''));
    } catch { /* malformed or relative links do not establish a source */ }
  }
  return [...names];
}

function decisionBriefDateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
  ) return '';
  return date.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

export function judgmentHtml(s, briefDate = '') {
  // Coerce horizon to a valid tier — a missing/out-of-range value would render an
  // unstyled pip with no tier name, silently misrepresenting the signal.
  const h = [1, 2, 3].includes(s.horizon) ? s.horizon : 2;
  if (h !== s.horizon) console.warn('[wall] judgment with invalid horizon:', s.horizon, '—', s.title);

  // Two independent axes: the tier names the judgment's analytic horizon,
  // while Decision says when the operator should decide/initiate the first
  // response. The source Markdown intentionally stays terse; expand it here so
  // "7 days" can never read as incident age, a prediction, or a countdown.
  const decision = formatDecisionWindow(s.decision);
  const decisionDate = decision.relative ? decisionBriefDateLabel(briefDate) : '';
  const decisionAria = decisionDate
    ? `Decision window: ${decision.display.toLowerCase()}, measured from the ${decisionDate} Briefing`
    : `Decision window: ${decision.display}`;
  const decisionHtml = decision.display
    ? `<div class="nb-jfact nb-jdecision${decision.legacy ? ' is-legacy' : ''}" aria-label="${escapeHtml(decisionAria)}">
        <dt>Decision</dt>
        <dd>${escapeHtml(decision.display)}${decisionDate ? `<small class="nb-decision-anchor">From ${escapeHtml(decisionDate)} Briefing</small>` : ''}</dd>
      </div>`
    : '';
  const certainty = judgmentCertainty(s.confidence);
  const facts = `<dl class="nb-jfacts" aria-label="Judgment timing and ${certainty.label.toLowerCase()}">
    <div class="nb-jfact">
      <dt>Horizon</dt>
      <dd class="h${h}"><i class="h-pip h${h}" aria-hidden="true"></i>${escapeHtml(TIER_NAMES[h] || '')}</dd>
    </div>
    ${decisionHtml}
    ${certainty.value ? `<div class="nb-jfact nb-jconfidence"><dt>${certainty.label}</dt><dd>${escapeHtml(certainty.value)}</dd></div>` : ''}
  </dl>`;

  // The one this-shift action — the climax, marked by the blue directive rule.
  // Its parsed owner and target sit outside the clamped imperative so the board
  // never drops accountability or timing when the instruction is long.
  const action = actionDisplayModel(s.actionShift);
  const act = action.imperative || action.owner || action.target
    ? `<div class="nb-act c-action">
        ${action.owner ? `<span class="nb-act-owner">${escapeHtml(action.owner)}</span>` : ''}
        ${action.imperative ? `<span class="nb-act-text nb-clamp nb-clamp-3">${escapeHtml(action.imperative)}</span>` : ''}
        ${action.target ? `<span class="nb-act-target"><small>Recommended target</small><strong>${escapeHtml(action.target)}</strong></span>` : ''}
      </div>`
    : '';

  const sources = judgmentSources(s);
  const evidence = s.isKEV || sources.length
    ? `<div class="nb-jevidence" aria-label="Saved citation provenance">
        ${s.isKEV ? `<span class="nb-evidence-kev">KEV${s.kevCVE ? ` · ${escapeHtml(s.kevCVE)}` : ''}</span>` : ''}
        ${sources.length ? `<span class="nb-evidence-sources"><b>${sources.length === 1 ? 'Cited source' : 'Cited sources'}</b> ${sources.map(escapeHtml).join(' · ')}</span>` : ''}
      </div>`
    : '';
  const reasoning = s.assessment || certainty.basis || evidence
    ? `<div class="nb-jreasoning">
        ${s.assessment ? `<p class="nb-jbody"><span class="nb-clamp nb-clamp-4">${escapeHtml(s.assessment)}</span></p>` : ''}
        ${certainty.basis ? `<p class="nb-jbody nb-certainty-basis"><strong>${certainty.label} basis:</strong> ${escapeHtml(certainty.basis)}</p>` : ''}
        ${evidence}
      </div>`
    : '';
  // The FOLD (reasoning | directive) is emitted ONLY when at least one of the two
  // exists — so a bordered-but-empty ledger or a stranded gutter can never appear.
  // Presence is decided here in JS (no :has()/placeholder hacks).
  const fold = (reasoning || act)
    ? `<footer class="nb-jfold${reasoning && act ? '' : ' is-single'}">${reasoning}${act}</footer>`
    : '';

  return `
    <article class="nb-judgment nb-lead">
      <div class="nb-jhead-band">
        <div class="nb-jhead-row">
          <div class="nb-jhead-main">
            <h2 class="nb-jhead"><span class="nb-clamp nb-clamp-3">${escapeHtml(s.title)}</span></h2>
            ${s.line ? `<p class="nb-standfirst"><span class="nb-clamp nb-clamp-3">${escapeHtml(s.line)}</span></p>` : ''}
          </div>
          <div class="nb-jhead-aside">
            ${facts}
          </div>
        </div>
      </div>
      ${fold}
    </article>`;
}

// One wire row, racked onto shared columns: rail · horizon · headline+meta · severity · age.
function wireStoryHtml(s, isLead) {
  const h = [1, 2, 3].includes(s.horizon) ? s.horizon : 2;   // a missing/out-of-range tier would render an unstyled, invisible row at 10 ft
  const age = relAge(s.date);
  const fresh = isFresh(s.date);
  const cls = `nb-item h${h}${isLead ? ' lead' : ''}${s.isKEV ? ' is-kev' : ''}${s.urgency === 'critical' ? ' is-crit' : ''}`;

  const sev = [];
  if (s.isKEV) {
    sev.push('<span class="nb-badge kev">KEV</span>');
    if (s.kevCVE) sev.push(`<span class="nb-badge nb-cve kev">${escapeHtml(s.kevCVE)}</span>`);
  }
  else if (s.urgency === 'critical') sev.push('<span class="nb-badge crit">CRITICAL</span>');
  const cvss = cvssFrom(s);
  if (cvss) {
    const sv = (cvss.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/) || [])[1] || 'na';
    sev.push(`<span class="nb-badge cvss sev-${sv.toLowerCase()}">${escapeHtml(cvss)}</span>`);
  }

  const meta = [];
  const actor = s.actors && s.actors[0];
  if (actor) {
    const region = regionLabels[actor.region] || actor.region;
    // Heuristic attribution — mark it auto-tagged so the Wall never renders a
    // regex-derived guess as confirmed fact (trust-affordance parity with the Wire).
    meta.push(`<span class="nb-heur" title="Auto-tagged from headline text — attribution is heuristic; verify with vendor reporting">${escapeHtml(actor.name + (region ? ' · ' + region : ''))}</span>`);
  } else if (s.vendors && s.vendors[0]) {
    meta.push(`<span class="nb-heur" title="Auto-tagged from headline text — vendor match is heuristic; verify with vendor advisories">${escapeHtml(s.vendors[0])}</span>`);
  }
  // The reporting-source count is readable without knowing the nested-ring icon.
  // Its brand accent denotes provenance, separate from trajectory/liveness.
  // Cap the printed count at 9+ (matching the Wire), so a runaway source count
  // number never widens the meta line or reads as a spurious precision at 10 ft.
  if (s.corroboration > 1) {
    const shown = s.corroboration > 9 ? '9+' : String(s.corroboration);
    meta.push(`<span class="nb-corrob" title="Reported by ${escapeHtml(String(s.corroboration))} distinct sources"><span class="nb-corrob-rings" aria-hidden="true"></span>${escapeHtml(shown)} sources</span>`);
  }
  if (s.source) meta.push(`<span class="nb-source-name">Source: ${escapeHtml(s.source)}</span>`);

  const dek = cleanSummary(s.description);
  // The score's own receipt ("KEV-verified · reported by 3 distinct sources · CVSS
  // 9.8"), not just the bare score/badges above: the Wire route already ships
  // scoreRationale (routes/landscape.js) but compactHeadline — the shape behind
  // landscape.signals, which is what the Wall actually renders — currently omits
  // it (lib/landscape.js). Read defensively so this is a no-op today and lights
  // up the moment that field ships.
  const rationale = s.scoreRationale ? escapeHtml(s.scoreRationale) : '';
  return `
    <article class="${cls}">
      <div class="nb-rail h${h}"></div>
      <div class="nb-c-h"><span class="nb-h h${h}"><i class="h-pip h${h}"></i>${TIER_NAMES[h] || ''}</span></div>
      <div class="nb-c-main">
        <h2 class="nb-headline"><span class="nb-clamp nb-clamp-2">${escapeHtml(s.title)}</span></h2>
        ${dek ? `<p class="nb-dek"><span class="nb-clamp nb-clamp-2">${escapeHtml(dek)}</span></p>` : ''}
        ${rationale ? `<p class="nb-score-rationale"><span class="nb-clamp nb-clamp-2">${rationale}</span></p>` : ''}
        ${meta.length ? `<div class="nb-submeta">${meta.join('')}</div>` : ''}
      </div>
      <div class="nb-c-sev">${sev.join('')}</div>
      <div class="nb-c-age">${age ? `<span class="nb-age${fresh ? ' fresh' : ''}">${fresh ? 'NEW · ' : ''}${escapeHtml(age)}</span>` : '<span class="nb-age nb-age-none" title="No publication date on the source item">—</span>'}</div>
    </article>
  `;
}

export function wirePageHtml(signals = []) {
  const usable = (Array.isArray(signals) ? signals : []).filter(s => s && String(s.title || '').trim());
  const sigs = usable.slice(0, WIRE_MAX);
  return `<section class="nb-section"><p class="nb-coverage">Top ${sigs.length} of ${usable.length} available signals · Full feed in Wire</p><div class="nb-feed">${sigs.map((s, i) => wireStoryHtml(s, i === 0)).join('')}</div></section>`;
}

// ── Brief parsing ──
// The brief→editorial-object parsers (parseBrief, parseJudgments,
// parseExecBullets, parseDeveloping, parseConvergence) live in the shared brief
// contract (lib/brief-schema.js, served at /vendor/brief-schema.js) so the Wall
// and the server parse the brief through one source and can never drift. They
// are imported at the top; the Wall keeps only its rendering below.

// cvssFrom/cleanSummary/relAge/isFresh/formatBriefDateStamp/isBriefStale live in
// wall-format.js (pure string/date functions, no DOM dependency).

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// Drive the board's staleness decay from the SAME warn state the masthead
// computes, so the dim and the STALE/UPDATED readout can never disagree.
function setBoardStale(stale) {
  document.querySelector('.news-mode')?.classList.toggle('nb-stale', !!stale);
}

// Kiosk-only overnight dim (a second burn-in lever alongside the pixel shift):
// a staffed watchfloor with an operator at the keys should never have its board
// dim itself unasked, so this is gated to kiosk mode exactly like the self-reload.
// Plain hour-of-day window, no cross-midnight special-casing needed since
// the default 01:00–05:00 window doesn't wrap past 24:00.
function applyQuietHourDim(now) {
  const el = document.querySelector('.news-mode');
  if (!el) return;
  const inWindow = document.body.classList.contains('kiosk')
    && now.getHours() >= QUIET_DIM_START_HOUR && now.getHours() < QUIET_DIM_END_HOUR;
  el.classList.toggle('nb-quiet-dim', inWindow);
}

// The masthead's most legible liveness word, kept honest: its text AND colour
// follow the same warn state as the dot and the integrity readout.
function setLiveWord(word, warn) {
  const el = document.getElementById('nbLiveWord');
  if (!el) return;
  el.textContent = word;
  el.dataset.status = warn ? 'warn' : 'live';
  // The integrity readout updates every second (the ticking "UPDATED 4m");
  // announcing that to a screen reader each tick is noise. Announce the board
  // status ONLY when the word actually changes, so the transition is heard once.
  if (word !== lastBoardWord) {
    lastBoardWord = word;
    setText('nbAnnounce', `Board status: ${word}`);
  }
}

// Liveness: a ticking clock, a mono date stamp, and a freshness / feed-health
// readout that turns amber when data ages or feeds drop, so a frozen board can
// never pass for live.
function startLiveline() {
  updateLiveline();
  timers.push(setInterval(updateLiveline, 1000));
}

function updateLiveline() {
  stepDwell(); // discrete dwell countdown under reduced motion (no-op otherwise)
  const now = new Date();
  applyQuietHourDim(now);   // kiosk-only overnight dim; cheap, so it rides the existing 1s tick rather than its own timer
  setText('nbClock', now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }));
  reflectPageMetadata();
  reflectPaused();
  reflectPager();
  const stalled = !paused && (newsPages.length > 1 || readingOffsets.length > 1) && lastFlipAt > 0
    && (Date.now() - lastFlipAt) > 2 * currentDwellMs();
  const playback = document.getElementById('nbPlayback');
  if (playback) {
    playback.textContent = renderLoadError ? `Display error · ${paused ? 'Paused · ' : ''}Retrying on refresh`
      : !displayedPage ? (sourceLoadError ? 'Waiting for data' : 'Loading')
        : paused ? 'Paused' : stalled ? 'Rotation stalled'
          : newsPages.length <= 1 && readingOffsets.length <= 1 ? 'Single page' : 'Auto-rotating';
    playback.dataset.status = stalled || renderLoadError ? 'warn' : 'live';
  }
  const el = document.getElementById('nbIntegrity');
  const dot = document.getElementById('nbLiveDot');
  if (!el) return;
  const genMs = Date.parse(landscape?.generatedAt);
  const ageSec = Number.isFinite(genMs) ? Math.max(0, Math.round((Date.now() - genMs) / 1000)) : null;
  const ago = ageSec === null ? '' : ageSec < 90 ? `${ageSec}s` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m` : `${Math.round(ageSec / 3600)}h`;
  const ok = landscape?.feeds?.ok;
  const total = landscape?.feeds?.total;
  const invalidFeeds = !Number.isFinite(ok) || !Number.isFinite(total) || total <= 0 || total < ok || ok < 0;
  const stale = ageSec !== null && ageSec > staleAfterSec(landscape?.pipeline?.refreshMinutes);
  const degraded = !invalidFeeds && ok < total;
  let word;
  if (sourceLoadError) {
    el.textContent = `Source refresh unavailable · Retrying${ago ? ` · Last refresh ${ago} ago` : ''}`;
    word = 'FEEDS UNAVAILABLE';
  } else if (!landscape) {
    el.textContent = 'Loading source data';
    word = 'FEEDS LOADING';
  } else if (ageSec === null) {
    el.textContent = landscape.generatedAt ? 'Feed refresh time unavailable' : 'Awaiting first feed refresh';
    word = 'FEEDS UNKNOWN';
  } else if (invalidFeeds) {
    el.textContent = `Feed health unavailable · Refreshed ${ago} ago`;
    word = 'FEEDS UNKNOWN';
  } else {
    el.textContent = `Feeds ${ok}/${total} · Refreshed ${ago} ago`;
    word = stale ? 'FEEDS STALE' : degraded ? 'FEEDS DEGRADED' : 'FEEDS CURRENT';
  }
  const warn = sourceLoadError || ageSec === null || invalidFeeds || stale || degraded;
  el.dataset.status = warn ? 'warn' : 'live';
  if (dot) dot.dataset.status = warn ? 'warn' : 'live';
  setLiveWord(word, warn);
  setBoardStale(warn);
}

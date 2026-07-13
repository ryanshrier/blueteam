// BlueTeam.News — the Wall.
// A passive watchfloor broadsheet for a TV on the operations floor: a nameplate
// masthead (folio · live date · clock) over a rotating set of editorial sections
// that read the daily brief — The Briefing (BLUF + in-brief) and Key Judgments
// (with the "line", confidence, decision window) —
// interleaved with The Wire (live scored signals). Editorial serif headlines,
// warm cream ink, the decision facts as chips. Updates and rotates on a timer.

import { escapeHtml } from '../core/sanitize.js';
import { fetchLandscape, fetchHeadlines, fetchBrief, fetchEdition, fetchHealth } from '../core/api.js';
import { setState } from '../core/store.js';
// One brief contract, shared with the server (lib/brief-schema.js, served at
// /vendor/brief-schema.js): the section names, field labels, and parse helpers
// live there so the Wall and the server can never drift. The Wall keeps its own
// rendering; only its parsing sources this module.
import { parseBrief } from '/vendor/brief-schema.js';

import { TIER_NAMES } from '../core/tiers.js';
// The Wall's own pure rotation/parsing helpers, extracted so they carry no
// DOM dependency and can be unit-tested directly (test/wall-format.test.js), the
// same split already applied to the Wire (wire-format.js). This view keeps only
// the DOM-touching render/timer code; buildPages/splitBluf/relAge/etc. now live
// there as the single source of truth.
import {
  buildPages as buildPagesPure, splitBluf, cvssFrom, cleanSummary,
  relAge, isFresh, formatBriefDateStamp, isBriefStale, staleAfterSec,
  executiveSummaryModel,
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
  developing: 18_000, kev: 16_000, wire: 18_000, empty: 8_000,
};

// The folio slug doubles as the running section label: section identity lives in
// the persistent masthead, so each page's body is pure content with no repeated
// per-page header (and no live/updated line — the masthead is the one indicator).
const SECTION_LABELS = {
  bluf: 'The BLUF', execsummary: 'EXECUTIVE SUMMARY', judgment: 'KEY JUDGMENT',
  developing: 'DEVELOPING SITUATIONS', convergence: 'CONVERGENCE',
  kev: 'KEV · NEWLY ADDED',
  wire: 'THE WIRE', empty: 'Cyber Defense Intelligence',
};
// Page kinds sourced from the parsed brief, i.e. everything that must never
// be read as live-generated: these carry the brief's own as-of date in the slug so
// a weekend-old brief can never rotate under a masthead silently implying "today".
const BRIEF_KINDS = new Set(['bluf', 'execsummary', 'judgment', 'developing', 'convergence']);

let timers = [];
let mounted = false;
let landscape = null;
let allHeadlines = [];    // full scored-headline list (not landscape.signals' top-14 cut) — used to match a judgment to its source publishers by CVE
let newsPage = 0;
let newsTimer = null;      // self-scheduling per-kind page-advance timer
let newsPages = [];        // current rotation of broadsheet sections
let paused = false;        // operator-held rotation (Space); auto-advance frozen while set
let keyHandler = null;     // non-kiosk manual-advance/pause keydown, bound on mount, removed on unmount
let briefDoc = null;       // { bluf, execSummary[], stories[], developing[], convergence[], watchlist[], date }
let briefDocFile = null;   // brief filename currently loaded
let lastFlipAt = 0;        // timestamp of the last renderPage attempt (success or caught failure); updateLiveline watches this for a stalled flip chain

export function mount(layer) {
  if (mounted) return;
  mounted = true;
  // /wall is the canonical passive display route; ?operator is the explicit
  // staffed-review escape hatch that keeps the documented arrow/Space controls
  // reachable without weakening unattended kiosk behavior.
  const wallParams = new URLSearchParams(window.location.search);
  if (window.location.pathname === '/wall' && !wallParams.has('operator')) {
    document.body.classList.add('kiosk');
  }
  mountNews(layer);
  // Manual control for a staffed watchfloor (NOT kiosk: a kiosk is a passive
  // display with no operator at the keys). Arrow keys step pages and freeze the
  // auto-timer; Space holds/resumes the rotation. Bound only while the Wall is
  // mounted and removed in unmount so it never leaks into other views.
  if (!document.body.classList.contains('kiosk')) {
    keyHandler = onWallKey;
    document.addEventListener('keydown', keyHandler);
  }
}

export function unmount() {
  if (!mounted) return;
  mounted = false;
  for (const t of timers) clearInterval(t);
  clearTimeout(newsTimer);
  timers = [];
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }   // drop the manual-control listener with the view
  paused = false;
  landscape = null;
  allHeadlines = [];
  lastBoardWord = '';   // re-announce board status fresh on a remount
  newsPage = 0;
  newsPages = [];
  briefDoc = null;
  briefDocFile = null;
  lastFlipAt = 0;
  lastKnownServerBootMs = null;   // re-baseline on remount rather than reloading against a stale comparison
  lastQuietHourReloadDay = null;
  burnInIdx = 0;
  document.body.classList.remove('kiosk');
  const layer = document.getElementById('wallLayer');
  if (layer) layer.innerHTML = '';
}

async function poll() {
  try {
    landscape = await fetchLandscape();
    // Overlay the active edition's region labels (pack-driven), keeping the Wall's
    // terse defaults authoritative for their own keys. Cached, so this is cheap.
    try {
      const e = await fetchEdition();
      if (e?.regions) regionLabels = { ...e.regions, ...WALL_REGION_DEFAULTS };
    } catch { /* keep the defaults */ }
    // The full scored-headline list (landscape.signals is capped to the top 14,
    // too narrow to find most judgments' source articles) — decorative lookup
    // only, so a failure here never blocks the board's render.
    fetchHeadlines()
      .then(result => {
        if (Array.isArray(result?.headlines)) allHeadlines = result.headlines;
      })
      .catch(() => { /* keep the last complete source index */ });
    setState({ landscape });
    if (!mounted) return;
    renderNews();
    checkKioskSelfReload();   // after a good landscape fetch, so a reload never races an outage
  } catch {
    /* keep last good render */
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
let lastKnownServerBootMs = null;        // inferred from /api/health's uptime
let lastQuietHourReloadDay = null;       // local calendar day (toDateString) of the last quiet-hour reload, so it fires once per day
async function checkKioskSelfReload() {
  if (!document.body.classList.contains('kiosk')) return;
  try {
    const health = await fetchHealth();
    if (Number.isFinite(health?.uptime)) {
      const impliedBootMs = Date.now() - health.uptime * 1000;
      if (lastKnownServerBootMs !== null && impliedBootMs - lastKnownServerBootMs > 2 * 60_000) {
        location.reload();
        return;
      }
      lastKnownServerBootMs = impliedBootMs;
    }
  } catch { /* health check is best-effort; never block the board on it */ }

  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() === KIOSK_QUIET_HOUR && lastQuietHourReloadDay !== today) {
    lastQuietHourReloadDay = today;
    location.reload();
  }
}

// ══════════════════════════════════════════════════════════
// The broadsheet — a passive cyber-defense newspaper for a watchfloor TV.
// A nameplate masthead (folio · live date · clock) over a rotating set of
// editorial sections that fully read the daily brief — The Briefing (BLUF +
// in-brief), Key Judgments (with the punchy "line", confidence, decision
// window), the 72-Hour Watchlist — interleaved with The Wire (live signals).
// Editorial serif headlines, warm cream ink, the decision facts as chips.
// ══════════════════════════════════════════════════════════

function mountNews(layer) {
  layer.innerHTML = `
    <div class="wall news-mode">
      <h1 class="nb-sr-only">BlueTeam.News Wall</h1>
      <header class="nb-folio">
        <div class="nb-folio-id">
          <span class="nb-wordmark">BLUETEAM.NEWS</span>
        </div>
        <span class="nb-folio-slug" id="nbSlug">Cyber Defense Intelligence</span>
        <div class="nb-folio-status">
          <span class="nb-integrity" id="nbIntegrity" data-status="live">—</span>
          <span class="nb-folio-live"><span class="nb-live-dot" id="nbLiveDot" data-status="live"></span><span id="nbLiveWord">LIVE</span> · <span id="nbClock">--:--</span></span>
        </div>
      </header>

      <div class="nb-dwell"><i id="nbDwell"></i></div>
      <span class="nb-sr-only" id="nbAnnounce" role="status" aria-live="polite"></span>

      <div class="nb-body" id="nbBody">
        <div class="nb-empty nb-opening">
          <span class="nb-opening-kicker">Preparing the watchfloor</span>
          <strong>Assembling today’s edition</strong>
          <span>Signals will surface as the feeds respond.</span>
        </div>
      </div>

      <footer class="nb-foot">
        <span class="nb-pager" id="nbPager"></span>
        <span class="nb-controls-hint" id="nbControlsHint">←/→ pages · Space pause · Esc exit</span>
      </footer>
    </div>
  `;

  startLiveline();
  poll();
  if (!document.body.classList.contains('kiosk')) {
    timers.push(setTimeout(() => document.getElementById('nbControlsHint')?.classList.add('is-hidden'), 6500));
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
  newsPages = rebuilt;
  if (newsPage >= newsPages.length) newsPage = 0;
  if (paused) {
    // A held rotation must never have its content swapped underneath the
    // operator; defer any pending change until resume() re-renders explicitly.
    updateLiveline();
    return;
  }
  const currentHtml = newsPages.length ? renderSection(newsPages[newsPage]) : '';
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
  if (!f) { briefDoc = null; briefDocFile = null; return; }
  if (f === briefDocFile) return;
  briefDocFile = f;
  fetchBrief(f).then(d => {
    if (!mounted || briefDocFile !== f) return;
    briefDoc = parseBrief(d.content || '');
    briefDoc.date = (landscape.brief && landscape.brief.date) || '';
    newsPages = buildPages();
    if (newsPage >= newsPages.length) newsPage = 0;
    if (!paused) renderPage();   // a new brief landing must not swap content under a held page either; togglePause's resume path catches it up
  }).catch(() => {
    // Reset briefDocFile too, not just briefDoc: leaving briefDocFile set to
    // the filename that just failed would make the `f === briefDocFile` guard above
    // permanently suppress a retry until a NEW brief filename appears (typically the
    // next day). Rebuild pages + re-render immediately so any brief-derived pages
    // built from the previous (now-stale) briefDoc are dropped from rotation rather
    // than lingering and throwing when renderSection reads a null briefDoc.
    briefDoc = null;
    briefDocFile = null;
    newsPages = buildPages();
    if (newsPage >= newsPages.length) newsPage = 0;
    if (!paused) renderPage();
  });
}

// Thin wrapper over the pure buildPages in wall-format.js, closing over this
// module's own briefDoc/landscape state so every existing call site (renderNews,
// ensureBrief, renderPageUnsafe, togglePause) is unchanged.
function buildPages() {
  return buildPagesPure(briefDoc, landscape);
}

// A bare exception anywhere in the render path used to kill the self-scheduling
// flip chain outright (scheduleNextPage at the end never ran), freezing the board on
// stale content while the masthead kept reading LIVE — the one freeze mode the
// integrity readout couldn't see. Wrapped so a poisoned page renders the empty
// fallback, logs, and STILL re-arms the timer: the rotation heals past it next flip.
function renderPage() {
  lastFlipAt = Date.now();   // recorded even on failure: a caught error still counts as "the board tried to turn"
  try {
    renderPageUnsafe();
  } catch (err) {
    console.error('[wall] renderPage failed — rendering fallback and continuing rotation:', err);
    const body = document.getElementById('nbBody');
    if (body) {
      const fallback = '<div class="nb-empty">Pipeline starting — signals surface as the feeds respond.</div>';
      body.innerHTML = fallback;
      body.dataset.pageHtml = fallback;   // keep the fingerprint in sync so the next poll's diff isn't comparing against stale content
    }
    resetDwell();
    scheduleNextPage();   // never let a poisoned page stall the rotation permanently
  }
}

function renderPageUnsafe() {
  const body = document.getElementById('nbBody');
  if (!body) return;
  if (!newsPages.length) newsPages = buildPages();
  newsPage = newsPage % newsPages.length;
  const page = newsPages[newsPage];
  const html = renderSection(page);
  body.innerHTML = html;
  body.dataset.pageHtml = html;   // the "is the current page actually different" fingerprint renderNews compares against on each poll
  body.classList.remove('nb-fade');
  void body.offsetWidth;
  body.classList.add('nb-fade');
  // Brief-derived pages (BLUF, judgments, developing situations, …) stamp the BRIEF's own
  // as-of date as part of the slug, not the masthead's live clock: a weekend-old
  // brief must never rotate under a slug that reads as generated today. The slug
  // itself flips to the warn hue (matching the integrity readout) once the brief
  // is stale, so the "live-looking but old" failure is visible at the section label.
  const slugEl = document.getElementById('nbSlug');
  const label = SECTION_LABELS[page.kind] || 'Cyber Defense Intelligence';
  if (slugEl) {
    const briefKind = BRIEF_KINDS.has(page.kind);
    const briefStamp = briefKind ? formatBriefDateStamp(briefDoc?.date) : '';
    slugEl.textContent = briefStamp ? `${label} · ${briefStamp}` : label;
    slugEl.dataset.status = briefKind && isBriefStale(briefDoc?.date) ? 'warn' : 'live';
  }
  // While held, the pager carries the PAUSED affordance beside the folio count
  // so the state is legible at 10 ft; the .nb-paused class lets the styles freeze the
  // dwell bar and dim the live tempo without hiding the position in the rotation.
  reflectPaused();
  setText('nbPager', paused ? `❚❚ PAUSED · ${newsPage + 1} / ${newsPages.length}` : `${newsPage + 1} / ${newsPages.length}`);
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
  return PAGE_DWELL_MS[newsPages[newsPage]?.kind] || NEWS_PAGE_MS;
}

// Schedule the next flip for the CURRENT page's dwell. Called from renderPage so
// the flip timer and the dwell-bar (resetDwell) always start together, in sync —
// no gap between the bar emptying and the page turning. Cleared in unmount().
function scheduleNextPage() {
  clearTimeout(newsTimer);
  if (!mounted || paused || newsPages.length <= 1) return;   // a held rotation never re-arms the auto-flip
  newsTimer = setTimeout(advanceNewsPage, currentDwellMs());
}

function advanceNewsPage() {
  if (!mounted || newsPages.length <= 1) return;
  newsPage = (newsPage + 1) % newsPages.length;
  renderPage();
}

// Manual control on a staffed (non-kiosk) watchfloor. Bound in mount, removed
// in unmount. Arrow keys step the rotation and clear the auto-timer (an operator
// stepping through implies they want to dwell, so we stop the flip); Space holds and
// resumes. We deliberately do NOT touch G (view chord) or Esc (Wall exit) — those
// stay owned by the global shortcuts so this handler never blocks a view change.
function onWallKey(e) {
  if (!mounted) return;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  switch (e.key) {
    case 'ArrowRight': e.preventDefault(); stepPage(+1); break;
    case 'ArrowLeft':  e.preventDefault(); stepPage(-1); break;
    case ' ':          // Space — hold / resume the rotation
    case 'Spacebar':   e.preventDefault(); togglePause(); break;
    default: /* leave every other key (G-chord, Esc, etc.) to the global handlers */
  }
}

// Step one page in either direction, wrapping. Clears the auto-timer first: a manual
// step means the operator is driving, so the board waits on them, not the clock
// (scheduleNextPage re-arms it only when NOT paused — a manual step alone doesn't pause,
// but it does reset the current page's dwell so the next auto-flip is a full read away).
function stepPage(dir) {
  if (!mounted || newsPages.length <= 1) return;
  clearTimeout(newsTimer);
  newsPage = (newsPage + dir + newsPages.length) % newsPages.length;
  renderPage();
}

// Toggle the operator hold. Pausing freezes the flip timer and the dwell bar; resuming
// re-arms the rotation for the current page's remaining read from the top.
function togglePause() {
  if (!mounted) return;
  paused = !paused;
  if (paused) {
    clearTimeout(newsTimer);
    reflectPaused();
    setText('nbPager', `❚❚ PAUSED · ${newsPage + 1} / ${newsPages.length}`);
    resetDwell();   // freeze the bar full
  } else {
    // Content updates were deferred while held (renderNews returns early on
    // `paused`); catch the current page up to whatever's current now, QUIETLY (no
    // innerHTML swap/re-animate unless the content actually changed) rather than
    // waiting up to 60s for the next poll to notice.
    newsPages = buildPages();
    if (newsPage >= newsPages.length) newsPage = 0;
    const body = document.getElementById('nbBody');
    const html = newsPages.length ? renderSection(newsPages[newsPage]) : '';
    if (body && body.dataset.pageHtml !== html) {
      body.innerHTML = html;
      body.dataset.pageHtml = html;
    }
    reflectPaused();
    setText('nbPager', `${newsPage + 1} / ${newsPages.length}`);
    resetDwell();          // restart the countdown for the current page
    scheduleNextPage();    // and re-arm the auto-flip
  }
}

// Reflect the hold state on the board so the styles can freeze the dwell tempo and
// stamp the paused affordance — kept honest with the `paused` flag, never guessed.
function reflectPaused() {
  document.querySelector('.news-mode')?.classList.toggle('nb-paused', paused);
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
    return '<div class="nb-empty">Pipeline starting — the brief populates once the first signals are in.</div>';
  }
  switch (def.kind) {
    // The cover: the day's thesis as a newspaper front-page lead — eyebrow →
    // towering headline (the claim) → standfirst deck (the detail). Splitting the
    // one BLUF sentence into headline + deck is what fills the page AND lets the
    // full ~70-word thesis read across a room without truncating: the claim is
    // short and large, the detail flows beneath it one size down.
    case 'bluf': {
      const { headline, deck } = splitBluf(briefDoc.bluf);
      return `
        <section class="nb-section nb-cover-page">
          <div class="nb-cover">
            <span class="nb-cover-kicker">Bottom line up front</span>
            <h2 class="nb-cover-head"><span class="nb-clamp nb-clamp-4">${escapeHtml(headline)}</span></h2>
            ${deck ? `<p class="nb-cover-deck"><span class="nb-clamp nb-clamp-6">${escapeHtml(deck)}</span></p>` : ''}
          </div>
        </section>`;
    }

    // Executive summary: situation on the left, owner queue on the right. A deadline
    // shared by every action is printed once above the queue, not repeated in
    // every row. This changes presentation only; the saved brief stays intact.
    case 'execsummary': {
      const model = executiveSummaryModel(briefDoc.execSummary || []);
      const situation = [model.threat, model.exposure, ...model.context].filter(Boolean).slice(0, 3);
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
          <div class="nb-exec-grid">
            <section class="nb-exec-situation" aria-labelledby="nbExecSituation">
              <header>
                <span class="nb-exec-overline">Situation brief</span>
                <h3 id="nbExecSituation">Threat and exposure</h3>
              </header>
              <dl>${situationHtml}</dl>
            </section>
            <section class="nb-exec-decisions${model.decisions.length > 6 ? ' is-packed' : model.decisions.length > 4 ? ' is-dense' : ''}" aria-labelledby="nbExecDecisions">
              <header>
                <div>
                  <span class="nb-exec-overline">Owner queue</span>
                  <h3 id="nbExecDecisions">Decisions required</h3>
                </div>
                ${model.commonDeadline ? `<div class="nb-exec-shared-due"><span>Shared due</span><strong>${escapeHtml(model.commonDeadline)}</strong></div>` : ''}
              </header>
              ${decisionsHtml ? `<ol>${decisionsHtml}</ol>` : '<p class="nb-exec-none">No owner-specific decision was included.</p>'}
            </section>
          </div>`}
        </section>`;
    }

    // One operational judgment, the focal object, with the this-shift action.
    case 'judgment': {
      const s = (briefDoc.stories || [])[def.idx];
      if (!s) return '<div class="nb-empty">—</div>';
      return `<section class="nb-section nb-judgment-page">${judgmentHtml(s)}</section>`;
    }

    // The live status board: what is moving, which way, and the escalation trigger.
    case 'developing': {
      const rows = (briefDoc.developing || []).slice(0, 3).map(developingHtml).join('');
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
            <span class="nb-conv-kicker accent">Convergence</span>
            <h2 class="nb-conv-title"><span class="nb-clamp nb-clamp-2">${escapeHtml(c.title)}</span></h2>
          </header>
          <div class="nb-conv-stack">
            <div class="nb-conv-block">
              <span class="nb-conv-label">The intersection</span>
              <p class="nb-conv-intersect"><span class="nb-clamp nb-clamp-6">${escapeHtml(c.intersection)}</span></p>
            </div>
            <div class="nb-conv-block nb-conv-block-lead">
              <span class="nb-conv-label accent">The cascade</span>
              <p class="nb-conv-cascade"><span class="nb-clamp nb-clamp-6">${escapeHtml(c.cascade)}</span></p>
            </div>
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
      const sigs = (landscape.signals || []).slice(0, WIRE_MAX);
      return `<section class="nb-section"><div class="nb-feed">${sigs.map((s, i) => wireStoryHtml(s, i === 0)).join('')}</div></section>`;
    }

    default:
      return '<div class="nb-empty">Pipeline starting — the brief populates once the first signals are in.</div>';
  }
}

// One Developing Situation row: color-keyed trajectory token + name + trip-line.
function developingHtml(d) {
  const v = (d.trajectory || '').toLowerCase();
  const cls = v.startsWith('accel') ? 'accel' : v.startsWith('decel') ? 'decel' : v.startsWith('inflect') ? 'inflect' : '';
  const glyph = cls === 'accel' ? '▲' : cls === 'decel' ? '▼' : cls === 'inflect' ? '◆' : '•';
  return `
    <div class="nb-dev">
      <span class="nb-traj ${cls}">${glyph} ${escapeHtml(d.trajectory || 'Tracking')}</span>
      <div class="nb-dev-body">
        <h3 class="nb-dev-name"><span class="nb-clamp nb-clamp-2">${escapeHtml(d.name)}</span></h3>
        ${d.watch ? `<p class="nb-dev-watch"><span class="nb-clamp nb-clamp-2">${escapeHtml(d.watch)}</span></p>` : ''}
      </div>
    </div>`;
}

// The Key-Judgment page as a broadsheet FRONT-PAGE LEAD (claim·reasoning·
// directive + hero tier). A top-to-bottom stack of full-width bands: a tier
// rail (the 200ms moment) → the dominant claim that OWNS the vertical slack as
// broadsheet air → a lower fold (reasoning | directive) that is emitted ONLY when
// it has content. No side-by-side columns above the fold, so no column can strand
// an L-shaped void beside it — the cardinal failure of the old triptych, cured
// structurally. Tier hue is tier-only (rail/disc); --paper-accent is the directive
// mark only — never crossed.
// The publishers behind this judgment, matched conservatively: only by an exact
// CVE id against the full scored-headline list (allHeadlines — landscape.signals
// is capped to the top 14, too narrow to find most judgments' source articles).
// No fuzzy title matching — a judgment must never claim a source it can't prove
// came from. Most Tactical judgments carry a CVE; Strategic/policy ones often
// don't, and correctly show nothing rather than a guessed attribution.
function judgmentSources(s) {
  const cve = s.kevCVE || (String(s.title || '').match(/CVE-\d{4}-\d{4,}/) || [])[0];
  if (!cve) return [];
  const matched = allHeadlines.filter(h => h.kevCVE === cve || (h.cveData && String(h.cveData).includes(cve)));
  const names = new Set();
  matched.forEach(h => {
    const sources = Array.isArray(h.sources) && h.sources.length ? h.sources : [h.source];
    sources.forEach(n => n && names.add(n));
  });
  return [...names].slice(0, 4);   // a few reporting-source labels, not an exhaustive list that inflates the aside
}

function judgmentHtml(s) {
  // Coerce horizon to a valid tier — a missing/out-of-range value would render an
  // unstyled pip with no tier name, silently misrepresenting the signal.
  const h = [1, 2, 3].includes(s.horizon) ? s.horizon : 2;
  if (h !== s.horizon) console.warn('[wall] judgment with invalid horizon:', s.horizon, '—', s.title);

  // Chips sit as a kicker line above the claim (decision window + KEV) — the
  // rail above is tier identity only, so it never competes with the headline
  // for the page's width.
  const chips = [
    s.decision ? `<span class="nb-tag urgent">${escapeHtml(s.decision)}</span>` : '',
    s.isKEV ? `<span class="nb-badge kev">KEV${s.kevCVE ? ` ${escapeHtml(s.kevCVE)}` : ''}</span>` : '',
  ].join('');

  // The one this-shift action — the climax, marked as the directive by the blue
  // left rule (.c-action), never a role/owner tag. Suppressed cleanly when the
  // signal has no this-shift action (NEVER fabricated). The .c-action-label kicker
  // ("Act now") the Briefing emits is INTENTIONALLY omitted here: this is a
  // passive 10-ft board whose rail already carries the decision-window chip, and
  // the blue rule alone reads as "directive" across the room — the load-bearing
  // parts (rule · wash · accent · imperative) stay identical to the memo's.
  const act = s.actionShift
    ? `<div class="nb-act c-action"><span class="nb-act-text nb-clamp nb-clamp-3">${escapeHtml(s.actionShift.imperative)}</span></div>`
    : '';
  const reasoning = s.assessment
    ? `<p class="nb-jbody"><span class="nb-clamp nb-clamp-4">${escapeHtml(s.assessment)}</span></p>`
    : '';
  // The FOLD (reasoning | directive) is emitted ONLY when at least one of the two
  // exists — so a bordered-but-empty ledger or a stranded gutter can never appear.
  // Presence is decided here in JS (no :has()/placeholder hacks).
  const fold = (reasoning || act)
    ? `<footer class="nb-jfold${reasoning && act ? '' : ' is-single'}">${reasoning}${act}</footer>`
    : '';

  const sources = judgmentSources(s);

  return `
    <article class="nb-judgment nb-lead">
      <div class="nb-jhead-band">
        <div class="nb-jhead-row">
          <div class="nb-jhead-main">
            <h2 class="nb-jhead"><span class="nb-clamp nb-clamp-3">${escapeHtml(s.title)}</span></h2>
            ${s.line ? `<p class="nb-standfirst"><span class="nb-clamp nb-clamp-3">${escapeHtml(s.line)}</span></p>` : ''}
          </div>
          <div class="nb-jhead-aside">
            <div class="nb-jrail-tier">
              <span class="nb-jdisc h${h}"><i class="h-pip h${h}"></i></span>
              <span class="nb-hero-tier h${h}">${TIER_NAMES[h] || ''}</span>
            </div>
            ${chips ? `<div class="nb-jrail-chips">${chips}</div>` : ''}
            ${sources.length ? `<div class="nb-jsources"><span class="nb-jsources-label">Sources</span><ul>${sources.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>` : ''}
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
  if (s.isKEV) sev.push(`<span class="nb-badge kev">KEV${s.kevCVE ? ` ${escapeHtml(s.kevCVE)}` : ''}</span>`);
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
  // Cross-source reporting as the SAME nested-ring ×N glyph as the Wire, in the Wall's
  // brand alias (provenance strength), NOT green — green stays for trajectory/liveness.
  // Cap the printed count at 9+ (matching the Wire), so a runaway source count
  // number never widens the meta line or reads as a spurious precision at 10 ft.
  if (s.corroboration > 1) {
    const shown = s.corroboration > 9 ? '9+' : String(s.corroboration);
    meta.push(`<span class="nb-corrob" title="Reported by ${escapeHtml(String(s.corroboration))} distinct sources"><span class="nb-corrob-rings" aria-hidden="true"></span>×${escapeHtml(shown)}</span>`);
  }
  if (s.source) meta.push(escapeHtml(s.source));

  const dek = cleanSummary(s.description).slice(0, 280);
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
        ${meta.length ? `<div class="nb-submeta">${meta.join(' · ')}</div>` : ''}
      </div>
      <div class="nb-c-sev">${sev.join('')}</div>
      <div class="nb-c-age">${age ? `<span class="nb-age${fresh ? ' fresh' : ''}">${fresh ? 'NEW · ' : ''}${escapeHtml(age)}</span>` : '<span class="nb-age nb-age-none" title="No publication date on the source item">—</span>'}</div>
    </article>
  `;
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
  setText('nbClock', now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }));
  const el = document.getElementById('nbIntegrity');
  const dot = document.getElementById('nbLiveDot');
  if (!el) return;
  if (!landscape || !landscape.generatedAt) {
    el.textContent = 'AWAITING FIRST RUN';
    el.dataset.status = 'warn';
    if (dot) dot.dataset.status = 'warn';
    setLiveWord('AWAITING', true);
    setBoardStale(true);
    return;
  }
  // Never let a malformed timestamp read as live — a NaN age would render
  // "UPDATED NaN" on a frozen board, the cardinal status-that-lies failure.
  const genMs = Date.parse(landscape.generatedAt);
  if (!Number.isFinite(genMs)) {
    el.textContent = 'AWAITING FIRST RUN';
    el.dataset.status = 'warn';
    if (dot) dot.dataset.status = 'warn';
    setLiveWord('AWAITING', true);
    setBoardStale(true);
    return;
  }
  const ageSec = Math.max(0, Math.round((Date.now() - genMs) / 1000));
  const ago = ageSec < 90 ? `${ageSec}s` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m` : `${Math.round(ageSec / 3600)}h`;
  // Feed-health invariant: a missing feeds object or total < ok is corrupt data,
  // not "0/0 operational" — say so rather than printing a plausible-looking lie.
  const ok = landscape.feeds?.ok;
  const total = landscape.feeds?.total;
  if (!Number.isFinite(ok) || !Number.isFinite(total) || total <= 0 || total < ok || ok < 0) {
    el.textContent = `FEEDS [data error] · UPDATED ${ago}`;
    el.dataset.status = 'warn';
    if (dot) dot.dataset.status = 'warn';
    setLiveWord('DEGRADED', true);
    setBoardStale(true);
    return;
  }
  // The rotation-freeze detector: data can be perfectly fresh (FEEDS ok,
  // ageSec low) while the page-turn timer itself has died, and until now nothing
  // watched the flip chain directly — only DATA age, which keeps ticking. Any
  // multi-page rotation that hasn't flipped in ~2x its current page's dwell is
  // stalled; checked here (already ticking at 1s) independent of feed health so a
  // stalled rotation can never hide behind an otherwise-healthy FEEDS readout.
  const stalled = !paused && newsPages.length > 1 && lastFlipAt > 0
    && (Date.now() - lastFlipAt) > 2 * currentDwellMs();
  if (stalled) {
    el.textContent = `ROTATION STALLED · UPDATED ${ago}`;
    el.dataset.status = 'warn';
    if (dot) dot.dataset.status = 'warn';
    setLiveWord('STALLED', true);
    setBoardStale(true);
    return;
  }
  el.textContent = `FEEDS ${ok}/${total} · UPDATED ${ago}`;
  // The masthead's most legible word must agree with the dot/readout: STALE past
  // the freshness window, DEGRADED when feeds drop, LIVE only when both hold.
  // Derived from the configured refresh cadence (analysisSettings.refreshMinutes,
  // Zod-validated 2–120 in lib/config.js) rather than a bare hardcoded 20 minutes: an
  // operator running a slower-than-20min cadence (e.g. 30 or 60, to be polite to feed
  // hosts) would otherwise read STALE for most of every healthy cycle. 20 min stays
  // the FLOOR so a fast cadence still gets a meaningful stale window.
  // landscape.pipeline.refreshMinutes is not yet served by the backend (lib/landscape.js
  // builds the payload) — staleAfterSec (wall-format.js) reads it defensively and
  // falls back to the previous fixed 20-minute threshold so today's behavior is
  // unchanged until the field ships.
  const stale = ageSec > staleAfterSec(landscape.pipeline?.refreshMinutes);
  const feedsLow = total && ok < total * 0.7;
  const warn = stale || feedsLow;
  el.dataset.status = warn ? 'warn' : 'live';
  if (dot) dot.dataset.status = warn ? 'warn' : 'live';
  setLiveWord(stale ? 'STALE' : feedsLow ? 'DEGRADED' : 'LIVE', warn);
  setBoardStale(warn);
}

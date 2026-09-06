// BlueTeam.News — the Wall.
// Automatic display of the saved Briefing and current retained feed signals.
// Navy/sans-serif topic bundles preserve assessments, complete actions and
// explicit source/edition timing. Default entry starts without controls or
// setup; the optional ?read=1 route retains complete staffed reading tools.

import { escapeHtml } from '../core/sanitize.js';
import { fetchLandscape, fetchBrief, fetchEdition, fetchHealth } from '../core/api.js';
import { setState } from '../core/store.js';
import { followInternalLink, navigate, getWallReturnUrl } from '../core/router.js';
import { archivePublishedAt, formatBriefPublication, formatBriefPublishedAt } from '../core/brief-date.js';
import { readingStops } from './wall-reading.js';
// One brief contract, shared with the server (lib/brief-schema.js, served at
// /vendor/brief-schema.js): the section names, field labels, and parse helpers
// live there so the Wall and the server can never drift. The Wall keeps its own
// rendering; only its parsing sources this module.
import { formatDecisionWindow, judgmentCertainty, parseBrief, briefSectionAnchors } from '/vendor/brief-schema.js';

import { TIER_NAMES } from '../core/tiers.js';
// The Wall's own pure rotation/parsing helpers, extracted so they carry no
// DOM dependency and can be unit-tested directly (test/wall-format.test.js), the
// same split already applied to the Wire (wire-format.js). This view keeps only
// the DOM-touching render/timer code; buildPages/splitBluf/relAge/etc. now live
// there as the single source of truth.
import {
  buildPages as buildPagesPure, splitBluf, cvssFrom, cleanSummary,
  relAge, isFresh, isBriefStale, staleAfterSec,
  executiveSummaryModel, executiveTargetModel,
} from './wall-format.js';
import { renderKevSection } from './wall-kev.js';
import { buildPresentationPages, loadDisplaySettings, displayDwellMs, presentationReadingText, splitResponsePage, pageKey, topicKey, topicLabel, readerFragment, inDimWindow, storyActions, isEligibleWallEdition } from './wall-presentation.js';
import { mountWallBrowser } from './wall-browser.js';
import { mountWallActions, wallActionHtml } from './wall-actions.js';
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
  watchlist: 'WATCHLIST',
  briefexcluded: 'BRIEFING REVIEW STATUS',
};
// Page kinds sourced from the parsed brief, i.e. everything that must never
// be read as live-generated: these carry the brief's own as-of date in the slug so
// a weekend-old brief can never rotate under a masthead silently implying "today".
const BRIEF_KINDS = new Set(['bluf', 'execsummary', 'judgment', 'developing', 'convergence', 'watchlist']);

let timers = [];
let mounted = false;
let landscape = null;
let newsPage = 0;
let newsTimer = null;      // self-scheduling per-kind page-advance timer
let newsPages = [];        // current rotation of broadsheet sections
const measuredResponses = new Map();
let paused = false;        // operator-held rotation (Space); auto-advance frozen while set
let keyHandler = null;     // non-kiosk manual-advance/pause keydown, bound on mount, removed on unmount
let briefDoc = null;       // { bluf, execSummary[], stories[], developing[], convergence[], watchlist[], date }
let briefDocFile = null;   // brief filename currently loaded
let briefCheckedAt = 0;
let briefRequestPending = false;
let briefLoadError = false; // latest saved Briefing exists but could not be fetched/parsed
let briefExcluded = false;
let lastFlipAt = 0;        // timestamp of the last renderPage attempt (success or caught failure); updateLiveline watches this for a stalled flip chain
let sourceLoadError = false;
let renderLoadError = false;
let displayedPage = null;  // publication metadata belongs to the held content, never the next poll
let readingOffsets = [0];
let resizeHandler = null;
let mountVersion = 0;      // ignore a response from an earlier mount
let mountedLayer = null;  // delegated navigation survives section body replacements
let displaySettings = loadDisplaySettings();
let browserDisplay = null;
let displaySettingsHandler = null;
let exitRevealTimer = null;
let availablePages = [];
let briefingReady = false;
let holdUntil = 0;
let lastFeedAt = 0;
let nextFeedIndex = 0;
let interruptedPage = null;
let allActions = null;
let pendingMaintenance = false;
let restoreTopic = null;
let skipLinkHref = null;
const isPresentation = () => document.body.classList.contains('kiosk');

export function mount(layer) {
  if (mounted) return;
  mounted = true;
  mountVersion++;
  mountedLayer = layer;
  layer.addEventListener('click', onWallLink);
  // Every normal Wall entry, including old ?operator links, starts unattended.
  // The optional explicit reading route is separate from navigation/display.
  const wallParams = new URLSearchParams(window.location.search);
  if (/^\/wall\/?$/.test(window.location.pathname) && wallParams.get('read') !== '1') {
    document.body.classList.add('kiosk');
  }
  displaySettings = loadDisplaySettings();
  paused = !isPresentation();
  lastFeedAt = Date.now();
  try { restoreTopic = JSON.parse(sessionStorage.getItem('bt-wall-topic') || 'null'); sessionStorage.removeItem('bt-wall-topic'); } catch { restoreTopic = null; }
  document.body.classList.toggle('wall-operator', !isPresentation());
  const skip = document.querySelector('.skip-link');
  skipLinkHref = skip?.getAttribute('href');
  skip?.setAttribute('href', '#nbBody');
  mountNews(layer);
  if (isPresentation()) {
    browserDisplay = mountWallBrowser({ settings: displaySettings, onExit: () => navigate(getWallReturnUrl()) });
    layer.addEventListener('pointermove', revealExit);
    layer.addEventListener('pointerdown', revealExit);
    layer.addEventListener('focusin', revealExit);
  }
  displaySettingsHandler = () => {
    displaySettings = loadDisplaySettings();
    browserDisplay?.update(displaySettings);
    syncWallScale();
    const key = displayedPage && pageKey(displayedPage);
    newsPages = availablePages = buildPages();
    newsPage = Math.max(0, newsPages.findIndex(page => pageKey(page) === key));
    renderPage();
  };
  window.addEventListener('wall-display-settings-changed', displaySettingsHandler);
  // Keyboard interaction also makes an unattended display usable by an operator.
  // Bound only while the Wall is mounted so controls never leak into other views.
  keyHandler = onWallKey;
  document.addEventListener('keydown', keyHandler);
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
  mountedLayer?.removeEventListener('click', onWallLink);
  mountedLayer?.removeEventListener('pointermove', revealExit);
  mountedLayer?.removeEventListener('pointerdown', revealExit);
  mountedLayer?.removeEventListener('focusin', revealExit);
  mountedLayer = null;
  for (const t of timers) clearInterval(t);
  clearTimeout(newsTimer);
  timers = [];
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }   // drop the manual-control listener with the view
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  browserDisplay?.destroy();
  browserDisplay = null;
  if (displaySettingsHandler) window.removeEventListener('wall-display-settings-changed', displaySettingsHandler);
  displaySettingsHandler = null;
  clearTimeout(exitRevealTimer);
  exitRevealTimer = null;
  allActions?.destroy();
  allActions = null;
  availablePages = [];
  briefingReady = false;
  holdUntil = 0;
  interruptedPage = null;
  pendingMaintenance = false;
  restoreTopic = null;
  nextFeedIndex = 0;
  if (skipLinkHref) document.querySelector('.skip-link')?.setAttribute('href', skipLinkHref);
  skipLinkHref = null;
  paused = false;
  landscape = null;
  lastBoardWord = '';   // re-announce board status fresh on a remount
  newsPage = 0;
  newsPages = [];
  measuredResponses.clear();
  briefDoc = null;
  briefDocFile = null;
  briefCheckedAt = 0;
  briefRequestPending = false;
  briefLoadError = false;
  briefExcluded = false;
  sourceLoadError = false;
  renderLoadError = false;
  displayedPage = null;
  readingOffsets = [0];
  lastFlipAt = 0;
  lastKnownServerBootMs = null;   // re-baseline on remount rather than reloading against a stale comparison
  lastQuietHourReloadDay = null;
  burnInIdx = 0;
  document.body.classList.remove('kiosk');
  document.body.classList.remove('wall-controls-visible');
  document.body.classList.remove('wall-operator');
  document.body.classList.remove('wall-exit-visible');
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
        pendingMaintenance = displaySettings.maintenance;
      }
      lastKnownServerBootMs = impliedBootMs;
    }
  } catch { /* health check is best-effort; never block the board on it */ }
  if (!mounted || version !== mountVersion || !document.body.classList.contains('kiosk')) return;

  const now = new Date();
  const today = now.toDateString();
  if (displaySettings.maintenance && now.getHours() === displaySettings.maintenanceHour && lastQuietHourReloadDay !== today) {
    lastQuietHourReloadDay = today;
    pendingMaintenance = true;
  }
  if (pendingMaintenance && !paused && !document.querySelector('dialog[open]') && claimKioskMaintenanceReload(today)) {
    try { sessionStorage.setItem('bt-wall-topic', JSON.stringify({ key: displayedPage && pageKey(displayedPage), topic: displayedPage?.topicText, briefFile: displayedPage?.briefFile, scroll: document.getElementById('nbBody')?.scrollTop || 0 })); } catch { /* reload remains best effort */ }
    location.reload();
  }
}

// ══════════════════════════════════════════════════════════
// Automatic display — restrained edition/health folio and a coherent reading
// bundle. Full reading controls exist only on the explicit reading route.
// ══════════════════════════════════════════════════════════

export function wallScaleForWidth(width) {
  return Number.isFinite(width) && width >= 2200 ? width / 1920 : 1;
}

function syncWallScale() {
  const wall = document.querySelector('.news-mode');
  if (wall) {
    const scale = isPresentation() ? wallScaleForWidth(window.innerWidth) : 1;
    wall.style.zoom = String(scale);
    wall.dataset.displaySize = displaySettings.size;
    wall.dataset.displayMargin = displaySettings.margin;
    const margin = { normal: .02, safe: .04, wide: .06 }[displaySettings.margin] || .02;
    // Resolve safe margins before CSS zoom so a 4% setting remains 4% of the
    // physical browser viewport at 1080p and native 4K alike.
    wall.style.setProperty?.('--nb-safe-padding-x', `${(window.innerWidth || 1920) / scale * margin}px`);
    wall.style.setProperty?.('--nb-safe-padding-y', `${(window.innerHeight || 1080) / scale * margin}px`);
  }
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
          ${!isPresentation() ? '<span class="nb-brief-stamp" id="nbBriefStamp"></span>' : ''}
        </div>
        <div class="nb-folio-status">
          <span class="nb-folio-live"><span class="nb-live-dot" id="nbLiveDot" data-status="warn"></span><span id="nbLiveWord">FEEDS LOADING</span></span>
          <span class="nb-clock" id="nbClock">--:--</span>
          <span class="nb-integrity" id="nbIntegrity" data-status="live">—</span>
          ${isPresentation() ? `<a class="nb-display-exit" id="nbExit" href="${escapeHtml(getWallReturnUrl())}" aria-label="Exit Wall">Esc to exit</a>` : ''}
        </div>
      </header>

      <div class="nb-dwell"><i id="nbDwell"></i></div>
      <span class="nb-sr-only" id="nbAnnounce" role="status" aria-live="polite"></span>
      <span class="nb-sr-only" id="nbPageAnnounce" role="status" aria-live="polite"></span>
      ${!isPresentation() ? '<div class="nb-ready" id="nbReady" hidden><span>Latest Briefing ready. The current screen is held.</span><button type="button" id="nbLoadReady">Open latest Briefing</button></div>' : ''}
      <div class="nb-subject" id="nbSubject"></div>
      <aside class="nb-review" id="nbReview" hidden></aside>

      <div class="nb-body" id="nbBody" ${!isPresentation() ? 'tabindex="0"' : ''} aria-label="Wall content">
        <div class="nb-empty nb-opening">
          <span class="nb-opening-kicker">Preparing the watchfloor</span>
          <strong>Loading the latest available information</strong>
          <span>Signals will surface as the feeds respond.</span>
        </div>
      </div>

      ${!isPresentation() ? `<footer class="nb-foot">
        <p class="nb-capability-status" id="nbCapabilityStatus" role="status" hidden></p>
        <div class="nb-position"><span class="nb-playback" id="nbPlayback"></span><span class="nb-pager" id="nbPager"></span></div>
        <nav class="nb-controls" id="nbControls" aria-label="Wall controls">
          <label class="nb-section-control">Section <select id="nbSections" aria-label="Choose Wall section" disabled><option>Loading sections…</option></select></label>
          <div class="nb-transport" role="group" aria-label="Playback">
          <button type="button" id="nbPrev" disabled aria-label="Previous page" title="Previous page (Left arrow)">← Previous</button>
          <button type="button" id="nbPause" disabled title="Pause or resume rotation (Space)">Pause</button>
          <button type="button" id="nbNext" disabled aria-label="Next page" title="Next page (Right arrow)">Next →</button>
          </div><div class="nb-reading-tools" role="group" aria-label="Reading and display">
          <button type="button" id="nbAllActions" disabled>All actions</button>
          <a id="nbOpen" href="/wire">Open in Wire</a>
          <details class="nb-display-menu"><summary>Display</summary><div>
          <a href="/wall">Present on display</a>
          <a href="/settings#wallDisplay">Display preferences</a>
          </div></details>
          <button type="button" id="nbPersistentHold" hidden>Pause until I resume</button>
          <a id="nbExit" href="${escapeHtml(getWallReturnUrl())}">Exit Wall</a>
          </div>
          <span class="nb-controls-hint" id="nbControlsHint">←/→ continue · Space pause/resume · Esc exit</span>
        </nav>
      </footer>` : `<footer class="nb-display-footer"><div class="nb-footer-source"><span id="nbTopicPosition"></span><span id="nbSource"></span></div><div class="nb-brief-stamp" id="nbBriefStamp"></div></footer>`}
    </div>
  `;

  syncWallScale();
  if (!isPresentation()) allActions = mountWallActions({ getDocument: () => displayedPage?.document || briefDoc, onOpen: () => holdReading(true) });
  document.getElementById('nbAllActions')?.addEventListener('click', event => allActions?.open(event.currentTarget));
  document.getElementById('nbBody')?.addEventListener('click', event => {
    const button = event.target.closest?.('[data-wall-actions]');
    if (button) allActions?.open(button);
  });
  document.querySelector('.nb-display-menu')?.addEventListener('toggle', event => { if (event.currentTarget.open) holdReading(true); });
  document.getElementById('nbPersistentHold')?.addEventListener('click', () => { holdUntil = 0; holdReading(true); updateLiveline(); });
  document.getElementById('nbReview')?.addEventListener('click', event => {
    if (!isPresentation() && event.target?.closest?.('summary')) holdReading(true);
  });
  document.getElementById('nbLoadReady')?.addEventListener('click', () => {
    paused = true; holdUntil = 0; briefingReady = false;
    newsPages = availablePages = buildPages();
    newsPage = Math.max(0, newsPages.findIndex(page => BRIEF_KINDS.has(page.kind)));
    renderPage(); announcePosition();
  });
  startLiveline();
  poll();
  {
    document.getElementById('nbPrev')?.addEventListener('click', () => stepPage(-1));
    document.getElementById('nbNext')?.addEventListener('click', () => stepPage(1));
    document.getElementById('nbPause')?.addEventListener('click', togglePause);
    document.getElementById('nbSections')?.addEventListener('change', (event) => {
      const index = Number(event.target.value);
      if (!Number.isInteger(index) || !availablePages[index]) return;
      const selected = availablePages[index];
      const publicationChanged = displayedPage?.briefFile !== briefDoc?.filename;
      // The picker describes the held rotation, while a poll may already have
      // loaded a newer document. Resolve the choice against its actual sections
      // before rendering, including editions with fewer judgments.
      newsPages = buildPages();
      const exact = newsPages.findIndex(page => pageKey(page) === pageKey(selected));
      let resolved = exact;
      if (resolved < 0) {
        const sameKind = newsPages.map((page, i) => ({ page, i })).filter(({ page }) => page.kind === selected.kind);
        resolved = sameKind.length ? sameKind.reduce((nearest, item) =>
          Math.abs((item.page.idx ?? 0) - (selected.idx ?? 0)) < Math.abs((nearest.page.idx ?? 0) - (selected.idx ?? 0)) ? item : nearest
        ).i : 0;
      }
      paused = true;
      holdUntil = 0;
      briefingReady = false;
      clearTimeout(newsTimer);
      newsPage = resolved;
      renderPage();
      announcePosition(exact < 0 ? 'Sections updated. The selected section is no longer available; showing the nearest available section.'
        : publicationChanged ? 'Sections refreshed to the latest available content.' : '');
    });
    // Scrolling is an intentional read: hold the current content before it can
    // advance. Programmatic continuation scrolling never triggers this handler.
    const body = document.getElementById('nbBody');
    body?.addEventListener('wheel', () => holdReading(), { passive: true });
    body?.addEventListener('touchstart', () => holdReading(), { passive: true });
    body?.addEventListener('focusin', () => {
      if (isPresentation()) return;
      // Tab and assistive-technology focus are intentional reading, including
      // when focus enters before the first request has finished.
      if (!displayedPage) paused = true;
      holdReading();
    });
  }
  timers.push(setInterval(poll, DATA_POLL_MS));
  cycleBurnInShift();   // first shift immediately so the board isn't pinned at (0,0) for the first 5 minutes
  timers.push(setInterval(cycleBurnInShift, BURN_IN_SHIFT_MS));
}

function onWallLink(event) {
  const link = event.target?.closest?.('a[href]');
  if (!link) return;
  if (!/^\/(?:wire|briefing|wall|settings)(?:[/?#]|$)/.test(link.getAttribute?.('href') || '')) return;
  if (link.getAttribute('href') === '/wall?read=1' && !link.target && !link.hasAttribute?.('download') && isPresentation() && displayedPage && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !(event.button > 0)) {
    const idx = ['judgment', 'convergence'].includes(displayedPage.kind) ? displayedPage.idx : undefined;
    try { sessionStorage.setItem('bt-wall-topic', JSON.stringify({ key: pageKey({ kind: displayedPage.kind, idx }), briefFile: displayedPage.briefFile })); } catch { /* normal navigation remains available */ }
  }
  followInternalLink(event, link);
}

function revealExit() {
  if (!mounted || !isPresentation()) return;
  document.body.classList.add('wall-exit-visible');
  clearTimeout(exitRevealTimer);
  exitRevealTimer = setTimeout(() => document.body.classList.remove('wall-exit-visible'), 2500);
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
  availablePages = rebuilt;
  if (briefExcluded && BRIEF_KINDS.has(displayedPage?.kind)) {
    newsPages = rebuilt;
    newsPage = 0;
    renderPage();
    return;
  }
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

// Revalidate saved reading copies at the poll interval, since an editorial
// overlay can change without changing an immutable original filename.
function ensureBrief() {
  const eligible = isEligibleWallEdition(landscape.brief);
  const f = eligible && landscape.brief && landscape.brief.filename;
  if (!f) {
    briefDoc = null;
    briefDocFile = null;
    briefLoadError = false;
    briefExcluded = !eligible || landscape.briefAvailability?.status === 'no-eligible-edition';
    return;
  }
  if (briefRequestPending && f === briefDocFile) return;
  if (f === briefDocFile && Date.now() - briefCheckedAt < DATA_POLL_MS) return;
  const priorDoc = briefDoc;
  const hadThisEdition = priorDoc?.filename === f;
  briefDocFile = f;
  briefRequestPending = true;
  briefCheckedAt = Date.now();
  const version = mountVersion;
  const briefDate = landscape.brief?.date || '';
  fetchBrief(f).then(d => {
    if (!mounted || version !== mountVersion || briefDocFile !== f) return;
    briefRequestPending = false;
    if (!isEligibleWallEdition(d)) {
      briefDoc = null;
      briefExcluded = true;
      briefLoadError = false;
      briefingReady = false;
      // Review disposition outranks a passive hold: a known-bad edition must
      // leave automatic rotation, even when its immutable filename is unchanged.
      newsPages = availablePages = buildPages();
      newsPage = 0;
      renderPage();
      return;
    }
    briefExcluded = false;
    const readingCopy = d.reviewedContent || d.content || '';
    const unchanged = hadThisEdition && priorDoc?.readingCopy === readingCopy && priorDoc?.review?.id === d.review?.id && priorDoc?.review?.status === d.review?.status
      && priorDoc?.review?.presentation?.reviewedAt === d.review?.presentation?.reviewedAt;
    briefDoc = parseBrief(readingCopy, {
      verifiedKevCves: d.inputManifest?.verification?.selectedKevCves,
    });
    briefDoc.warnings = Array.isArray(d.meta?.warnings) ? [...d.meta.warnings] : [];
    briefDoc.readingCopy = readingCopy;
    briefDoc.anchors = briefSectionAnchors(d.reviewedContent || d.content || '');
    briefDoc.review = d.review || null;
    briefDoc.disposition = d.disposition || null;
    briefLoadError = false;
    briefDoc.filename = f;
    briefDoc.date = briefDate;
    // Only persisted publication metadata proves a generation instant. The
    // archive's generatedAt fallback can be a copied legacy file's mtime.
    briefDoc.generatedAt = archivePublishedAt(d);
    availablePages = buildPages();
    briefingReady = !isPresentation() && !!displayedPage && (displayedPage.briefFile !== f || displayedPage.review?.id !== briefDoc.review?.id || displayedPage.review?.status !== briefDoc.review?.status
      || (BRIEF_KINDS.has(displayedPage.kind) && displayedPage.readingCopy !== readingCopy));
    if (!displayedPage || restoreTopic || (!unchanged && !paused && readingOffsets.length <= 1)) {
      newsPages = availablePages;
      if (newsPage >= newsPages.length) newsPage = 0;
      renderPage();
    }
    if (briefingReady) setText('nbPageAnnounce', 'Latest Briefing ready. Available sections have updated; your current screen remains held.');
    const heldFile = displayedPage?.briefFile;
    if (heldFile && heldFile !== f && BRIEF_KINDS.has(displayedPage.kind)) {
      // A held older publication is normally preserved. Recheck its disposition
      // when Latest changes so a newly flagged/superseded edition cannot remain
      // on an unattended display merely because the replacement loaded first.
      fetchBrief(heldFile).then(held => {
        if (!mounted || version !== mountVersion || briefDocFile !== f || displayedPage?.briefFile !== heldFile || isEligibleWallEdition(held)) return;
        newsPages = availablePages = buildPages();
        newsPage = Math.max(0, newsPages.findIndex(page => BRIEF_KINDS.has(page.kind)));
        renderPage();
        setText('nbPageAnnounce', 'The held edition is no longer eligible for Wall display. Showing the current eligible edition.');
      }).catch(() => { /* retain the last established state on a read failure */ });
    }
    updateLiveline();
  }).catch(() => {
    if (!mounted || version !== mountVersion || briefDocFile !== f) return;
    briefRequestPending = false;
    // Reset briefDocFile too, not just briefDoc: leaving briefDocFile set to
    // the filename that just failed would make the `f === briefDocFile` guard above
    // permanently suppress a retry until a NEW brief filename appears (typically the
    // next day). Rebuild pages + re-render immediately so any brief-derived pages
    // built from the previous (now-stale) briefDoc are dropped from rotation rather
    // than lingering and throwing when renderSection reads a null briefDoc.
    briefDoc = hadThisEdition ? priorDoc : null;
    briefDocFile = null;
    briefLoadError = true;
    availablePages = buildPages();
    briefingReady = false;
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
  if (isPresentation()) {
    const pages = buildPresentationPages(briefDoc, landscape, displaySettings, { briefLoadError });
    if (briefExcluded) pages.unshift({ kind: 'briefexcluded' });
    return pages.flatMap(page => measuredResponses.get(topicKey(page)) === JSON.stringify(page) ? splitResponsePage(page) : [page]);
  }
  const pages = buildPagesPure(briefDoc, landscape, { briefLoadError, judgMax: Infinity, convMax: Infinity });
  if (briefExcluded) pages.unshift({ kind: 'briefexcluded' });
  if (briefDoc?.watchlist?.length) {
    const feedIndex = pages.findIndex(page => ['kev', 'wire'].includes(page.kind));
    pages.splice(feedIndex < 0 ? pages.length : feedIndex, 0, { kind: 'watchlist' });
  }
  return pages;
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
  availablePages = buildPages();
  let restoredScroll = null;
  if (restoreTopic) {
    const sameEdition = !restoreTopic.briefFile || restoreTopic.briefFile === briefDoc?.filename;
    const restored = newsPages.findIndex(page => sameEdition ? pageKey(page) === restoreTopic.key : topicLabel(page, briefDoc, landscape) === restoreTopic.topic);
    if (restored >= 0) { newsPage = restored; restoredScroll = Number(restoreTopic.scroll) || 0; restoreTopic = null; }
    else if (briefDoc || !landscape?.brief?.filename) restoreTopic = null;
  }
  newsPage = newsPage % newsPages.length;
  const page = newsPages[newsPage];
  displayedPage = {
    ...page, index: newsPage, count: newsPages.length,
    briefDate: briefDoc?.date, briefGeneratedAt: briefDoc?.generatedAt,
    briefFile: briefDoc?.filename,
    briefWarnings: [...(briefDoc?.warnings || [])],
    briefAnchors: Array.isArray(briefDoc?.anchors) ? briefDoc.anchors.map(item => ({ ...item })) : {},
    review: briefDoc?.review,
    readingCopy: briefDoc?.readingCopy,
    document: briefDoc,
    topicText: topicLabel(page, briefDoc, landscape),
    feedGeneratedAt: landscape?.generatedAt,
  };
  if (page.kind === 'wire') lastFeedAt = Date.now();
  // A committed render has adopted the available edition and rotation, even
  // when its selected topic is a feed page. Only an unchanged held screen needs
  // the ready notice; mode restoration must not announce its own initial load.
  briefingReady = false;
  const html = renderSection(page);
  const sameContent = body.dataset.pageHtml === html;
  const scrollTop = restoredScroll ?? (preservePosition && sameContent ? body.scrollTop : 0);
  body.innerHTML = html;
  body.dataset.pageHtml = html;   // the "is the current page actually different" fingerprint renderNews compares against on each poll
  body.scrollTop = scrollTop;
  body.classList.remove('nb-fade');
  void body.offsetWidth;
  body.classList.add('nb-fade');
  // Publication and feed-snapshot labels describe the displayed content. Feed
  // health can continue updating independently while the operator holds it.
  reflectPageMetadata();
  body.classList.remove('nb-tight');
  if (isPresentation() && body.clientHeight > 0 && body.scrollHeight > body.clientHeight + 2) body.classList.add('nb-tight');
  // Try the complete topic first. Split only measured overflow, keeping each
  // owner response intact. Word count never decides how many screens exist.
  if (isPresentation() && page.block && page.actions?.length > 1 && body.clientHeight > 0 && body.scrollHeight > body.clientHeight + 2) {
    const parts = splitResponsePage(page);
    measuredResponses.set(topicKey(page), JSON.stringify(page));
    newsPages.splice(newsPage, 1, ...parts);
    renderPageUnsafe(lastPart, preservePosition);
    return;
  }
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
  dwellStartMs = Date.now();
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
  if (isPresentation() && displayedPage?.block) {
    const text = presentationReadingText(displayedPage);
    return displayDwellMs(text, displaySettings.speed);
  }
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
  if (isPresentation()) {
    refreshReadingStops();
    const body = document.getElementById('nbBody');
    if (readingOffsets.some(offset => offset > (body?.scrollTop || 0) + 2)) { turnPage(1); return; }
    if (interruptedPage) {
      const nextPart = newsPages[newsPage + 1];
      if (nextPart && topicKey(nextPart) === topicKey(displayedPage)) { turnPage(1); return; }
      const key = interruptedPage;
      interruptedPage = null;
      newsPages = availablePages = buildPages();
      const at = newsPages.findIndex(page => pageKey(page) === key);
      if (at >= 0) { newsPage = at; renderPage(); return; }
    }
    const feeds = availablePages.filter(page => page.kind === 'wire');
    const following = newsPages[(newsPage + 1) % newsPages.length];
    const topicFinished = topicKey(following) !== topicKey(displayedPage);
    if (feeds.length && topicFinished && following?.kind !== 'wire' && displayedPage?.kind !== 'wire' && Date.now() - lastFeedAt >= displaySettings.feedSeconds * 1000) {
      // Insert only between complete topics, including their response steps and
      // viewport continuations. A long topic can exceed the preferred cadence.
      const next = newsPages[(newsPage + 1) % newsPages.length];
      interruptedPage = next && pageKey(next);
      newsPages = availablePages = buildPages();
      const feedTopics = feeds.filter(page => !page.part);
      const feed = feedTopics[nextFeedIndex++ % feedTopics.length];
      newsPage = Math.max(0, newsPages.findIndex(page => pageKey(page) === pageKey(feed)));
      renderPage(); return;
    }
  }
  turnPage(1);
}

// Passive display arrows advance without pausing; Escape exits. The explicit
// reading route keeps staffed holds and manual stepping. All handlers belong
// to this mount and respect navigation already handled by global shortcuts.
function onWallKey(e) {
  if (!mounted) return;
  if (isPresentation()) {
    if (e.key === 'Tab') revealExit();
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); navigate(getWallReturnUrl()); }
    if (!e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault(); turnPage(e.key === 'ArrowRight' ? 1 : -1);
    }
    return;
  }
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
  if (document.querySelector('dialog[open], [aria-modal="true"], .help-overlay')) return;
  if (e.target?.isContentEditable || e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const interactive = e.target?.closest?.('button, a, summary, [role="button"]');
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
  holdUntil = 0;
  clearTimeout(newsTimer);
  turnPage(dir);
  announcePosition();
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
  const matched = newsPages.findIndex(page => pageKey(page) === pageKey(displayedPage));
  if (matched >= 0) newsPage = matched;
  newsPage = (newsPage + dir + newsPages.length) % newsPages.length;
  renderPage(dir < 0);
}

function refreshReadingStops(rearm = false) {
  const body = document.getElementById('nbBody');
  if (!body) return;
  // A changed viewport is a new composition opportunity, not a permanent split.
  if (rearm && isPresentation() && displayedPage) {
    const key = topicKey(displayedPage);
    measuredResponses.clear();
    newsPages = buildPages();
    newsPage = Math.max(0, newsPages.findIndex(page => topicKey(page) === key));
    renderPage(false, true);
    return;
  }
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
  const part = readingOffsets.length > 1 ? ` · Screen ${index + 1} of ${readingOffsets.length}` : '';
  if (isPresentation()) {
    const topics = [...new Set(availablePages.map(topicKey))];
    const position = Math.max(0, topics.indexOf(topicKey(displayedPage))) + 1;
    const continuation = displayedPage.parts > 1 ? ` · Response ${displayedPage.part + 1}/${displayedPage.parts}` : '';
    setText('nbTopicPosition', `Topic ${String(position).padStart(2, '0')} / ${topics.length}${continuation}${part}`);
    if (readingOffsets.length > 1) setText('nbSlug', displayedPage.topic?.split(':')[0] || SECTION_LABELS[displayedPage.kind]);
  }
  const availableIndex = availablePages.findIndex(page => pageKey(page) === pageKey(displayedPage));
  const oldEdition = BRIEF_KINDS.has(displayedPage.kind) && displayedPage.briefFile !== briefDoc?.filename;
  const oldReadingCopy = BRIEF_KINDS.has(displayedPage.kind) && displayedPage.readingCopy !== briefDoc?.readingCopy;
  setText('nbPager', oldEdition || oldReadingCopy ? `Held ${oldEdition ? 'edition' : 'reading copy'} · Section ${displayedPage.index + 1} of ${displayedPage.count}${part}`
    : availableIndex >= 0 ? `Section ${availableIndex + 1} of ${availablePages.length}${part}` : `Held topic${part}`);
  const next = document.getElementById('nbNext');
  const previous = document.getElementById('nbPrev');
  if (next) {
    next.textContent = index < readingOffsets.length - 1 ? 'Continue →' : 'Next section →';
    next.setAttribute('aria-label', next.textContent);
    next.title = `${next.textContent} (Right arrow)`;
  }
  if (previous) {
    previous.textContent = index > 0 ? '← Back' : '← Previous section';
    previous.setAttribute('aria-label', previous.textContent);
    previous.title = `${previous.textContent} (Left arrow)`;
  }
  const picker = document.getElementById('nbSections');
  if (picker) {
    const options = availablePages.map((page, i) => `<option value="${i}">${i + 1}. ${escapeHtml(topicLabel(page, briefDoc, landscape))}</option>`).join('');
    if (picker.dataset.options !== options) { picker.innerHTML = options; picker.dataset.options = options; }
    const current = availablePages.findIndex(page => pageKey(page) === pageKey(displayedPage));
    picker.value = current >= 0 ? String(current) : '';
    picker.disabled = !availablePages.length;
  }
  const open = document.getElementById('nbOpen');
  if (open) {
    const displayedFile = displayedPage.briefFile || briefDocFile;
    const isBrief = BRIEF_KINDS.has(displayedPage.kind) && displayedFile;
    const fragment = readerFragment(displayedPage, displayedPage.briefAnchors);
    open.setAttribute('href', isBrief ? `/briefing/${encodeURIComponent(displayedFile)}${fragment}` : displayedPage.signalKey ? `/wire?signal=${encodeURIComponent(displayedPage.signalKey)}` : displayedPage.cve ? `/wire?q=${encodeURIComponent(displayedPage.cve)}` : '/wire');
    open.textContent = isBrief ? 'Open Briefing' : 'Open in Wire';
  }
}

function announcePosition(update = '') {
  if (!displayedPage) return;
  setText('nbPageAnnounce', `${update ? `${update} ` : ''}${SECTION_LABELS[displayedPage.kind] || 'Wall'}. ${document.getElementById('nbPager')?.textContent || ''}. Paused for reading.`);
}

function holdReading(persistent = false) {
  if (isPresentation()) return;
  if (isPresentation() && !persistent && displaySettings.holdSeconds && (!paused || holdUntil)) holdUntil = Date.now() + displaySettings.holdSeconds * 1000;
  if (persistent) holdUntil = 0;
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
  holdUntil = 0;
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
  const actions = document.getElementById('nbAllActions');
  if (actions) {
    const doc = displayedPage?.document || briefDoc;
    const count = (doc?.stories || []).reduce((n, story) => n + storyActions(story).length, 0);
    actions.disabled = !doc;
    actions.textContent = count ? `All actions (${count})` : 'Actions and context';
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
  setText('nbSubject', displayedPage.topicText || topicLabel(displayedPage, briefDoc, landscape));
  const ready = document.getElementById('nbReady');
  if (ready) ready.hidden = !briefingReady;
  const reviewNode = document.getElementById('nbReview');
  if (reviewNode) {
    const review = briefKind ? displayedPage.review : null;
    // Presentation has the reviewed state in its folio and complete provenance
    // in All actions. Reserve this second row for actual review failures; the
    // operator reading view keeps its inline disclosure.
    reviewNode.hidden = !review || (isPresentation() && review.status === 'editorially-corrected' && isEligibleWallEdition(displayedPage.document));
    if (review) {
      const reviewIdentity = [review.reviewer || 'Editorial review', formatBriefPublishedAt(review.reviewedAt)].filter(Boolean).join(' · ');
      const originalWarnings = displayedPage.briefWarnings || [];
      const originalChecks = originalWarnings.length
        ? `<details><summary>Original generation source-check notes (${originalWarnings.length})</summary><p>These findings belong to the unchanged original output. The reading copy and editorial scope are described above.</p><ul>${originalWarnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : '';
      const html = review.status === 'editorially-corrected'
        ? `<details><summary>Editorially corrected reading copy · review details</summary><p>${escapeHtml(reviewIdentity)}</p><p>${escapeHtml(review.scope || '')}</p>${originalChecks}<a href="/briefing/${encodeURIComponent(displayedPage.briefFile)}#editorial-review">Review corrections and original in Briefing</a></details>`
        : `<p role="alert">${escapeHtml(review.message || 'Editorial review unavailable. Original text displayed.')}</p>`;
      if (reviewNode.dataset.reviewHtml !== html) { reviewNode.innerHTML = html; reviewNode.dataset.reviewHtml = html; }
    }
  }
  const stamp = document.getElementById('nbBriefStamp');
  if (stamp) {
    const publication = formatBriefPublication({ generatedAt: displayedPage.briefGeneratedAt, filename: displayedPage.briefFile, date: displayedPage.briefDate });
    const feedTime = formatBriefPublishedAt(displayedPage.feedGeneratedAt);
    const feedStamp = ['wire', 'kev'].includes(displayedPage.kind)
      ? (feedTime ? `Feed snapshot ${feedTime}` : 'Feed snapshot time unavailable') : '';
    const reviewed = displayedPage.review?.status === 'editorially-corrected' && isEligibleWallEdition(displayedPage.document);
    const currentWarnings = !reviewed ? displayedPage.briefWarnings || [] : [];
    const reviewStamp = reviewed ? 'AI-generated · Editorially reviewed' : `AI-generated · Verify before acting${currentWarnings.length ? ` · ${currentWarnings.length} review ${currentWarnings.length === 1 ? 'note' : 'notes'}` : ''}`;
    stamp.textContent = briefKind
      ? `${publication}${stale ? ' · Older edition' : ''}${briefLoadError ? ' · Refresh unavailable' : ''} · ${reviewStamp}`
      : [feedStamp, briefLoadError ? 'Briefing unavailable · Retrying automatically'
        : displayedPage.kind === 'brieferror' && briefDoc ? 'Briefing available · Resume or advance to read' : ''].filter(Boolean).join(' · ');
    stamp.title = briefKind ? (reviewed ? 'Editorial scope, corrections and original generation findings are available in review details.' : currentWarnings.join('\n')) : '';
    stamp.dataset.status = stale || briefLoadError || (briefKind && currentWarnings.length) ? 'warn' : 'live';
    if (isPresentation()) {
      const fullStamp = stamp.textContent;
      const time = briefKind ? formatBriefPublishedAt(displayedPage.briefGeneratedAt) : feedTime;
      const edition = briefKind ? `Briefing · ${time || displayedPage.briefDate || 'Time unavailable'}` : `Collection · ${time || 'Time unavailable'}`;
      const state = briefKind ? (reviewed ? 'AI-generated · Editorially reviewed' : reviewStamp) : 'Source reporting · Local exposure unknown';
      const states = [...state.split(' · '), ...(stale ? ['Older edition'] : []), ...(briefLoadError ? ['Refresh unavailable'] : [])];
      stamp.innerHTML = `<span>${escapeHtml(edition)}</span><span class="nb-edition-state">${states.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</span>`;
      stamp.title = fullStamp;
      setText('nbSource', presentationSourceText(displayedPage));
    }
  }
}

export function presentationSourceText(page) {
  const hosts = [...new Set((page.citations || []).filter(item => safeWallSource(item.url)).map(item => new URL(item.url).hostname.replace(/^www\./, '')))];
  const source = page.kind === 'kev' ? 'CISA KEV · Federal civilian scope' : page.source || hosts.slice(0, 3).join(' · ');
  return [source, page.kind === 'wire' ? `Reported ${relAge(page.sourceDate) || 'at an unavailable time'}` : '',
    page.catalogEntries?.length ? `KEV · ${page.catalogEntries.length} ${page.catalogEntries.length === 1 ? 'CVE' : 'CVEs'}` : ''].filter(Boolean).join(' · ');
}

// splitBluf/capitalizeFirst now live in wall-format.js (pure text-splitting,
// no DOM dependency) and are imported above; the doc comment on their rationale
// (the em/en-dash clause-break heuristic) lives with the implementation there.

function renderSection(def) {
  if (!def) return '';
  if (isPresentation() && def.block) return presentationHtml(def, { interactive: false });
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
    case 'briefexcluded':
      return `<section class="nb-section">${wallStateHtml('Review required', 'This edition is excluded from Wall rotation.', 'A known material issue or a superseding edition prevents automatic display. Current feed pages remain available.', 'warn')}<p class="nb-display-source">${isPresentation() ? 'Review editions in Briefing History.' : '<a href="/briefing?archive=1">Review editions in History</a>'}</p></section>`;
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
      const commonTarget = executiveTargetModel(model.commonDeadline);
      const situation = [model.threat, model.exposure, ...model.context].filter(Boolean);
      const situationClamp = situation.length <= 2 ? 6 : 3;
      const situationHtml = situation.map((item, i) => `
        <div class="nb-exec-fact${i === 0 ? ' is-primary' : ''}">
          <dt>${escapeHtml(item.label)}</dt>
          <dd><span class="nb-clamp nb-clamp-${situationClamp}">${escapeHtml(item.text)}</span></dd>
        </div>`).join('');
      const decisionsHtml = model.decisions.map((item, i) => {
        const target = executiveTargetModel(item.deadline);
        return `
        <li class="nb-exec-decision">
          <span class="nb-exec-index" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
          <div class="nb-exec-task">
            <strong>${escapeHtml(item.owner)}</strong>
            <p><span class="nb-clamp nb-clamp-3">${escapeHtml(item.action)}</span></p>
          </div>
          ${item.deadline && !model.commonDeadline ? `<span class="nb-exec-due">${escapeHtml(target.label)} · ${escapeHtml(target.value)}</span>` : ''}
        </li>`;
      }).join('');
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
                ${model.commonDeadline ? `<div class="nb-exec-shared-due"><span>${escapeHtml(commonTarget.label === 'Due' ? 'Shared due' : commonTarget.label)}</span><strong>${escapeHtml(commonTarget.value)}</strong></div>` : ''}
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
      return `<section class="nb-section nb-judgment-page">${judgmentHtml(s, briefDoc?.date)}</section>`;
    }

    // The live status board: what is moving, which way, and the escalation trigger.
    case 'developing': {
      const rows = (briefDoc.developing || []).filter(d => d && [d.name, d.watch, d.trajectory].some(v => String(v || '').trim())).map(developingHtml).join('');
      return `<section class="nb-section"><div class="nb-devboard">${rows}</div></section>`;
    }
    case 'watchlist': {
      const entries = briefDoc.watchlistEntries || (briefDoc.watchlist || []).map(text => ({ text }));
      return `<section class="nb-section"><h2 class="nb-dev-name">Watchlist</h2><p class="nb-coverage">${escapeHtml(briefDoc.watchlistMetadata?.validityText || 'Validity boundary not specified')} · from ${escapeHtml(briefDoc.date || 'the saved edition')}</p><div class="nb-devboard">${entries.map(item => `<article class="nb-dev"><div class="nb-dev-main"><p class="nb-dev-watch">${escapeHtml(item.text)}</p>${sourceLinksHtml(item.citations)}</div></article>`).join('')}</div></section>`;
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
            ${c.confirmation ? `<div class="nb-conv-block"><span class="nb-conv-label">Confirmation criterion</span><p class="nb-conv-intersect">${escapeHtml(c.confirmation)}</p></div>` : ''}
            ${c.actionRationale ? `<div class="nb-conv-block"><span class="nb-conv-label">Action rationale</span><p class="nb-conv-intersect">${escapeHtml(c.actionRationale)}</p></div>` : ''}
            ${sourceLinksHtml(c.citations)}
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

export function presentationHtml(page, { interactive = true } = {}) {
  const certainty = judgmentCertainty(page.certainty || '');
  const decision = formatDecisionWindow(page.decision || '');
  const decisionDate = decision.relative ? decisionBriefDateLabel(page.editionDate) : '';
  const target = page.kind === 'execsummary' ? executiveTargetModel(page.timing) : {
    label: 'Recommended target',
    value: String(page.target || (!page.decision ? page.timing : '') || '').replace(/^(?:recommended\s+)?target\s*:?\s*/i, ''),
  };
  const citations = (page.citations || []).filter(item => safeWallSource(item.url)).slice(0, 3);
  const provenance = page.source ? `Source: ${interactive && safeWallSource(page.sourceUrl) ? `<a href="${escapeHtml(page.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.source)}</a>` : escapeHtml(page.source)}`
    : citations.map(item => interactive ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(new URL(item.url).hostname.replace(/^www\./, ''))}</a>` : escapeHtml(new URL(item.url).hostname.replace(/^www\./, ''))).join(' · ');
  const showDecision = decision.display && !page.actions?.length;
  const hasFacts = [page.cve, page.added, page.federalDue, page.validity, showDecision, target.value, certainty.value].some(Boolean);
  // Composition changes type and measure, never the authored words. Long
  // unreviewed openings remain complete reading copy instead of a giant title.
  const openingWords = String(page.block.text || '').trim().split(/\s+/).filter(Boolean).length;
  const composition = page.kind === 'bluf' ? (openingWords > 90 ? 'reading' : openingWords <= 32 ? 'short' : 'opening')
    : page.kind === 'wire' && openingWords <= 65 ? 'report' : 'topic';
  return `<section class="nb-display-card" data-kind="${escapeHtml(page.kind)}" data-composition="${composition}">
    ${page.kind !== 'bluf' || page.parts > 1 ? `<p class="nb-display-kicker">${page.kind !== 'bluf' ? escapeHtml(page.block.label || SECTION_LABELS[page.kind] || 'Saved assessment') : ''}${page.parts > 1 ? `${page.kind !== 'bluf' ? ' · ' : ''}Part ${page.part + 1} of ${page.parts}` : ''}</p>` : ''}
    ${page.kind !== 'bluf' ? `<h2>${escapeHtml(page.topic || '')}</h2>` : ''}
    <div class="nb-display-response${page.actions?.length ? ' has-actions' : ''}">${page.kind === 'bluf' ? `<p class="nb-cover-label">Shift assessment</p><h2 class="nb-cover-title">${escapeHtml(page.coverTitle || 'Threat landscape briefing')}</h2><p class="nb-display-text nb-display-opening-copy">${escapeHtml(page.block.text)}</p>${page.priorities?.length ? `<ol class="nb-cover-priorities">${page.priorities.map(title => `<li>${escapeHtml(title)}</li>`).join('')}</ol>` : ''}` : `<p class="nb-display-text">${escapeHtml(page.block.text)}</p>`}
    ${page.actions?.length ? `<ol class="nb-response-actions nb-display-actions${page.actions.length > 1 ? ' has-multiple' : ''}">${page.actions.map(action => wallActionHtml(action, { compact: true })).join('')}</ol>` : ''}
    ${page.condition ? `<div class="nb-display-condition"><strong>${page.kind === 'kev' ? 'Applicability decision' : 'Escalation condition'}</strong><p>${escapeHtml(page.condition)}</p></div>` : ''}</div>
    ${hasFacts ? `<div class="nb-display-facts">
      ${page.cve ? `<span>${page.isKEV || page.kind === 'kev' ? 'Confirmed exploited · ' : ''}${escapeHtml(page.cve)}</span>` : ''}
      ${page.added ? `<span>Catalog added · ${escapeHtml(page.added)} (UTC)</span>` : ''}
      ${page.federalDue ? `<span>Federal civilian deadline · ${escapeHtml(page.federalDue)} (FCEB scope)</span>` : ''}
      ${page.validity ? `<span>Watch validity · ${escapeHtml(page.validity)}</span>` : ''}
      ${showDecision ? `<span>Decision · ${escapeHtml(decision.display)}${decisionDate ? ` <small>(from ${escapeHtml(decisionDate)} Briefing)</small>` : ''}</span>` : ''}
      ${target.value ? `<span>${escapeHtml(target.label)} · ${escapeHtml(target.value)}</span>` : ''}
      ${certainty.value ? `<span>${escapeHtml(certainty.label)} · ${escapeHtml(certainty.value)}</span>` : ''}
    </div>` : ''}
    ${interactive && provenance ? `<p class="nb-display-source">${provenance}</p>` : ''}
    ${interactive && page.kind === 'wire' ? `<p class="nb-display-source">Report age · ${escapeHtml(relAge(page.sourceDate) || 'Publication time unavailable')}</p>` : ''}
    ${interactive && page.kind === 'kev' ? '<p class="nb-display-source">CISA Known Exploited Vulnerabilities catalog · Verify affected versions and local exposure.</p>' : ''}
    ${interactive && page.kind === 'wire' ? `<p class="nb-display-source">Wall selection · Signal ${page.selectionIndex || 1} of ${page.selectionCount || 1} · <a href="/wire">Full feed in Wire</a></p>` : ''}
    ${interactive && ['judgment', 'convergence', 'developing', 'watchlist'].includes(page.kind) ? `<p class="nb-display-source"><button type="button" data-wall-actions>All actions and source context</button>${page.actionCount ? ` · ${page.actionCount} authored ${page.actionCount === 1 ? 'action' : 'actions'} in this topic` : ''}</p>` : ''}
  </section>`;
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
        ${sourceLinksHtml(d.citations)}
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

  const actions = storyActions(s);
  const act = actions.length
    ? `<div class="nb-act c-action"><h3 class="nb-actions-heading">Recommended actions · ${actions.length}</h3><ol class="nb-response-actions">${actions.map(action => wallActionHtml(action)).join('')}</ol></div>`
    : '';

  const sources = judgmentSources(s);
  const evidence = s.isKEV || sources.length
    ? `<div class="nb-jevidence" aria-label="Saved citation provenance">
        ${s.isKEV ? `<span class="nb-evidence-kev">KEV${s.kevCVE ? ` · ${escapeHtml(s.kevCVE)}` : ''}</span>` : ''}
        ${sources.length ? `<span class="nb-evidence-sources"><b>${sources.length === 1 ? 'Cited source' : 'Cited sources'}</b> ${sources.map(host => {
          const citation = (s.citations || []).find(item => safeWallSource(item.url) && new URL(item.url).hostname.replace(/^www\./i, '') === host);
          return `<a href="${escapeHtml(citation.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>`;
        }).join(' · ')}</span>` : ''}
      </div>`
    : '';
  const reasoning = s.assessment || certainty.basis || s.forecast || evidence
    ? `<div class="nb-jreasoning">
        ${s.assessment ? `<p class="nb-jbody"><span class="nb-clamp nb-clamp-4">${escapeHtml(s.assessment)}</span></p>` : ''}
        ${certainty.basis ? `<p class="nb-jbody nb-certainty-basis"><strong>${certainty.label} basis:</strong> ${escapeHtml(certainty.basis)}</p>` : ''}
        ${s.forecast ? `<p class="nb-jbody"><strong>Forecast:</strong> ${escapeHtml(s.forecast)}</p>` : ''}
        ${[['What happened', s.whatHappened], ['Defender impact', s.defenderImpact], ['Relevance', s.relevance]].some(([, text]) => text) ? `<details class="nb-authored-context"><summary>Supporting context</summary>${[['What happened', s.whatHappened], ['Defender impact', s.defenderImpact], ['Relevance', s.relevance]].filter(([, text]) => text).map(([label, text]) => `<p class="nb-jbody"><strong>${label}:</strong> ${escapeHtml(text)}</p>`).join('')}</details>` : ''}
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
  if (s.source) meta.push(`<span class="nb-source-name">Source: ${safeWallSource(s.link) ? `<a href="${escapeHtml(s.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.source)}</a>` : escapeHtml(s.source)}</span>`);

  const dek = cleanSummary(s.displayExcerpt || s.description);
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
        <h2 class="nb-headline"><a href="/wire?signal=${escapeHtml(encodeURIComponent(s.link || s.title))}" class="nb-clamp nb-clamp-2">${escapeHtml(s.editorialContext?.title || s.title)}</a></h2>
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
  return `<section class="nb-section"><p class="nb-coverage">Top ${sigs.length} of ${usable.length} available signals · <a href="/wire">Full feed in Wire</a></p><div class="nb-feed">${sigs.map((s, i) => wireStoryHtml(s, i === 0)).join('')}</div></section>`;
}

function safeWallSource(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

function sourceLinksHtml(citations = []) {
  const valid = citations.filter(item => safeWallSource(item.url));
  return valid.length ? `<p class="nb-display-source">${valid.map(item => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label || new URL(item.url).hostname)}</a>`).join(' · ')}</p>` : '';
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
  const value = String(text ?? '');
  if (el && el.textContent !== value) el.textContent = value;
}

// Drive the board's staleness decay from the SAME warn state the masthead
// computes, so the dim and the STALE/UPDATED readout can never disagree.
function setBoardStale(stale) {
  document.querySelector('.news-mode')?.classList.toggle('nb-stale', !!stale);
}

// Kiosk-only overnight dim (a second burn-in lever alongside the pixel shift):
// a staffed watchfloor with an operator at the keys should never have its board
// dim itself unasked, so this is gated to kiosk mode exactly like the self-reload.
// The configured hour window supports midnight crossings and is opt-in.
function applyQuietHourDim(now) {
  const el = document.querySelector('.news-mode');
  if (!el) return;
  const inWindow = isPresentation() && !paused && displaySettings.dim
    && inDimWindow(now.getHours(), displaySettings.dimStart, displaySettings.dimEnd);
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
  if (holdUntil && Date.now() >= holdUntil) {
    const body = document.getElementById('nbBody');
    // Never move content while a keyboard/assistive-technology reader owns it.
    if (!body?.contains?.(document.activeElement) && !document.querySelector('dialog[open]')) togglePause();
  }
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
        : paused ? holdUntil ? (Date.now() >= holdUntil ? 'Held while reading · Resume when ready' : `Temporary hold · ${Math.max(0, Math.ceil((holdUntil - Date.now()) / 1000))}s`) : 'Paused' : stalled ? 'Rotation stalled'
          : newsPages.length <= 1 && readingOffsets.length <= 1 ? 'Single page' : `Playing · Next in ${Math.max(0, Math.ceil((dwellMs - (Date.now() - dwellStartMs)) / 1000))}s`;
    playback.dataset.status = stalled || renderLoadError ? 'warn' : 'live';
  }
  const persistentHold = document.getElementById('nbPersistentHold');
  if (persistentHold) persistentHold.hidden = !holdUntil;
  const el = document.getElementById('nbIntegrity');
  const dot = document.getElementById('nbLiveDot');
  if (!el) return;
  const genMs = Date.parse(landscape?.generatedAt);
  const ageSec = Number.isFinite(genMs) ? Math.max(0, Math.round((Date.now() - genMs) / 1000)) : null;
  const ago = ageSec === null ? '' : ageSec < 90 ? `${ageSec}s` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m` : `${Math.round(ageSec / 3600)}h`;
  const ok = landscape?.feeds?.ok;
  const total = landscape?.feeds?.total;
  const invalidFeeds = !Number.isFinite(ok) || !Number.isFinite(total) || total <= 0 || total < ok || ok < 0;
  const stale = ageSec !== null && ageSec > Math.max(2 * 60 * 60, staleAfterSec(landscape?.pipeline?.refreshMinutes));
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
  el.hidden = isPresentation() && !warn;
  el.dataset.status = warn ? 'warn' : 'live';
  if (dot) dot.dataset.status = warn ? 'warn' : 'live';
  setLiveWord(word, warn);
  setBoardStale(warn);
}

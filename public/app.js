// BlueTeam.News — frontend boot: header, router, view switching, landscape poll.

import { getState, setState, on, emit } from './modules/core/store.js';
import { initRouter, navigate } from './modules/core/router.js';
import { initHeader } from './modules/layout/header.js';
import { initShortcuts } from './modules/core/shortcuts.js';
import { initInfotips } from './modules/core/infotip.js';
import { fetchLandscape } from './modules/core/api.js';
import { escapeHtml } from './modules/core/sanitize.js';
import { applyTheme, getThemePreference } from './modules/core/theme.js';

const viewCache = {};
let renderGeneration = 0;
let landscapeTimer = null;
let activeView = null;

// Tear down the currently-mounted view (its timers, listeners, GPU context)
// before mounting the next. Every view module may expose an unmount().
function teardownActiveView() {
  if (activeView && typeof activeView.unmount === 'function') {
    try { activeView.unmount(); } catch (err) { console.error('[app] view unmount failed:', err); }
  }
  activeView = null;
}

// On route change, take keyboard/SR users to the new view: focus its heading
// (or the region itself), making the surface programmatically focusable first.
// preventScroll keeps the layout calm — the view already scrolls to top on mount.
function focusViewRegion(region) {
  if (!region) return;
  const target = region.querySelector('h1, [role="heading"]') || region;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch { target.focus(); }
}

async function renderView(mode) {
  const main = document.getElementById('main');
  const wallLayer = document.getElementById('wallLayer');
  if (!main || !wallLayer) return;

  const thisRender = ++renderGeneration;

  // Tear down whatever view is currently active before mounting the next.
  teardownActiveView();
  // A new surface starts at its masthead. Without this, switching from the
  // bottom of a long briefing to another long view preserved the old page offset
  // and could land the operator halfway down (or at the bottom of) the new view.
  try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }
  catch { window.scrollTo(0, 0); }

  // The Wall is a full-screen broadsheet layer over the app.
  if (mode === 'wall') {
    try {
      if (!viewCache.wall) viewCache.wall = await import('./modules/wall/wall-view.js');
      if (thisRender !== renderGeneration) return;
      document.body.classList.add('wall-active');
      wallLayer.classList.remove('hidden');
      wallLayer.removeAttribute('aria-hidden');
      viewCache.wall.mount(wallLayer);
      activeView = viewCache.wall;
      focusViewRegion(wallLayer);
    } catch (err) {
      if (thisRender !== renderGeneration) return;
      console.error('[app] failed to load view "wall":', err);
      try { viewCache.wall?.unmount?.(); } catch { /* continue restoring the shell */ }
      document.body.classList.remove('wall-active');
      wallLayer.classList.add('hidden');
      wallLayer.setAttribute('aria-hidden', 'true');
      main.innerHTML = `<div class="error-message">Failed to load view: ${escapeHtml(err.message)}</div>`;
      focusViewRegion(main);
    }
    return;
  }

  // Non-wall views render into <main>; keep the wall layer hidden.
  document.body.classList.remove('wall-active');
  wallLayer.classList.add('hidden');
  wallLayer.setAttribute('aria-hidden', 'true');

  let viewModule;
  try {
    if (mode === 'wire') {
      if (!viewCache.wire) viewCache.wire = await import('./modules/wire/wire-view.js');
      viewModule = viewCache.wire;
    } else if (mode === 'settings') {
      if (!viewCache.settings) viewCache.settings = await import('./modules/settings/settings-view.js');
      viewModule = viewCache.settings;
    } else {
      if (!viewCache.briefing) viewCache.briefing = await import('./modules/briefing/briefing-view.js');
      viewModule = viewCache.briefing;
    }
    if (thisRender !== renderGeneration) return;
    viewModule.render(main);
    activeView = viewModule;
    focusViewRegion(main);
  } catch (err) {
    if (thisRender !== renderGeneration) return;
    console.error(`[app] failed to load view "${mode}":`, err);
    try { viewModule?.unmount?.(); } catch { /* continue rendering the error state */ }
    main.innerHTML = `<div class="error-message">Failed to load view: ${escapeHtml(err.message)}</div>`;
    focusViewRegion(main);
  }
}

// Tolerate transient blips and the warmup window, but don't let a persistently
// dead pipeline read as live: after N consecutive failures, flag landscapeStale
// so the UI can say so. Cleared the moment a poll succeeds.
let landscapePollFailures = 0;
const LANDSCAPE_STALE_AFTER = 3;

async function pollLandscape() {
  try {
    const landscape = await fetchLandscape();
    landscapePollFailures = 0;
    setState(getState().landscapeStale ? { landscape, landscapeStale: false } : { landscape });
  } catch {
    landscapePollFailures++;
    if (landscapePollFailures >= LANDSCAPE_STALE_AFTER && !getState().landscapeStale) {
      setState({ landscapeStale: true });
    }
  }
}

async function boot() {
  // The inline head script handles the first paint; arm the live media-query
  // listener here so the "System" preference also follows an OS theme change
  // made while this long-running desk is already open.
  try {
    if (getThemePreference() === 'system') applyTheme('system');
  } catch { /* storage unavailable — retain the FOUC-free painted fallback */ }
  initHeader();
  initShortcuts();
  // Delegated hover/keyboard/tap explanations for [data-tip] chips — bound once.
  initInfotips();

  on('mode-changed', renderView);

  on('generate-brief', async () => {
    if (getState().isGenerating) return;
    const { startGeneration } = await import('./modules/briefing/brief-stream.js');
    startGeneration();
    navigate('/briefing/new');
  });

  // initRouter() emits mode-changed (forceEmit), which renders the initial view.
  initRouter();

  pollLandscape();
  landscapeTimer = setInterval(pollLandscape, 60_000);
  window.addEventListener('beforeunload', () => clearInterval(landscapeTimer));
}

boot().catch(err => console.error('[app] boot failed:', err));

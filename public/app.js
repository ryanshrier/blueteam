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
let wallOperatorMode = null;

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

function renderViewError(main, mode, err) {
  const label = {wire:'Wire', briefing:'Briefing', settings:'Settings', wall:'Wall'}[mode] || 'View';
  main.innerHTML = `<section class="view-load-state" role="alert">
    <p class="view-kicker">Unable to open</p><h1 class="view-title">${label}</h1>
    <p>The application could not load this view. Reload to try again.</p>
    <button type="button" class="btn-primary" id="retryView">Reload view</button>
    <details><summary>Technical details</summary><p>${escapeHtml(err?.message || 'Unknown load error')}</p></details>
  </section>`;
  main.querySelector('#retryView')?.addEventListener('click', () => window.location.reload());
  focusViewRegion(main);
}

async function renderView(mode) {
  const main = document.getElementById('main');
  const wallLayer = document.getElementById('wallLayer');
  if (!main || !wallLayer) return;

  const thisRender = ++renderGeneration;
  // Wall presentation mode belongs to the query, which can change without a
  // surface transition (G then L from a kiosk, or browser Back).
  wallOperatorMode = mode === 'wall' ? new URLSearchParams(window.location.search).has('operator') : null;

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
      renderViewError(main, mode, err);
    }
    return;
  }

  // Non-wall views render into <main>; keep the wall layer hidden.
  document.body.classList.remove('wall-active');
  wallLayer.classList.add('hidden');
  wallLayer.setAttribute('aria-hidden', 'true');

  const destination = {wire:'Wire', settings:'Settings', briefing:'Briefing'}[mode] || 'Briefing';
  main.innerHTML = `<section class="view-load-state" role="status"><p class="view-kicker">Opening</p><h1 class="view-title">${destination}</h1><p>Loading ${destination.toLowerCase()}…</p></section>`;

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
    renderViewError(main, mode, err);
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
  on('route-changed', ({ mode }) => {
    if (mode === 'wall' && wallOperatorMode !== new URLSearchParams(window.location.search).has('operator')) {
      renderView('wall');
    }
  });

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

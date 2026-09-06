// BlueTeam.News client router. Product surfaces use ordinary, shareable paths;
// URL fragments remain available for in-page anchors inside rendered briefings.

import { getState, setState, emit } from './store.js';
import { requestWallFullscreen } from '../wall/wall-browser.js';

let editionTitle = 'BlueTeam.News';
let pageTitle = 'Wire';
const viewMemory = new Map();
let wallReturnUrl = '/wire';

function locationUrl() { return `${window.location.pathname}${window.location.search || ''}${window.location.hash || ''}`; }
export function rememberCurrentView() {
  if (typeof window === 'undefined') return;
  const route = resolveLocation(window.location.pathname).data;
  if (route.action === 'generate') return;
  const url = locationUrl();
  viewMemory.set(route.mode, { url, scroll: Number(window.scrollY) || 0 });
  if (route.mode !== 'wall') wallReturnUrl = url;
  emit('view-memory-changed');
}
export function currentViewUrl(mode) { return mode === 'wall' ? '/wall' : viewMemory.get(mode)?.url || `/${mode}`; }
export function getViewScroll(mode) { return viewMemory.get(mode)?.scroll || 0; }
export function getWallReturnUrl() { return wallReturnUrl; }
export function rememberViewScroll(mode, scroll) {
  const prior = viewMemory.get(mode);
  if (prior) prior.scroll = Math.max(0, Number(scroll) || 0);
}

export function setPageTitle(label) {
  pageTitle = label || 'Wire';
  if (typeof document !== 'undefined') document.title = `${pageTitle} · ${editionTitle}`;
}

export function setEditionTitle(label) {
  editionTitle = label || 'BlueTeam.News';
  setPageTitle(pageTitle);
}

// Enhance ordinary links without taking over new tabs, downloads or browser menus.
export function followInternalLink(event, link = event.currentTarget) {
  if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link?.target || link?.hasAttribute?.('download')) return;
  const path = link?.getAttribute?.('href');
  if (!path?.startsWith('/') || path.startsWith('//')) return;
  event.preventDefault();
  // Keep this synchronous with the user's ordinary link gesture. Route mounts,
  // reloads, history navigation, and modified/new-tab clicks never request it.
  if (/^\/wall\/?(?:[?#]|$)/.test(path) && new URLSearchParams(path.split('?')[1]?.split('#')[0]).get('read') !== '1') requestWallFullscreen();
  navigate(path);
}

const routes = [
  { pattern: /^\/wire\/?$/, mode: 'wire' },
  { pattern: /^\/wall\/?$/, mode: 'wall' },
  { pattern: /^\/settings\/?$/, mode: 'settings' },
  { pattern: /^\/briefing\/new\/?$/, mode: 'briefing', action: 'generate' },
  { pattern: /^\/briefing\/([^/]+)\/?$/, mode: 'briefing', param: 'filename' },
  { pattern: /^\/briefing\/?$/, mode: 'briefing' },
];

export function initRouter() {
  // Views restore their own reading positions after asynchronous rendering.
  // Native restoration can otherwise run later and put a fresh masthead under
  // the sticky header, particularly when returning from a full-screen Wall.
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  window.addEventListener('popstate', () => handleRoute());
  window.addEventListener('scroll', () => {
    const mode = resolveLocation(window.location.pathname).data.mode;
    rememberViewScroll(mode, window.scrollY);
  }, { passive: true });
  document.addEventListener('click', handleRouteLink);
  handleRoute(true);
}

export function handleRouteLink(event) {
  const link = event.target?.closest?.('a[href]');
  const href = link?.getAttribute?.('href');
  if (!href?.startsWith('/') || href.startsWith('//')) return;
  // Downloads, APIs and other server endpoints retain normal browser behavior.
  const pathname = href.split(/[?#]/, 1)[0];
  if (!routes.some(route => route.pattern.test(pathname))) return;
  followInternalLink(event, link);
}

export function navigate(destination) {
  rememberCurrentView();
  const path = destination.startsWith('/') ? destination : `/${destination}`;
  const current = locationUrl();
  if (current === path) handleRoute();
  else {
    window.history.pushState(null, '', path);
    handleRoute();
  }
}

export function resolveLocation(pathname) {
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const data = { mode: route.mode, action: route.action || null };
    if (route.param && match[1]) {
      try { data[route.param] = decodeURIComponent(match[1]); }
      catch { data[route.param] = match[1]; }
    }
    return { data };
  }
  return { data: { mode: 'wire', action: null }, canonicalPath: '/wire' };
}

function handleRoute(forceEmit = false) {
  const resolved = resolveLocation(window.location.pathname);
  if (resolved.canonicalPath) window.history.replaceState(null, '', resolved.canonicalPath);
  const data = resolved.data;
  if (data.action !== 'generate') {
    const prior = viewMemory.get(data.mode);
    viewMemory.set(data.mode, { url: locationUrl(), scroll: prior?.url === locationUrl() ? prior.scroll : 0 });
  }
  const viewLabel = { wire: 'Wire', wall: 'Wall', settings: 'Settings', briefing: 'Briefing' }[data.mode];
  const edition = data.filename?.match(/^brief-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/);
  setPageTitle(edition ? `Briefing · ${edition[1]}${edition[2] ? ` · Edition ${Number(edition[2])}` : ''}` : viewLabel);
  const modeChanged = getState().mode !== data.mode;
  setState({ mode: data.mode });
  // setState emits mode-changed itself on a real transition. The forced initial
  // event is only needed when the resolved mode already equals the store default;
  // emitting twice on a non-default deep link mounted/imported that view twice.
  if (forceEmit && !modeChanged) emit('mode-changed', data.mode);
  emit('route-changed', data);
}

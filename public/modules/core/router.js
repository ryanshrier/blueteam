// BlueTeam.News client router. Product surfaces use ordinary, shareable paths;
// URL fragments remain available for in-page anchors inside rendered briefings.

import { getState, setState, emit } from './store.js';

const routes = [
  { pattern: /^\/wire\/?$/, mode: 'wire' },
  { pattern: /^\/wall\/?$/, mode: 'wall' },
  { pattern: /^\/settings\/?$/, mode: 'settings' },
  { pattern: /^\/briefing\/new\/?$/, mode: 'briefing', action: 'generate' },
  { pattern: /^\/briefing\/([^/]+)\/?$/, mode: 'briefing', param: 'filename' },
  { pattern: /^\/briefing\/?$/, mode: 'briefing' },
];

export function initRouter() {
  window.addEventListener('popstate', () => handleRoute());
  handleRoute(true);
}

export function navigate(destination) {
  const path = destination.startsWith('/') ? destination : `/${destination}`;
  const current = `${window.location.pathname}${window.location.search}`;
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
  const modeChanged = getState().mode !== data.mode;
  setState({ mode: data.mode });
  // setState emits mode-changed itself on a real transition. The forced initial
  // event is only needed when the resolved mode already equals the store default;
  // emitting twice on a non-default deep link mounted/imported that view twice.
  if (forceEmit && !modeChanged) emit('mode-changed', data.mode);
  emit('route-changed', data);
}

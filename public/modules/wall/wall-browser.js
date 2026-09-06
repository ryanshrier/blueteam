import { loadDisplaySettings } from './wall-presentation.js';

let fullscreenRequest = null;
let mountGeneration = 0;
let activeMountGeneration = 0;
let pendingExit = null;

function releaseFullscreen(request) {
  if (!request?.entered || document.fullscreenElement !== document.documentElement) return pendingExit || Promise.resolve();
  request.entered = false;
  try {
    const exit = Promise.resolve(document.exitFullscreen?.()).catch(() => {});
    pendingExit = exit;
    exit.finally(() => { if (pendingExit === exit) pendingExit = null; });
    return exit;
  } catch { return Promise.resolve(); }
}

// Called synchronously by ordinary Wall navigation gestures, never by mount or
// refresh. A denied/unsupported request leaves the full-viewport Wall usable.
export function requestWallFullscreen() {
  if (!loadDisplaySettings().fullscreen || typeof document === 'undefined'
    // Embedded browsers can expose requestFullscreen while policy/platform
    // support explicitly disables it. Do not start that unsupported request.
    || document.fullscreenEnabled === false
    || globalThis.navigator?.userActivation?.isActive === false
    || !document.documentElement?.requestFullscreen) return Promise.resolve(false);
  const previous = fullscreenRequest;
  if (document.fullscreenElement && previous?.entered && previous.owner === activeMountGeneration && activeMountGeneration) return Promise.resolve(true);
  if (document.fullscreenElement && !previous?.entered && !pendingExit) return Promise.resolve(false);
  const request = { owner: 0, entered: false, pending: true, promise: null };
  fullscreenRequest = request;
  const invoke = () => {
    if (fullscreenRequest !== request || (request.owner && activeMountGeneration !== request.owner)
      || document.fullscreenEnabled === false || globalThis.navigator?.userActivation?.isActive === false || document.fullscreenElement) return false;
    try {
      return Promise.resolve(document.documentElement.requestFullscreen()).then(() => {
        request.entered = document.fullscreenElement === document.documentElement;
        return request.entered;
      }).catch(() => false);
    } catch { return false; }
  };
  // Finish an earlier owned transition before a fresh gesture's request. Its
  // native exit event can then never be mistaken for an exit from the new visit.
  const prior = previous?.pending || previous?.entered
    ? previous.promise.then(() => releaseFullscreen(previous)) : pendingExit;
  request.promise = Promise.resolve(prior ? prior.then(invoke) : invoke()).finally(() => { request.pending = false; });
  return request.promise;
}

export function mountWallBrowser({ settings, onExit }) {
  const generation = ++mountGeneration;
  activeMountGeneration = generation;
  // A new visit can claim only the request made for it, never the previous
  // visit's already-claimed fullscreen state or delayed native events.
  const claimedFullscreen = fullscreenRequest?.owner === 0 ? fullscreenRequest : null;
  if (claimedFullscreen) claimedFullscreen.owner = generation;
  let active = true;
  let lock = null;
  let wakePending = false;
  let current = settings;
  async function awake() {
    if (!active || !current.awake || document.visibilityState === 'hidden' || lock || wakePending || !globalThis.navigator?.wakeLock?.request) return;
    wakePending = true;
    try {
      const next = await navigator.wakeLock.request('screen');
      if (!active || !current.awake || document.visibilityState === 'hidden') { await next.release(); return; }
      lock = next;
      next.addEventListener('release', () => { if (lock === next) lock = null; });
    } catch { /* Display still operates when browser/OS power policy declines. */ }
    finally { wakePending = false; }
  }
  const visible = () => { if (document.visibilityState !== 'hidden') awake(); };
  const fullscreenChanged = () => {
    // Native Escape may leave fullscreen without delivering an app key event.
    if (active && claimedFullscreen?.entered && claimedFullscreen.owner === generation && !document.fullscreenElement) {
      claimedFullscreen.entered = false;
      onExit();
    }
  };
  document.addEventListener('visibilitychange', visible);
  document.addEventListener('fullscreenchange', fullscreenChanged);
  awake();
  return {
    update(next) {
      current = next;
      if (!current.awake && lock) { const previous = lock; lock = null; Promise.resolve(previous.release()).catch(() => {}); }
      else awake();
    },
    destroy() {
      if (!active) return;
      active = false;
      if (activeMountGeneration === generation) activeMountGeneration = 0;
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      if (lock) { const previous = lock; lock = null; Promise.resolve(previous.release()).catch(() => {}); }
      // A navigation can leave while the gesture request is still resolving.
      if (claimedFullscreen?.entered) releaseFullscreen(claimedFullscreen);
      else if (claimedFullscreen?.pending) claimedFullscreen.promise.then(() => {
        // A newer request is serialized behind this transition. Releasing the
        // departed request before that new entry prevents a fullscreen leak.
        if (!fullscreenRequest?.entered || fullscreenRequest === claimedFullscreen) releaseFullscreen(claimedFullscreen);
      });
    },
  };
}

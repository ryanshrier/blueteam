// BlueTeam.News — reactive state store + event bus.

const listeners = new Map();

const state = {
  // Wire is the canonical default landing: the analyst's working surface and the
  // router's fallback. Store init, router fallback, header home, and Esc all align to it.
  mode: 'wire',              // briefing | wire | wall
  currentBrief: null,        // { filename, content, timestamp }
  landscape: null,           // latest /api/landscape payload
  landscapeStale: false,     // true after N consecutive poll failures (dead pipeline)
  isGenerating: false,
};

export function getState() { return state; }

export function setState(patch) {
  const prev = { ...state };
  Object.assign(state, patch);
  emit('state-changed', { prev, current: state, patch });
  if (patch.mode !== undefined && patch.mode !== prev.mode) emit('mode-changed', state.mode);
  if (patch.isGenerating !== undefined) emit('generating-changed', state.isGenerating);
  if (patch.landscape !== undefined) emit('landscape-updated', state.landscape);
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}

export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

export function emit(event, data) {
  listeners.get(event)?.forEach(fn => {
    try { fn(data); } catch (e) { console.error(`[store] handler error (${event}):`, e); }
  });
}

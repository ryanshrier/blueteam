// BlueTeam.News — keyboard shortcuts.
// G then B / W / L / S — Briefing / Wire / waLL / Settings · Ctrl+Enter — generate
// · / — focus the active search field · Esc — exit wall

import { getState, on, emit } from './store.js';
import { navigate } from './router.js';
import { openHelp, closeHelp } from './help.js';

let gPending = false;
let gTimer = null;
// Remember the surface we came from so Esc returns there, not a fixed home.
// Wire is the canonical fallback (see store.js).
let lastNonWallMode = 'wire';

export function initShortcuts() {
  document.addEventListener('keydown', handleKeydown);
  on('mode-changed', (mode) => { if (mode !== 'wall') lastNonWallMode = mode; });
}

function isTypingContext(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function handleKeydown(e) {
  // Esc closes the help overlay first, ahead of any other Esc handling — and it
  // must win even from inside a typing context (an input can sit in the overlay).
  // closeHelp() is a no-op when nothing is open, so this is safe unconditionally.
  if (e.code === 'Escape') {
    const closed = document.querySelector('.help-overlay');
    if (closed) { e.preventDefault(); closeHelp(); return; }
  }

  // A modal owns the keyboard while it is open. In particular, do not let `?`,
  // G-chords, or Ctrl/Command+Enter open a second overlay or start generation
  // behind the printable-edition/help dialog. The dialog's own handler retains
  // Escape and Tab trapping.
  if (document.querySelector('[aria-modal="true"]')) return;

  if (isTypingContext(e.target)) return;
  const state = getState();
  const key = String(e.key || '').toLowerCase();

  // ? (Shift+/) opens the "how to read BlueTeam.News" help. Guarded by the typing
  // check above; kept off the G-chord path so it never eats a pending chord.
  if (e.key === '?') {
    e.preventDefault();
    openHelp();
    return;
  }

  // Esc exits the wall back to the previously-active surface (fallback /wire)
  if (e.code === 'Escape' && state.mode === 'wall') {
    e.preventDefault();
    navigate(`/${lastNonWallMode || 'wire'}`);
    return;
  }

  // G-chord navigation
  if (gPending) {
    gPending = false;
    clearTimeout(gTimer);
    if (key === 'b') { e.preventDefault(); navigate('/briefing'); return; }
    if (key === 'w') { e.preventDefault(); navigate('/wire'); return; }
    if (key === 'l') { e.preventDefault(); navigate('/wall'); return; }
    // #82 — Settings was only mouse-reachable (the header gear); the G-chord
    // covered B/W/L but not S, leaving the help overlay's keyboard map unable
    // to reach a core destination.
    if (key === 's') { e.preventDefault(); navigate('/settings'); return; }
  }

  if (key === 'g' && !e.ctrlKey && !e.metaKey) {
    gPending = true;
    gTimer = setTimeout(() => { gPending = false; }, 500);
    return;
  }

  // Generate briefing
  if ((e.metaKey || e.ctrlKey) && e.code === 'Enter') {
    e.preventDefault();
    if (!state.isGenerating) emit('generate-brief');
  }

  // #82 — '/' focuses the active surface's text-entry field: the Wire's filter
  // input or the Briefing's search, whichever is mounted. isTypingContext above
  // already keeps this from firing while a field has focus, so a literal '/'
  // typed into a field is never hijacked.
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const field = document.getElementById('wireSearch') || document.getElementById('briefSearch');
    if (field) { e.preventDefault(); field.focus(); }
  }
}

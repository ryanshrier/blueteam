// BlueTeam.News — infotip primitive.
//
// The operator surfaces lean on `title=` tooltips to explain trust affordances
// (KEV, EXPLOIT, cross-source ×N, heuristic auto-tags, priority). Native
// `title=` only surfaces on hover with a mouse — touch and keyboard users never
// see the explanation. This replaces that with a single delegated bubble that
// shows on hover, keyboard focus, AND tap (click = touch toggle), so every
// input modality gets the same plain-text explanation.
//
// Contract: an element opts in with `data-tip="<plain text>"` + `tabindex="0"`
// and keeps an `aria-label` with the same text for screen readers (the bubble
// itself is decorative for AT — the label carries the SR path). Emitters strip
// their `title=` so there's no double native+custom tooltip. This module owns
// only the bubble + the delegated listeners; the CSS (.infotip-bubble,
// [data-tip] focus-visible + cursor) lives in app.css.

let bubble = null;      // the single reused bubble node, appended to <body>
let anchor = null;      // the [data-tip] the bubble is currently pinned to
let bound = false;      // idempotency guard — initInfotips() is bound once in boot

// Gap between the anchor and the bubble, and the viewport margin we clamp to.
const GAP = 8;
const MARGIN = 8;

// Resolve the [data-tip] ancestor of an event target (the tip may sit on a
// wrapper whose inner glyphs are the actual event.target).
function tipTarget(node) {
  if (!(node instanceof Element)) return null;
  return node.closest('[data-tip]');
}

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement('div');
  bubble.className = 'infotip-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bubble);
  return bubble;
}

// Position the bubble above the anchor by default; flip below when it would
// clip the top edge, and clamp horizontally so it never runs off-screen.
function place(el) {
  const b = ensureBubble();
  const r = el.getBoundingClientRect();
  const bw = b.offsetWidth;
  const bh = b.offsetHeight;

  let top = r.top - bh - GAP;
  if (top < MARGIN) top = r.bottom + GAP;   // flip below when there's no room above

  let left = r.left + r.width / 2 - bw / 2;  // centred on the anchor
  const maxLeft = window.innerWidth - bw - MARGIN;
  if (left > maxLeft) left = maxLeft;
  if (left < MARGIN) left = MARGIN;

  b.style.left = `${Math.round(left)}px`;
  b.style.top = `${Math.round(top)}px`;
}

function show(el) {
  const text = el.getAttribute('data-tip');
  if (!text) return;
  const b = ensureBubble();
  b.textContent = text;
  b.setAttribute('aria-hidden', 'false');
  anchor = el;
  place(el);   // measure after the text is set so the size is final
}

function hide() {
  if (!bubble) return;
  bubble.setAttribute('aria-hidden', 'true');
  anchor = null;
}

function onOver(e) {
  const el = tipTarget(e.target);
  if (el) show(el);
}

function onOut(e) {
  // Ignore moves that stay within the same anchor (child glyph → wrapper).
  if (anchor && e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget)) return;
  if (tipTarget(e.target)) hide();
}

function onFocus(e) {
  const el = tipTarget(e.target);
  if (el) show(el);
}

function onBlur(e) {
  if (tipTarget(e.target)) hide();
}

// Click = touch toggle: tapping a tip with the bubble already on it dismisses it,
// otherwise shows it. Mouse users get the same via hover, so this is additive.
// A tap OUTSIDE any tip while a bubble is open dismisses it — most mobile
// browsers emulate a mouseout that reaches onOut on the new tap, but dismissal
// isn't guaranteed on every browser/element, so this closes that gap explicitly.
function onClick(e) {
  const el = tipTarget(e.target);
  if (!el) {
    if (anchor) hide();
    return;
  }
  if (anchor === el && bubble && bubble.getAttribute('aria-hidden') === 'false') hide();
  else show(el);
}

function onKey(e) {
  if (e.key === 'Escape' && anchor) hide();
}

// A pinned bubble goes stale the moment the page scrolls under it — hide rather
// than chase the anchor. `capture` catches scrolls on any nested scroller.
function onScroll() {
  if (anchor) hide();
}

// A pinned bubble also goes stale when its anchor is removed from the DOM out
// from under it — e.g. the Wire's 5-min auto-refresh or a filter toggle rebuilds
// #wireList via innerHTML while a bubble is shown. Element removal fires no
// mouseout/blur, so onOut/onBlur never see it (both require the event target to
// BE a tip) and the bubble would float, unpinned, over whatever now occupies that
// screen position — misattributing its text to a different row. A single
// document-level observer catches any anchor's removal, from any view, without
// each view having to remember to call hide() before it rebuilds.
let anchorObserver = null;
function ensureAnchorObserver() {
  if (anchorObserver) return;
  anchorObserver = new MutationObserver(() => {
    if (anchor && !anchor.isConnected) hide();
  });
  anchorObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Bind the delegated infotip listeners once. Called from app.js boot.
 * Idempotent — repeat calls are a no-op.
 */
export function initInfotips() {
  if (bound) return;
  bound = true;
  ensureBubble();
  document.addEventListener('mouseover', onOver);
  document.addEventListener('mouseout', onOut);
  document.addEventListener('focusin', onFocus);
  document.addEventListener('focusout', onBlur);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);
  ensureAnchorObserver();
}

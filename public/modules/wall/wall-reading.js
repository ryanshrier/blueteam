// Viewport continuations keep every line reachable at the chosen type size.
// Adjacent screens overlap by at least one large text line, so a line crossing
// the viewport edge is fully visible on the next screen. Staffed readers can
// also scroll the same content directly; there is no second abridged document.
export function readingStops(body) {
  const height = Number(body?.clientHeight) || 0;
  const end = Math.max(0, (Number(body?.scrollHeight) || 0) - height);
  if (height <= 0 || end <= 2) return [0];
  let overlap = 64;
  const view = body.ownerDocument?.defaultView;
  if (view?.getComputedStyle && body.querySelectorAll) {
    for (const element of body.querySelectorAll('*')) {
      const style = view.getComputedStyle(element);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
      if (Number.isFinite(line)) overlap = Math.max(overlap, line + 8);
    }
  }
  const stride = Math.max(1, height - Math.min(overlap, height / 2));
  // Keep a decision, directive, or evidence row together on at least one part
  // when it fits in the reading viewport. Oversized blocks retain the same
  // overlapping-line fallback; the document itself is never clipped or copied.
  const blocks = [];
  if (body.getBoundingClientRect && body.querySelectorAll) {
    const bodyRect = body.getBoundingClientRect();
    const origin = bodyRect.top;
    // DOM rectangles include CSS zoom, while scrollTop/clientHeight do not.
    const scale = bodyRect.height > 0 && height > 0 ? bodyRect.height / height : 1;
    const scrollTop = Number(body.scrollTop) || 0;
    for (const element of body.querySelectorAll('.nb-exec-decision, .nb-response-action, .nb-act, .nb-conv-move, .nb-led-row, .nb-item, .nb-dev, .nb-exec-fact')) {
      if (!element.getBoundingClientRect) continue;
      const rect = element.getBoundingClientRect();
      const top = Math.floor((rect.top - origin) / scale + scrollTop);
      const bottom = (rect.bottom - origin) / scale + scrollTop;
      if (bottom > top && bottom - top <= height) blocks.push({ top, bottom });
    }
  }
  const stops = [0];
  while (stops.at(-1) < end) {
    const current = stops.at(-1);
    let next = Math.min(end, Math.round(current + stride));
    for (const block of blocks) {
      if (block.top > current && block.top < next && block.bottom > next) next = block.top;
    }
    stops.push(next);
  }
  return stops;
}

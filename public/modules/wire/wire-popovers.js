// Score disclosures float over other row actions. Keep their native details
// semantics while giving mouse, touch, and keyboard users a dismissal path.
export function bindScoreDismissal(list, doc = document) {
  if (!list) return () => {};
  const opened = () => [...list.querySelectorAll('.wire-score[open]')];
  const outside = event => {
    for (const panel of opened()) {
      if (!panel.contains(event.target)) panel.open = false;
    }
  };
  const keydown = event => {
    if (event.key !== 'Escape' || doc.querySelector('dialog[open], [aria-modal="true"]')) return;
    const panels = opened();
    if (!panels.length) return;
    const focused = panels.find(panel => panel.contains(doc.activeElement));
    panels.forEach(panel => { panel.open = false; });
    event.preventDefault();
    event.stopPropagation();
    // Do not pull focus away from another control merely because a pointer
    // opened a score earlier. A focused disclosure returns to its summary.
    focused?.querySelector('summary')?.focus({ preventScroll: true });
  };
  doc.addEventListener('click', outside, true);
  doc.addEventListener('focusin', outside, true);
  doc.addEventListener('keydown', keydown, true);
  return () => {
    doc.removeEventListener('click', outside, true);
    doc.removeEventListener('focusin', outside, true);
    doc.removeEventListener('keydown', keydown, true);
  };
}

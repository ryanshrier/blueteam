// Toolbar disclosures share Escape/outside-click behavior and close each other.
export function bindDisclosureDismissal(disclosures, doc = document) {
  const panels = disclosures.filter(Boolean);
  let pointerActivation = null;
  const pointerDown = event => {
    pointerActivation = { id: event.pointerId, target: event.target };
  };
  const pointerEnd = event => {
    if (pointerActivation?.id === event.pointerId) pointerActivation = null;
  };
  const dismissOutside = (event, fromFocus = false) => {
    // Dialogs can return focus to controls inside the disclosure that opened them.
    if (doc.querySelector('dialog[open], [aria-modal="true"]')) return;
    panels.forEach(panel => {
      // Safari may focus a containing main region when a pointer presses a
      // button. Keep its disclosure available until that activation completes.
      const activatingInside = fromFocus && pointerActivation && panel.contains(pointerActivation.target);
      if (panel.open && !panel.contains(event.target) && !activatingInside) panel.open = false;
    });
  };
  const dismissFocus = event => dismissOutside(event, true);
  const dismissClick = event => {
    pointerActivation = null;
    dismissOutside(event);
  };
  const escape = event => {
    pointerActivation = null;
    if (event.key !== 'Escape' || doc.querySelector('dialog[open], [aria-modal="true"]')) return;
    const opened = panels.filter(panel => panel.open);
    if (!opened.length) return;
    opened.forEach(panel => {
      panel.open = false;
      if (panel.contains(doc.activeElement)) panel.querySelector('summary')?.focus({ preventScroll: true });
    });
    event.preventDefault();
    event.stopPropagation();
  };
  doc.addEventListener('pointerdown', pointerDown, true);
  doc.addEventListener('pointerup', pointerEnd, true);
  doc.addEventListener('pointercancel', pointerEnd, true);
  doc.addEventListener('click', dismissClick, true);
  doc.addEventListener('focusin', dismissFocus, true);
  doc.addEventListener('keydown', escape, true);
  return () => {
    pointerActivation = null;
    doc.removeEventListener('pointerdown', pointerDown, true);
    doc.removeEventListener('pointerup', pointerEnd, true);
    doc.removeEventListener('pointercancel', pointerEnd, true);
    doc.removeEventListener('click', dismissClick, true);
    doc.removeEventListener('focusin', dismissFocus, true);
    doc.removeEventListener('keydown', escape, true);
  };
}

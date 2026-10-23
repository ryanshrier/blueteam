// Toolbar disclosures share Escape/outside-click behavior and close each other.
export function bindDisclosureDismissal(disclosures, doc = document) {
  const panels = disclosures.filter(Boolean);
  const dismissOutside = event => {
    // Dialogs can return focus to controls inside the disclosure that opened them.
    if (doc.querySelector('dialog[open], [aria-modal="true"]')) return;
    panels.forEach(panel => { if (panel.open && !panel.contains(event.target)) panel.open = false; });
  };
  const escape = event => {
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
  doc.addEventListener('click', dismissOutside, true);
  doc.addEventListener('focusin', dismissOutside, true);
  doc.addEventListener('keydown', escape, true);
  return () => {
    doc.removeEventListener('click', dismissOutside, true);
    doc.removeEventListener('focusin', dismissOutside, true);
    doc.removeEventListener('keydown', escape, true);
  };
}

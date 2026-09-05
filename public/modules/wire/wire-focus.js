// Preserve the keyboard's place when polling or a row action rebuilds the feed.
const ACTIONS = [
  '[data-mark-read]', '[data-dismiss]', '[data-restore]', '[data-evidence]',
  '[data-summary]', '[data-copy-link]', '[data-copy-cve]', '.wire-item-title',
  '.wire-score summary',
];

export function captureWireFocus(list, activeElement) {
  if (!activeElement || !list?.contains?.(activeElement)) return null;
  const rows = [...list.querySelectorAll('.wire-item')];
  const index = rows.findIndex(row => row === activeElement || row.contains(activeElement));
  if (index < 0) return null;
  const row = rows[index];
  const action = ACTIONS.find(selector => [...row.querySelectorAll(selector)].includes(activeElement));
  return { key: row.dataset.key, index, action, cve: activeElement.dataset?.copyCve };
}

export function restoreWireFocus(list, saved, fallback) {
  if (!saved) return;
  const rows = [...list.querySelectorAll('.wire-item')];
  const row = rows.find(item => item.dataset.key === saved.key);
  let target = row;
  if (row && saved.action) {
    target = [...row.querySelectorAll(saved.action)]
      .find(node => !node.disabled && (!saved.cve || node.dataset?.copyCve === saved.cve)) || row;
  }
  // A hidden/filtered row has no replacement: continue at its successor, or
  // the last remaining row. Empty feeds return to the persistent search field.
  target ||= rows[Math.min(saved.index, rows.length - 1)] || fallback;
  target?.focus?.({ preventScroll: true });
}

// Spend a small share of an existing budget on evidence gaps. This changes
// request order, never the total live-request allowance. A one-slot budget
// remains available to the highest-priority normal candidate.
export function withinInvestigationBudget(items, budget, investigate = item => item?.selectionInvestigation) {
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  if (!limit) return [];
  const ordinary = items.filter(item => !investigate(item));
  const exploratory = items.filter(item => investigate(item));
  const reserved = Math.min(2, Math.floor(limit / 5), exploratory.length);
  const first = ordinary.slice(0, Math.max(0, limit - reserved));
  const second = exploratory.slice(0, Math.min(limit - first.length, reserved || (!ordinary.length ? limit : 0)));
  return [...first, ...second, ...ordinary.slice(first.length), ...exploratory.slice(second.length)].slice(0, limit);
}

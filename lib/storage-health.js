// Process-local results of real persistence operations. A readable database is
// not proof that evidence, archives, or settings were saved successfully.
const areas = new Map();

export function recordStorageOutcome(scope, error = null) {
  const outcome = { status: error ? 'error' : 'ok', checkedAt: new Date().toISOString() };
  if (error) outcome.errorCode = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'STORAGE_ERROR';
  areas.set(scope, outcome);
}

export function getStorageHealth() {
  return {
    status: [...areas.values()].some(area => area.status === 'error') ? 'error' : 'ok',
    areas: Object.fromEntries([...areas].map(([scope, outcome]) => [scope, { ...outcome }])),
  };
}

export function resetStorageHealth() { areas.clear(); }

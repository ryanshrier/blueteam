export const FIXTURE_CASES = Object.freeze([
  { id: 'kev-one', label: 'KEV · one long row', surface: 'wall' },
  { id: 'kev-missing', label: 'KEV · missing fields', surface: 'wall' },
  { id: 'wall-loading', label: 'Wall · loading', surface: 'wall' },
  { id: 'wall-stale', label: 'Wall · stale', surface: 'wall' },
  { id: 'wire-loading', label: 'Wire · loading', surface: 'operator' },
  { id: 'brief-error', label: 'Briefing · error', surface: 'operator' },
  { id: 'brief-empty', label: 'Briefing · empty', surface: 'operator' },
]);

function localDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysBefore(now, days) {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return localDateOnly(date);
}

export function buildFixtureData(now = new Date()) {
  const longRecord = {
    cve: 'CVE-2026-123456',
    vendor: 'Example Industrial Controls International',
    product: 'Remote Operations Management and Supervisory Control Gateway Enterprise Edition',
    name: 'Improper neutralization of special elements used in an operating system command vulnerability',
    dateAdded: daysBefore(now, 0),
  };

  return {
    'kev-one': {
      added7d: 1,
      added24h: 1,
      recent: [longRecord],
    },
    'kev-missing': {
      added7d: 0,
      added24h: 0,
      recent: [{ cve: '', vendor: '', product: '', name: '', dateAdded: '' }],
    },
    'wall-stale': {
      added7d: 1,
      added24h: 0,
      recent: [{ ...longRecord, dateAdded: daysBefore(now, 2) }],
    },
  };
}

// Settings form rules and in-memory drafts. No storage API is used: secrets and
// unsaved operator text survive route changes only within this open application.
const clone = value => value == null ? value : structuredClone(value);
export function createSettingsDrafts() {
  const drafts = new Map();
  return {
    get: section => clone(drafts.get(section) ?? null),
    set: (section, value) => value == null ? drafts.delete(section) : drafts.set(section, clone(value)),
    clearIf(section, submitted) {
      if (JSON.stringify(drafts.get(section)) === JSON.stringify(submitted)) drafts.delete(section);
    },
  };
}

export const PROFILE_LIMITS = {
  technologies: { count: 25, length: 64 }, sectors: { count: 20, length: 128 },
  regions: { count: 100, length: 128 }, intelligenceQuestions: { count: 100, length: 300 },
  exclusions: { count: 25, length: 64 },
};
export const lines = value => String(value || '').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
export function profileErrors(profile) {
  const errors = {};
  for (const [field, { count, length }] of Object.entries(PROFILE_LIMITS)) {
    const values = lines(profile[field]);
    if (values.length > count) errors[field] = `Use up to ${count} entries, one per line.`;
    else if (values.some(value => value.length > length)) errors[field] = `Keep each entry to ${length} characters or fewer.`;
  }
  if (String(profile.teamProfile || '').length > 512) errors.teamProfile = 'Use 512 characters or fewer.';
  return errors;
}

export function validTimezone(value) {
  if (value === 'local') return true;
  if (!value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
export function scheduleErrors(schedule) {
  const errors = {};
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) errors.time = 'Choose a time from 00:00 to 23:59.';
  if (!validTimezone(schedule.timezone)) errors.timezone = 'Choose a timezone from the suggestions, or enter a valid IANA name.';
  if (!['skip', 'catch-up'].includes(schedule.missedRun)) errors.missedRun = 'Choose a missed-run policy.';
  if (!Number.isInteger(Number(schedule.retryMinutes)) || Number(schedule.retryMinutes) < 1 || Number(schedule.retryMinutes) > 1440) errors.retryMinutes = 'Use a whole number from 1 to 1440 minutes.';
  if (!Number.isInteger(Number(schedule.maxAttempts)) || Number(schedule.maxAttempts) < 1 || Number(schedule.maxAttempts) > 10) errors.maxAttempts = 'Use a whole number from 1 to 10 attempts.';
  return errors;
}
export function timezoneOptions() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers get the common zones */ }
  return [...new Set(['local', 'UTC', Intl.DateTimeFormat().resolvedOptions().timeZone,
    'America/Chicago', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', ...zones])].filter(Boolean);
}
export function nextRunLabel(value, timezone) {
  const at = new Date(value);
  if (!value || !Number.isFinite(at.getTime())) return '';
  const zone = timezone && timezone !== 'local' && validTimezone(timezone) ? timezone : 'UTC';
  const display = at.toLocaleString('en-US', { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${display} · ${zone}${timezone === 'local' ? ' (schedule uses server local time)' : ''}`;
}
export function settingsLoadFailure(error, restricted = false) {
  return restricted || [401, 403].includes(error?.status) || /\b(?:401|403)\b/.test(error?.message || '')
    ? 'Operator access required. Open the local operator connection or authenticate, then retry.'
    : 'Settings could not be loaded. Check the server connection and retry; your draft is retained.';
}

import { describe, expect, test } from '@jest/globals';
import { createSettingsDrafts, PROFILE_LIMITS, profileErrors, scheduleErrors, timezoneOptions, nextRunLabel, settingsLoadFailure } from '../public/modules/settings/form-state.js';
import { WATCH_PROFILE_LIMITS } from '../lib/watch-profile.js';

describe('Settings draft ownership', () => {
  test('drafts survive route consumers, cannot be mutated by a reader, and late saves preserve newer edits', () => {
    const drafts = createSettingsDrafts();
    const submitted = { technologies: 'first' };
    drafts.set('profile', submitted);
    const reopened = drafts.get('profile');
    reopened.technologies = 'changed externally';
    expect(drafts.get('profile')).toEqual(submitted);
    drafts.set('profile', { technologies: 'newer edit' });
    drafts.clearIf('profile', submitted);
    expect(drafts.get('profile')).toEqual({ technologies: 'newer edit' });
    drafts.clearIf('profile', { technologies: 'newer edit' });
    expect(drafts.get('profile')).toBeNull();
  });
});

describe('Settings validation and timing', () => {
  test('profile field limits match the server contract and identify each violating field', () => {
    expect(PROFILE_LIMITS).toEqual(WATCH_PROFILE_LIMITS);
    expect(profileErrors({ technologies: 'valid', sectors: 'a'.repeat(129), exclusions: Array.from({ length: 26 }, (_, i) => `topic ${i}`).join('\n'), teamProfile: 'a'.repeat(513) }))
      .toEqual({ sectors: 'Keep each entry to 128 characters or fewer.', exclusions: 'Use up to 25 entries, one per line.', teamProfile: 'Use 512 characters or fewer.' });
  });
  test('schedule validation includes time, zone, and integer boundaries', () => {
    const saved = { time: '05:00', timezone: 'America/Chicago', missedRun: 'skip', retryMinutes: '15', maxAttempts: '3' };
    expect(scheduleErrors(saved)).toEqual({});
    expect(Object.keys(scheduleErrors({ ...saved, time: '25:00', timezone: 'Chicago/not-a-zone', retryMinutes: '0', maxAttempts: '2.5' }))).toEqual(['time', 'timezone', 'retryMinutes', 'maxAttempts']);
    expect(timezoneOptions()).toEqual(expect.arrayContaining(['local', 'UTC', 'America/Chicago']));
  });
  test('next run is formatted in the configured zone; server local is never mistaken for viewer local', () => {
    expect(nextRunLabel('2026-09-06T10:00:00Z', 'America/Chicago')).toMatch(/05:00 · America\/Chicago/);
    expect(nextRunLabel('2026-09-06T10:00:00Z', 'local')).toMatch(/10:00 · UTC \(schedule uses server local time\)/);
    expect(nextRunLabel('bad date', 'local')).toBe('');
  });
  test('service failures and restricted responses give different recovery advice', () => {
    expect(settingsLoadFailure(new Error('Request failed (/api/settings): 503'))).toMatch(/server connection/);
    expect(settingsLoadFailure(new Error('Request failed (/api/settings): 403'))).toMatch(/Operator access required/);
    expect(settingsLoadFailure(null, true)).toMatch(/authenticate/);
  });
});

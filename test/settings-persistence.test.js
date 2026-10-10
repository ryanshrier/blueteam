import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUserSettings, getUserSettings, getUserSettingsStatus, saveUserSettings, getBriefScheduleSettings } from '../lib/user-settings.js';
import { getStorageHealth, resetStorageHealth } from '../lib/storage-health.js';
let directory;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'settings-validation-')); resetStorageHealth(); loadUserSettings(directory); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); resetStorageHealth(); });

test.each([
  { openaiKey: 42 }, { watchTerms: 'one' }, { watchProfile: { technologies: [42] } },
  { briefSchedule: { enabled: true, time: 'bad-time' } },
  { briefSchedule: { enabled: true, timezone: 'Not/A-Timezone' } },
  { briefSchedule: { enabled: 'yes' } }, { briefSchedule: { enabled: true, retryMinutes: 0 } },
])('invalid saved fields preserve last good data and disable unattended generation: %j', invalid => {
  saveUserSettings(directory, { watchTerms: ['Synthetic'], briefSchedule: { enabled: true, time: '06:30' } });
  const path = join(directory, 'settings.local.json');
  const contents = JSON.stringify(invalid);
  writeFileSync(path, contents);
  loadUserSettings(directory);
  expect(getUserSettingsStatus()).toMatchObject({ status: 'error', errorCode: 'INVALID_SETTINGS', usingLastGood: true });
  expect(getUserSettings().watchTerms).toEqual(['Synthetic']);
  expect(getBriefScheduleSettings().enabled).toBe(false);
  expect(() => saveUserSettings(directory, { watchTerms: [] })).toThrow(/Restore valid/);
  expect(readFileSync(path, 'utf8')).toBe(contents);
  writeFileSync(path, JSON.stringify({ briefSchedule: { enabled: true, time: '07:00' } }));
  loadUserSettings(directory);
  expect(getBriefScheduleSettings()).toMatchObject({ enabled: true, time: '07:00' });
  expect(getUserSettingsStatus().status).toBe('ok');
});

test('a write failure stays visible through rereads, and a successful retry clears it', () => {
  saveUserSettings(directory, { watchTerms: ['Original'] });
  const temporary = join(directory, 'settings.local.json.tmp');
  mkdirSync(temporary);
  expect(() => saveUserSettings(directory, { watchTerms: ['Changed'] })).toThrow();
  expect(getUserSettingsStatus()).toMatchObject({ status: 'error', operation: 'write' });
  expect(getStorageHealth().areas.settings.status).toBe('error');
  loadUserSettings(directory);
  expect(getUserSettingsStatus().status).toBe('error');
  expect(getUserSettings().watchTerms).toEqual(['Original']);
  rmSync(temporary, { recursive: true });
  saveUserSettings(directory, { watchTerms: ['Changed'] });
  expect(getUserSettingsStatus().status).toBe('ok');
  expect(getStorageHealth().areas.settings.status).toBe('ok');
});

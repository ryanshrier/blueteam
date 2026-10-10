// BlueTeam.News — operator settings and provider credentials.
// Persisted to data/settings.local.json, which is gitignored. The key is stored
// in plaintext on the local disk, exactly like .env — acceptable for a
// self-hosted, loopback-bound, single-operator deploy. It is never logged and
// never returned raw over the API (the route masks it).

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { sanitizeWatchProfile, validateWatchProfile, getEffectiveWatchProfile as resolveWatchProfile } from './watch-profile.js';
import { log } from './logger.js';
import { recordStorageOutcome } from './storage-health.js';

const FILE = 'settings.local.json';
let cache = null;
let cachePath = null;
let hasLastGood = false;
let settingsStatus = { status: 'missing', usingLastGood: false };
const LOAD_ERROR_MESSAGE = 'Saved settings could not be read. Restore valid settings.local.json and retry; the existing file has been preserved.';

export function getUserSettingsStatus() {
  return { ...settingsStatus };
}

function filePath(dataDir) {
  return join(dataDir, FILE);
}

// Operator watch-terms are LITERAL keywords (never regex — scoring.js escapes
// them before they reach a RegExp). Normalize defensively at the persistence
// boundary: keep only strings, strip control chars, trim, drop empties, bound
// each to 64 chars, dedupe case-insensitively, cap the list at 25. The route
// rejects a malformed POST outright; this is the last-line guard so a
// hand-edited settings.local.json can never inject an over-long or unbounded
// list into scoring.
export const MAX_WATCH_TERMS = 25;
export const MAX_TERM_LEN = 64;

// Drop C0 + DEL control characters (codepoint-filtered rather than a control-char
// regex literal — the same guard the settings route applies before validation).
export function stripControl(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c > 0x1f && c !== 0x7f) out += ch;
  }
  return out;
}

function sanitizeWatchTerms(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    // Strip control chars, then trim (a whitespace-only term collapses to '' and
    // is dropped rather than surviving as blank).
    const term = stripControl(raw).trim();
    if (!term) continue;
    const clipped = term.slice(0, MAX_TERM_LEN);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= MAX_WATCH_TERMS) break;
  }
  return out;
}

export const MAX_ORG_SECTOR_LEN = 120;
export const MAX_ORG_PROFILE_LEN = 500;
export const MAX_ORG_REGIONS = 20;
export const MAX_ORG_REGION_LEN = 80;

// Scheduled briefings are intentionally opt-in. Older settings files do not
// contain this block, so merging them over this disabled default is the
// migration: adding an API key never starts an unattended, billable job.
export const DEFAULT_BRIEF_SCHEDULE = Object.freeze({
  enabled: false,
  time: '05:00',
  timezone: 'local',
  missedRun: 'skip',
  retryMinutes: 15,
  maxAttempts: 3,
});

export const MIN_BRIEF_RETRY_MINUTES = 1;
export const MAX_BRIEF_RETRY_MINUTES = 24 * 60;
export const MIN_BRIEF_ATTEMPTS = 1;
export const MAX_BRIEF_ATTEMPTS = 10;

export function isValidTimeZone(value) {
  if (value === 'local') return true;
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function sanitizeBriefSchedule(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...DEFAULT_BRIEF_SCHEDULE };
  if (typeof source.enabled === 'boolean') out.enabled = source.enabled;
  if (typeof source.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(source.time)) {
    out.time = source.time;
  }
  if (isValidTimeZone(source.timezone)) out.timezone = source.timezone;
  if (source.missedRun === 'skip' || source.missedRun === 'catch-up') {
    out.missedRun = source.missedRun;
  }
  if (
    Number.isInteger(source.retryMinutes)
    && source.retryMinutes >= MIN_BRIEF_RETRY_MINUTES
    && source.retryMinutes <= MAX_BRIEF_RETRY_MINUTES
  ) {
    out.retryMinutes = source.retryMinutes;
  }
  if (
    Number.isInteger(source.maxAttempts)
    && source.maxAttempts >= MIN_BRIEF_ATTEMPTS
    && source.maxAttempts <= MAX_BRIEF_ATTEMPTS
  ) {
    out.maxAttempts = source.maxAttempts;
  }
  return out;
}

export function getBriefScheduleSettings(settings = getUserSettings()) {
  const schedule = sanitizeBriefSchedule(settings?.briefSchedule);
  // A retained last-good profile remains useful for reading, but an invalid
  // persisted schedule must not start unattended, billable work.
  if (settings === cache && settingsStatus.status === 'error' && settingsStatus.operation === 'read') schedule.enabled = false;
  return schedule;
}

// The Organization Profile card overrides config.json's `organization.{sector,
// profile,regions}` per-field — a blank field falls back to the config.json
// default rather than persisting an empty override (see getEffectiveOrganization).
// Legacy organization writes set sector/profile/regions. The unified profile
// also exposes the former config-only watchTopics as intelligence questions.
function sanitizeOrganization(obj) {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (typeof obj.sector === 'string') {
      const v = stripControl(obj.sector).trim().slice(0, MAX_ORG_SECTOR_LEN);
      if (v) out.sector = v;
    }
    if (typeof obj.profile === 'string') {
      const v = stripControl(obj.profile).trim().slice(0, MAX_ORG_PROFILE_LEN);
      if (v) out.profile = v;
    }
    if (Array.isArray(obj.regions)) {
      const v = [];
      const seen = new Set();
      for (const raw of obj.regions) {
        if (typeof raw !== 'string') continue;
        const region = stripControl(raw).trim().slice(0, MAX_ORG_REGION_LEN);
        if (!region) continue;
        const key = region.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        v.push(region);
        if (v.length >= MAX_ORG_REGIONS) break;
      }
      if (v.length) out.regions = v;
    }
  }
  // undefined (not {}) when nothing survives, so a full clear removes the key
  // entirely on the next save rather than persisting an empty override object.
  return Object.keys(out).length ? out : undefined;
}

// Only ever persist fields we recognize, and only well-formed values.
function sanitize(obj) {
  const out = {};
  for (const field of ['anthropicKey', 'openaiKey']) {
    const value = typeof obj?.[field] === 'string' ? obj[field].trim() : '';
    if (value && !apiKeyError(field, value)) out[field] = value;
  }
  if (['anthropic', 'openai', 'custom'].includes(obj?.aiProvider)) out.aiProvider = obj.aiProvider;
  if (typeof obj?.openaiModel === 'string' && validOpenaiModel(obj.openaiModel.trim())) out.openaiModel = obj.openaiModel.trim();
  if (obj?.watchTerms !== undefined) {
    out.watchTerms = sanitizeWatchTerms(obj.watchTerms);
  }
  if (obj?.organization !== undefined) {
    out.organization = sanitizeOrganization(obj.organization);
  }
  if (obj?.watchProfile !== undefined) {
    out.watchProfile = sanitizeWatchProfile(obj.watchProfile);
  }
  if (obj?.briefSchedule !== undefined) {
    out.briefSchedule = sanitizeBriefSchedule(obj.briefSchedule);
  }
  return out;
}

export const MAX_API_KEY_BYTES = 512;

export function apiKeyError(field, value) {
  if (typeof value !== 'string') return `${field} must be a string.`;
  if (Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) return `${field} must be ${MAX_API_KEY_BYTES} bytes or fewer.`;
  const key = value.trim();
  if (!key) return null;
  if (field === 'anthropicKey' ? !/^sk-ant-[A-Za-z0-9_-]+$/.test(key)
    : !/^sk-(?!ant-)[A-Za-z0-9_-]+$/.test(key)) {
    return field === 'anthropicKey'
      ? 'That doesn’t look like an Anthropic key (expected sk-ant-…).'
      : 'That doesn’t look like an OpenAI API key (expected sk-…).';
  }
  return null;
}

export function validOpenaiModel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validatePersistedSettings(value) {
  const invalid = () => { throw Object.assign(new Error('Invalid saved settings'), { code: 'INVALID_SETTINGS' }); };
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const strings = (items, count, length) => Array.isArray(items) && items.length <= count
    && items.every(item => typeof item === 'string' && item.length <= length);
  if (!object(value)) invalid();
  const allowed = new Set(['anthropicKey', 'openaiKey', 'aiProvider', 'openaiModel', 'watchTerms', 'organization', 'watchProfile', 'briefSchedule']);
  if (Object.keys(value).some(key => !allowed.has(key))) invalid();
  for (const field of ['anthropicKey', 'openaiKey']) {
    if (Object.hasOwn(value, field) && apiKeyError(field, value[field])) invalid();
  }
  if (Object.hasOwn(value, 'aiProvider') && !['anthropic', 'openai', 'custom'].includes(value.aiProvider)) invalid();
  if (Object.hasOwn(value, 'openaiModel') && !validOpenaiModel(value.openaiModel)) invalid();
  if (Object.hasOwn(value, 'watchTerms') && !strings(value.watchTerms, MAX_WATCH_TERMS, MAX_TERM_LEN)) invalid();
  if (Object.hasOwn(value, 'watchProfile') && validateWatchProfile(value.watchProfile).error) invalid();
  if (Object.hasOwn(value, 'organization')) {
    const org = value.organization;
    if (!object(org)) invalid();
    if (Object.hasOwn(org, 'sector') && (typeof org.sector !== 'string' || org.sector.length > MAX_ORG_SECTOR_LEN)) invalid();
    if (Object.hasOwn(org, 'profile') && (typeof org.profile !== 'string' || org.profile.length > MAX_ORG_PROFILE_LEN)) invalid();
    if (Object.hasOwn(org, 'regions') && !strings(org.regions, MAX_ORG_REGIONS, MAX_ORG_REGION_LEN)) invalid();
  }
  if (Object.hasOwn(value, 'briefSchedule')) {
    const schedule = value.briefSchedule;
    if (!object(schedule)) invalid();
    if (Object.keys(schedule).some(key => !Object.hasOwn(DEFAULT_BRIEF_SCHEDULE, key))) invalid();
    if (Object.hasOwn(schedule, 'enabled') && typeof schedule.enabled !== 'boolean') invalid();
    if (Object.hasOwn(schedule, 'time') && (typeof schedule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))) invalid();
    if (Object.hasOwn(schedule, 'timezone') && !isValidTimeZone(schedule.timezone)) invalid();
    if (Object.hasOwn(schedule, 'missedRun') && !['skip', 'catch-up'].includes(schedule.missedRun)) invalid();
    for (const [key, min, max] of [['retryMinutes', MIN_BRIEF_RETRY_MINUTES, MAX_BRIEF_RETRY_MINUTES], ['maxAttempts', MIN_BRIEF_ATTEMPTS, MAX_BRIEF_ATTEMPTS]]) {
      if (Object.hasOwn(schedule, key) && (!Number.isInteger(schedule[key]) || schedule[key] < min || schedule[key] > max)) invalid();
    }
  }
}

// Merge the operator's saved organization overrides (sector/profile/regions)
// over config.json's `organization` block — a field the operator never set (or
// cleared back to blank) falls back to the config.json default. The canonical
// watch profile projects its explicit overrides into this compatibility view.
export function getEffectiveOrganization(config) {
  const base = config?.organization || {};
  const override = getUserSettings().organization || {};
  const effective = {
    ...base,
    ...(override.sector ? { sector: override.sector } : {}),
    ...(override.profile ? { profile: override.profile } : {}),
    ...(override.regions?.length ? { regions: override.regions } : {}),
  };
  // The legacy view remains available to API clients and existing prompt code.
  // Only explicitly unified fields replace the legacy fallback semantics.
  const unified = { ...sanitizeWatchProfile(config?.watchProfile), ...sanitizeWatchProfile(getUserSettings().watchProfile) };
  const profile = getEffectiveWatchProfile(config);
  if (Object.hasOwn(unified, 'sectors')) effective.sector = profile.sectors.join(', ');
  if (Object.hasOwn(unified, 'regions')) effective.regions = profile.regions;
  if (Object.hasOwn(unified, 'teamProfile')) effective.profile = profile.teamProfile;
  if (Object.hasOwn(unified, 'intelligenceQuestions')) effective.watchTopics = profile.intelligenceQuestions;
  return effective;
}

export function getEffectiveWatchProfile(config) {
  return resolveWatchProfile(config, getUserSettings());
}

export function loadUserSettings(dataDir) {
  const target = resolve(filePath(dataDir));
  if (cachePath !== target) {
    cache = {};
    cachePath = target;
    hasLastGood = false;
    settingsStatus = { status: 'missing', usingLastGood: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('Settings must be an object');
    validatePersistedSettings(parsed);
    cache = sanitize(parsed);
    hasLastGood = true;
    // Reading a file does not prove that a previous failed write is repaired.
    if (settingsStatus.operation !== 'write') {
      settingsStatus = { status: 'ok', usingLastGood: false };
      recordStorageOutcome('settings');
    }
  } catch (err) {
    if (err.code === 'ENOENT' && !hasLastGood && settingsStatus.status !== 'error') {
      cache = {};
      settingsStatus = { status: 'missing', usingLastGood: false };
    } else {
      // Never log JSON parser messages: they can include fragments of an API
      // key. Retain the last good state for this directory and block saves.
      const errorCode = err instanceof SyntaxError ? 'INVALID_JSON' : /^[A-Z_]+$/.test(err.code || '') ? err.code : 'READ_FAILED';
      if (settingsStatus.errorCode !== errorCode) log.error('settings', `${LOAD_ERROR_MESSAGE} (${errorCode})`);
      settingsStatus = { status: 'error', operation: 'read', usingLastGood: hasLastGood, errorCode, message: LOAD_ERROR_MESSAGE };
      recordStorageOutcome('settings', err);
    }
  }
  return cache;
}

export function getUserSettings() {
  return cache || {};
}

export function saveUserSettings(dataDir, patch) {
  // Recheck the current file before any merge. This also permits recovery by
  // restoring a valid file, and incorporates legitimate edits made on disk.
  loadUserSettings(dataDir);
  if (settingsStatus.status === 'error' && settingsStatus.operation !== 'write') {
    const error = new Error(LOAD_ERROR_MESSAGE);
    error.code = 'E_SETTINGS_LOAD';
    throw error;
  }
  const merged = { ...(cache || {}), ...patch };
  if (patch.watchProfile !== undefined) {
    merged.watchProfile = { ...(cache?.watchProfile || {}), ...sanitizeWatchProfile(patch.watchProfile) };
  } else if (cache?.watchProfile) {
    // Older API clients can still update overlapping fields after migration.
    // Preserve all other unified fields and the original legacy values on disk.
    merged.watchProfile = { ...cache.watchProfile };
    if (Object.hasOwn(patch, 'watchTerms')) merged.watchProfile.technologies = sanitizeWatchTerms(patch.watchTerms);
    if (Object.hasOwn(patch, 'organization')) {
      const org = sanitizeOrganization(patch.organization) || {};
      delete merged.watchProfile.sectors;
      delete merged.watchProfile.regions;
      delete merged.watchProfile.teamProfile;
      if (org.sector) merged.watchProfile.sectors = [org.sector];
      if (org.regions) merged.watchProfile.regions = org.regions;
      if (org.profile) merged.watchProfile.teamProfile = org.profile;
    }
  }
  const next = sanitize(merged);
  const target = filePath(dataDir);
  const temp = `${target}.tmp`;
  // Same-directory temp + rename keeps a crash from truncating the only saved
  // key/settings copy. Tighten an existing file too; `mode` alone only applies
  // when writeFile creates a new file.
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* Windows/no chmod support */ }
  } catch (err) {
    try { unlinkSync(temp); } catch { /* absent or locked */ }
    settingsStatus = { status: 'error', operation: 'write', usingLastGood: hasLastGood,
      errorCode: /^[A-Z_]+$/.test(err.code || '') ? err.code : 'WRITE_FAILED',
      message: 'Settings could not be saved. Check state-directory permissions and available disk space, then retry.' };
    recordStorageOutcome('settings', err);
    throw err;
  }
  cache = next;
  hasLastGood = true;
  settingsStatus = { status: 'ok', usingLastGood: false };
  recordStorageOutcome('settings');
  return cache;
}

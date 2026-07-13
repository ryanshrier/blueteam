// BlueTeam.News — operator-set runtime settings (Anthropic key, watch terms,
// organization profile overrides).
// Persisted to data/settings.local.json, which is gitignored. The key is stored
// in plaintext on the local disk, exactly like .env — acceptable for a
// self-hosted, loopback-bound, single-operator deploy. It is never logged and
// never returned raw over the API (the route masks it).

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const FILE = 'settings.local.json';
let cache = null;

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

// The Organization Profile card overrides config.json's `organization.{sector,
// profile,regions}` per-field — a blank field falls back to the config.json
// default rather than persisting an empty override (see getEffectiveOrganization).
// Only sector/profile/regions are operator-settable; audience/watchTopics stay
// config.json-only (not exposed in the Settings UI).
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
  if (typeof obj?.anthropicKey === 'string' && obj.anthropicKey.startsWith('sk-ant-')) {
    out.anthropicKey = obj.anthropicKey.trim();
  }
  if (obj?.watchTerms !== undefined) {
    out.watchTerms = sanitizeWatchTerms(obj.watchTerms);
  }
  if (obj?.organization !== undefined) {
    out.organization = sanitizeOrganization(obj.organization);
  }
  return out;
}

// Merge the operator's saved organization overrides (sector/profile/regions)
// over config.json's `organization` block — a field the operator never set (or
// cleared back to blank) falls back to the config.json default. audience and
// watchTopics are always config.json's, since they aren't operator-editable.
export function getEffectiveOrganization(config) {
  const base = config?.organization || {};
  const override = getUserSettings().organization || {};
  return {
    ...base,
    ...(override.sector ? { sector: override.sector } : {}),
    ...(override.profile ? { profile: override.profile } : {}),
    ...(override.regions?.length ? { regions: override.regions } : {}),
  };
}

export function loadUserSettings(dataDir) {
  try {
    cache = sanitize(JSON.parse(readFileSync(filePath(dataDir), 'utf-8')));
  } catch {
    cache = {};
  }
  return cache;
}

export function getUserSettings() {
  return cache || {};
}

export function saveUserSettings(dataDir, patch) {
  const next = sanitize({ ...(cache || {}), ...patch });
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
    throw err;
  }
  cache = next;
  return cache;
}

// BlueTeam.News — runtime settings route: the operator's Anthropic API key.
// GET reports key presence (masked, never raw). POST sets or clears it,
// persists to data/settings.local.json, and rebuilds the live Anthropic client
// so the Briefing turns on without a server restart.

import { Router } from 'express';
import {
  saveUserSettings, getUserSettings, stripControl, MAX_WATCH_TERMS, MAX_TERM_LEN,
  MAX_ORG_SECTOR_LEN, MAX_ORG_PROFILE_LEN, MAX_ORG_REGIONS, MAX_ORG_REGION_LEN,
  getBriefScheduleSettings, isValidTimeZone,
  MIN_BRIEF_RETRY_MINUTES, MAX_BRIEF_RETRY_MINUTES,
  MIN_BRIEF_ATTEMPTS, MAX_BRIEF_ATTEMPTS,
} from '../lib/user-settings.js';
import { log } from '../lib/logger.js';

// Anthropic keys are currently far smaller than this. Keep enough headroom for
// future formats while bounding request-driven allocation, persistence, and
// provider-client construction if a trusted browser/API client malfunctions.
export const MAX_ANTHROPIC_KEY_BYTES = 512;

function anthropicKeyTooLarge(value) {
  return value.length > MAX_ANTHROPIC_KEY_BYTES
    || Buffer.byteLength(value, 'utf8') > MAX_ANTHROPIC_KEY_BYTES;
}

function keySizeError(res, verification = false) {
  const payload = {
    error: `anthropicKey must be ${MAX_ANTHROPIC_KEY_BYTES} bytes or fewer.`,
    code: 'E_KEYFMT',
  };
  if (verification) payload.valid = false;
  return res.status(400).json(payload);
}

// Watch-term validation (mirrors the persistence-layer sanitize in
// user-settings.js — same limits and control-char guard, imported from there so
// the two can't drift). We reject the WHOLE request on any structural violation
// (rather than silently dropping bad entries) so the operator gets an honest
// error instead of a surprise on the next refresh. These are LITERAL keywords —
// never regex; scoring.js escapes them before they reach a RegExp.

// Validate + normalize a watchTerms array from the request body. Returns
// `{ terms }` on success or `{ error }` (a plain message) on violation. Empties
// are dropped and the list deduped case-insensitively; anything else that fails
// the shape (non-array, wrong type, over-length, too many) rejects the request.
function validateWatchTerms(input) {
  if (!Array.isArray(input)) return { error: 'watchTerms must be an array of keywords.' };
  if (input.length > MAX_WATCH_TERMS) return { error: `Too many watch-terms (max ${MAX_WATCH_TERMS}).` };
  const terms = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') return { error: 'Each watch-term must be a string.' };
    const term = stripControl(raw).trim();
    if (!term) continue; // drop empties/whitespace-only rather than reject
    if (term.length > MAX_TERM_LEN) return { error: `Watch-terms must be ${MAX_TERM_LEN} characters or fewer.` };
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return { terms };
}

// Validate an organization-profile patch. Each field is optional (the operator
// may set just one), but a present field must be well-formed — reject the whole
// request on a bad shape rather than silently dropping it, same as watchTerms.
function validateOrganization(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'organization must be an object.' };
  }
  if (input.sector !== undefined) {
    if (typeof input.sector !== 'string') return { error: 'organization.sector must be a string.' };
    if (input.sector.length > MAX_ORG_SECTOR_LEN) return { error: `organization.sector must be ${MAX_ORG_SECTOR_LEN} characters or fewer.` };
  }
  if (input.profile !== undefined) {
    if (typeof input.profile !== 'string') return { error: 'organization.profile must be a string.' };
    if (input.profile.length > MAX_ORG_PROFILE_LEN) return { error: `organization.profile must be ${MAX_ORG_PROFILE_LEN} characters or fewer.` };
  }
  const organization = { ...input };
  if (input.regions !== undefined) {
    if (!Array.isArray(input.regions) || input.regions.some(r => typeof r !== 'string')) {
      return { error: 'organization.regions must be an array of strings.' };
    }
    if (input.regions.length > MAX_ORG_REGIONS) return { error: `organization.regions must be ${MAX_ORG_REGIONS} entries or fewer.` };
    const regions = [];
    const seen = new Set();
    for (const raw of input.regions) {
      const region = stripControl(raw).trim();
      if (!region) continue;
      if (region.length > MAX_ORG_REGION_LEN) {
        return { error: `Each organization region must be ${MAX_ORG_REGION_LEN} characters or fewer.` };
      }
      const key = region.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      regions.push(region);
    }
    organization.regions = regions;
  }
  return { organization };
}

function validateBriefSchedule(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'briefSchedule must be an object.' };
  }
  const allowed = new Set(['enabled', 'time', 'timezone', 'missedRun', 'retryMinutes', 'maxAttempts']);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) return { error: `Unknown briefSchedule field: ${unknown}.` };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return { error: 'briefSchedule.enabled must be a boolean.' };
  }
  if (input.time !== undefined && (
    typeof input.time !== 'string'
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)
  )) {
    return { error: 'briefSchedule.time must use 24-hour HH:MM format.' };
  }
  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
    return { error: 'briefSchedule.timezone must be "local" or a valid IANA timezone.' };
  }
  if (input.missedRun !== undefined && !['skip', 'catch-up'].includes(input.missedRun)) {
    return { error: 'briefSchedule.missedRun must be "skip" or "catch-up".' };
  }
  if (input.retryMinutes !== undefined && (
    !Number.isInteger(input.retryMinutes)
    || input.retryMinutes < MIN_BRIEF_RETRY_MINUTES
    || input.retryMinutes > MAX_BRIEF_RETRY_MINUTES
  )) {
    return { error: `briefSchedule.retryMinutes must be an integer from ${MIN_BRIEF_RETRY_MINUTES} to ${MAX_BRIEF_RETRY_MINUTES}.` };
  }
  if (input.maxAttempts !== undefined && (
    !Number.isInteger(input.maxAttempts)
    || input.maxAttempts < MIN_BRIEF_ATTEMPTS
    || input.maxAttempts > MAX_BRIEF_ATTEMPTS
  )) {
    return { error: `briefSchedule.maxAttempts must be an integer from ${MIN_BRIEF_ATTEMPTS} to ${MAX_BRIEF_ATTEMPTS}.` };
  }
  return {
    briefSchedule: getBriefScheduleSettings({
      briefSchedule: { ...getBriefScheduleSettings(), ...input },
    }),
  };
}

export function createSettingsRouter({
  dataDir,
  getAiStatus,
  refreshAi,
  verifyKey,
  getAlertRules,
  getOrganization,
  getBriefScheduleStatus,
  onBriefScheduleChanged,
  loopback = true,
}) {
  const router = Router();
  // Authentication is a property of this request, not of the process. A
  // configured API_SECRET must never make every request implicitly trusted.
  const trusted = res => loopback || res.locals.authenticated === true;

  router.get('/settings', (req, res) => {
    const s = getAiStatus();
    const payload = { ai: { enabled: s.enabled, keySource: s.source, keyMasked: s.masked } };
    // Alert rules + saved watch-terms are surfaced ONLY to a trusted caller
    // (loopback or API_SECRET-authed) — an untrusted network client sees just the
    // read-only note, never the operator's configured rules or keywords.
    if (trusted(res)) {
      const rules = (typeof getAlertRules === 'function' ? getAlertRules() : null) || [];
      payload.alertRules = rules.map(r => ({ pattern: String(r.pattern), boost: Number(r.boost) || 0, source: 'config' }));
      payload.watchTerms = Array.isArray(getUserSettings().watchTerms) ? [...getUserSettings().watchTerms] : [];
      payload.organization = typeof getOrganization === 'function' ? getOrganization() : {};
      payload.briefSchedule = getBriefScheduleSettings();
      payload.briefScheduleStatus = typeof getBriefScheduleStatus === 'function'
        ? getBriefScheduleStatus()
        : null;
    }
    res.json(payload);
  });

  // ── POST /settings/verify — one cheap Anthropic call to confirm a key actually
  // works (not just that it's well-formed). Same write-gate as POST /settings since
  // it accepts a key in the body. Returns { valid: true|false|null, error?, note? }.
  router.post('/settings/verify', async (req, res) => {
    if (!trusted(res)) {
      return res.status(403).json({ error: 'Verifying a key over the network requires API_SECRET (or run on loopback).', code: 'E_EXPOSED' });
    }
    if (typeof verifyKey !== 'function') {
      return res.status(501).json({ valid: null, error: 'Verification is not available on this server.' });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'anthropicKey') && typeof req.body.anthropicKey !== 'string') {
      return res.status(400).json({ valid: false, error: 'anthropicKey must be a string.', code: 'E_KEYFMT' });
    }
    if (typeof req.body?.anthropicKey === 'string' && anthropicKeyTooLarge(req.body.anthropicKey)) {
      return keySizeError(res, true);
    }
    try {
      const candidate = typeof req.body?.anthropicKey === 'string' ? req.body.anthropicKey : '';
      res.json(await verifyKey(candidate));
    } catch {
      res.json({ valid: null, error: 'Verification failed unexpectedly.' });
    }
  });

  router.post('/settings', (req, res) => {
    const body = req.body || {};

    // Validate the entire multi-field update before touching disk. A request can
    // carry the key, watch terms, and organization together; processing and
    // persisting them one by one meant a later validation error returned 400
    // after an earlier field had already changed. Build one sanitized patch and
    // persist it once so a rejected request has no side effects.
    const patch = {};
    let keyAction = null;
    let watchTermCount = null;
    let organizationChanged = false;
    let scheduleChanged = false;

    if (Object.prototype.hasOwnProperty.call(body, 'anthropicKey')) {
      // Never let an unauthenticated network client write or clear the key —
      // only loopback, or an API_SECRET-authed request, may change it.
      if (!trusted(res)) {
        return res.status(403).json({
          error: 'Setting the API key over the network requires API_SECRET (or run on loopback).',
          code: 'E_EXPOSED',
        });
      }
      if (typeof body.anthropicKey !== 'string') {
        return res.status(400).json({
          error: 'anthropicKey must be a string.',
          code: 'E_KEYFMT',
        });
      }
      if (anthropicKeyTooLarge(body.anthropicKey)) {
        return keySizeError(res);
      }
      const raw = body.anthropicKey.trim();
      if (raw === '') {
        patch.anthropicKey = undefined;
        keyAction = 'cleared';
      } else if (!raw.startsWith('sk-ant-')) {
        return res.status(400).json({
          error: 'That doesn’t look like an Anthropic key (expected sk-ant-…).',
          code: 'E_KEYFMT',
        });
      } else {
        patch.anthropicKey = raw;
        keyAction = 'updated';
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'watchTerms')) {
      // Same write-gate as the key: watch-terms are operator config, not public
      // input — an untrusted network client must not seed the scoring pipeline.
      if (!trusted(res)) {
        return res.status(403).json({
          error: 'Setting watch-terms over the network requires API_SECRET (or run on loopback).',
          code: 'E_EXPOSED',
        });
      }
      const { terms, error } = validateWatchTerms(body.watchTerms);
      if (error) return res.status(400).json({ error, code: 'E_WATCHTERMS' });
      // Persist the normalized (deduped, trimmed, bounded) literal list. Terms
      // are escaped to literals in scoring.js and apply on the next refresh.
      patch.watchTerms = terms;
      watchTermCount = terms.length;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'organization')) {
      // Same write-gate as watchTerms/anthropicKey — the organization profile
      // shapes the Briefing's Relevance judgment, not public input.
      if (!trusted(res)) {
        return res.status(403).json({
          error: 'Setting the organization profile over the network requires API_SECRET (or run on loopback).',
          code: 'E_EXPOSED',
        });
      }
      const { organization, error } = validateOrganization(body.organization);
      if (error) return res.status(400).json({ error, code: 'E_ORGPROFILE' });
      // A blank field clears that override and falls back to config.json's
      // default (see getEffectiveOrganization) — never merged with the
      // PREVIOUS override, so removing a value in the UI actually removes it.
      patch.organization = organization;
      organizationChanged = true;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'briefSchedule')) {
      if (!trusted(res)) {
        return res.status(403).json({
          error: 'Setting the briefing schedule over the network requires API_SECRET (or run on loopback).',
          code: 'E_EXPOSED',
        });
      }
      const { briefSchedule, error } = validateBriefSchedule(body.briefSchedule);
      if (error) return res.status(400).json({ error, code: 'E_BRIEF_SCHEDULE' });
      patch.briefSchedule = briefSchedule;
      scheduleChanged = true;
    }

    if (Object.keys(patch).length > 0) {
      saveUserSettings(dataDir, patch);
      if (keyAction) refreshAi();
      if (keyAction) log.info('settings', `Operator Anthropic key ${keyAction}`); // never logs key material
      if (watchTermCount !== null) log.info('settings', `Operator watch-terms updated (${watchTermCount})`);
      if (organizationChanged) log.info('settings', 'Operator organization profile updated');
      if (scheduleChanged) log.info('settings', `Daily briefing schedule ${patch.briefSchedule.enabled ? 'enabled' : 'disabled'} (${patch.briefSchedule.time}, ${patch.briefSchedule.timezone})`);
      // A key change may unblock an already-enabled schedule, but it never
      // enables one: the persisted briefSchedule.enabled flag remains the gate.
      if ((scheduleChanged || keyAction) && typeof onBriefScheduleChanged === 'function') {
        try { onBriefScheduleChanged(); } catch (err) {
          log.error('settings', `Rearming daily briefing schedule failed: ${err.message}`);
        }
      }
    }

    const s = getAiStatus();
    const out = { ok: true, ai: { enabled: s.enabled, keySource: s.source, keyMasked: s.masked } };
    // Echo the saved watch-terms/organization back to a trusted caller so the
    // client reflects the server-normalized values without a second GET.
    if (trusted(res)) {
      out.watchTerms = Array.isArray(getUserSettings().watchTerms) ? [...getUserSettings().watchTerms] : [];
      out.organization = typeof getOrganization === 'function' ? getOrganization() : {};
      out.briefSchedule = getBriefScheduleSettings();
      out.briefScheduleStatus = typeof getBriefScheduleStatus === 'function'
        ? getBriefScheduleStatus()
        : null;
    }
    res.json(out);
  });

  return router;
}

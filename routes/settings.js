import { Router } from 'express';
import {
  saveUserSettings, stripControl, MAX_WATCH_TERMS, MAX_TERM_LEN,
  apiKeyError, validOpenaiModel, MAX_API_KEY_BYTES,
  MAX_ORG_SECTOR_LEN, MAX_ORG_PROFILE_LEN, MAX_ORG_REGIONS, MAX_ORG_REGION_LEN,
  getBriefScheduleSettings, isValidTimeZone,
  MIN_BRIEF_RETRY_MINUTES, MAX_BRIEF_RETRY_MINUTES,
  MIN_BRIEF_ATTEMPTS, MAX_BRIEF_ATTEMPTS,
  getEffectiveWatchProfile, getUserSettingsStatus,
} from '../lib/user-settings.js';
import { validateWatchProfile } from '../lib/watch-profile.js';
import { log } from '../lib/logger.js';

export const MAX_ANTHROPIC_KEY_BYTES = MAX_API_KEY_BYTES;

function publicAiStatus(status, trusted) {
  const keyStatus = value => ({ enabled: value.enabled, keySource: value.source, keyMasked: value.masked, model: value.model });
  const payload = { ...keyStatus(status), provider: status.provider };
  if (trusted && status.providers) payload.providers = Object.fromEntries(
    Object.entries(status.providers).map(([provider, value]) => [provider, keyStatus(value)]),
  );
  return payload;
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
  getWatchProfile,
  getBriefScheduleStatus,
  onBriefScheduleChanged,
  loopback = true,
}) {
  const router = Router();
  // Authentication is a property of this request, not of the process. A
  // configured API_SECRET must never make every request implicitly trusted.
  const trusted = res => loopback || res.locals.authenticated === true;
  const effectiveProfile = () => typeof getWatchProfile === 'function'
    ? getWatchProfile()
    : getEffectiveWatchProfile({ organization: typeof getOrganization === 'function' ? getOrganization() : {} });

  router.get('/settings', (req, res) => {
    res.vary('Authorization');
    const s = getAiStatus();
    const payload = { ai: publicAiStatus(s, trusted(res)) };
    // Alert rules + saved watch-terms are surfaced ONLY to a trusted caller
    // (loopback or API_SECRET-authed) — an untrusted network client sees just the
    // read-only note, never the operator's configured rules or keywords.
    if (trusted(res)) {
      res.set('Cache-Control', 'private, no-store');
      payload.storage = getUserSettingsStatus();
      const rules = (typeof getAlertRules === 'function' ? getAlertRules() : null) || [];
      payload.alertRules = rules.map(r => ({ pattern: String(r.pattern), boost: Number(r.boost) || 0, source: 'config' }));
      payload.watchProfile = effectiveProfile();
      payload.watchTerms = [...payload.watchProfile.technologies];
      payload.organization = typeof getOrganization === 'function' ? getOrganization() : {};
      payload.briefSchedule = getBriefScheduleSettings();
      payload.briefScheduleStatus = typeof getBriefScheduleStatus === 'function'
        ? getBriefScheduleStatus()
        : null;
    }
    res.json(payload);
  });

  // POST /settings/verify makes a minimal provider request to confirm a key
  // works (not just that it's well-formed). Same write-gate as POST /settings since
  // it accepts a key in the body. Returns { valid: true|false|null, error?, note? }.
  router.post('/settings/verify', async (req, res) => {
    if (!trusted(res)) {
      return res.status(403).json({ error: 'Verifying a key over the network requires API_SECRET (or run on loopback).', code: 'E_EXPOSED' });
    }
    if (typeof verifyKey !== 'function') {
      return res.status(501).json({ valid: null, error: 'Verification is not available on this server.' });
    }
    const body = req.body || {};
    const provider = body.provider ?? (Object.hasOwn(body, 'openaiKey') ? 'openai' : 'anthropic');
    if (!['anthropic', 'openai'].includes(provider)) return res.status(400).json({ valid: false, error: 'provider must be anthropic or openai.', code: 'E_PROVIDER' });
    const field = provider === 'openai' ? 'openaiKey' : 'anthropicKey';
    const otherField = provider === 'openai' ? 'anthropicKey' : 'openaiKey';
    if (Object.hasOwn(body, otherField)) return res.status(400).json({ valid: false, error: 'Send only the selected provider’s key.', code: 'E_KEYFMT' });
    const candidate = Object.hasOwn(body, field) ? body[field] : '';
    const error = apiKeyError(field, candidate);
    if (error) return res.status(400).json({ valid: false, error, code: 'E_KEYFMT' });
    if (body.openaiModel !== undefined && (provider !== 'openai' || !validOpenaiModel(body.openaiModel))) {
      return res.status(400).json({ valid: false, error: 'openaiModel must be a model ID of 1–128 characters.', code: 'E_MODEL' });
    }
    try {
      res.json(await verifyKey(candidate.trim(), provider, body.openaiModel));
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
    let aiChanged = false;
    let watchTermCount = null;
    let organizationChanged = false;
    let scheduleChanged = false;
    let watchProfileChanged = false;

    if (Object.prototype.hasOwnProperty.call(body, 'watchProfile')) {
      if (!trusted(res)) return res.status(403).json({ error: 'Setting the watch profile over the network requires API_SECRET (or run on loopback).', code: 'E_EXPOSED' });
      // Do not accept two conflicting representations in one atomic update.
      if (Object.hasOwn(body, 'watchTerms') || Object.hasOwn(body, 'organization')) return res.status(400).json({ error: 'Send watchProfile separately from legacy watchTerms or organization fields.', code: 'E_WATCHPROFILE' });
      const { watchProfile, error } = validateWatchProfile(body.watchProfile);
      if (error) return res.status(400).json({ error, code: 'E_WATCHPROFILE' });
      patch.watchProfile = watchProfile;
      watchProfileChanged = true;
    }

    for (const field of ['anthropicKey', 'openaiKey', 'aiProvider', 'openaiModel']) {
      if (!Object.hasOwn(body, field)) continue;
      if (!trusted(res)) return res.status(403).json({ error: 'Changing AI settings over the network requires API_SECRET (or run on loopback).', code: 'E_EXPOSED' });
      if (field.endsWith('Key')) {
        const error = apiKeyError(field, body[field]);
        if (error) return res.status(400).json({ error, code: 'E_KEYFMT' });
        patch[field] = body[field].trim() || undefined;
      } else if (field === 'aiProvider') {
        if (!['anthropic', 'openai'].includes(body[field])) return res.status(400).json({ error: 'aiProvider must be anthropic or openai.', code: 'E_PROVIDER' });
        patch[field] = body[field];
      } else {
        if (typeof body[field] !== 'string' || (body[field].trim() && !validOpenaiModel(body[field].trim()))) return res.status(400).json({ error: 'openaiModel must be a model ID of 1–128 characters, or empty to reset.', code: 'E_MODEL' });
        patch[field] = body[field].trim() || undefined;
      }
      aiChanged = true;
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
      try {
        saveUserSettings(dataDir, patch);
      } catch (err) {
        if (err.code === 'E_SETTINGS_LOAD') {
          return res.status(503).json({ error: err.message, code: err.code, storage: getUserSettingsStatus() });
        }
        throw err;
      }
      if (aiChanged) refreshAi();
      if (aiChanged) log.info('settings', 'Operator AI settings updated');
      if (watchTermCount !== null) log.info('settings', `Operator watch-terms updated (${watchTermCount})`);
      if (organizationChanged) log.info('settings', 'Operator organization profile updated');
      if (watchProfileChanged) log.info('settings', 'Operator watch profile updated');
      if (scheduleChanged) log.info('settings', `Daily briefing schedule ${patch.briefSchedule.enabled ? 'enabled' : 'disabled'} (${patch.briefSchedule.time}, ${patch.briefSchedule.timezone})`);
      // A key change may unblock an already-enabled schedule, but it never
      // enables one: the persisted briefSchedule.enabled flag remains the gate.
      if ((scheduleChanged || aiChanged) && typeof onBriefScheduleChanged === 'function') {
        try { onBriefScheduleChanged(); } catch (err) {
          log.error('settings', `Rearming daily briefing schedule failed: ${err.message}`);
        }
      }
    }

    const s = getAiStatus();
    const out = { ok: true, ai: publicAiStatus(s, trusted(res)) };
    // Echo the saved watch-terms/organization back to a trusted caller so the
    // client reflects the server-normalized values without a second GET.
    if (trusted(res)) {
      out.watchProfile = effectiveProfile();
      out.watchTerms = [...out.watchProfile.technologies];
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

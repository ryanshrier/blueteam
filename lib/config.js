// BlueTeam.News — config management with Zod validation and hot-reload.
// config.json is the single tuning surface: feeds, horizons, alert rules,
// and analysis settings. Invalid startup configuration fails closed; an
// invalid hot reload is rejected while the last-known-good value stays active.

import { z } from 'zod';
import { createHash } from 'crypto';
import { readFileSync, watch } from 'fs';
import { basename, dirname } from 'path';
import { log } from './logger.js';

// ── Schema ──
const HttpUrlSchema = z.string().max(4096).url().refine((value) => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, { message: 'must be an HTTP(S) URL without embedded credentials' });

const FeedSchema = z.object({
  id: z.string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'must contain only letters, numbers, dots, underscores, or hyphens')
    .optional(),
  url: HttpUrlSchema,
  source: z.string().trim().min(1).max(128),
  category: z.string().trim().min(1).max(64).default('general'),
  horizon: z.number().int().min(1).max(3),
  weight: z.number().min(0).max(3).default(1.0),
  deepExtract: z.boolean().default(false),
}).strict().transform((feed) => ({
  ...feed,
  // The operator may supply a human-readable ID. Otherwise derive one from the
  // canonical feed URL so health/history keys survive source-label edits.
  id: (feed.id || `feed-${createHash('sha256').update(new URL(feed.url).toString()).digest('hex').slice(0, 12)}`).toLowerCase(),
}));

const AlertRuleSchema = z.object({
  pattern: z.string().trim().min(1).max(256).refine((pattern) => {
    try {
      new RegExp(pattern, 'i');
      return true;
    } catch {
      return false;
    }
  }, { message: 'must be a valid regular expression' }),
  boost: z.number().min(0).max(20).default(5),
}).strict();

const HorizonSchema = z.object({
  name: z.string().trim().min(1).max(64),
  window: z.string().trim().max(256).default(''),
  question: z.string().trim().max(512).default(''),
}).strict();

const HorizonWeightsSchema = z.object({
  horizon1: z.number().min(0).max(1).default(0.45),
  horizon2: z.number().min(0).max(1).default(0.40),
  horizon3: z.number().min(0).max(1).default(0.15),
}).strict().prefault({});

// Outbound alert webhook. Empty url = DISABLED (the default); nothing is
// ever sent until an operator sets a url. SSRF-guarded at dispatch time.
// `events` chooses what the webhook fires for: alert-rule-matched headlines
// ('alerts'), the finished daily brief's BLUF ('brief'), or both.
const WebhookSchema = z.object({
  url: z.union([z.literal(''), HttpUrlSchema]).default(''),
  format: z.enum(['slack', 'json']).default('slack'),
  events: z.enum(['alerts', 'brief', 'both']).default('alerts'),
}).strict().prefault({});

// The score model: five normalized evidence axes, each weighted; weights are
// normalized to sum 1 at scoring time, so these are RELATIVE emphases, not a
// hard budget. recencyHalfLifeHours sets the continuous recency decay.
const ScoringSchema = z.object({
  recencyHalfLifeHours: z.number().min(1).max(336).default(30),
  axisWeights: z.object({
    recency: z.number().min(0).max(1).default(0.22),
    corroboration: z.number().min(0).max(1).default(0.18),
    exploitation: z.number().min(0).max(1).default(0.28),
    severity: z.number().min(0).max(1).default(0.16),
    relevance: z.number().min(0).max(1).default(0.16),
  }).strict().prefault({}),
}).strict().prefault({});

export const MIN_GENERATION_TIMEOUT_SEC = 30;
export const MAX_GENERATION_TIMEOUT_SEC = 600;

const AnalysisSettingsSchema = z.object({
  model: z.string().trim().min(1).max(128).default('claude-haiku-4-5'),
  preferredModel: z.string().trim().min(1).max(128).default('claude-sonnet-5'),
  maxSignals: z.number().int().min(1).max(10).default(6),
  maxPatterns: z.number().int().min(1).max(10).default(3),
  maxConvergence: z.number().int().min(1).max(5).default(2),
  maxTokens: z.number().int().min(1000).max(32000).default(16000),
  freshnessHours: z.number().min(1).max(168).default(48),
  continuityDepth: z.number().int().min(0).max(10).default(5),
  refreshMinutes: z.number().min(2).max(120).default(10),
  maxArticleExtractions: z.number().int().min(0).max(50).default(10),
  maxCVEEnrichments: z.number().int().min(0).max(50).default(8),
  maxEPSSLookups: z.number().int().min(0).max(100).default(20),
  headlineArchiveDays: z.number().int().min(1).max(90).default(14),
  generationTimeoutSec: z.number().int()
    .min(MIN_GENERATION_TIMEOUT_SEC)
    .max(MAX_GENERATION_TIMEOUT_SEC)
    .default(180),
  // Sonnet 5 enables adaptive thinking by default. Medium is the balanced
  // editorial setting; 'off' explicitly disables thinking, while high can use
  // substantially more of the shared output budget.
  thinkingEffort: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  horizonWeights: HorizonWeightsSchema,
  scoring: ScoringSchema,
  debugScoring: z.boolean().default(false),
  webhook: WebhookSchema,
}).strict().prefault({});

const OrganizationSchema = z.object({
  profile: z.string().trim().max(512).default('Enterprise cyber defense team'),
  audience: z.string().trim().max(512).default('Cyber defenders and security leadership'),
  sector: z.string().trim().max(128).default(''),
  watchTopics: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
  regions: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
}).strict().prefault({});

const DEFAULT_HORIZONS = {
  1: { name: 'Tactical', window: 'Current shift to 7 days', question: 'What demands attention before the next shift change?' },
  2: { name: 'Operational', window: 'Coming weeks to 12 months', question: 'What developing threat activity, capability, exposure, or policy change requires a defensive adjustment over the coming weeks or months?' },
  3: { name: 'Strategic', window: 'Beyond 12 months', question: 'What structural change will materially alter the threat environment, defensive model, or risk posture?' },
};

const HorizonsSchema = z.object({
  1: HorizonSchema.default(DEFAULT_HORIZONS[1]),
  2: HorizonSchema.default(DEFAULT_HORIZONS[2]),
  3: HorizonSchema.default(DEFAULT_HORIZONS[3]),
}).strict().prefault({});

const ConfigSchema = z.object({
  organization: OrganizationSchema,
  horizons: HorizonsSchema,
  trustedFeeds: z.array(FeedSchema).max(250).default([]),
  alertRules: z.array(AlertRuleSchema).max(100).default([]),
  analysisSettings: AnalysisSettingsSchema,
}).strict().superRefine((config, ctx) => {
  const dimensions = [
    ['id', (feed) => typeof feed?.id === 'string' ? feed.id.toLowerCase() : null],
    ['url', (feed) => {
      try { return typeof feed?.url === 'string' ? new URL(feed.url).toString() : null; } catch { return null; }
    }],
    ['source', (feed) => typeof feed?.source === 'string' ? feed.source.toLowerCase() : null],
  ];
  for (const [field, keyFor] of dimensions) {
    const seen = new Map();
    config.trustedFeeds.forEach((feed, index) => {
      const key = keyFor(feed);
      if (!key) return;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['trustedFeeds', index, field],
          message: `duplicates trustedFeeds.${field} at index ${seen.get(key)}`,
        });
      } else {
        seen.set(key, index);
      }
    });
  }
});

// ── State ──
let _config = null;
let _configVersion = 0;
let _configPath = null;
let _watcher = null;
let _debounceTimer = null;
let _watchGeneration = 0;
// Last reload rejection (validation or parse failure), surfaced via /api/health
// so an operator hand-editing config.json can see a hot-reload was REJECTED —
// without this, configVersion still looking "current" reads as "applied".
let _lastReloadError = null;

export function initConfig(configPath) {
  // Reinitialization is used by tests and embedders. Close the previous watch
  // first so callbacks for an old path cannot reload or leak after replacement.
  stopConfigWatch();
  _configPath = configPath;
  loadConfig();

  try {
    const generation = ++_watchGeneration;
    const configName = basename(configPath);
    // Watch the directory rather than the file inode. Editors commonly save by
    // atomic rename; a file-level watch can silently remain attached to the old
    // inode and stop observing every later edit.
    _watcher = watch(dirname(configPath), (_eventType, changedName) => {
      if (generation !== _watchGeneration) return;
      if (changedName && String(changedName).toLowerCase() !== configName.toLowerCase()) return;
      if (_debounceTimer) return;
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        if (generation !== _watchGeneration) return;
        log.info('config', `config.json changed — reloading (v${_configVersion + 1})`);
        loadConfig();
      }, 500);
    });
    // fs.watch's 'error' event is otherwise unhandled, which is FATAL to the
    // whole process (Node re-throws unhandled 'error' events) — e.g. Windows
    // raises EPERM if the watched file's directory is removed out from under
    // the watcher. Hot-reload is a nice-to-have; losing it must never take
    // the server down. Fail closed on the watch, not on the process.
    _watcher.on('error', (err) => {
      if (generation !== _watchGeneration) return;
      log.warn('config', `fs.watch error, hot-reload disabled: ${err.message}`);
      stopConfigWatch();
    });
  } catch (err) {
    log.warn('config', `fs.watch failed, hot-reload disabled: ${err.message}`);
  }
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(_configPath, 'utf-8'));
  } catch (err) {
    log.error('config', `Failed to load config.json: ${err.message}`);
    _lastReloadError = { at: new Date().toISOString(), message: err.message };
    if (_config) return _config; // last known good
    throw new Error(`Cannot start with an unreadable config: ${err.message}`, { cause: err });
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    const msg = `Validation failed:\n  ${issues.join('\n  ')}`;
    log.warn('config', msg);
    _lastReloadError = { at: new Date().toISOString(), message: msg };
    // Hot reload rejects a bad edit and keeps the last-known-good value. Startup
    // has no safe value to preserve, so fail loudly instead of booting with an
    // empty/default feed set that looks healthy.
    if (_config) return _config;
    throw new Error(`Cannot start with an invalid config: ${msg}`);
  }

  _config = result.data;
  _lastReloadError = null;
  _configVersion++;
  return _config;
}

export function getConfig() {
  return _config || loadConfig();
}

export function getConfigVersion() {
  return _configVersion;
}

/** Last reload rejection ({ at, message }), or null if the last reload applied cleanly. */
export function getLastReloadError() {
  return _lastReloadError;
}

export function getHorizonName(config, horizon) {
  return config.horizons?.[String(horizon)]?.name || `Tier ${horizon}`;
}

export function stopConfigWatch() {
  _watchGeneration += 1;
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
}

/** Test-only: reset module state between test cases (otherwise process-lifetime). */
export function _resetForTests() {
  _config = null;
  _configVersion = 0;
  _configPath = null;
  _lastReloadError = null;
  stopConfigWatch();
}

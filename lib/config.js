// BlueTeam.News — config management with Zod validation and hot-reload.
// config.json is the single tuning surface: feeds, horizons, alert rules,
// analysis settings. Invalid fields fall back to defaults with a warning.

import { z } from 'zod';
import { readFileSync, watch } from 'fs';
import { basename, dirname } from 'path';
import { log } from './logger.js';

// ── Schema ──
const FeedSchema = z.object({
  url: z.string().url(),
  source: z.string().min(1),
  category: z.string().default('general'),
  horizon: z.number().int().min(1).max(3),
  weight: z.number().min(0).max(3).default(1.0),
  deepExtract: z.boolean().default(false),
});

const AlertRuleSchema = z.object({
  pattern: z.string().min(1),
  boost: z.number().min(0).max(20).default(5),
});

const HorizonSchema = z.object({
  name: z.string().min(1),
  window: z.string().default(''),
  question: z.string().default(''),
});

const HorizonWeightsSchema = z.object({
  horizon1: z.number().min(0).max(1).default(0.45),
  horizon2: z.number().min(0).max(1).default(0.40),
  horizon3: z.number().min(0).max(1).default(0.15),
}).prefault({});

// Outbound alert webhook. Empty url = DISABLED (the default); nothing is
// ever sent until an operator sets a url. SSRF-guarded at dispatch time.
// `events` chooses what the webhook fires for: alert-rule-matched headlines
// ('alerts'), the finished daily brief's BLUF ('brief'), or both.
const WebhookSchema = z.object({
  url: z.string().default(''),
  format: z.enum(['slack', 'json']).default('slack'),
  events: z.enum(['alerts', 'brief', 'both']).default('alerts'),
}).prefault({});

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
  }).prefault({}),
}).prefault({});

const AnalysisSettingsSchema = z.object({
  model: z.string().default('claude-haiku-4-5'),
  preferredModel: z.string().default('claude-sonnet-5'),
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
  generationTimeoutSec: z.number().int().min(30).max(600).default(180),
  // Sonnet 5 enables adaptive thinking by default. Medium is the balanced
  // editorial setting; 'off' explicitly disables thinking, while high can use
  // substantially more of the shared output budget.
  thinkingEffort: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  horizonWeights: HorizonWeightsSchema,
  scoring: ScoringSchema,
  debugScoring: z.boolean().default(false),
  webhook: WebhookSchema,
}).prefault({});

const OrganizationSchema = z.object({
  profile: z.string().default('Enterprise cyber defense team'),
  audience: z.string().default('Cyber defenders and security leadership'),
  sector: z.string().default(''),
  watchTopics: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
}).prefault({});

const DEFAULT_HORIZONS = {
  1: { name: 'Tactical', window: 'Current shift to 7 days', question: 'What demands attention before the next shift change?' },
  2: { name: 'Operational', window: 'Coming weeks to 12 months', question: 'What developing threat activity, capability, exposure, or policy change requires a defensive adjustment over the coming weeks or months?' },
  3: { name: 'Strategic', window: 'Beyond 12 months', question: 'What structural change will materially alter the threat environment, defensive model, or risk posture?' },
};

const ConfigSchema = z.object({
  organization: OrganizationSchema,
  horizons: z.record(z.string(), HorizonSchema).default(DEFAULT_HORIZONS),
  trustedFeeds: z.array(FeedSchema).default([]),
  alertRules: z.array(AlertRuleSchema).default([]),
  analysisSettings: AnalysisSettingsSchema,
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
  try {
    const raw = JSON.parse(readFileSync(_configPath, 'utf-8'));
    const result = ConfigSchema.safeParse(raw);

    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
      const msg = `Validation failed:\n  ${issues.join('\n  ')}`;
      log.warn('config', msg);
      _lastReloadError = { at: new Date().toISOString(), message: msg };
      // Keep the last-known-good config on a rejected reload (mirrors the
      // JSON-parse-failure catch below). Falling back to ConfigSchema.parse({})
      // here would silently swap the whole feed set for zero feeds while still
      // reporting the reload as "applied".
      if (_config) return _config;
      _config = ConfigSchema.parse({});
    } else {
      _config = result.data;
      _lastReloadError = null;
    }

    _configVersion++;
    return _config;
  } catch (err) {
    log.error('config', `Failed to load config.json: ${err.message}`);
    _lastReloadError = { at: new Date().toISOString(), message: err.message };
    if (_config) return _config; // last known good
    _config = ConfigSchema.parse({});
    return _config;
  }
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

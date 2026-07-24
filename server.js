// BlueTeam.News — composition root.
// Load config → init db → start background refresher → mount middleware
// and routes → listen. Logic lives in lib/; this file is wiring only.

import dotenv from 'dotenv';
// Default precedence (NOT override): a real shell/service-manager env var wins
// over .env. Otherwise an untouched `cp .env.example .env` (the README's own
// setup step) would silently clobber HOST/PORT/API_SECRET the operator exports
// at runtime — see .env.example, which now ships those defaults commented out.
dotenv.config({ quiet: true }); // suppress dotenv's stdout banner/tip line

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'fs';

import { initConfig, getConfig, stopConfigWatch } from './lib/config.js';
import { initDB, backfillBriefSearch, closeDB } from './lib/db.js';
import { log, requestLogger, startupBanner } from './lib/logger.js';
import {
  cors,
  requestId,
  nonce,
  securityHeaders,
  createRateLimiters,
  bearerAuth,
  contentTypeCheck,
  loopbackHostGuard,
  originCheck,
  isLoopbackHost,
  apiSecretValidationError,
} from './lib/middleware.js';
import { createCompressionMiddleware } from './lib/compression.js';
import { startRefreshSchedule, stopRefreshSchedule, refreshNow, getLatestRun, getRunAgeMs } from './lib/refresher.js';
import { startDailyBriefSchedule, stopDailyBriefSchedule, requestBriefGeneration } from './lib/brief-scheduler.js';
import { refreshKEV } from './lib/enrichment.js';
import { setDomainPack, setEnrichers } from './lib/domain.js';
import { cyberPack } from './config/domains/cyber.js';
import { cyberEnrichers } from './config/domains/cyber-enrichers.js';
import { healthHandler } from './lib/health.js';
import { createBriefRouter } from './routes/brief.js';
import { createLandscapeRouter } from './routes/landscape.js';
import { createSettingsRouter } from './routes/settings.js';
import { loadUserSettings, getUserSettings, getEffectiveOrganization } from './lib/user-settings.js';
import { APP_VERSION } from './lib/version.js';
import { PUBLIC_APP_NAME } from './lib/identity.js';
import { normalizePublicBaseUrl } from './lib/public-url.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths & constants ──
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const HISTORY_DIR = join(__dirname, 'briefs');
const DATA_DIR = join(__dirname, 'data');
const CONFIG_PATH = join(__dirname, 'config.json');
const DB_PATH = join(DATA_DIR, 'watchfloor.db');
const BOOT_TIME = Date.now();

let PUBLIC_BASE_URL = null;
try {
  PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
} catch (err) {
  log.error('env', err.message);
  process.exit(1);
}

// Validate the network boundary before creating files, opening SQLite, or
// starting an outbound catalog refresh. Invalid exposure/auth settings must
// fail without any startup side effects.
const IS_LOOPBACK = isLoopbackHost(HOST);
const apiSecretError = apiSecretValidationError({ bindHost: HOST, secret: process.env.API_SECRET });
if (apiSecretError) {
  log.error('env', `${apiSecretError} Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  process.exit(1);
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o700);
  } catch (err) {
    log.warn('permissions', `Could not set private directory permissions on ${path}: ${err.message}`);
  }
}

function hardenExistingPrivateFile(path) {
  if (process.platform === 'win32') return;
  try {
    // Never follow a local symlink merely to change its target's mode.
    if (!lstatSync(path).isFile()) return;
    chmodSync(path, 0o600);
  } catch (err) {
    log.warn('permissions', `Could not set private file permissions on ${path}: ${err.message}`);
  }
}

ensurePrivateDirectory(HISTORY_DIR);
ensurePrivateDirectory(DATA_DIR);

// Tighten files created by older releases. New settings, briefs, and database
// files also request 0600 at their respective write/open boundaries.
if (process.platform !== 'win32') {
  for (const name of readdirSync(HISTORY_DIR)) {
    if (/^brief-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(name)) {
      hardenExistingPrivateFile(join(HISTORY_DIR, name));
    }
  }
  for (const name of readdirSync(DATA_DIR)) {
    if (
      /^settings\.local\.json(?:\.tmp)?$/.test(name)
      || /\.db(?:-(?:wal|shm))?$/.test(name)
    ) {
      hardenExistingPrivateFile(join(DATA_DIR, name));
    }
  }
}

// ── Initialize core systems ──
initConfig(CONFIG_PATH);
initDB(DB_PATH);
backfillBriefSearch(HISTORY_DIR);

// BlueTeam.News ships one cyber threat-intelligence product. The profile seam
// remains internal so future CTI specializations can reuse the engine without
// turning the release into a generic multi-domain briefing platform.
setDomainPack(cyberPack);
setEnrichers(cyberEnrichers);

// Warm the CISA KEV catalog at boot (non-blocking). Otherwise a brief generated
// in the first seconds — before the first pipeline run enriches KEV — sees an
// empty catalog and reports "0 new KEV" when the truth is simply "not yet
// loaded." Fire-and-forget: the catalog loads ASAP and failures are logged,
// never fatal (refreshKEV falls back to the SQLite cache internally).
refreshKEV().catch(err => log.warn('kev', `Boot KEV warm-up failed: ${err.message}`));

// ── Environment validation ──
const API_KEY_PRIMARY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_PRIMARY;
const API_KEY_SECONDARY = process.env.ANTHROPIC_API_KEY_SECONDARY;

if (API_KEY_PRIMARY && !API_KEY_PRIMARY.startsWith('sk-ant-')) {
  log.warn('env', 'ANTHROPIC_API_KEY does not match expected format (sk-ant-...)');
}

// ── Anthropic client (mutable) ──
// Env key wins; otherwise the operator can set a key at runtime in the in-app
// Settings panel (persisted to data/settings.local.json). `ai.client` is rebuilt
// in place via refreshAi() so the Briefing turns on without a restart.
loadUserSettings(DATA_DIR);

const ai = { client: null, source: null, masked: null };

function maskKey(key) {
  if (!key) return null;
  return key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : 'sk-ant-…';
}

function buildAnthropic(key) {
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// Recompute the live client from current key sources (env wins over operator-set).
function refreshAi() {
  const settingsKey = getUserSettings().anthropicKey || null;
  const effective = API_KEY_PRIMARY || settingsKey;
  ai.client = buildAnthropic(effective);
  ai.source = API_KEY_PRIMARY ? 'env' : (settingsKey ? 'settings' : null);
  ai.masked = effective ? maskKey(effective) : null;
  ai.rotated = false; // a fresh build resets any prior secondary-key rotation
}
refreshAi();
if (!ai.client) {
  log.warn('env', 'No Anthropic API key configured — AI briefing disabled (wall and wire still work)');
} else if (ai.source === 'settings') {
  log.info('settings', 'Anthropic API key loaded from local Settings');
}

// Rotate the live client to the secondary key (env ANTHROPIC_API_KEY_SECONDARY)
// after the primary is rejected mid-generation. The brief route calls this on a
// 401/403 and retries the stream with the returned client — the real failover
// path, since generation streams (messages.stream) rather than going through
// messages.create. Idempotent: once rotated, returns null so a caller can tell
// "rotated" from "nothing to rotate to" and never loops on two dead keys.
function rotateToSecondaryKey() {
  if (!API_KEY_SECONDARY || ai.source === 'env:secondary') return null;
  ai.client = buildAnthropic(API_KEY_SECONDARY);
  ai.source = 'env:secondary';
  ai.masked = maskKey(API_KEY_SECONDARY);
  ai.rotated = true;
  log.warn('auth', 'Primary API key rejected — rotated to secondary');
  return ai.client;
}

function getAiStatus() {
  return { enabled: Boolean(ai.client), source: ai.source, masked: ai.masked, rotated: Boolean(ai.rotated) };
}

// Verify a candidate (or the active) key with ONE minimal, cheap Anthropic call, so the
// operator learns a mistyped-but-well-formed key is dead HERE — not when a full brief
// 503s and burns cents. A 401/403 is a genuine auth rejection; a 429/404/400 means the
// key authenticated and the issue is rate/model/params; a 5xx or network error is
// inconclusive (don't claim the key is bad when we couldn't reach Anthropic).
async function verifyAnthropicKey(candidate) {
  const key = (typeof candidate === 'string' && candidate.trim())
    || API_KEY_PRIMARY || getUserSettings().anthropicKey || null;
  if (!key) return { valid: false, error: 'No key to verify — paste one first.' };
  if (!key.startsWith('sk-ant-')) return { valid: false, error: 'That doesn’t look like an Anthropic key (expected sk-ant-…).' };
  try {
    const probe = new Anthropic({ apiKey: key });
    await probe.messages.create({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    return { valid: true };
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) return { valid: false, error: 'Key rejected by Anthropic — invalid or revoked.' };
    if (status === 429) return { valid: true, note: 'Key is valid (currently rate-limited).' };
    if (status === 404 || status === 400) return { valid: true, note: 'Key authenticated.' };
    return { valid: null, error: 'Could not reach Anthropic to verify — try again shortly.' };
  }
}

// ── Cooldown gate (per-process duplicate-generation guard) ──
const cooldown = {
  _last: {},
  check(key, cooldownMs = 10000) {
    const now = Date.now();
    if (this._last[key] && now - this._last[key] < cooldownMs) return false;
    this._last[key] = now;
    return true;
  },
};

// ══════════════════════════════════════════
// EXPRESS APP
// ══════════════════════════════════════════
const app = express();
app.disable('x-powered-by');

// Behind a reverse proxy? Trust it so rate-limiting and client-IP logging are
// correct. Off by default (direct/loopback); set TRUST_PROXY to a hop count
// (e.g. 1) or a subnet/'loopback' when running behind nginx/Caddy/Cloudflare.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp);
}

// The default local/no-secret deployment has no bearer boundary, so validate
// Host before compression, CORS, parsers, static files, or API routes can do
// work. This blocks DNS-rebinding pages from treating 127.0.0.1 as their own
// origin. Authenticated reverse-proxy deployments may use their public Host.
app.use(loopbackHostGuard({ enabled: IS_LOOPBACK && !process.env.API_SECRET }));
app.use(createCompressionMiddleware());
app.use(cors(PORT));
app.use(requestId);
app.use(nonce);
app.use(securityHeaders);
app.use(requestLogger);

const { apiLimiter, generationLimiter, dailyGenerationLimiter, verifyLimiter } = createRateLimiters();
app.use('/api/', apiLimiter);
app.post('/api/brief', generationLimiter, dailyGenerationLimiter);
app.post('/api/settings/verify', verifyLimiter);

if (process.env.API_SECRET) {
  app.use('/api/', bearerAuth);
  log.info('auth', 'Bearer token auth enabled on /api/*');
}

// Browser mutations must be same-origin (or match the one explicit CORS
// origin). The daily scheduler and CLI/API clients omit Origin and continue to
// work; bearer authentication remains mandatory when API_SECRET is configured.
app.use(originCheck({ publicBaseUrl: PUBLIC_BASE_URL }));
app.use(express.json({ limit: '100kb' }));
app.use(contentTypeCheck);

// ── Vendor modules served from node_modules (no CDN at runtime) ──
const VENDOR_FILES = {
  '/vendor/marked.esm.js': [
    join(__dirname, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
  ],
  '/vendor/purify.es.mjs': [
    join(__dirname, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs'),
  ],
  // Our own shared brief-contract parser (lib/brief-schema.js) — dependency-free
  // pure ESM, served byte-for-byte so the Wall and the server parse one contract.
  '/vendor/brief-schema.js': [
    join(__dirname, 'lib', 'brief-schema.js'),
  ],
};

for (const [route, candidates] of Object.entries(VENDOR_FILES)) {
  const filePath = candidates.find(p => existsSync(p));
  if (!filePath) {
    log.warn('static', `Vendor file missing for ${route} — run npm install`);
    continue;
  }
  // Read once at startup into a Buffer, not per-request: these files are
  // immutable for the process lifetime (node_modules, or our own brief-schema.js
  // which only changes on deploy — i.e. a restart, which re-reads it here anyway).
  // Serving the cached Buffer removes a synchronous disk read from the hot path.
  const body = readFileSync(filePath);
  app.get(route, (req, res) => {
    // Our own brief-schema.js is a live contract that changes between releases —
    // never let a returning kiosk cache a stale parser across deploys. Third-party
    // libs (marked, purify) are immutable per install, so they keep the long cache.
    res.setHeader('Cache-Control', route.endsWith('brief-schema.js') ? 'no-cache' : 'public, max-age=86400');
    res.type('application/javascript').send(body);
  });
}

// ── index.html with nonce injection + cache busting ──
// The template is read once at startup and cached; only the per-request nonce
// and boot-time cache-buster are substituted on the hot path (no per-request
// disk read). Editing public/index.html requires a restart to take effect,
// same as every other static asset here.
const INDEX_HTML_PATH = join(__dirname, 'public', 'index.html');
let indexHtmlTemplate;
try {
  indexHtmlTemplate = readFileSync(INDEX_HTML_PATH, 'utf-8');
} catch (err) {
  log.error('static', `Failed to read index.html: ${err.message}`);
}
app.get('/', (req, res) => res.redirect(302, '/wire'));
// Never let express.static serve the raw template: its inline bootstrap lacks a
// per-request CSP nonce and its {{BOOT}} cache keys are unresolved. A direct
// /index.html visit should land on the canonical, nonce-injected app route.
app.get('/index.html', (req, res) => res.redirect(302, '/wire'));
app.get(/^\/(?:wire|wall|settings|briefing(?:\/[^/]+)?)\/?$/, (req, res) => {
  if (indexHtmlTemplate === undefined) {
    return res.status(500).type('text/plain').send('Failed to read index.html');
  }
  const html = indexHtmlTemplate
    .replace(/<script /g, `<script nonce="${res.locals.nonce}" `)
    .replace(/\{\{BOOT\}\}/g, String(BOOT_TIME));
  res.type('html').send(html);
});

// ── Static files ──
app.use(express.static(join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/[\\/]vendor[\\/]fonts[\\/]/.test(filePath)) {
      // Vendored woff2 fonts are immutable per install (same file for the life of
      // the deploy) — cache forever instead of revalidating on every kiosk reload.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ── GET /embed — compact, header-less, read-only signal strip ──
// A minimal panel a team can drop into an <iframe> on a wiki/NOC portal: top-N
// scored signals + a KEV/freshness line, sourced from the same in-memory run
// the Wall/Wire poll. Deliberately keyless (no operator config surfaced, no
// bearer token — an iframe src can't carry an Authorization header). That's
// fine on the default loopback deployment, but on an API_SECRET-gated
// non-loopback bind it's the one unauthenticated route serving scored intel,
// so it fails closed there by default: set ENABLE_EMBED=1 to opt back in.
const EMBED_ENABLED = !process.env.API_SECRET || process.env.ENABLE_EMBED === '1';
if (process.env.API_SECRET && !EMBED_ENABLED) {
  log.info('embed', 'API_SECRET is set — /embed disabled by default (set ENABLE_EMBED=1 to opt in)');
}
function escapeEmbedHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Feed-controlled links are attacker-influenceable; allow only http(s) so a
// malicious feed's javascript:/data: link never becomes a live href — the same
// gate httpLink() (routes/landscape.js) and safeSlackLink() (lib/alerts.js)
// apply at their own sinks. A rejected link renders as plain text, not an anchor.
const embedHttpLink = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
app.get('/embed', (req, res) => {
  if (!EMBED_ENABLED) return res.status(404).end();
  const run = getLatestRun();
  const tierParam = Number(req.query.tier);
  const tier = [1, 2, 3].includes(tierParam) ? tierParam : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

  let headlines = run?.headlines || [];
  if (tier) headlines = headlines.filter(h => h.horizon === tier);
  const top = headlines.slice(0, limit);
  const kevCount = headlines.filter(h => h.isKEV).length;
  const ageMin = run ? Math.floor(getRunAgeMs() / 60000) : null;

  const rows = top.map(h => {
    const title = escapeEmbedHtml(h.title);
    const safeLink = embedHttpLink(h.link);
    const inner = safeLink ? `<a href="${escapeEmbedHtml(safeLink)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
    const kevTag = h.isKEV ? ' <span class="kev">KEV</span>' : '';
    return `<li><span class="score">${Math.round((h.score || 0) * 10) / 10}</span> ${inner}${kevTag}</li>`;
  }).join('\n      ');

  // Relax frame-ancestors for THIS route only — the whole point of /embed is to
  // render inside another origin's iframe (Confluence, Grafana, a NOC portal).
  // Every other route keeps the global 'none' set in lib/middleware.js. Helmet
  // also emits the legacy X-Frame-Options header, which overrides the intended
  // cross-origin embed behavior in browsers that enforce it, so remove it only
  // for this explicitly embeddable response.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *");
  res.removeHeader('X-Frame-Options');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${PUBLIC_APP_NAME} — signals</title>
<style>
  body { margin: 0; padding: 8px 12px; background: #0b0f1a; color: #dbe2f0; font: 13px/1.5 -apple-system, Segoe UI, sans-serif; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 4px 0; border-bottom: 1px solid #1c2333; }
  li:last-child { border-bottom: none; }
  a { color: #dbe2f0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .score { display: inline-block; min-width: 2.4em; color: #7ea2ff; font-variant-numeric: tabular-nums; }
  .kev { color: #ff8a8a; font-size: 11px; font-weight: 600; }
  .meta { margin-top: 6px; color: #8892a8; font-size: 11px; }
</style></head>
<body>
  <ul>
    ${rows || '<li>No signals yet.</li>'}
  </ul>
  <div class="meta">${kevCount} KEV active · ${ageMin === null ? 'no data' : `updated ${ageMin}m ago`}</div>
</body></html>`);
});

// ══════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════
app.use('/api', createBriefRouter({ getAnthropic: () => ai.client, rotateKey: rotateToSecondaryKey, historyDir: HISTORY_DIR, cooldown, publicBaseUrl: PUBLIC_BASE_URL, localPort: PORT }));
app.use('/api', createLandscapeRouter({ historyDir: HISTORY_DIR, cooldown, publicBaseUrl: PUBLIC_BASE_URL }));
app.use('/api', createSettingsRouter({ dataDir: DATA_DIR, getAiStatus, refreshAi, verifyKey: verifyAnthropicKey, getAlertRules: () => getConfig().alertRules, getOrganization: () => getEffectiveOrganization(getConfig()), loopback: IS_LOOPBACK, authed: Boolean(process.env.API_SECRET) }));
app.get('/api/health', healthHandler({
  bootTime: BOOT_TIME,
  version: APP_VERSION,
  dataDir: DATA_DIR,
  getAiStatus,
  loopback: IS_LOOPBACK,
  requireAuthForDetails: Boolean(process.env.API_SECRET),
}));

// Unknown /api/* route → JSON 404 (not the HTML SPA fallthrough).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Terminal error handler — a malformed body, oversized payload, or sync throw
// returns clean JSON instead of crashing the process or leaking a stack trace.
// Streamed responses that already sent headers (SSE) are left to close.
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid JSON body' });
  log.error('http', `Unhandled request error: ${err && err.message ? err.message : err}`);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ══════════════════════════════════════════
// START
// ══════════════════════════════════════════
startRefreshSchedule();

const server = app.listen(PORT, HOST, () => {
  startupBanner({
    host: HOST,
    port: PORT,
    version: APP_VERSION,
    feedCount: getConfig().trustedFeeds?.length || 0,
    aiEnabled: Boolean(ai.client),
  });
  startDailyBriefSchedule({
    generateBrief: generateScheduledBrief,
    isEnabled: () => Boolean(ai.client),
  });
});

// Reuse the public briefing route internally so the unattended edition receives
// the exact same validation, persistence, search indexing, model fallback, and
// webhook behavior as an operator-triggered brief. Refresh first so 05:00 never
// writes from yesterday's in-memory evidence set.
async function generateScheduledBrief() {
  if (!ai.client) throw new Error('AI briefing is disabled — configure an Anthropic API key');
  await refreshNow('daily-brief');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  const connectHost = (HOST === '0.0.0.0' || HOST === '::') ? '127.0.0.1' : HOST;
  const urlHost = connectHost.includes(':') ? `[${connectHost}]` : connectHost;
  return requestBriefGeneration({
    baseUrl: `http://${urlHost}:${address.port}`,
    apiSecret: process.env.API_SECRET || '',
  });
}

server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.timeout = 300_000;

// ── Graceful shutdown ──
function shutdown(signal) {
  log.info('server', `${signal} received — shutting down gracefully`);
  stopConfigWatch();
  stopRefreshSchedule();
  stopDailyBriefSchedule();
  server.close(() => {
    closeDB();
    log.info('server', 'All connections closed');
    process.exit(0);
  });
  setTimeout(() => { log.error('server', 'Forced exit'); process.exit(1); }, 30000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Process-level safety net ──
// The background refresher and setImmediate DB writes run fire-and-forget; an
// escaped rejection would otherwise kill the daemon with no log line. Log
// rejections (and keep running); on a truly uncaught exception, log, attempt a
// best-effort DB close, and exit so a supervisor restarts cleanly.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error('process', `Unhandled promise rejection: ${err.message}\n${err.stack || ''}`);
});

let exiting = false;
process.on('uncaughtException', (err) => {
  log.error('process', `Uncaught exception: ${err.message}\n${err.stack || ''}`);
  if (exiting) return;
  exiting = true;
  try { closeDB(); } catch { /* best effort */ }
  process.exit(1);
});

// BlueTeam.News — Express middleware stack: CORS, request IDs, CSP nonces,
// security headers, rate limiting, optional bearer auth.

import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MIN_API_SECRET_LENGTH = 32;
const MAX_API_SECRET_BYTES = 1024;

function isHealthPath(path) {
  return path === '/health' || path === '/health/';
}

/**
 * True only for the three explicit bind names this application supports as
 * local-only. Do not resolve names here: treating an arbitrary hostname that
 * happens to resolve to loopback as trusted is the DNS-rebinding bug the Host
 * guard below is designed to prevent.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized,
  );
}

/**
 * Validate the optional shared API token before the server starts.
 *
 * The default loopback/no-secret workflow remains valid. Once authentication is
 * explicitly enabled, however, accepting a short or copied example token gives
 * operators a security boundary that only looks protected. Network binds also
 * continue to fail closed when no token is configured.
 *
 * Returns an actionable error string, or null when the configuration is safe.
 */
export function apiSecretValidationError({ bindHost, secret }) {
  const loopback = isLoopbackHost(bindHost);
  if (secret === undefined || secret === null || secret === '') {
    return loopback
      ? null
      : `Refusing to bind ${bindHost} without API_SECRET; configure a random token of at least ${MIN_API_SECRET_LENGTH} characters or bind to 127.0.0.1.`;
  }
  if (typeof secret !== 'string') {
    return `API_SECRET must be a string of at least ${MIN_API_SECRET_LENGTH} characters.`;
  }
  if (secret !== secret.trim()) {
    return 'API_SECRET must not have leading or trailing whitespace.';
  }
  if (secret.length < MIN_API_SECRET_LENGTH || Buffer.byteLength(secret, 'utf8') < MIN_API_SECRET_LENGTH) {
    return `API_SECRET must be at least ${MIN_API_SECRET_LENGTH} characters long.`;
  }
  if (Buffer.byteLength(secret, 'utf8') > MAX_API_SECRET_BYTES) {
    return `API_SECRET must not exceed ${MAX_API_SECRET_BYTES} bytes.`;
  }

  const canonical = secret.toLowerCase().replace(/[^a-z0-9]/g, '');
  const repeatedPlaceholder = /^(?:(?:changeme|replaceme|yoursecrethere|yourtokenhere|apisecret|password|secret|example|test|token)[0-9]*)+$/;
  if (canonical.includes('placeholder') || repeatedPlaceholder.test(canonical) || new Set(secret).size < 8) {
    return 'API_SECRET is an obvious placeholder or is too repetitive; generate a random token instead.';
  }
  return null;
}

function hostHeaderName(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || value !== value.trim()) return null;
  if (/[\u0000-\u0020\u007f,/@\\?#]/.test(value)) return null;

  let hostname;
  let port;
  if (value.startsWith('[')) {
    const match = value.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!match) return null;
    [, hostname, port] = match;
  } else {
    const match = value.match(/^([^:]+)(?::(\d{1,5}))?$/);
    if (!match) return null;
    [, hostname, port] = match;
  }
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;

  const normalized = hostname.toLowerCase();
  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}

/**
 * Reject DNS-rebinding Host headers before any route or parser runs.
 *
 * This guard is intended for the default loopback/no-secret deployment. When a
 * strong API_SECRET is configured, deployments may legitimately use a reverse
 * proxy and public hostname, and bearer authentication remains the API
 * boundary instead.
 */
export function loopbackHostGuard({ enabled = true } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    const hostname = hostHeaderName(req.headers.host);
    if (hostname && LOOPBACK_HOSTS.has(hostname)) return next();
    res.setHeader('Connection', 'close');
    return res.status(421).json({ error: 'Unrecognized Host header', code: 'E009' });
  };
}

function canonicalHttpOrigin(value) {
  if (typeof value !== 'string' || !value || value.includes(',')) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return null;
    if (value !== parsed.origin && value !== `${parsed.origin}/`) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Require browser-initiated mutations to come from this request's own origin,
 * from the canonical PUBLIC_BASE_URL, or from the one explicitly configured
 * CORS origin. Requests with no Origin remain valid for the in-process
 * scheduler, curl, and other non-browser API clients; their bearer token is
 * still checked when authentication is enabled.
 */
export function originCheck({
  allowedOrigin = process.env.CORS_ORIGIN,
  publicBaseUrl,
} = {}) {
  const configuredOrigin = canonicalHttpOrigin(allowedOrigin);
  const publicOrigin = canonicalHttpOrigin(publicBaseUrl);
  return (req, res, next) => {
    const apiPath = (req.originalUrl || req.url || '').split('?', 1)[0];
    if (!STATE_CHANGING_METHODS.has(req.method) || !/^\/api(?:\/|$)/.test(apiPath)) return next();

    const supplied = req.headers.origin;
    if (supplied === undefined) return next();

    const requestOrigin = canonicalHttpOrigin(`${req.protocol}://${req.headers.host || ''}`);
    const callerOrigin = canonicalHttpOrigin(supplied);
    if (callerOrigin && (
      callerOrigin === requestOrigin
      || callerOrigin === publicOrigin
      || callerOrigin === configuredOrigin
    )) return next();
    return res.status(403).json({ error: 'Origin not allowed', code: 'E010' });
  };
}

export function cors(port) {
  return (req, res, next) => {
    const origin = process.env.CORS_ORIGIN || `http://127.0.0.1:${port}`;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

export function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}

export function nonce(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
}

export function securityHeaders(req, res, next) {
  const n = res.locals.nonce;
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", `'nonce-${n}'`],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: process.env.NODE_ENV === 'production'
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
  })(req, res, next);
}

export function createRateLimiters() {
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => isHealthPath(req.path),
    message: { error: 'Too many requests — try again in a minute', code: 'E003' },
  });

  const generationLimiter = rateLimit({
    windowMs: 30_000,
    max: 2,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    // Don't spend budget on rejected clicks (disabled/cooldown/error 4xx+).
    skipFailedRequests: true,
    // SSE commits HTTP 200 before generation finishes. Charge once a provider
    // call is attempted (it can be billable even if the client disconnects or
    // the stream later fails); refund only requests rejected before that point.
    requestWasSuccessful: (_req, res) =>
      res.locals?.briefGenerationAttempted === true || res.locals?.briefGenerationSucceeded === true,
    message: { error: 'Generation rate limited — wait 30 seconds', code: 'E003' },
  });

  const dailyGenerationLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    // A request rejected before the provider call (no key/cooldown) must not
    // consume the daily budget. Once a provider call starts, charge it even if
    // the SSE client disconnects or the upstream stream later fails.
    skipFailedRequests: true,
    requestWasSuccessful: (_req, res) =>
      res.locals?.briefGenerationAttempted === true || res.locals?.briefGenerationSucceeded === true,
    message: { error: 'Daily generation limit reached', code: 'E003' },
  });

  // /settings/verify makes a real Anthropic call like generation does, but sits
  // behind only the general apiLimiter (180/min) otherwise — a buggy or
  // compromised authed client could burn a lot of the operator's API budget
  // before that caps it. Tighter than generation (this is a cheap 1-token ping,
  // not a full brief) but still bounded.
  const verifyLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification attempts — wait a minute', code: 'E003' },
  });

  return { apiLimiter, generationLimiter, dailyGenerationLimiter, verifyLimiter };
}

/** Bearer-token auth — active only when API_SECRET is set. */
export function bearerAuth(req, res, next) {
  const secret = process.env.API_SECRET;
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(secret || '');
  const valid = Boolean(secret)
    && tokenBuf.length === secretBuf.length
    && crypto.timingSafeEqual(tokenBuf, secretBuf);

  // Health remains reachable by unauthenticated uptime probes, but a valid
  // optional token marks only this request as trusted for detailed diagnostics.
  if (isHealthPath(req.path)) {
    if (valid) res.locals.authenticated = true;
    return next();
  }

  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized', code: 'E008' });
  }
  res.locals.authenticated = true;
  next();
}

// No path exemptions: every state-changing /api/ request must carry
// Content-Type: application/json. That header is not on the CORS
// "simple request" allowlist, so the browser forces a preflight before
// sending it — which the default same-origin CORS policy then blocks for
// any cross-origin caller. /api/brief and /api/refresh used to be exempt
// (to match callers that POST with no body/content-type), which made them
// reachable as a no-preflight CSRF from any page the operator visits while
// blueteam is running on localhost. The frontend must send this header on
// every POST — see public/modules/core/api.js's generateBrief().
export function contentTypeCheck(req, res, next) {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && req.path.startsWith('/api/')) {
    const ct = req.headers['content-type'] || '';
    // Use the MIME essence, not a substring. `text/plain; application/json`
    // remains a browser-simple text/plain request and previously bypassed the
    // preflight-based CSRF gate on bodyless /brief and /refresh POSTs.
    const essence = ct.split(';', 1)[0].trim().toLowerCase();
    if (essence !== 'application/json') {
      return res.status(415).json({ error: 'Content-Type must be application/json', code: 'E005' });
    }
  }
  next();
}

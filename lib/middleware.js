// BlueTeam.News — Express middleware stack: CORS, request IDs, CSP nonces,
// security headers, rate limiting, optional bearer auth.

import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

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
    skip: (req) => req.path === '/health',
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
  if (req.path === '/health') {
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

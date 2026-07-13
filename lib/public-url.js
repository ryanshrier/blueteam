// Canonical outward-facing URLs. PUBLIC_BASE_URL is operator-controlled but
// still validated as hostile input: only an HTTP(S) origin is accepted, with
// no credentials, application path, query, or fragment to leak into links.

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizePublicBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an absolute http(s) origin, for example https://blueteam.news');
  }

  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new Error('PUBLIC_BASE_URL must use http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('PUBLIC_BASE_URL must not contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must be an origin only, with no path, query, or fragment');
  }

  return url.origin;
}

export function localhostBaseUrl(port = process.env.PORT || 3000) {
  const parsed = Number(port);
  const safePort = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
  return `http://localhost:${safePort}`;
}

// Request-derived origins remain useful for local feeds and reverse-proxy
// deployments that have not configured a canonical public URL. Forwarded
// headers are considered only when Express has an explicit trust-proxy policy.
export function requestBaseUrl(req, configuredBaseUrl = null) {
  const canonical = normalizePublicBaseUrl(configuredBaseUrl);
  if (canonical) return canonical;

  const trustProxy = Boolean(req?.app?.get('trust proxy'));
  const rawProto = (trustProxy && req.headers?.['x-forwarded-proto']) || req?.protocol || 'http';
  const proto = String(rawProto).split(',')[0].trim();
  const safeProto = HTTP_PROTOCOLS.has(`${proto}:`) ? proto : 'http';

  const rawHeader = (trustProxy && req.headers?.['x-forwarded-host']) || req?.get?.('host') || '';
  const rawHost = String(rawHeader).split(',')[0].trim();
  if (!/^[a-zA-Z0-9.\-:[\]]+$/.test(rawHost)) return localhostBaseUrl();

  try {
    const candidate = new URL(`${safeProto}://${rawHost}`);
    if (candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) {
      return localhostBaseUrl();
    }
    return candidate.origin;
  } catch {
    return localhostBaseUrl();
  }
}

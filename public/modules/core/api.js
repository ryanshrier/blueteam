// BlueTeam.News — API client with GET dedupe + short-lived caching.

const inFlight = new Map();
const cache = new Map();

// Every fetch is bounded so a hung request (half-open TCP, a blackholing proxy)
// can't wedge the inFlight dedupe map forever — without this, a single dead
// request would make every subsequent call to the same URL return the same
// never-settling promise, and surfaces like the Wall (unattended for days)
// would read STALE permanently until someone reloads the page.
const DEFAULT_TIMEOUT_MS = 15_000;

async function getJson(url, { ttlMs = 0 } = {}) {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.data;

  if (inFlight.has(url)) return inFlight.get(url);

  const promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Request failed (${url}): ${res.status}`);
    const data = await res.json();
    if (ttlMs > 0) cache.set(url, { data, expires: Date.now() + ttlMs });
    return data;
  })();

  inFlight.set(url, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(url);
  }
}

// Drop a cached entry so the next getJson() call for this URL is forced to
// re-fetch. Used where a write (e.g. a just-saved brief) must be visible
// immediately, ahead of the URL's normal ttlMs.
function invalidate(url) {
  cache.delete(url);
}

export function fetchLandscape() {
  return getJson('/api/landscape', { ttlMs: 15_000 });
}

export function fetchHeadlines() {
  return getJson('/api/headlines', { ttlMs: 30_000 });
}

// `fresh: true` drops the cached list first — used right after a generation
// completes, so a force-reload of the history dropdown can't rebuild from a
// list that's still within its 20s TTL and therefore missing the brand-new
// brief (a fast Haiku brief, or the very first one, can complete inside that
// window).
export function fetchBriefs({ fresh = false } = {}) {
  if (fresh) invalidate('/api/briefs');
  return getJson('/api/briefs', { ttlMs: 20_000 });
}

export function fetchBrief(filename) {
  return getJson(`/api/brief/${encodeURIComponent(filename)}`, { ttlMs: 5 * 60_000 });
}

export function fetchHealth() {
  return getJson('/api/ready');
}

// The active edition's identity (name + region labels). Cached long — it only
// changes when the server swaps Domain Packs. Read by the header (wordmark/title)
// and the Wall (region labels), so neither hardcodes the cyber edition.
export function fetchEdition() {
  return getJson('/api/edition', { ttlMs: 5 * 60_000 });
}

export async function searchBriefs(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

export function fetchSettings() {
  return getJson('/api/settings');
}

export async function saveSettings(patch) {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Settings save failed (${res.status})`);
  }
  return res.json();
}

// Confirm a key actually works (one cheap server-side Anthropic call). Returns
// { valid: true|false|null, error?, note? } — null means "couldn't verify".
export async function verifyKey(anthropicKey) {
  const res = await fetch('/api/settings/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anthropicKey }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS + 2_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Verify failed (${res.status})`);
  return body;
}

export async function generateBrief() {
  // Content-Type: application/json is required by the server's contentTypeCheck
  // (it forces a CORS preflight, closing the localhost-CSRF hole). Send it plus
  // an empty JSON body even though the route reads no body.
  const res = await fetch('/api/brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const headerSeconds = Number(res.headers.get('retry-after'));
    const retryAfter = Number.isFinite(Number(body.retryAfterSeconds))
      ? Number(body.retryAfterSeconds)
      : (Number.isFinite(headerSeconds) ? headerSeconds : null);
    const suffix = retryAfter ? ` Try again in about ${Math.max(1, Math.ceil(retryAfter))} seconds.` : '';
    const messages = {
      E_GENERATION_ACTIVE: `A Briefing is already being generated.${suffix}`,
      E_GENERATION_COOLDOWN: `The previous Briefing just finished.${suffix}`,
      E_GENERATION_RATE: `Too many Briefing requests were started from this client.${suffix}`,
      E_GENERATION_DAILY_LIMIT: 'The daily Briefing generation limit has been reached. Try again tomorrow.',
    };
    const err = new Error(messages[body.code] || body.error || `Briefing generation is rate limited.${suffix}`);
    err.code = body.code || 'E_RATE_LIMIT';
    err.retryAfterSeconds = retryAfter;
    throw err;
  }
  if (res.status === 503) {
    // AI disabled (no key). Tag it so the UI can guide to Settings, not Retry.
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'AI briefing is disabled on this server.');
    err.code = body.code || 'E002';
    err.aiDisabled = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res;
}

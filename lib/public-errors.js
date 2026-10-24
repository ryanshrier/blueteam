// One projection for diagnostics that may cross the API/provider boundary.
// Never forward arbitrary adapter error objects or nested details.
export function publicErrorText(value, env = process.env, maxLength = 300) {
  let detail = String(value || '');
  const secrets = Object.entries(env).filter(([name, secret]) => /key|token|secret|password|credential/i.test(name)
    && typeof secret === 'string' && secret.length >= 4).map(([, secret]) => secret).sort((a, b) => b.length - a.length);
  for (const secret of secrets) detail = detail.split(secret).join('[REDACTED]');
  return detail.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z\d_.~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

const detailKeys = new Set(['status', 'canGenerate', 'scope', 'code', 'reason', 'headlines', 'freshHeadlines',
  'retainedHeadlines', 'observedAt', 'usableHeadlines', 'substantiveSources', 'ageMs', 'collection',
  'configuredSources', 'reachableSources', 'freshSources', 'outage', 'lastAttemptAt', 'retainedLastGood']);
export function publicErrorDetails(error, env = process.env) {
  if (error?.code !== 'E_EVIDENCE' || !error.details || typeof error.details !== 'object' || Array.isArray(error.details)) return undefined;
  const project = (object, depth = 0) => Object.fromEntries(Object.entries(object).filter(([key]) => detailKeys.has(key))
    .slice(0, 24).flatMap(([key, value]) => {
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return [[key, value]];
      if (typeof value === 'string') return [[key, publicErrorText(value, env)]];
      if (key === 'collection' && value && typeof value === 'object' && !Array.isArray(value) && depth === 0) return [[key, project(value, 1)]];
      return [];
    }));
  return project(error.details);
}

export function projectPublicError(error, env = process.env) {
  const projected = new Error(publicErrorText(error?.message || error, env) || 'Provider request failed.');
  if (typeof error?.reason === 'string') projected.reason = publicErrorText(error.reason, env);
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) projected.status = error.status;
  if (typeof error?.code === 'string' && /^[A-Za-z][A-Za-z\d_]{0,63}$/.test(error.code)
    && publicErrorText(error.code, env) === error.code) projected.code = error.code;
  // These booleans are internal billing/retry facts, never arbitrary provider
  // detail. Losing uncertainty here can purchase the same scheduled work again.
  for (const key of ['completionUncertain', 'timedOut']) {
    if (typeof error?.[key] === 'boolean') projected[key] = error[key];
  }
  const details = publicErrorDetails(error, env);
  if (details) projected.details = details;
  return projected;
}

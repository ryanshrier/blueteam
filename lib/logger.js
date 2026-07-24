// BlueTeam.News — structured logger + request logging middleware.
// Pretty colored lines in development, JSON lines in production.

import { PUBLIC_APP_NAME } from './identity.js';

const MAX_LOG_MESSAGE_LENGTH = 8_192;
const UNSAFE_LOG_CODE_POINT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)@/gi;

function visibleCodePoint(char) {
  return `\\u{${char.codePointAt(0).toString(16).toUpperCase()}}`;
}

function redactSecrets(value) {
  return value
    // URL credentials must never be copied into logs. Keep the host/path for
    // diagnosis while making both the username and password unrecoverable.
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(/\bsk-ant-[a-z0-9_-]{6,}\b/gi, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/\bBearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&\s]*/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/**
 * Make untrusted text safe for terminal and line-oriented JSON logs.
 *
 * Newlines are retained by default so stack traces remain useful; the
 * development formatter prefixes each continuation line with trusted logger
 * metadata. All terminal controls, C1 controls, and bidi formatting controls
 * are rendered visibly instead of being interpreted.
 */
export function sanitizeLogText(
  input,
  { maxLength = MAX_LOG_MESSAGE_LENGTH, preserveNewlines = true } = {},
) {
  let value;
  try {
    value = String(input ?? '');
  } catch {
    value = '[unprintable]';
  }

  const truncated = value.length > maxLength;
  value = value.slice(0, maxLength)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(UNSAFE_LOG_CODE_POINT, visibleCodePoint);
  if (!preserveNewlines) value = value.replace(/\n/g, '\\n');
  value = redactSecrets(value);
  return truncated ? `${value}...[truncated]` : value;
}

function sanitizeComponent(component) {
  return sanitizeLogText(component, { maxLength: 48, preserveNewlines: false })
    .replace(/[^a-z0-9_.:-]/gi, '_') || 'app';
}

function sanitizeExtra(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return sanitizeLogText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'undefined') return undefined;
  if (depth >= 3) return '[truncated]';
  if (typeof value !== 'object') return sanitizeLogText(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeExtra(item, depth + 1, seen));
  }

  const clean = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    const safeKey = sanitizeLogText(key, { maxLength: 64, preserveNewlines: false });
    clean[safeKey] = sanitizeExtra(item, depth + 1, seen);
  }
  return clean;
}

function emit(level, component, message, extra = {}) {
  const safeComponent = sanitizeComponent(component);
  const safeMessage = sanitizeLogText(message);
  const entry = {
    ...sanitizeExtra(extra),
    ts: new Date().toISOString(),
    level,
    component: safeComponent,
    msg: safeMessage,
  };

  const stream = level === 'error' ? process.stderr : process.stdout;
  // Read lazily so NODE_ENV populated by dotenv after ESM imports still selects
  // production JSON output.
  if (process.env.NODE_ENV !== 'production') {
    const color = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level] || '\x1b[0m';
    const reset = '\x1b[0m';
    const ts = entry.ts.slice(11, 19);
    const prefix = `${color}[${ts}] [${safeComponent.toUpperCase()}]${reset}`;
    const formatted = safeMessage.replace(/\n/g, `\n${prefix} | `);
    stream.write(`${prefix} ${formatted}\n`);
  } else {
    stream.write(JSON.stringify(entry) + '\n');
  }
}

export const log = {
  info: (component, message, extra) => emit('info', component, message, extra),
  warn: (component, message, extra) => emit('warn', component, message, extra),
  error: (component, message, extra) => emit('error', component, message, extra),
};

export function requestLogger(req, res, next) {
  const start = performance.now();
  res.on('finish', () => {
    if (req.path === '/api/health') return; // skip monitoring noise
    const ms = (performance.now() - start).toFixed(0);
    log.info('http', `${req.method} ${req.path} ${res.statusCode} ${ms}ms`, { requestId: req.id });
  });
  next();
}

export function startupBanner({ host, port, version, feedCount, aiEnabled }) {
  const lines = [
    '',
    '  ┌─────────────────────────────────────────────┐',
    `  │  ${PUBLIC_APP_NAME} v${version}                  │`,
    '  └─────────────────────────────────────────────┘',
    '',
    `  → App:    http://${host}:${port}`,
    `  → Wall:   http://${host}:${port}/wall`,
    `  → Health: http://${host}:${port}/api/health`,
    `  → Feeds:  ${feedCount} sources configured`,
    `  → AI briefing: ${aiEnabled ? 'enabled' : 'disabled (set ANTHROPIC_API_KEY to enable)'}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

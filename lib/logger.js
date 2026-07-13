// BlueTeam.News — structured logger + request logging middleware.
// Pretty colored lines in development, JSON lines in production.

import { PUBLIC_APP_NAME } from './identity.js';

function emit(level, component, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
    ...extra,
  };

  const stream = level === 'error' ? process.stderr : process.stdout;
  // Read lazily so NODE_ENV populated by dotenv after ESM imports still selects
  // production JSON output.
  if (process.env.NODE_ENV !== 'production') {
    const color = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level] || '\x1b[0m';
    const reset = '\x1b[0m';
    const ts = entry.ts.slice(11, 19);
    stream.write(`${color}[${ts}] [${component.toUpperCase()}]${reset} ${message}\n`);
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

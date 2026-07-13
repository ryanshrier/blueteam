// BlueTeam.News — response compression with SSE-safe filtering.
// Server-sent event streams must never be compressed: proxy/browser
// buffering would stall the live briefing render.

import compression from 'compression';

/**
 * Returns false when compression would break streaming or is explicitly
 * disabled. Exported for unit tests.
 */
export function shouldCompressResponse(req, res) {
  if (req.headers['x-no-compression']) return false;
  const ct = res.getHeader('Content-Type');
  if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
  if (req.headers.accept?.includes('text/event-stream')) return false;
  return compression.filter(req, res);
}

export function createCompressionMiddleware() {
  return compression({
    threshold: 512,
    filter: shouldCompressResponse,
  });
}

// Bounded, loopback-only probes for GHSA-27r3-jxmh-p828 and
// GHSA-xjj6-f33q-929c. Run only in a disposable child process.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { Agent, fetch as transportFetch } from 'undici';
import { bearerAuth, contentTypeCheck, originCheck } from '../../lib/middleware.js';
import {
  safeFetch, readCapped, closeOutboundDispatchers, _setTransportFetchForTests,
} from '../../lib/net.js';

const scenario = process.argv[2];
const watchdog = setTimeout(() => {
  console.error(`Timed out: ${scenario}`);
  process.exit(1);
}, 8_000);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  const finished = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await finished;
}

function httpRequest(url, options, send = req => req.end()) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ...options, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.setTimeout(3_000, () => req.destroy(new Error('Loopback request timed out')));
    send(req);
  });
}

async function compressedRequest() {
  const app = express();
  process.env.API_SECRET = 'test-only-secret-with-at-least-32-characters';
  // Match the relevant server.js ordering: API auth does not cover the global
  // JSON parser on non-API paths. No real application state or paid work runs.
  app.use('/api/', bearerAuth);
  app.use(originCheck({ publicBaseUrl: null }));
  app.use(express.json({ limit: '100kb' }));
  app.use(contentTypeCheck);
  const body = { probe: 'compressed request' };
  const first = Buffer.concat([gzipSync(JSON.stringify(body)), Buffer.from([0])]);
  const trailing = Buffer.alloc(100 * 1024, 0x58);
  let client;
  app.post('/parser-probe', (req, res) => {
    assert.deepEqual(req.body, body);
    // The decoder has finished, but the HTTP request has not. Sending the last
    // bytes here deterministically exercises the previously orphaned decoder.
    req.once('end', () => res.json(req.body));
    client.end(trailing);
  });
  app.get('/health-probe', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  const base = await listen(server);
  try {
    const response = await httpRequest(`${base}/parser-probe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': first.length + trailing.length,
      },
    }, req => { client = req; req.write(first); });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), body);
    await delay(100);
    assert.equal((await httpRequest(`${base}/health-probe`)).status, 200);
  } finally {
    await close(server);
  }
}

async function excessiveEncodings() {
  const server = createServer((req, res) => {
    if (req.url === '/malformed') {
      res.writeHead(200, {
        'Content-Encoding': Array(6).fill('gzip').join(', '),
        'Content-Length': '100',
        Connection: 'close',
      });
      res.flushHeaders();
      // Close after headers with no promised body. Vulnerable Undici rejects
      // fetch, then emits an uncaught error from its orphaned response stream.
      res.socket.end();
      return;
    }
    res.end('still healthy');
  });
  const base = await listen(server);
  const agent = new Agent({ connections: 2, pipelining: 1 });
  // safeFetch intentionally rejects loopback destinations. Its existing test
  // seam maps a vetted public literal to this fixture; the fetch implementation
  // and HTTP parser are real, and no socket can reach an external destination.
  _setTransportFetchForTests((url, options) => transportFetch(
    `${base}${new URL(url).pathname}`, { ...options, dispatcher: agent },
  ));
  try {
    await assert.rejects(
      safeFetch('http://93.184.216.34/malformed', { signal: AbortSignal.timeout(3_000) }),
      error => /too many content-encodings/.test(error.cause?.message || error.message),
    );
    // Allow the socket close and any delayed unhandled error to surface before
    // asserting that the same process can still fetch and read another body.
    await delay(100);
    const response = await safeFetch('http://93.184.216.34/healthy', { signal: AbortSignal.timeout(3_000) });
    assert.equal(await readCapped(response, 1024), 'still healthy');
  } finally {
    _setTransportFetchForTests();
    await agent.destroy();
    await closeOutboundDispatchers();
    await close(server);
  }
}

try {
  if (scenario === 'compressed-request') await compressedRequest();
  else if (scenario === 'excessive-encodings') await excessiveEncodings();
  else throw new Error(`Unknown fixture: ${scenario}`);
  console.log(`PASS ${scenario}`);
} finally {
  clearTimeout(watchdog);
}

// Real authenticated draft routes with private synthetic state and no provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionSmokeEnvironment, seedProductionSmoke } from '../../scripts/check-production-render.mjs';
import { buildGroundingManifest } from '../../lib/grounding.js';
import { buildGenerationManifest } from '../../lib/generation-manifest.js';
import { saveRejectedBrief } from '../../lib/brief-drafts.js';
import { validateBrief } from '../../lib/validation.js';
import { BRIEF_EVALUATION_CASES, referenceBrief, EVAL_DATE } from './brief-evaluation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = await mkdtemp(join(tmpdir(), 'brief-processing-http-'));
const delay = ms => new Promise(done => setTimeout(done, ms));
let child, logs = '';
try {
  const seed = await seedProductionSmoke(state);
  const item = structuredClone(BRIEF_EVALUATION_CASES[0]);
  item.headlines[0].link += '?signature=synthetic-http-signed-destination&id=42#details';
  const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
  const content = referenceBrief(item);
  const validation = validateBrief(content, EVAL_DATE, { publication: true, editorialStandard: 2, groundingManifest });
  const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, groundingManifest,
    config: {}, editionContext: { date: EVAL_DATE, timezone: 'UTC' } });
  manifest.editorialStandard = 2;
  assert.equal(manifest.grounding.urlIdentities.algorithm, 'sha256-canonical-url-v1');
  assert(!JSON.stringify(manifest).includes('synthetic-http-signed-destination'));
  const drafts = ['revalidate', 'publish'].map(() => saveRejectedBrief(join(state, 'briefs'), { content, manifest, validation }));
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  const origin = `http://127.0.0.1:${port}`, secret = randomBytes(32).toString('hex');
  child = spawn(process.execPath, [join(root, 'server.js')], { cwd: state, windowsHide: true,
    env: { ...productionSmokeEnvironment({ stateDir: state, configPath: seed.configPath, port, secret }), BLUETEAM_LAUNCHER_IPC: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk; });
  let ready = false;
  const startupDeadline = Date.now() + 8000;
  for (let attempt = 0; attempt < 80 && Date.now() < startupDeadline; attempt++) {
    if (child.exitCode !== null) throw new Error('Synthetic server exited: ' + logs);
    try { if ((await fetch(origin + '/api/live', { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(50);
  }
  assert(ready, 'Synthetic server did not start: ' + logs);
  // This input passed the original admission guard and froze the server before
  // its validator worker started. Retain the exact under-100KB shape.
  const text = '<a '.repeat(7900) + 'x'.repeat(55_000);
  const results = [];
  for (const [index, route] of ['revalidate', 'publish'].entries()) {
    const draft = drafts[index];
    const body = JSON.stringify({ content: text, baseRevision: 1, ...(route === 'publish' ? { inputSha256: draft.manifestSha256 } : {}) });
    assert(Buffer.byteLength(body) < 100_000);
    const request = fetch(`${origin}/api/brief/drafts/${draft.id}/${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(12_000) }).then(async response => ({ status: response.status, body: await response.json() }));
    // Attach rejection immediately, even while the concurrent probe runs.
    const settled = request.then(value => ({ value }), error => ({ error }));
    await delay(50);
    const started = performance.now();
    const live = await fetch(origin + '/api/live', { signal: AbortSignal.timeout(1000) });
    const liveMs = performance.now() - started;
    assert.equal(live.status, 200);
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    const { status, body: response } = outcome.value;
    assert(route === 'publish' ? [400, 422].includes(status) : [200, 400].includes(status), `${route}: ${status}`);
    if (status === 400) assert(['E_BRIEF_VALIDATION_TIMEOUT', 'E_BRIEF_VALIDATION', 'E_BRIEF_INPUT_LIMIT'].includes(response.code), JSON.stringify(response));
    results.push({ route, status, liveStatus: live.status, liveMs, bodyBytes: Buffer.byteLength(body) });
  }
  console.log('PASS brief-processing-http ' + JSON.stringify({ runtime: process.version, results }));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise(done => child.once('exit', done));
    const guard = setTimeout(() => child.kill('SIGKILL'), 2500);
    if (child.connected) child.send({ type: 'blueteam:shutdown', signal: 'SIGTERM' }, () => {});
    else child.kill('SIGTERM');
    await exited; clearTimeout(guard);
  }
  const target = await realpath(state);
  if (dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('brief-processing-http-')) throw new Error('Unsafe synthetic-state cleanup');
  await rm(target, { recursive: true, force: true });
}

/** Real server/browser integration: private temporary state, synthetic evidence,
 * no provider credentials, no collection, and no mocked application requests. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(done => setTimeout(done, ms));

// Use an allowlist: neither provider secrets/custom modules nor NODE_OPTIONS,
// proxy configuration, operator state paths or dotenv files reach the server.
export function productionSmokeEnvironment({ stateDir, configPath, port, secret }, inherited = process.env) {
  const system = Object.fromEntries(Object.entries(inherited).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_all)$/i.test(key)));
  return { ...system, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), API_SECRET: secret,
    BLUETEAM_STATE_DIR: resolve(stateDir), BLUETEAM_CONFIG_PATH: resolve(configPath), BLUETEAM_DISABLE_COLLECTION: '1' };
}

export async function seedProductionSmoke(stateDir) {
  const [{ initDB, setMeta, closeDB }, { saveRejectedBrief }, { buildGenerationManifest },
    { buildGroundingManifest }, { repairBriefFormatting, validateBrief }, { BRIEF_EVALUATION_CASES, referenceBrief }] = await Promise.all([
    import('../lib/db.js'), import('../lib/brief-drafts.js'), import('../lib/generation-manifest.js'),
    import('../lib/grounding.js'), import('../lib/validation.js'), import('../test/fixtures/brief-evaluation.js'),
  ]);
  const item = BRIEF_EVALUATION_CASES[0];
  const now = new Date().toISOString();
  const headlines = item.headlines.map((headline, index) => ({ ...headline, date: now, horizon: 1, score: 80 - index }));
  await mkdir(join(stateDir, 'data'), { recursive: true });
  await mkdir(join(stateDir, 'briefs'), { recursive: true });
  initDB(join(stateDir, 'data', 'watchfloor.db'));
  try {
    const { observeSources } = await import('../lib/evidence.js');
    observeSources(headlines, { observedAt: now });
    setMeta('latest_run', JSON.stringify({ headlines, generatedAt: now, generatedAtMs: Date.parse(now), stats: { totalFeeds: 0, successfulFeeds: 0 } }));
  } finally { closeDB(); }
  const content = repairBriefFormatting(referenceBrief(item).replace('The vendor confirms exploitation in original reporting.',
    'The vendor confirms exploitation in original reporting. [Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor)'));
  const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
  const validation = validateBrief(content, '2026-09-05', { publication: true, editorialStandard: 2, groundingManifest, kevSet: new Set(), kevCatalogLoaded: true });
  const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, config: {}, editionContext: { date: '2026-09-05', timezone: 'UTC', scheduled: false }, groundingManifest });
  Object.assign(manifest, { generationId: randomUUID(), editorialStandard: 2, generatedAt: now,
    verification: { kevCatalogLoaded: true, selectedKevCves: [] }, providerAttempts: [],
    costEstimate: { usd: 0, status: 'synthetic-no-provider' }, publicationValidation: { ...validation, partial: true } });
  const artifact = saveRejectedBrief(join(stateDir, 'briefs'), { id: manifest.generationId, content, manifest, validation: { ...validation, partial: true } });
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ organization: { profile: 'Synthetic browser test' }, trustedFeeds: [], alertRules: [], analysisSettings: { webhook: { url: '', format: 'slack', events: 'alerts' } } }));
  return { configPath, artifact, headlines };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function waitForServer(child, origin, logs) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Production server exited (${child.exitCode}): ${logs()}`);
    try { if ((await fetch(`${origin}/api/live`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error(`Production server did not become ready: ${logs()}`);
}

async function evaluate(connection, expression) {
  const result = await connection.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(connection, expression, description = expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(connection, expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

export async function runProductionSmoke() {
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome or Edge is required (or set CHROME_PATH)');
  const stateDir = await mkdtemp(join(tmpdir(), 'blueteam-production-smoke-'));
  const connections = [];
  let child, browser, independentBrowser;
  let logs = '';
  const errors = [];
  try {
    const seed = await seedProductionSmoke(stateDir);
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const secret = randomBytes(32).toString('hex');
    async function startServer() {
      child = spawn(process.execPath, [join(ROOT, 'server.js')], { cwd: stateDir,
        env: productionSmokeEnvironment({ stateDir, configPath: seed.configPath, port, secret }),
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', error => errors.push(`Server process: ${error.message}`));
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = `${logs}${chunk}`.slice(-16_000); });
      await waitForServer(child, origin, () => logs);
    }
    await startServer();
    const auth = { Authorization: `Bearer ${secret}` };
    assert.equal((await fetch(`${origin}/api/settings`)).status, 401, 'Real API authentication must reject missing credentials');
    browser = await launchBrowser(browserPath);
    async function page(instance = browser) {
      const target = await (await fetch(`${instance.debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      connections.push(connection);
      await Promise.all([connection.call('Page.enable'), connection.call('Runtime.enable'), connection.call('Network.enable')]);
      await connection.call('Network.setExtraHTTPHeaders', { headers: auth });
      connection.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
      connection.on('Network.responseReceived', event => {
        if (event.type === 'Document' && event.response.url.startsWith(origin)) {
          const headers = Object.fromEntries(Object.entries(event.response.headers).map(([key, value]) => [key.toLowerCase(), value]));
          if (!/script-src[^;]*'nonce-/.test(headers['content-security-policy'] || '')) errors.push('Production document omitted its nonce CSP');
        }
      });
      connection.on('Fetch.requestPaused', event => {
        const local = event.request.url.startsWith(`${origin}/`);
        if (!local) errors.push(`Unexpected external browser request: ${event.request.url}`);
        void connection.call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
          requestId: event.requestId, ...(!local ? { errorReason: 'BlockedByClient' } : {}),
        }).catch(error => errors.push(error.message));
      });
      await connection.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await connection.call('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.violatedDirective + ': ' + event.blockedURI));
      ` });
      return connection;
    }
    async function navigate(connection, path, ready) {
      if (await evaluate(connection, 'typeof window.__cspViolations !== "undefined"')) {
        assert.deepEqual(await evaluate(connection, 'window.__cspViolations'), [], 'CSP must allow the real application');
      }
      const loaded = connection.waitFor('Page.loadEventFired');
      await connection.call('Page.navigate', { url: origin + path });
      await loaded;
      await waitFor(connection, ready);
      assert(await evaluate(connection, '[...document.scripts].filter(script => script.type === "module").every(script => !!script.nonce)'), 'App module scripts must receive a CSP nonce');
    }
    const first = await page();
    await navigate(first, '/settings', 'document.querySelector("#profileTechnologies")?.disabled === false');
    await evaluate(first, `document.querySelector('#profileTechnologies').value = 'Synthetic Smoke Gateway';
      document.querySelector('#profileTechnologies').dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#saveProfile').click();`);
    await waitFor(first, 'document.querySelector("#profileFeedback")?.textContent.startsWith("Saved.")', 'Watch profile saved through the real settings route');
    const settings = JSON.parse(await readFile(join(stateDir, 'data', 'settings.local.json'), 'utf8'));
    assert(settings.watchProfile.technologies.includes('Synthetic Smoke Gateway'), 'Settings must persist in isolated storage');

    const signal = seed.headlines[0].link;
    assert(signal && seed.headlines[1]?.link, 'Synthetic evidence must include two Wire signals');
    const wirePath = `/wire?signal=${encodeURIComponent(signal)}`;
    const formReady = '!!document.querySelector("#wireInspector [data-decision-form]") && document.querySelector("#wireDecisionStatus")?.textContent.startsWith("Decisions saved on this server")';
    await navigate(first, wirePath, formReady);
    assert(await evaluate(first, 'document.querySelector("#wireDecisionNotice").hidden && !!document.querySelector("#wireViewTools #wireDecisionStatus")'), 'Routine decision status stays in View tools so the scan list remains near the top');
    const second = await page();
    await navigate(second, wirePath, formReady);
    const draft = note => `(() => { const form = document.querySelector('#wireInspector [data-decision-form]');
      form.elements.namedItem('note').value = ${JSON.stringify(note)};
      form.elements.namedItem('note').dispatchEvent(new Event('input', {bubbles:true})); })()`;
    const submit = `document.querySelector('#wireInspector [data-decision-form]').requestSubmit()`;
    const savedNote = note => `JSON.parse(localStorage.getItem('wire.server-decisions.v1') || '[]').some(record => record.signal === ${JSON.stringify(signal)} && record.decision.note === ${JSON.stringify(note)})`;
    await evaluate(first, draft('My retained unsaved investigation'));
    await evaluate(second, draft('New assessment saved in another tab'));
    await evaluate(second, submit);
    await waitFor(second, savedNote('New assessment saved in another tab'));
    await evaluate(first, submit);
    await waitFor(first, '!!document.querySelector("#wireInspector [data-decision-rebase]")', 'Cross-tab conflict shown');
    assert.equal(await evaluate(first, `document.querySelector('#wireInspector [name="note"]').value`), 'My retained unsaved investigation');
    assert(await evaluate(first, savedNote('New assessment saved in another tab')));
    await evaluate(first, `document.querySelector('#wireInspector [data-decision-rebase]').click()`);
    await waitFor(first, '!document.querySelector("#wireInspector [data-decision-rebase]")');
    await evaluate(first, submit);
    await waitFor(first, savedNote('My retained unsaved investigation'));
    const serverDecisions = async () => (await (await fetch(`${origin}/api/decisions`, { headers: auth })).json()).items;
    let committed = (await serverDecisions()).find(record => record.signal === signal);
    assert.equal(committed.revision, 2);
    assert.equal(committed.decision.note, 'My retained unsaved investigation');
    await evaluate(first, `document.querySelector('#wireInspector [data-decision-history]').click()`);
    await waitFor(first, 'document.querySelector("dialog")?.textContent.includes("Evidence copy retained")');
    assert(await evaluate(first, 'document.querySelector("dialog").textContent.includes("Individual author identity is not recorded")'));
    await evaluate(first, `document.querySelector('dialog [data-close]').click()`);

    // A separate browser profile has no local records/cache but reads the same
    // committed server assessment, proving persistence is not a localStorage alias.
    independentBrowser = await launchBrowser(browserPath);
    const independent = await page(independentBrowser);
    await navigate(independent, wirePath, formReady);
    assert.equal(await evaluate(independent, `localStorage.getItem('wire.decisions.v1')`), null);
    assert.equal(await evaluate(independent, `document.querySelector('#wireInspector [name="note"]').value`), committed.decision.note);

    const legacy = JSON.stringify({ [signal]: { state: 'affected', note: 'Conflicting legacy decision' },
      'https://example.test/legacy-decision': { state: 'investigate', note: 'Legacy off-feed record', recordedAt: '2026-09-01T00:00:00Z' } });
    await evaluate(first, `localStorage.setItem('wire.decisions.v1', ${JSON.stringify(legacy)})`);
    await navigate(first, wirePath, formReady);
    assert(await evaluate(first, '!document.querySelector("#wireDecisionNotice").hidden && document.querySelector("#wireMigrateDecisions").getClientRects().length > 0'), 'Retained browser decisions remain visibly actionable without opening View tools');
    await evaluate(first, `document.querySelector('#wireMigrateDecisions').click()`);
    await waitFor(first, 'document.querySelector("dialog")?.textContent.includes("1 conflicts left unchanged")');
    assert.equal(await evaluate(first, `localStorage.getItem('wire.decisions.v1')`), legacy);
    assert.equal((await serverDecisions()).find(record => record.signal === signal).decision.note, committed.decision.note);
    assert((await serverDecisions()).some(record => record.decision.note === 'Legacy off-feed record'));
    await evaluate(first, `document.querySelector('dialog [data-close]').click()`);

    // An offline save keeps a retryable draft in this tab across reloads.
    await navigate(first, `/wire?signal=${encodeURIComponent(seed.headlines[1].link)}`, formReady);
    await evaluate(first, draft('Offline draft remains recoverable'));
    await first.call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await evaluate(first, submit);
    await waitFor(first, 'document.querySelector("#wireDecisionStatus")?.textContent.includes("unavailable")');
    assert(await evaluate(first, '!document.querySelector("#wireDecisionNotice").hidden && document.querySelector("#wireDecisionNoticeText").textContent.includes("unavailable") && document.querySelector("#wireRetryDecisions").getBoundingClientRect().height >= 44'), 'Offline decision warning and usable retry remain visible outside View tools');
    assert(!(await serverDecisions()).some(record => record.signal === seed.headlines[1].link));
    await first.call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await evaluate(first, 'document.querySelector("#wireRetryDecisions").click()');
    await waitFor(first, formReady, 'Visible retry restores the decision connection');
    assert(await evaluate(first, 'document.querySelector("#wireRetryDecisions").hidden && !document.querySelector("#wireDecisionNoticeText").textContent.includes("unavailable")'), 'Recovery clears the offline warning');
    await navigate(first, `/wire?signal=${encodeURIComponent(seed.headlines[1].link)}`, formReady);
    assert.equal(await evaluate(first, `document.querySelector('#wireInspector [name="note"]').value`), 'Offline draft remains recoverable');
    await evaluate(first, submit);
    await waitFor(first, `!Object.keys(JSON.parse(sessionStorage.getItem('wire.decision-drafts.v1') || '{}')).includes(${JSON.stringify(seed.headlines[1].link)})`);
    assert((await serverDecisions()).some(record => record.decision.note === 'Offline draft remains recoverable'));

    const { default: Database } = await import('better-sqlite3');
    const database = new Database(join(stateDir, 'data', 'watchfloor.db'), { readonly: true });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 3);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM decision_revisions').get().n, 4);
    } finally { database.close(); }
    const stopped = new Promise(done => child.once('exit', done));
    child.kill('SIGTERM'); await stopped;
    await startServer();
    await navigate(independent, wirePath, formReady);
    assert.equal(await evaluate(independent, `document.querySelector('#wireInspector [name="note"]').value`), committed.decision.note);

    await navigate(first, '/briefing', '!!document.querySelector("#briefDrafts")');
    await evaluate(first, `document.querySelector('#briefDrafts').click()`);
    await waitFor(first, `!!document.querySelector('[data-draft-id="${seed.artifact.id}"]')`);
    await evaluate(first, `document.querySelector('[data-draft-id="${seed.artifact.id}"]').click()`);
    await waitFor(first, '!!document.querySelector("#draftRepair")');
    // Saving the same captured text is an explicit retention action; publication
    // still performs all real checks and writes a verifiable archive/receipt.
    await evaluate(first, `document.querySelector('[data-draft-save]').click()`);
    await waitFor(first, 'document.querySelector(".draft-review-note")?.textContent.includes("Draft saved")', 'Draft saved on the production server');
    await evaluate(first, `document.querySelector('[data-draft-close]').click(); document.querySelector('#briefDrafts').click()`);
    await waitFor(first, `!!document.querySelector('[data-draft-id="${seed.artifact.id}"]')`);
    await evaluate(first, `document.querySelector('[data-draft-id="${seed.artifact.id}"]').click()`);
    await waitFor(first, '!!document.querySelector("#draftRepair")');
    assert.equal(await evaluate(first, 'document.querySelector("#draftRepair").value'), seed.artifact.revisions.at(-1).content);
    await evaluate(first, `document.querySelector('[data-draft-publish]').click()`);
    await waitFor(first, 'location.pathname.startsWith("/briefing/brief-") && !document.querySelector(".brief-draft-dialog")', 'Publication and reader navigation');
    const filename = await evaluate(first, 'decodeURIComponent(location.pathname.split("/").at(-1))');
    assert.equal(await readFile(join(stateDir, 'briefs', filename), 'utf8'), seed.artifact.revisions.at(-1).content);
    const savedArtifact = await (await fetch(`${origin}/api/brief/drafts/${seed.artifact.id}`, { headers: auth })).json();
    assert.equal(savedArtifact.status, 'published');
    assert(savedArtifact.operatorSavedAt, 'Explicit draft save must survive reopen');

    await navigate(first, '/wall?read=1', '!!document.querySelector(".news-mode")');
    await evaluate(second, `localStorage.setItem('bt-wall-display', JSON.stringify({ size: 'largest', margin: 'safe', awake: false, fullscreen: false }))`);
    await waitFor(first, 'document.querySelector(".news-mode")?.dataset.displaySize === "largest"', 'Wall applies preferences from the settings tab');
    assert.equal(await evaluate(first, 'document.querySelector(".news-mode").dataset.displayMargin'), 'safe');
    for (const connection of connections) assert.deepEqual(await evaluate(connection, 'window.__cspViolations'), [], 'No production CSP violations');
    assert.deepEqual(errors, [], 'No browser errors or external requests');
    assert(!/pipeline.*(?:starting|complete)|fetching.*feed/i.test(logs), 'Disabled collection must stay disabled');
    console.log('PASS production server: authentication/CSP, settings, SQLite decisions and history, separate browsers, conflicts/imports/offline drafts, restart durability, draft publication, Wall preferences; no provider calls.');
  } catch (error) {
    throw new Error(`${error.message}\n${errors.join('\n')}\nServer output:\n${logs}`, { cause: error });
  } finally {
    for (const connection of connections) connection.close();
    try {
      if (browser) await browser.close();
    } finally {
      try {
        if (independentBrowser) await independentBrowser.close();
      } finally {
        if (child && child.exitCode === null) {
          child.kill('SIGTERM');
          await Promise.race([new Promise(done => child.once('exit', done)), delay(5000)]);
          if (child.exitCode === null) child.kill('SIGKILL');
        }
        // stateDir is always this invocation's mkdtemp child, never an operator path.
        assert(dirname(stateDir) === resolve(tmpdir()) && stateDir.startsWith(join(resolve(tmpdir()), 'blueteam-production-smoke-')));
        await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProductionSmoke();
}

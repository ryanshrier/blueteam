// Actual installed Safari via Apple's /usr/bin/safaridriver. No generic WebKit
// package, Selenium, live operator data, external API, or paid generation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { SafariWebDriver } from './safari-webdriver.mjs';

assert.equal(process.platform, 'darwin', 'This acceptance check requires actual macOS Safari. Run its macOS CI job.');
const directory = process.env.SAFARI_ARTIFACT_DIR ? resolve(process.env.SAFARI_ARTIFACT_DIR)
  : await mkdtemp(join(tmpdir(), 'blueteam-safari-'));
await mkdir(directory, { recursive: true });
const report = { status: 'running', synthetic: true, gitCommit: process.env.GITHUB_SHA || null,
  system: { platform: process.platform, release: release(), architecture: arch() }, checks: [],
  limits: ['Native OS print/Save PDF dialogs and download destinations are not exercised.', 'Desktop Safari automation window; no iOS or phone viewport emulation.', 'Screenshots require human visual review.'] };
let driver, client, fixtureServer, docsServer;
let driverLog = '';
const delay = ms => new Promise(done => setTimeout(done, ms));
const writes = [];
try {
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const driverPort = socket.address().port;
  await new Promise(done => socket.close(done));
  driver = spawn('/usr/bin/safaridriver', ['-p', String(driverPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [driver.stdout, driver.stderr]) stream.on('data', data => { driverLog = (driverLog + data).slice(-30_000); });
  driver.on('error', error => { driverLog += error.message; });
  client = new SafariWebDriver(`http://127.0.0.1:${driverPort}`);
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    assert(driver.exitCode === null, `SafariDriver exited: ${driverLog}`);
    try { ready = (await client.command('GET', '/status', undefined, 2_000)).ready; } catch { /* Driver is starting. */ }
    if (ready) break;
    await delay(100);
  }
  assert(ready, `SafariDriver did not become ready: ${driverLog}`);
  const session = await client.command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari', platformName: 'mac', pageLoadStrategy: 'normal' } } });
  client.sessionId = session.sessionId;
  report.capabilities = session.capabilities;
  assert.equal(session.capabilities.browserName.toLowerCase(), 'safari', 'Acceptance must use actual Safari');
  assert(session.capabilities.browserVersion, 'Record the Safari version');
  await client.session('POST', '/timeouts', { implicit: 0, pageLoad: 30_000, script: 15_000 });
  await client.session('POST', '/window/rect', { width: 1280, height: 900 });

  const fixtureApp = express();
  fixtureApp.use((req, _res, next) => { if (!['GET', 'HEAD'].includes(req.method)) writes.push(`${req.method} ${req.path}`); next(); });
  fixtureApp.use(createFixtureApp());
  fixtureServer = fixtureApp.listen(0, '127.0.0.1');
  docsServer = express().use(express.static(resolve('docs'), { etag: false, maxAge: 0 })).listen(0, '127.0.0.1');
  await Promise.all([fixtureServer, docsServer].map(server => new Promise(done => server.once('listening', done))));
  const origin = `http://127.0.0.1:${fixtureServer.address().port}`;
  const docsOrigin = `http://127.0.0.1:${docsServer.address().port}`;
  async function until(expression, label = expression) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (await client.execute(`return (${expression});`)) return; await delay(75); }
    assert.fail(`Safari timed out: ${label}`);
  }
  async function navigate(url) {
    await client.session('POST', '/url', { url });
    await client.session('POST', '/execute/async', { script: 'const done = arguments[arguments.length - 1]; document.fonts.ready.then(() => done(true), () => done(false));', args: [] });
  }
  async function record(name) {
    const metrics = await client.execute(`return { title:document.title, url:location.href, viewport:{width:innerWidth,height:innerHeight}, scrollWidth:document.documentElement.scrollWidth,
      errors:window.__fixtureErrors || [], failedImages:[...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src) };`);
    assert(metrics.scrollWidth <= metrics.viewport.width + 1, `${name}: no page horizontal overflow`);
    assert.deepEqual(metrics.errors, [], `${name}: no uncaught module errors`);
    assert.deepEqual(metrics.failedImages, [], `${name}: images loaded`);
    const image = await client.session('GET', '/screenshot');
    await writeFile(join(directory, `${name}.png`), Buffer.from(image, 'base64'));
    report.checks.push({ name, ...metrics });
    console.log(`PASS Safari ${session.capabilities.browserVersion}: ${name} (${metrics.viewport.width}x${metrics.viewport.height}).`);
  }
  await navigate(docsOrigin + '/');
  await until('document.querySelector("#hero-title") && [...document.images].filter(i => i.loading !== "lazy").every(i => i.complete && i.naturalWidth > 0)', 'public landing heading and visible images');
  await record('landing');
  await client.click('a[href="#start"]');
  await until('location.hash === "#start" && Math.abs(document.querySelector("#start").getBoundingClientRect().top) < 200', 'landing setup link reaches its content');
  await record('landing-setup');

  await navigate(origin + '/wire?scenario=source-revision&theme=dark&capture&reducedMotion');
  await until('document.querySelectorAll(".wire-item").length === 4');
  await client.click('[data-horizon="1"]');
  await until('document.querySelectorAll(".wire-item").length === 2');
  await record('wire-filtered');
  await client.execute('window.__evidenceOpener = document.querySelector("[data-evidence]");');
  await client.click('[data-evidence]');
  await until('document.querySelector(".evidence-dialog ins")');
  assert(await client.execute('return document.querySelector(".evidence-dialog").contains(document.activeElement);'), 'Evidence dialog owns initial focus');
  assert(await client.execute('return document.querySelector(".evidence-dialog del").textContent.includes("2.4.3") && document.querySelector(".evidence-dialog ins").textContent.includes("2.4.4");'), 'Actual retained revision changes are shown');
  for (const expanded of [false, true]) {
    await client.execute('document.querySelectorAll(".evidence-dialog details").forEach(d => { d.open = arguments[0]; });', [expanded]);
    for (const shift of [false, true]) {
      await client.execute('document.querySelector("[data-evidence-close]").focus();');
      const visited = new Set();
      for (let index = 0; index < 18; index++) {
        await client.key('\uE004', shift);
        const focus = await client.execute(`return { inside:document.querySelector('.evidence-dialog').contains(document.activeElement), label:document.activeElement.outerHTML };`);
        assert(focus.inside, `Safari evidence focus escaped: ${expanded ? 'expanded' : 'collapsed'} ${shift ? 'reverse' : 'forward'} Tab ${index + 1}`);
        visited.add(focus.label);
      }
      assert(visited.size >= 4, 'Safari keyboard actually traverses the dialog controls');
    }
    await record(`evidence-${expanded ? 'expanded' : 'collapsed'}`);
  }
  await client.key('\uE00C');
  assert(await client.execute('return !document.querySelector(".evidence-dialog") && document.activeElement === window.__evidenceOpener;'), 'Safari Escape closes evidence and restores the exact opener');

  await navigate(origin + '/briefing?scenario=handoff&theme=light&capture&reducedMotion');
  await until('document.querySelectorAll(".brief-judgment-card").length === 3 && !document.querySelector("#briefExport").disabled');
  await record('briefing');
  await client.click('#briefExport');
  await until('document.querySelector(".np-frame")?.contentDocument?.querySelector(".np-colophon") && !document.querySelector(".np-ov-print").disabled');
  const edition = await client.execute(`const frame = document.querySelector('.np-frame'); const doc = frame.contentDocument; return {
    warnings:[...doc.querySelectorAll('.np-validation li')].map(e=>e.textContent.trim()),
    headings:[...doc.querySelectorAll('h2,h3')].map(e=>e.textContent.trim()),
    width:frame.clientWidth, scrollWidth:doc.documentElement.scrollWidth, fonts:[...doc.fonts].filter(f=>f.status==='loaded').map(f=>f.family),
    colophon:doc.querySelector('.np-colophon').textContent.trim() };`);
  assert.equal(edition.warnings.length, 2, 'Safari Print Edition preserves saved review notes');
  assert(edition.fonts.length > 0, 'Safari loads print fonts');
  assert(edition.scrollWidth <= edition.width + 1, 'Safari Print Edition fits the iframe');
  assert(edition.colophon.includes('Verify every CVE ID'), 'Safari retains the print verification footer');
  for (const label of ['Executive summary', 'Developing situations', 'Convergence', 'Watchlist', 'Sources']) {
    assert(edition.headings.some(value => value.toLowerCase().includes(label.toLowerCase())), `Safari print preview contains ${label}`);
  }
  report.edition = edition;
  await record('print-preview');
  await client.execute('const doc = document.querySelector(".np-frame").contentDocument; doc.defaultView.scrollTo(0, doc.documentElement.scrollHeight);');
  await record('print-preview-end');
  await client.click('.np-ov-close');
  assert(await client.execute('return !document.querySelector(".np-overlay") && document.activeElement.id === "briefExport";'), 'Safari closes Print Edition and restores its opener');

  await navigate(origin + '/settings?scenario=normal&theme=dark&capture&reducedMotion');
  await until('document.querySelector("#profileTechnologies")?.value === "Gateway" && document.querySelector("#systemHealth")?.textContent.includes("42")');
  assert(await client.execute('return getComputedStyle(document.querySelector("#settingsStorageStatus")).display === "none";'), 'No empty Settings error banner');
  await record('settings');
  await client.click('[data-theme-choice="light"]');
  assert(await client.execute('return document.documentElement.dataset.theme === "light";'), 'Safari applies the appearance control');
  await record('settings-appearance');
  await navigate(origin + '/wall?operator&scenario=normal&kind=bluf&theme=light&capture&reducedMotion');
  await until('document.body.dataset.fixtureReady === "true"', 'paused production Wall fixture');
  await record('wall');
  assert.deepEqual(writes, [], 'Safari smoke performs no API writes');
  report.status = 'passed';
  console.log(`Safari artifacts: ${directory}. Inspect screenshots before visual acceptance. Native print dialogs remain untested.`);
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error);
  if (client?.sessionId) {
    try { await writeFile(join(directory, 'failure.png'), Buffer.from(await client.session('GET', '/screenshot', undefined, 5_000), 'base64')); } catch { /* Keep the initial error. */ }
  }
  throw error;
} finally {
  if (client?.sessionId) { try { await client.session('DELETE', '', undefined, 5_000); } catch { /* Driver cleanup below. */ } }
  if (driver && driver.exitCode === null) {
    driver.kill();
    await Promise.race([new Promise(done => driver.once('exit', done)), delay(3_000).then(() => driver.kill('SIGKILL'))]);
  }
  for (const server of [fixtureServer, docsServer]) if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await writeFile(join(directory, 'safaridriver.log'), driverLog);
  await writeFile(join(directory, 'acceptance-report.json'), JSON.stringify(report, null, 2));
}

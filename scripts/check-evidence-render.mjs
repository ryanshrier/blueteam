// Real production modules with synthetic APIs. Uses the existing dependency-free
// browser launcher; no database, settings writes, external sources or AI calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const browserPath = findBrowser();
assert(browserPath, 'Chrome/Chromium/Edge required. Set CHROME_PATH.');
const server = createFixtureApp().listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let connection;
const errors = [];
const delay = ms => new Promise(done => setTimeout(done, ms));

try {
  browser = await launchBrowser(browserPath);
  const response = await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' });
  const page = await response.json();
  connection = new CdpConnection(page.webSocketDebuggerUrl);
  await Promise.all([connection.call('Page.enable'), connection.call('Runtime.enable'), connection.call('Network.enable')]);
  connection.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.text || 'Browser exception'));
  connection.on('Network.requestWillBeSent', event => {
    if (/^https?:/.test(event.request.url) && !event.request.url.startsWith(`${origin}/`)) errors.push(`External request: ${event.request.url}`);
  });
  async function evaluate(expression) {
    const result = await connection.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  async function until(expression) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(50); }
    assert.fail(`Timed out: ${expression}`);
  }
  async function navigate(path) {
    await connection.call('Page.navigate', { url: origin + path });
    await until('document.readyState === "complete"');
    await evaluate('document.fonts.ready.then(() => true)');
  }
  async function key(key, code = key, shift = false) {
    await connection.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}), modifiers: shift ? 8 : 0, windowsVirtualKeyCode: key === 'Tab' ? 9 : key === 'Escape' ? 27 : 13 });
    await connection.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: shift ? 8 : 0 });
  }
  for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
    await connection.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 });
    await navigate(`/wire?scenario=source-revision&theme=${theme}&capture&reducedMotion`);
    await until('document.querySelector("[data-evidence]")');
    await evaluate('document.querySelector("[data-evidence]").focus()');
    await key('Enter');
    await until('document.querySelector(".evidence-dialog ins")');
    assert(await evaluate('document.querySelector(".evidence-dialog").contains(document.activeElement)'), 'Dialog owns initial focus');
    assert(await evaluate('document.querySelector(".evidence-dialog").textContent.includes("Local exposure and mitigation remain unverified")'));
    assert(await evaluate('document.querySelector(".evidence-dialog del").textContent.includes("2.4.3")'));
    assert(await evaluate('document.querySelector(".evidence-dialog ins").textContent.includes("2.4.4")'));
    const metrics = await evaluate(`(() => { const d = document.querySelector('.evidence-dialog'); const r = d.getBoundingClientRect(); return { width: innerWidth, right: r.right, left: r.left, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, controls: [...d.querySelectorAll('button, select, summary')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().height) }; })()`);
    assert(metrics.left >= 0 && metrics.right <= metrics.width + 1, `Dialog fits ${width}`);
    assert(metrics.scrollWidth <= metrics.clientWidth + 1, 'No internal horizontal overflow');
    assert(metrics.controls.every(height => height >= 44), 'Touch controls at least 44px');
    for (let i = 0; i < 12; i++) { await key('Tab'); assert(await evaluate('document.querySelector(".evidence-dialog").contains(document.activeElement)'), 'Tab stays in dialog'); }
    if (process.env.EVIDENCE_SCREENSHOT_DIR) {
      const directory = resolve(process.env.EVIDENCE_SCREENSHOT_DIR);
      await mkdir(directory, { recursive: true });
      await evaluate('document.querySelector(".evidence-dialog").scrollTop = 0');
      const shot = await connection.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(directory, `evidence-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await evaluate('document.querySelector("#evidenceSource").value = "1"; document.querySelector("#evidenceSource").dispatchEvent(new Event("change"))');
    await until('document.querySelector("#evidenceRecord").textContent.includes("independent source")');
    await key('Escape');
    assert(await evaluate('!document.querySelector(".evidence-dialog") && document.activeElement.matches("[data-evidence]")'), 'Escape restores row control focus');
    await navigate(`/wire?scenario=evidence-unavailable&theme=${theme}&capture`);
    await until('document.querySelector("[data-evidence]")');
    await evaluate('document.querySelector("[data-evidence]").click()');
    await until('document.querySelector("[data-evidence-retry]")');
    await key('Escape');
    await navigate(`/wire?scenario=normal&theme=${theme}&capture`);
    await until('document.querySelector("[data-evidence]")');
    await evaluate('document.querySelector("[data-evidence]").click()');
    await until('document.querySelector("#evidenceRecord").textContent.includes("No retained source observation")');
    await key('Escape');
    await navigate(`/settings?scenario=normal&theme=${theme}&capture`);
    await until('document.body.textContent.includes("Watch profile")');
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Settings fits viewport');
    await navigate(`/briefing?scenario=source-revision&theme=${theme}&capture`);
    await until('document.querySelector("#briefInputManifest a")');
    assert(await evaluate('document.querySelector("#briefInputManifest a").getAttribute("href").endsWith("/manifest")'), 'Saved input link names the current edition');
    assert(await evaluate('fetch(document.querySelector("#briefInputManifest a").href).then(r => r.json()).then(r => r.schemaVersion === 1 && r.synthetic === true)'), 'Rendered link resolves to the synthetic input receipt');
    await navigate(`/briefing?scenario=normal&theme=${theme}&capture`);
    await until('document.querySelector("#briefInputManifest")?.textContent.includes("unavailable for this edition")');
    assert(await evaluate('!document.querySelector("#briefInputManifest a")'), 'Historical edition has no fabricated receipt link');
    console.log(`PASS evidence ${width}px ${theme}: excerpts, changes, keyboard, source switch, errors, legacy, Settings, Briefing receipts`);
  }
  assert.deepEqual(errors, [], 'Browser errors or unexpected requests');
} finally {
  connection?.close();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}

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
  async function activate(selector) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await key('Enter');
  }
  async function openDisclosure(selector) {
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).open`)) return;
    await activate(`${selector} > summary`);
    await until(`document.querySelector(${JSON.stringify(selector)}).open`);
  }
  async function openSignalDetails(selector) {
    if (await evaluate('innerWidth >= 1000')) {
      await activate(`${selector} > summary`);
      await until('document.querySelector("#wireInspector:not([hidden]) .wire-inspector-content")');
      return '#wireInspector';
    }
    await openDisclosure(selector);
    return `${selector}[open]`;
  }
  async function openEvidence() {
    await until('document.querySelector("[data-evidence]")');
    const scope = await openSignalDetails('.wire-item:has([data-evidence]) .wire-details');
    await activate(`${scope} [data-evidence]`);
  }
  async function assertDialogKeyboardTraversal(label) {
    // The expectation is native document focus membership, independent of the
    // application's tabbable-control helper. Repeated traversal crosses both
    // ends of this fixed fixture's control sequence in each direction.
    for (const shift of [false, true]) {
      await evaluate('document.querySelector("[data-evidence-close]").focus()');
      for (let i = 0; i < 12; i++) {
        await key('Tab', 'Tab', shift);
        const contained = await evaluate('document.querySelector(".evidence-dialog").contains(document.activeElement)');
        if (!contained) console.error(`Evidence keyboard failure: ${label}, ${shift ? 'reverse' : 'forward'} Tab ${i + 1}`);
        assert(contained, 'Tab stays in dialog');
      }
    }
  }
  for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
    await connection.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 });
    await navigate(`/wire?scenario=source-revision&theme=${theme}&capture&reducedMotion`);
    await openEvidence();
    await until('document.querySelector(".evidence-dialog ins")');
    assert(await evaluate('document.querySelector(".evidence-dialog").contains(document.activeElement)'), 'Dialog owns initial focus');
    assert(await evaluate('document.querySelector(".evidence-dialog").textContent.includes("Local exposure and mitigation remain unverified")'));
    assert(await evaluate('document.querySelector(".evidence-dialog del").textContent.includes("2.4.3")'));
    assert(await evaluate('document.querySelector(".evidence-dialog ins").textContent.includes("2.4.4")'));
    const metrics = await evaluate(`(() => { const d = document.querySelector('.evidence-dialog'); const r = d.getBoundingClientRect(); return { width: innerWidth, right: r.right, left: r.left, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, controls: [...d.querySelectorAll('button, select, summary')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().height) }; })()`);
    assert(metrics.left >= 0 && metrics.right <= metrics.width + 1, `Dialog fits ${width}`);
    assert(metrics.scrollWidth <= metrics.clientWidth + 1, 'No internal horizontal overflow');
    assert(metrics.controls.every(height => height >= 44), 'Touch controls at least 44px');
    await assertDialogKeyboardTraversal(`${width}px ${theme}, initial disclosures`);
    for (const expanded of [false, true]) {
      await evaluate(`document.querySelectorAll('.evidence-dialog details').forEach(details => { details.open = ${expanded}; })`);
      await assertDialogKeyboardTraversal(`${width}px ${theme}, disclosures ${expanded ? 'expanded' : 'collapsed'}`);
    }
    if (process.env.EVIDENCE_SCREENSHOT_DIR) {
      const directory = resolve(process.env.EVIDENCE_SCREENSHOT_DIR);
      await mkdir(directory, { recursive: true });
      await evaluate('document.querySelector(".evidence-dialog").scrollTop = 0');
      const shot = await connection.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(directory, `evidence-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await openDisclosure('.evidence-source-picker');
    assert(await evaluate(`document.querySelector('[data-evidence-source="1"]')?.textContent.includes('Gateway investigation notes')`), 'Source picker keeps the distinguishing title readable');
    await activate('[data-evidence-source="1"]');
    await until('document.querySelector("#evidenceRecord").textContent.includes("independent source")');
    assert(await evaluate(`document.querySelector('[data-evidence-source="1"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('.evidence-source-picker').open`), 'Source selection updates and returns to the excerpt');
    await key('Escape');
    assert(await evaluate('!document.querySelector(".evidence-dialog") && document.activeElement.matches("[data-evidence]")'), 'Escape restores row control focus');
    await navigate(`/wire?scenario=evidence-unavailable&theme=${theme}&capture`);
    await openEvidence();
    await until('document.querySelector("[data-evidence-retry]")');
    await key('Escape');
    await navigate(`/wire?scenario=normal&theme=${theme}&capture`);
    await until('document.querySelector(".wire-details")');
    const legacyScope = await openSignalDetails('.wire-details');
    assert(await evaluate(`document.querySelector(${JSON.stringify(`${legacyScope} .wire-evidence-row .wire-retention-note`)})?.textContent.includes("No retained excerpt")`), 'Legacy evidence availability is explained in the responsive inspector');
    assert(await evaluate('!document.querySelector("[data-evidence]") && !document.querySelector(".evidence-dialog")'), 'Legacy rows do not offer an empty evidence dialog');
    await navigate(`/settings?scenario=normal&theme=${theme}&capture`);
    await until('document.body.textContent.includes("Watch profile")');
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Settings fits viewport');
    await until('document.querySelector("#aiProvider") && !document.querySelector("#aiProvider").disabled');
    await evaluate(`(() => { const select = document.querySelector('#aiProvider'); select.value = 'openai'; select.dispatchEvent(new Event('change')); document.querySelector('#set-ai').scrollIntoView({block:'start'}); })()`);
    assert(await evaluate('!document.querySelector("#openaiModelRow").hidden && document.querySelector("#apiKeyLabel").textContent === "OpenAI API key"'), 'OpenAI selection exposes its key and model');
    assert(await evaluate('!document.querySelector("#saveKey").disabled && document.documentElement.scrollWidth <= innerWidth + 1'), 'Provider can be saved and fits viewport');
    await evaluate(`(() => { const input = document.querySelector('#apiKey'); input.value = 'sk-proj-fixture'; input.dispatchEvent(new Event('input')); const select = document.querySelector('#aiProvider'); select.value = 'anthropic'; select.dispatchEvent(new Event('change')); })()`);
    assert(await evaluate('document.querySelector("#apiKey").value === ""'), 'Provider key drafts remain separate');
    await evaluate(`(() => { const select = document.querySelector('#aiProvider'); select.value = 'openai'; select.dispatchEvent(new Event('change')); })()`);
    assert(await evaluate('document.querySelector("#apiKey").value === "sk-proj-fixture"'), 'Switching back restores only that provider’s draft');
    if (process.env.EVIDENCE_SCREENSHOT_DIR) {
      const directory = resolve(process.env.EVIDENCE_SCREENSHOT_DIR);
      await mkdir(directory, { recursive: true });
      const shot = await connection.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(directory, `settings-openai-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await activate('#discardKey');
    await navigate(`/briefing?scenario=source-revision&theme=${theme}&capture`);
    await until('document.querySelector("[data-open-inputs]")');
    await openDisclosure('#briefEditionTools');
    await activate('[data-open-inputs]');
    await until('document.querySelector(".brief-input-dialog .brief-input-intro")');
    assert(await evaluate('document.querySelector("#briefInputTitle").textContent === "Edition sources and inputs" && !!document.querySelector(".brief-input-facts")'), 'Saved inputs open as a readable edition summary');
    await openDisclosure('.brief-input-download');
    assert(await evaluate('document.querySelector(".brief-input-download a").getAttribute("href").endsWith("/manifest") && document.querySelector(".brief-input-download a").hasAttribute("download")'), 'Advanced JSON download names the current edition');
    assert(await evaluate('(() => { const link = document.querySelector(".brief-input-download a"); return fetch(link.href).then(r => r.json()).then(r => r.schemaVersion === 1 && r.synthetic === true && r.edition.filename === decodeURIComponent(new URL(link.href).pathname.split("/")[3])); })()'), 'Readable receipt and optional JSON download resolve to the current synthetic edition');
    await key('Escape');
    assert(await evaluate('!document.querySelector(".brief-input-dialog") && document.activeElement.matches("[data-open-inputs]")'), 'Saved-input dialog restores its opener');
    await navigate(`/briefing?scenario=normal&theme=${theme}&capture`);
    await until('document.querySelector("#briefInputManifest")?.textContent.includes("unavailable for this edition")');
    await openDisclosure('#briefEditionTools');
    assert(await evaluate('!document.querySelector("[data-open-inputs]") && !document.querySelector("#briefInputManifest a")'), 'Historical edition has no fabricated receipt action');
    console.log(`PASS evidence ${width}px ${theme}: excerpts, changes, keyboard, source switch, errors, legacy, Settings, Briefing receipts`);
  }
  assert.deepEqual(errors, [], 'Browser errors or unexpected requests');
} finally {
  connection?.close();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}

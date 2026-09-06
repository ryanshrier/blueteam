// Production UI + read-only synthetic APIs. Run in CI or an explicitly chosen
// isolated browser environment; never connect this check to an operator server.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';
import { inspectPdfBounds, inspectPdfText, parseCsv } from './handoff-acceptance.mjs';
import { buildAppFixture } from '../test/visual/app-fixtures.js';

const run = promisify(execFile);
const delay = ms => new Promise(done => setTimeout(done, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = process.env.HANDOFF_ARTIFACT_DIR
  ? resolve(process.env.HANDOFF_ARTIFACT_DIR) : await mkdtemp(join(tmpdir(), 'blueteam-handoff-'));
await mkdir(directory, { recursive: true });
const downloads = await mkdtemp(join(directory, 'downloads-'));
const report = {
  status: 'running', synthetic: true, gitCommit: process.env.GITHUB_SHA || null,
  coverage: 'Production Wire Blob downloads and Chromium pagination of the unchanged production Print Edition iframe document.',
  limits: ['Native OS print dialog and Save PDF interaction are not tested.', 'Safari and WebKit are not tested.', 'Page images require human visual review; text/bounds checks do not prove visual fidelity.'],
  downloads: [], errors: [],
};
let server, browser, control, page;
const connections = [];
try {
  for (const tool of ['pdfinfo', 'pdftotext', 'pdftoppm']) {
    const result = await run(tool, ['-v'], { windowsHide: true });
    report[tool] = (result.stdout + result.stderr).split('\n')[0];
  }
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Chromium/Edge required. Set CHROME_PATH.');
  server = createFixtureApp().listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser(browserPath);
  const version = await (await fetch(`${browser.debugOrigin}/json/version`)).json();
  control = new CdpConnection(version.webSocketDebuggerUrl);
  report.browser = await control.call('Browser.getVersion');
  await control.call('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
  const receipts = new Map();
  control.on('Browser.downloadWillBegin', event => receipts.set(event.guid, { ...event }));
  control.on('Browser.downloadProgress', event => {
    const receipt = receipts.get(event.guid);
    if (receipt) Object.assign(receipt, event);
  });
  async function openPage() {
    const target = await (await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
    const connection = new CdpConnection(target.webSocketDebuggerUrl);
    connections.push(connection);
    await Promise.all(['Page', 'Runtime', 'Network'].map(domain => connection.call(`${domain}.enable`)));
    connection.on('Runtime.exceptionThrown', event => report.errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
    connection.on('Network.requestWillBeSent', event => {
      if (/^https?:/.test(event.request.url) && !event.request.url.startsWith(`${origin}/`)) report.errors.push(`Unexpected external request: ${event.request.url}`);
    });
    return connection;
  }
  async function evaluate(connection, expression) {
    const result = await connection.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  async function until(test, label) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (await test()) return; await delay(50); }
    assert.fail(`Timed out: ${label}`);
  }
  async function navigate(connection, path) {
    const loaded = connection.waitFor('Page.loadEventFired');
    await connection.call('Page.navigate', { url: origin + path });
    await loaded;
    await evaluate(connection, 'document.fonts.ready.then(() => true)');
  }
  async function activate(selector) {
    // Real browser keyboard activation, not an exporter helper or click mock.
    await evaluate(page, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) throw Error('Control unavailable'); e.scrollIntoView({block:'center'}); e.focus(); })()`);
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  async function screenshot(connection, name) {
    const shot = await connection.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(directory, name), Buffer.from(shot.data, 'base64'));
  }
  page = await openPage();
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate(page, '/wire?scenario=handoff&theme=dark&capture&reducedMotion');
  await until(() => evaluate(page, 'document.querySelectorAll(".wire-item").length === 4'), 'four fixture signals');
  await activate('[data-horizon="1"]');
  await until(() => evaluate(page, 'document.querySelectorAll(".wire-item").length === 2'), 'Horizon 1 filter');
  await activate('[data-mark-read="https://example.test/synthetic-0"]');
  assert(await evaluate(page, 'document.querySelector("[data-mark-read]").getAttribute("aria-pressed") === "true"'), 'Marked-read state is applied before export');
  await screenshot(page, 'wire-filtered.png');
  const expected = buildAppFixture('handoff').headlines.headlines.filter(item => item.horizon === 1);
  for (const format of ['csv', 'json']) {
    const previous = new Set(receipts.keys());
    await activate('#wireExport > summary');
    await activate(`[data-export="${format}"]`);
    let receipt;
    await until(() => {
      receipt = [...receipts.values()].find(item => !previous.has(item.guid));
      assert(receipt?.state !== 'canceled', `${format} download canceled`);
      return receipt?.state === 'completed';
    }, `${format} browser download completion`);
    assert(receipt.url.startsWith(`blob:${origin}/`), 'Download originates from the production Blob URL');
    assert.match(receipt.guid, /^[a-zA-Z0-9-]+$/, 'Download GUID is a safe local filename');
    assert.match(receipt.suggestedFilename, new RegExp(`^wire-signals-.+\\.${format}$`));
    let bytes;
    await until(async () => {
      try { bytes = await readFile(join(downloads, receipt.guid)); return bytes.length === receipt.receivedBytes; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }, `${format} received file is available on disk`);
    assert.equal(bytes.length, receipt.receivedBytes, 'Saved bytes match the browser receipt');
    assert(bytes.length > 100, 'Nonempty download');
    await writeFile(join(directory, `wire-filtered.${format}`), bytes);
    const rows = format === 'json' ? JSON.parse(bytes.toString('utf8')) : parseCsv(bytes.toString('utf8'));
    assert.equal(rows.length, 2, 'Only the two visible filtered signals are exported');
    for (const [index, source] of expected.entries()) {
      assert.equal(rows[index].link, source.link, 'Export order and identity match filtered rows');
      assert.equal(rows[index].title, format === 'csv' ? `'${source.title}` : source.title, 'Formula-like titles remain data');
      assert.equal(rows[index].description, format === 'csv' && index === 1 ? `'${source.description}` : source.description, 'Quoted/multiline descriptions round-trip');
      assert.equal(rows[index].read, format === 'csv' ? String(index === 0) : index === 0, 'Analyst read state survives download');
      assert.equal(Number(rows[index].horizon), 1);
    }
    assert(!(await evaluate(page, 'document.querySelector("#wireExport").open')), 'Export menu closes after activation');
    report.downloads.push({ ...receipt, artifact: `wire-filtered.${format}`, sha256: hash(bytes), rows: rows.length });
    console.log(`PASS: genuine ${format.toUpperCase()} Blob download (${bytes.length} bytes, two filtered rows, read state and escaped cells).`);
  }

  await navigate(page, '/briefing?scenario=handoff&theme=dark&capture&reducedMotion');
  await until(() => evaluate(page, 'document.querySelector("#briefExport") && !document.querySelector("#briefExport").disabled && document.querySelectorAll(".brief-judgment-card").length === 3'), 'complete saved synthetic edition');
  await activate('#briefExport');
  await until(() => evaluate(page, 'document.querySelector(".np-frame")?.contentDocument?.querySelector(".np-colophon") && !document.querySelector(".np-ov-print").disabled'), 'production Print Edition and fonts');
  await screenshot(page, 'print-preview.png');
  const preview = await evaluate(page, `(() => {
    const frame = document.querySelector('.np-frame');
    const doc = frame.contentDocument;
    const passageElements = [...doc.querySelectorAll('.np-body p, .np-body li:not(:has(li)):not(:has(p)), .np-exec-action-task > strong, .np-exec-action-due, .np-exec-fact-label, .np-body h2, .np-body h3, .np-validation li, .np-colophon')].filter(e => e.innerText.trim().length > 15);
    const passages = passageElements.map(e => e.innerText.trim());
    const executiveContextIndices = passageElements.flatMap((e, index) => e.matches('.brief-exec-heading, .np-exec-facts p') ? [index] : []);
    return { source: frame.srcdoc, dom: doc.documentElement.outerHTML, passages, executiveContextIndices,
      title: doc.title, warnings: [...doc.querySelectorAll('.np-validation li')].map(e => e.textContent.trim()),
      headings: [...doc.querySelectorAll('.np-body h2, .np-body h3')].map(e => e.textContent.trim()),
      viewport: { width: innerWidth, height: innerHeight, frameWidth: frame.clientWidth, frameHeight: frame.clientHeight },
      fonts: [...doc.fonts].filter(f => f.status === 'loaded').map(f => ({family:f.family, style:f.style, weight:f.weight})) };
  })()`);
  assert.equal(preview.warnings.length, 2, 'Persisted review notes reach Print Edition');
  assert(preview.passages.length > 30, 'Complete edition paragraphs are checked');
  assert(preview.fonts.length > 0, 'Print preview uses loaded self-hosted fonts');
  for (const heading of ['Executive summary', 'Developing situations', 'Convergence', 'Watchlist', 'Sources']) {
    assert(preview.headings.some(value => value.toLowerCase().includes(heading.toLowerCase())), `Preview retains ${heading}`);
  }
  await writeFile(join(directory, 'production-print-document.html'), preview.source);
  await writeFile(join(directory, 'production-print-dom.html'), preview.dom);
  await writeFile(join(directory, 'print-expectations.json'), JSON.stringify(preview, null, 2));

  // CDP Page.printToPDF targets a top-level page, not a child iframe. Install
  // the exact production srcdoc in a same-origin blank target, with no style or
  // content edits. Confirm its parsed DOM is identical before paginating it.
  const printPage = await openPage();
  await navigate(printPage, '/fixtures/handoff-print-target.html');
  const { frameTree } = await printPage.call('Page.getFrameTree');
  await printPage.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: preview.source });
  await until(() => evaluate(printPage, 'document.readyState === "complete"'), 'print target styles');
  await evaluate(printPage, 'document.fonts.ready.then(() => true)');
  assert.equal(await evaluate(printPage, 'document.documentElement.outerHTML'), preview.dom, 'PDF target preserves the exact production iframe DOM and CSS');
  const printOptions = { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, paperWidth: 8.5, paperHeight: 11 };
  const pdf = await printPage.call('Page.printToPDF', printOptions);
  const pdfBytes = Buffer.from(pdf.data, 'base64');
  assert(pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-')), 'Browser returned a genuine PDF');
  const pdfPath = join(directory, 'print-edition.pdf');
  await writeFile(pdfPath, pdfBytes);
  const { stdout: info } = await run('pdfinfo', [pdfPath], { windowsHide: true });
  await writeFile(join(directory, 'pdfinfo.txt'), info);
  // Default extraction reconstructs reading order across the executive columns;
  // retain a separate physical-layout extraction for human review.
  await run('pdftotext', [pdfPath, join(directory, 'print-edition.txt')], { windowsHide: true });
  await run('pdftotext', ['-layout', pdfPath, join(directory, 'print-edition-layout.txt')], { windowsHide: true });
  await run('pdftotext', ['-bbox-layout', pdfPath, join(directory, 'print-edition-bounds.html')], { windowsHide: true });
  // Keep rendered pages even if a text/bounds assertion subsequently fails.
  await run('pdftoppm', ['-r', '110', '-png', pdfPath, join(directory, 'print-page')], { windowsHide: true, timeout: 60_000 });
  const pages = (await readdir(directory)).filter(name => /^print-page-\d+\.png$/.test(name)).sort();
  const images = [];
  for (const name of pages) {
    const bytes = await readFile(join(directory, name));
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Poppler emitted PNG');
    images.push({ name, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: hash(bytes) });
  }
  report.pdf = { artifact: 'print-edition.pdf', sha256: hash(pdfBytes), bytes: pdfBytes.length, printOptions, images,
    sourceSha256: hash(preview.source), domSha256: hash(preview.dom), viewport: preview.viewport, fonts: preview.fonts, warnings: preview.warnings };
  const text = await readFile(join(directory, 'print-edition.txt'), 'utf8');
  const bboxHtml = await readFile(join(directory, 'print-edition-bounds.html'), 'utf8');
  const textResult = inspectPdfText(text, preview.passages, bboxHtml);
  const bounds = inspectPdfBounds(bboxHtml);
  assert.equal(bounds.length, textResult.pageCount, 'Bounding-box and text page counts agree');
  assert.equal(images.length, textResult.pageCount, 'Every PDF page has a review image');
  Object.assign(report.pdf, textResult, { bounds });
  assert.equal(preview.executiveContextIndices.length, 3, 'Executive heading and both context paragraphs are located in the PDF');
  const contextPages = new Set(preview.executiveContextIndices.flatMap(index => textResult.passagePositions[index].pages));
  assert.equal(contextPages.size, 1, 'Executive heading and parallel context row fit together on one PDF page');
  report.pdf.executiveContextPage = [...contextPages][0];
  assert.deepEqual(report.errors, [], 'No browser exceptions or external API requests');
  report.status = 'passed';
  console.log(`PASS: Chromium PDF has ${textResult.pageCount} nonblank pages, ${textResult.checkedPassages} retained passages, both review notes, final source evidence and verification footer.`);
  console.log(`Review every print-page PNG and print-edition.pdf in ${directory}. Native OS print dialogs and Safari remain separate manual checks.`);
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack || String(error);
  if (page) {
    try {
      const shot = await page.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(directory, 'failure.png'), Buffer.from(shot.data, 'base64'));
    } catch { /* Preserve the original failure. */ }
  }
  throw error;
} finally {
  await writeFile(join(directory, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  for (const connection of connections) connection.close();
  control?.close();
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(done => server.close(done));
}

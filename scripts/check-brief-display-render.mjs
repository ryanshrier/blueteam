// Real reader and Wall, frozen input, no provider or operator-state writes.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { displayFixture } from '../test/fixtures/brief-display.js';
import { briefPresentation } from '../lib/brief-reading-checks.js';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';
import { createFixtureRequestGuard } from './fixture-request-guard.mjs';
const { values } = parseArgs({ options: { output: { type: 'string' }, edition: { type: 'string' } } });
const output = resolve(values.output || '.tmp/brief-display-render');
await mkdir(output, { recursive: true });
const fixture = displayFixture();
const edition = values.edition ? JSON.parse(await readFile(resolve(values.edition), 'utf8')) : {
  filename: 'brief-2026-11-02-01.md', content: fixture.content, generatedAt: '2026-11-02T12:00:00Z',
  disposition: { status: 'eligible', eligibleForLatest: true },
  presentation: briefPresentation({ original: fixture.content, content: fixture.content,
    manifest: { displayCopy: fixture.displayCopy, publicationValidation: { validationPolicyVersion: 4, issues: [] } },
    disposition: { status: 'eligible', eligibleForLatest: true } }),
};
const app = createFixtureApp();
app.get('/display-fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">${['fonts','tokens','app','wall','frontend-refinement','briefing-refinement'].map(name => `<link rel="stylesheet" href="/${name}.css">`).join('')}</head><body><main class="app-main" id="main" tabindex="-1"></main><div id="wallLayer"></div><div id="toastContainer"></div></body></html>`));
const server = app.listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [], results = [];
let browser, cdp, guard;
const delay = ms => new Promise(done => setTimeout(done, ms));
try {
  browser = await launchBrowser(findBrowser());
  const tab = await (await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = new CdpConnection(tab.webSocketDebuggerUrl);
  await Promise.all([cdp.call('Page.enable'), cdp.call('Runtime.enable')]);
  cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  guard = createFixtureRequestGuard(cdp, { origin, errors }); await guard.enable();
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description); return result.result.value;
  };
  for (const scenario of [
    { mode: 'overview', width: 1440, height: 1000 }, { mode: 'overview', width: 390, height: 844 },
    { mode: 'report', width: 1440, height: 1000 }, { mode: 'wall', width: 1920, height: 1080 },
    { mode: 'wall', width: 1280, height: 720 }, { mode: 'wall', width: 1280, height: 720, size: 'largest' },
    { mode: 'wall', width: 1280, height: 720, legacy: true },
  ]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.waitFor('Page.loadEventFired');
    await cdp.call('Page.navigate', { url: origin + '/display-fixture' }); await loaded;
    const reading = structuredClone(edition);
    if (scenario.legacy) delete reading.presentation.displayCopy;
    await evaluate(`(${boot.toString()})(${JSON.stringify(reading)},${JSON.stringify(scenario)})`);
    await evaluate('document.fonts.ready'); await delay(100);
    const name = `${scenario.mode}-${scenario.width}${scenario.size ? '-' + scenario.size : ''}${scenario.legacy ? '-archive' : ''}`;
    const frames = [];
    for (let index = 0; index < (scenario.mode === 'wall' ? 40 : 1); index++) {
      const frame = await evaluate(`(async()=>{const body=document.querySelector('#nbBody');const {viewportReadingText,readingStops}=await import('/modules/wall/wall-reading.js');const {displayDwellMs}=await import('/modules/wall/wall-presentation.js');return {position:document.querySelector('#nbTopicPosition')?.innerText,headline:document.querySelector('.nb-glance-headline')?.innerText,scrollTop:body?.scrollTop,stops:body?readingStops(body):[],durationMs:body?displayDwellMs(viewportReadingText(body,readingStops(body)),'normal'):null,paragraphs:document.querySelectorAll('.nb-glance-summary').length,text:body?.innerText,documentHeight:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,firstStoryY:document.querySelector('.brief-overview-story h2')?.getBoundingClientRect().top};})()`);
      if (index && frame.position?.startsWith('Topic 01') && frame.scrollTop === 0) break;
      assert(!frame.overflow, `${name}: horizontal overflow`);
      if (scenario.mode === 'overview' && scenario.width < 600) assert(frame.firstStoryY < scenario.height - 100, 'Phone shows the first story before the fold');
      const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      frame.screenshot = `${name}-${index + 1}.png`;
      await writeFile(join(output, frame.screenshot), Buffer.from(shot.data, 'base64')); frames.push(frame);
      if (scenario.mode === 'wall') {
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
        await delay(350);
      }
    }
    const cycleMs = frames.reduce((sum, frame) => sum + (frame.durationMs || 0), 0);
    assert(frames.length < 40, `${name}: cycle never returned to its opening`);
    if (!values.edition && scenario.mode === 'wall' && !scenario.legacy && !scenario.size) {
      assert.equal(frames.length, 7, `${name}: reference opening and six stories each fit one screen`);
      assert(cycleMs < 300_000, `${name}: reference cycle exceeds five minutes`);
    }
    if (scenario.legacy) assert(frames.some(frame => frame.paragraphs > 1), 'Archive retains paragraph boundaries');
    results.push({ ...scenario, frames, cycleMs });
    await evaluate('window.__cleanupDisplay?.()');
    console.log(JSON.stringify({ name, frames: frames.length, cycleMs }));
  }
  await guard.settle(); assert.deepEqual(errors, []);
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ edition: edition.filename, synthetic: !values.edition, results, errors }, null, 2));
  guard?.dispose(); cdp?.close(); if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
}

async function boot(edition, scenario) {
  const filename = edition.filename;
  const originalFetch = window.fetch;
  window.fetch = async (url, options = {}) => {
    if (!String(url).startsWith('/api/')) return originalFetch(url, options);
    if (options.method && options.method !== 'GET') throw new Error('Unexpected fixture mutation');
    let data;
    if (url === '/api/settings') data = { ai: { enabled: true } };
    else if (url === '/api/brief/status') data = { persistence: 'ok', publicationRevision: 'fixture', active: false, latest: null, draftRecovery: { items: [] } };
    else if (url === '/api/briefs') data = [{ filename, disposition: edition.disposition }];
    else if (url === `/api/brief/${filename}`) data = edition;
    else if (url === '/api/headlines') data = { headlines: [] };
    else if (url === '/api/landscape') data = { brief: { filename, date: '2026-11-02' }, generatedAt: edition.generatedAt, signals: [], feeds: { ok: 1, total: 1 } };
    else if (url === '/api/edition') data = {};
    else if (url === '/api/health') data = { uptime: 100 };
    else throw new Error(`Unexpected fixture endpoint: ${url}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const wait = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 10)); } throw new Error('Display fixture timed out'); };
  if (scenario.mode === 'wall') {
    history.replaceState({}, '', '/wall');
    localStorage.setItem('bt-wall-display', JSON.stringify({ size: scenario.size || 'standard', fullscreen: false, awake: false }));
    const wall = await import('/modules/wall/wall-view.js');
    wall.mount(document.querySelector('#wallLayer'));
    await wait(() => document.querySelector('.nb-glance-headline') && document.querySelector('#nbTopicPosition')?.innerText.includes('Topic'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    window.__cleanupDisplay = wall.unmount;
  } else {
    history.replaceState({}, '', `/briefing/${filename}`);
    const { setState } = await import('/modules/core/store.js');
    const reader = await import('/modules/briefing/briefing-view.js');
    setState({ mode: 'briefing', isGenerating: false, currentBrief: null }); reader.render(document.querySelector('#main'));
    await wait(() => document.querySelector('#briefContent')?._validatedBriefContent === edition.content);
    document.querySelector(scenario.mode === 'report' ? '#briefReadingMode' : '#briefOverviewMode').click();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); scrollTo(0, 0);
    if (scenario.mode === 'overview' && scenario.width < 600) {
      const introduction = document.querySelector('.brief-overview-introduction');
      if (!introduction || introduction.open) throw new Error('Phone introduction should start collapsed');
      introduction.querySelector('summary').click();
      if (!introduction.open || !introduction.querySelector('.brief-overview-edition-note').textContent.trim()) throw new Error('Complete introduction must remain available');
      introduction.querySelector('summary').click();
    }
    window.__cleanupDisplay = reader.unmount;
  }
}

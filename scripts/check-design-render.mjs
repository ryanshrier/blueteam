// North-star frontend integration: real production modules, read-only fixtures.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const output = resolve(process.env.DESIGN_SCREENSHOT_DIR || 'docs/audits/2026-09-06/north-star/implemented');
await mkdir(output, { recursive: true });
const server = createFixtureApp().listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser(findBrowser());
let page;
const records = [], errors = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
try {
  const target = await (await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  page = new CdpConnection(target.webSocketDebuggerUrl);
  await Promise.all(['Page', 'Runtime', 'Network'].map(domain => page.call(`${domain}.enable`)));
  page.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on('Network.requestWillBeSent', event => {
    if (/^https?:/.test(event.request.url) && !event.request.url.startsWith(`${origin}/`)) errors.push(`Unexpected external request: ${event.request.url}`);
  });
  async function evaluate(expression) {
    const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  async function until(expression) {
    const end = Date.now() + 18000;
    while (Date.now() < end) { if (await evaluate(expression)) return; await delay(60); }
    assert.fail(`Timeout: ${expression}`);
  }
  async function navigate(path) {
    const loaded = page.waitFor('Page.loadEventFired');
    await page.call('Page.navigate', { url: origin + path });
    await loaded;
    await evaluate('document.fonts.ready.then(() => true)');
  }
  async function activate(selector) {
    await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e || e.disabled || !e.getClientRects().length) throw Error('Unavailable control: ${selector}'); e.scrollIntoView({block:'nearest'}); e.focus(); })()`);
    await page.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
    await page.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  }
  async function screenshot(name) {
    await delay(100);
    const dimensions = await evaluate(`(() => { const first=document.querySelector('.brief-overview-lead h2, .wire-item'); const r=first?.getBoundingClientRect(); return {width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,firstContentY:r?.y,columns:document.querySelector('.brief-overview-grid')?getComputedStyle(document.querySelector('.brief-overview-grid')).gridTemplateColumns:null}; })()`);
    assert(dimensions.pageWidth <= dimensions.width, `Horizontal fit: ${name}`);
    const shot = await page.call('Page.captureScreenshot',{format:'png'});
    await writeFile(resolve(output,`${name}.png`),Buffer.from(shot.data,'base64'));
    records.push({name,...dimensions});
    console.log(`PASS ${name}: ${dimensions.width}px; first content y=${Math.round(dimensions.firstContentY || 0)}`);
  }
  for(const width of [390, 1024, 1440]) for(const theme of ['light','dark']) {
    await page.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
    await navigate(`/briefing?scenario=sample&theme=${theme}&capture&reducedMotion`);
    await until('!!document.querySelector(".brief-overview-lead")');
    await activate('#briefOverviewMode');
    await until('!!document.querySelector(".brief-overview-timeline")');
    assert(await evaluate('document.querySelector(".briefing-layout").hidden'), 'Full report is preserved but hidden during Overview');
    await screenshot(`overview-${width}-${theme}`);
    const original = await evaluate('document.querySelector("#briefContent").textContent');
    await activate('.brief-overview-lead [data-overview-open]');
    assert(await evaluate('!document.querySelector(".briefing-layout").hidden && document.querySelector("#briefOverview").hidden'), 'Assessment link opens full report');
    assert(await evaluate('document.activeElement.id === "judgment-1"'), 'Assessment link restores heading focus');
    assert.equal(await evaluate('document.querySelector("#briefContent").textContent'),original,'Changing view preserves authored content');
    assert(await evaluate('document.querySelector(".brief-judgment-card > .assessment-meta") !== null'), 'Judgment metadata visible');
    if(width===1440) await screenshot(`reader-${theme}`);
    await activate('#briefOverviewMode');
    await evaluate('scrollTo(0,0)');
    await navigate(`/wire?scenario=normal&theme=${theme}&capture&reducedMotion`);
    await until('!!document.querySelector(".wire-item")');
    await screenshot(`wire-${width}-${theme}`);
    if(width===390) assert(await evaluate('document.querySelector(".wire-item").getBoundingClientRect().top <= 320'), 'Mobile first signal is accessible within opening screen');
    await activate('#wireViewTools > summary');
    assert(await evaluate('document.querySelector("#wireSortHost select").getClientRects().length > 0'), 'View tools expose sorting');
    await screenshot(`wire-tools-${width}-${theme}`);
  }
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  for(const scenario of ['long','sparse','stale','sourceerror','evidence']) {
    await navigate(`/briefing?scenario=${scenario}&theme=light&capture&reducedMotion`);
    await until('!!document.querySelector(".brief-overview-lead")');
    await activate('#briefOverviewMode');
    await until('!document.querySelector("[data-overview-recent]").textContent.includes("Loading current")');
    if(['stale','sourceerror'].includes(scenario)) assert(await evaluate('!!document.querySelector("[data-overview-recent] [data-level=warning]")'), 'Reporting failures/staleness explicitly labeled');
    if(scenario === 'evidence') {
      const sources = await evaluate(`(() => { const links = (host, selector) => [...host.querySelectorAll(selector)].map(link => link.href); return { overview: links(document, '.brief-overview-lead .assessment-meta__source'), report: links(document.querySelector('.brief-judgment-card'), ':scope > .assessment-meta .assessment-meta__source') }; })()`);
      assert(sources.overview.length > 0, 'Resolved sources are present in the overview');
      assert.deepEqual(sources.overview, sources.report, 'Overview and report retain the same lead sources');
    }
    await screenshot(`overview-${scenario}`);
  }
  await navigate('/briefing?scenario=empty&capture&reducedMotion');
  await until('!!document.querySelector(".empty-state")');
  assert(await evaluate('!document.querySelector(".briefing-layout").hidden'), 'No-brief state stays visible');
  await screenshot('briefing-empty');
  await navigate('/settings?scenario=normal&theme=light&capture&reducedMotion');
  await until('!!document.querySelector("#main input, #main textarea")');
  await screenshot('settings-light');
  assert.deepEqual(errors,[], 'No browser exceptions or external requests');
} finally {
  await writeFile(resolve(output,'measurements.json'),JSON.stringify({records,errors},null,2));
  page?.close();
  const profile = resolve(browser.profile);
  assert(profile.startsWith(resolve(tmpdir()) + sep) && profile.split(sep).at(-1).startsWith('blueteam-landing-browser-'));
  await browser.close();
  server.close();
}

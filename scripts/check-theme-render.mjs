// Theme acceptance against isolated synthetic APIs and real app renderers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const output = resolve(process.env.THEME_SCREENSHOT_DIR || 'docs/audits/2026-09-06/theme-pass');
await mkdir(output, { recursive: true });
const server = createFixtureApp().listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const records = [], errors = [], accentChecks = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
try {
  browser = await launchBrowser(findBrowser());
  const target = await (await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  page = new CdpConnection(target.webSocketDebuggerUrl);
  await Promise.all(['Page', 'Runtime'].map(domain => page.call(`${domain}.enable`)));
  page.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  async function evaluate(expression) {
    const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  async function until(expression) {
    for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await delay(50); }
    assert.fail(`Timed out: ${expression}`);
  }
  async function navigate(path, width) {
    await page.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    const loaded = page.waitFor('Page.loadEventFired');
    await page.call('Page.navigate', { url: origin + path }); await loaded;
    await evaluate('document.fonts.ready.then(() => true)'); await delay(200);
  }
  async function shot(name, theme) {
    const record = await evaluate(`(() => { const s=getComputedStyle(document.documentElement); return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme,scheme:s.colorScheme,workspace:s.getPropertyValue('--bg-primary').trim(),reading:s.getPropertyValue('--bg-reading').trim(),selection:s.getPropertyValue('--bg-selected').trim(),hover:s.getPropertyValue('--bg-hover').trim()}; })()`);
    assert.equal(record.theme, theme);
    assert.equal(record.scheme, theme, 'Native controls follow the explicit theme');
    assert(record.pageWidth <= record.width + 1, `${name}: horizontal fit`);
    assert.notEqual(record.workspace, record.reading, 'Reading ground differs from workspace');
    assert.notEqual(record.selection, record.hover, 'Selection differs from hover');
    const image = await page.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(output, `${name}.png`), Buffer.from(image.data, 'base64'));
    records.push({ name, ...record }); console.log(`PASS ${name}`);
  }
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const query = `&theme=${theme}&capture&reducedMotion`;
    await navigate(`/wire?scenario=source-revision${query}`, width);
    await until('!!document.querySelector(".wire-item")');
    await shot(`wire-${width}-${theme}`, theme);
    await evaluate('document.querySelector(".wire-details > summary").click()');
    await until(width >= 1000 ? '!!document.querySelector("#wireInspector:not([hidden])")' : '!!document.querySelector(".wire-details[open]")');
    await shot(`inspection-${width}-${theme}`, theme);
    await evaluate(`document.querySelector('${width >= 1000 ? '#wireInspector' : '.wire-details[open]'} [data-evidence]').click()`);
    await until('!!document.querySelector(".evidence-diff ins")');
    const content = await evaluate('document.querySelector(".evidence-dialog").textContent');
    const opposite = theme === 'light' ? 'dark' : 'light';
    await evaluate(`import('/modules/core/theme.js').then(m=>m.applyTheme('${opposite}'))`);
    assert.equal(await evaluate('document.querySelector(".evidence-dialog").textContent'), content, 'Theme switch preserves evidence');
    await evaluate(`import('/modules/core/theme.js').then(m=>m.applyTheme('${theme}'))`);
    await shot(`evidence-${width}-${theme}`, theme);
    await navigate(`/briefing?scenario=sample${query}`, width);
    await until('!!document.querySelector(".brief-overview")');
    await shot(`briefing-${width}-${theme}`, theme);
    await navigate(`/settings?scenario=normal${query}`, width);
    await until('!!document.querySelector("#saveProfile:disabled")');
    await shot(`settings-${width}-${theme}`, theme);
    await evaluate(`import('/modules/core/help.js').then(m=>m.openHelp())`);
    await shot(`help-${width}-${theme}`, theme);
  }
  for (const theme of ['light', 'dark']) {
    await navigate(`/wire?scenario=empty&theme=${theme}&capture`, 320);
    await shot(`empty-320-${theme}`, theme);
    await navigate(`/settings?scenario=settings-unavailable&theme=${theme}&capture`, 320);
    await shot(`unavailable-320-${theme}`, theme);
  }
  // Remove fixture theme pinning, then exercise genuine OS change events,
  // manual override persistence, and a reload through the first-paint script.
  await navigate('/settings?scenario=normal&capture', 1024);
  await evaluate(`import('/modules/core/theme.js').then(m=>m.applyTheme('system'))`);
  for (const theme of ['light', 'dark']) {
    await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await until(`document.documentElement.dataset.theme === '${theme}'`);
  }
  await evaluate(`import('/modules/core/theme.js').then(m=>m.applyTheme('light'))`);
  await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await navigate('/settings?scenario=normal&capture', 1024);
  await shot('persisted-light-1024', 'light');
  for (const theme of ['light', 'dark']) {
    await evaluate(`import('/modules/core/theme.js').then(m=>m.applyTheme('${theme}'))`);
    const checks = await evaluate(`(async () => {
      const m=await import('/modules/core/theme.js');
      const probe=document.createElement('span');document.body.append(probe);
      const rgb=token=>{probe.style.color='var(--'+token+')';return getComputedStyle(probe).color.match(/[\\d.]+/g).slice(0,3).map(Number)};
      const lum=channels=>channels.map(c=>{const n=c/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
      const ratio=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      const results=[];
      for(const accent of m.ACCENTS){m.applyAccent(accent.hex);const ink=lum(rgb('brand-text'));const fills=['bg-primary','bg-reading','bg-elevated','bg-selected','bg-hover','bg-input','bg-tertiary'];results.push({accent:accent.name,min:Math.min(...fills.map(token=>ratio(ink,lum(rgb(token)))))})}
      m.applyAccent(m.DEFAULT_ACCENT);probe.remove();return results;
    })()`);
    assert(checks.every(check => check.min >= 4.5), JSON.stringify(checks));
    accentChecks.push({ theme, checks });
    await navigate(`/settings?scenario=normal&theme=${theme}&capture`, 640);
    await shot(`reflow-640-${theme}`, theme);
    await navigate(`/wall?scenario=sample&theme=${theme}&capture`, 1440);
    await until('!!document.querySelector(".nb-display-card")');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".wall.news-mode")).getPropertyValue("--paper-bg").trim()'), theme === 'light' ? '#f1f0ec' : '#17191c', 'Automatic Wall follows the selected theme');
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(resolve(output, 'measurements.json'), JSON.stringify({ records, accentChecks, errors }, null, 2));
  page?.close(); await browser?.close(); server.closeAllConnections();
  await new Promise(done => server.close(done));
}

// Loaded only by serve-visual-fixtures.mjs, before the production application.
// Preserve production renderers and routing. The clock offset expires the real
// API cache and lets a reviewer invoke real polling callbacks without waiting a
// minute. No content, status, or rendering functions are replaced.
(() => {
  window.__fixtureErrors = [];
  addEventListener('error', event => window.__fixtureErrors.push(event.message || 'Fixture resource error'));
  addEventListener('unhandledrejection', event => window.__fixtureErrors.push(String(event.reason?.message || event.reason)));
  const params = new URLSearchParams(location.search);
  let capturedClipboardText = '';
  const clipboardMode = params.get('clipboard');
  if (clipboardMode === 'capture' || clipboardMode === 'denied') {
    // Test-only bridge for browser tools whose virtual clipboard is separate
    // from navigator.clipboard. Absent this explicit parameter, leave the real
    // browser clipboard untouched. Capture preserves the exact write argument.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(value) {
        if (clipboardMode === 'denied') throw new DOMException('Fixture clipboard permission denied', 'NotAllowedError');
        capturedClipboardText = String(value);
        const output = document.getElementById('fixtureClipboardOutput');
        if (output) output.value = capturedClipboardText;
      },
    } });
  }
  const scenarios = ['normal', 'sample', 'long', 'handoff', 'sparse', 'stale', 'loading', 'sourceerror', 'brieferror', 'empty', 'changed', 'evidence', 'source-revision', 'evidence-unavailable', 'health-healthy', 'health-degraded', 'health-unavailable', 'health-loading', 'health-minimal', 'no-key', 'settings-loading', 'settings-unavailable'];
  let scenario = scenarios.includes(params.get('scenario')) ? params.get('scenario') : 'normal';
  let offset = 0;
  const NativeDate = Date;
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const timeouts = new Map();
  // Record genuine scheduled work; Next timer fires only the production Wall's
  // named advance callback, cancelling its original timeout to prevent doubles.
  window.setTimeout = (fn, delay, ...args) => {
    if (typeof fn !== 'function') return nativeTimeout(fn, delay, ...args);
    const id = nativeTimeout(() => { timeouts.delete(id); fn(...args); }, delay);
    timeouts.set(id, { fn, delay, args });
    return id;
  };
  window.clearTimeout = id => { timeouts.delete(id); nativeClearTimeout(id); };
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
    static now() { return NativeDate.now() + offset; }
  };
  if (['light', 'dark'].includes(params.get('theme'))) localStorage.setItem('bt-theme', params.get('theme'));
  if (/^#[0-9a-f]{6}$/i.test(params.get('accent') || '')) localStorage.setItem('bt-accent', params.get('accent'));
  if (params.has('reducedMotion')) {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = nativeMatchMedia(query);
      if (query.includes('prefers-reduced-motion')) Object.defineProperty(result, 'matches', { value: query.includes('reduce') && !query.includes('no-preference') });
      return result;
    };
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation-duration:0.01ms!important;animation-delay:0s!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}';
    document.head.appendChild(style);
  }
  const nativeFetch = window.fetch.bind(window);
  let pendingRequests = 0;
  let lastApiActivity = NativeDate.now();
  let landscapeSeen = false;
  let expectedBrief = null;
  const seenBriefs = new Set();
  window.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      url.searchParams.set('scenario', scenario);
      url.searchParams.set('now', Date.now());
      pendingRequests++;
      return nativeFetch(url.href, options).then(async response => {
        if (url.pathname === '/api/landscape') {
          landscapeSeen = true;
          if (response.ok) expectedBrief = (await response.clone().json()).brief?.filename || null;
        }
        if (url.pathname.startsWith('/api/brief/')) seenBriefs.add(decodeURIComponent(url.pathname.slice('/api/brief/'.length)));
        return response;
      }).finally(() => { pendingRequests--; lastApiActivity = NativeDate.now(); });
    }
    return nativeFetch(input, options);
  };
  const intervals = new Map();
  const nativeInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = (fn, delay, ...args) => {
    const id = nativeInterval(fn, delay, ...args);
    if (typeof fn === 'function') intervals.set(id, { fn, delay, args });
    return id;
  };
  window.clearInterval = id => { intervals.delete(id); nativeClearInterval(id); };
  const settle = () => new Promise(resolve => nativeTimeout(resolve, 100));
  async function waitForData() {
    const started = NativeDate.now();
    while (NativeDate.now() - started < 20_000) {
      if (landscapeSeen && (!expectedBrief || seenBriefs.has(expectedBrief))
        && pendingRequests === 0 && NativeDate.now() - lastApiActivity >= 250
        && document.querySelector('#nbBody .nb-section')) return;
      await settle();
    }
    throw new Error('Fixture data did not finish loading');
  }
  async function refresh(next = scenario) {
    if (!scenarios.includes(next)) throw new Error('Unknown fixture scenario');
    scenario = next;
    offset += 61_000;
    document.getElementById('fixtureScenario')?.setAttribute('data-current', scenario);
    const selector = document.getElementById('fixtureScenario');
    if (selector) selector.value = scenario;
    await Promise.allSettled([...intervals.values()].filter(item => item.delay >= 60_000 && item.delay < 300_000).map(item => item.fn(...item.args)));
    await settle();
    tick();
    return state();
  }
  function tick(seconds = 1) {
    offset += seconds * 1000;
    [...intervals.values()].filter(item => item.delay <= 1000).forEach(item => item.fn(...item.args));
    return state();
  }
  async function nextTimer() {
    const scheduled = [...timeouts].find(([, item]) => item.fn.name === 'advanceNewsPage');
    if (!scheduled) return { ...state(), timer: 'No active Wall rotation timer (paused, loading, or one page)' };
    const [id, item] = scheduled;
    window.clearTimeout(id);
    offset += item.delay;
    item.fn(...item.args);
    await settle();
    tick(0);
    return state();
  }
  function state() {
    return { scenario, now: Date.now(), slug: document.getElementById('nbSlug')?.textContent,
      pager: document.getElementById('nbPager')?.textContent, status: document.getElementById('nbIntegrity')?.textContent,
      playback: document.getElementById('nbLiveWord')?.textContent, body: document.getElementById('nbBody')?.textContent };
  }
  const labels = { bluf: 'BLUF', execsummary: 'EXECUTIVE SUMMARY', judgment: 'KEY JUDGMENT', developing: 'DEVELOPING', convergence: 'CONVERGENCE', kev: 'KEV', wire: 'THE WIRE' };
  async function selectKind(kind) {
    const label = labels[kind];
    if (!label) throw new Error('Unknown Wall content kind');
    document.body.dataset.fixtureReady = 'false';
    await waitForData();
    // Wait for both landscape and saved Briefing before pausing: holding an early
    // KEV/Wire render intentionally defers the arriving Briefing in production.
    // Pause without advancing so a requested current BLUF remains at its top.
    if (!document.querySelector('.news-mode.nb-paused')) document.getElementById('nbPause')?.click();
    // Use the same keyboard event path as a person; selecting a page pauses.
    const key = key => document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : key, bubbles: true }));
    let visited = 0;
    do {
      if (document.getElementById('nbSlug')?.textContent.toUpperCase().includes(label)) {
        await document.fonts?.ready;
        await settle();
        document.body.dataset.fixtureReady = 'true';
        return state();
      }
      key('ArrowRight');
      await settle();
    } while (++visited < 100);
    throw new Error(`Wall kind unavailable in ${scenario}: ${kind}`);
  }
  window.__wallFixture = { refresh, tick, nextTimer, selectKind, state };
  addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('details');
    panel.id = 'fixtureControls';
    panel.style.cssText = 'position:fixed;z-index:100000;top:6px;left:6px;max-width:360px;padding:7px;background:#142033;color:#fff;border:1px solid #8195ad;font:13px system-ui;';
    panel.innerHTML = `<summary>Synthetic fixture controls</summary><label>Scenario <select id="fixtureScenario">${scenarios.map(value => `<option${value === scenario ? ' selected' : ''}>${value}</option>`).join('')}</select></label> <button id="fixturePoll">Poll now</button> <button id="fixtureTick">Status tick</button> <button id="fixtureNextTimer">Next timer</button><p>Read-only synthetic APIs. All generation and settings writes return 405.</p><label>Wall kind <select id="fixtureKind">${Object.keys(labels).map(value => `<option>${value}</option>`).join('')}</select></label> <button id="fixtureSelect">Show and pause</button>`;
    if (clipboardMode === 'capture' || clipboardMode === 'denied') {
      const label = document.createElement('label');
      label.textContent = `Fixture clipboard ${clipboardMode} output`;
      const output = document.createElement('textarea');
      output.id = 'fixtureClipboardOutput';
      output.readOnly = true;
      output.setAttribute('aria-label', 'Fixture clipboard capture');
      output.value = capturedClipboardText;
      label.appendChild(output);
      panel.appendChild(label);
    }
    if (params.has('capture')) panel.hidden = true;
    document.body.appendChild(panel);
    panel.querySelector('#fixturePoll').onclick = () => refresh(panel.querySelector('#fixtureScenario').value);
    panel.querySelector('#fixtureTick').onclick = () => tick();
    panel.querySelector('#fixtureNextTimer').onclick = () => nextTimer();
    panel.querySelector('#fixtureSelect').onclick = () => selectKind(panel.querySelector('#fixtureKind').value);
    if (params.get('kind')) {
      selectKind(params.get('kind')).catch(error => {
        document.body.dataset.fixtureError = error.message;
        console.error(error);
      });
    }
  });
})();

// Exercise the real browser sanitizer and semantic renderer with synthetic
// hostile content. No operator state, model calls, or remote sources are used.
// Reuse the portable browser launcher; no browser package is added to the app.
import assert from 'node:assert/strict';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const browserPath = findBrowser();
assert(browserPath, 'Chrome/Chromium/Edge required. Set CHROME_PATH.');
const app = createFixtureApp();
// Intentionally omit CSP on this isolated test document: a sanitizer failure
// must fail the test even when the production CSP would prevent execution.
app.get('/security-fixture', (_req, res) => res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body></body></html>'));
const server = app.listen(0, '127.0.0.1');
await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, connection;
const errors = [];

try {
  browser = await launchBrowser(browserPath);
  const response = await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' });
  const page = await response.json();
  connection = new CdpConnection(page.webSocketDebuggerUrl);
  await Promise.all([connection.call('Page.enable'), connection.call('Runtime.enable')]);
  // Stop unexpected requests before they leave the browser, rather than only
  // noticing a beacon after the request has been sent.
  connection.on('Fetch.requestPaused', event => {
    const local = event.request.url.startsWith(`${origin}/`);
    if (!local) errors.push(`Unexpected request: ${event.request.url}`);
    void connection.call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId: event.requestId, ...(!local ? { errorReason: 'BlockedByClient' } : {}),
    }).catch(error => errors.push(error.message));
  });
  connection.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await connection.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const loaded = connection.waitFor('Page.loadEventFired');
  await connection.call('Page.navigate', { url: `${origin}/security-fixture` });
  await loaded;
  const result = await connection.call('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(${runBrowserChecks.toString()})()`,
  });
  assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
  assert.deepEqual(errors, [], 'Browser errors or unexpected requests');
  console.log(`PASS browser security: ${result.result.value.cases} hostile live/draft cases; text-only Horizon tokens; safe citations; no executable nodes or handlers`);
} finally {
  connection?.close();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}

// Serialized into the isolated browser; keep all dependencies inside the function.
async function runBrowserChecks() {
  const { sanitize, sanitizeDraft, sanitizeSearchSnippet } = await import('/modules/core/sanitize.js');
  const { renderMarkdown, renderDraftMarkdown } = await import('/modules/core/markdown.js');
  const { applySemanticStyling } = await import('/modules/briefing/brief-renderer.js');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const corpus = [
    '<img src="https://attacker.invalid/pixel" onerror="window.__securityMarker=1">',
    '<script>window.__securityMarker=1</script><svg onload="window.__securityMarker=1"></svg>',
    '<a href="java&#x09;script:window.__securityMarker=1">unsafe link</a>',
    '<a href="data:text/html,<script>window.__securityMarker=1</script>">data link</a>',
    '[unsafe link](javascript:window.__securityMarker=1)',
    '[data link](data:text/html,unsafe)',
    '<iframe srcdoc="<script>parent.__securityMarker=1</script>"></iframe><object data="https://attacker.invalid/object"></object>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.__securityMarker=1>">',
    '<form id="securityClobber"><input name="__securityMarker"><button formaction="https://attacker.invalid">submit</button></form>',
    '<h2 id="securityClobber" class="security-spoof" data-danger="yes" aria-label="forged" style="position:fixed" onclick="window.__securityMarker=1">title</h2>',
    '<p><span title="[Horizon 1]&lt;img src=x onerror=window.__securityMarker=1&gt;">text</span></p>',
    '<p><strong>Act now:</strong> Owner — <em>Review</em> [Horizon 2] — tomorrow.<br><strong>The line:</strong> <span title="[Horizon 3]">Keep context.</span></p>',
  ];
  const renderers = { liveHtml: sanitize, liveMarkdown: renderMarkdown, draftHtml: sanitizeDraft, draftMarkdown: renderDraftMarkdown };
  const forbidden = 'script,style,img,svg,math,iframe,object,embed,form,input,button,textarea,select,link,meta,base';
  const inspect = (root, label) => {
    check(!root.querySelector(forbidden), label + ': forbidden element');
    for (const element of root.querySelectorAll('*')) {
      check(![...element.attributes].some(attr => /^on/i.test(attr.name) || attr.name === 'style' || attr.name === 'srcdoc'), label + ': executable attribute');
      if (element.hasAttribute('href')) check(!/^(?:javascript|data|vbscript):/i.test(element.getAttribute('href').replace(/\s/g, '')), label + ': unsafe protocol');
    }
    check(!root.querySelector('#securityClobber,.security-spoof,[data-danger]'), label + ': untrusted application hook');
    check(!window.__securityMarker, label + ': script executed');
  };
  let cases = 0;
  for (const [mode, render] of Object.entries(renderers)) for (const [index, payload] of corpus.entries()) {
    const root = document.createElement('section');
    root.innerHTML = render(payload);
    document.body.append(root);
    const label = mode + ' payload ' + index;
    inspect(root, label + ' sanitized');
    applySemanticStyling(root);
    await new Promise(done => setTimeout(done, 0));
    inspect(root, label + ' formatted');
    if (mode.startsWith('draft')) check(!root.querySelector('a[href]'), label + ': live draft link');
    root.remove(); cases++;
  }

  const root = document.createElement('section');
  document.body.append(root);
  root.innerHTML = sanitize('<p><span title="[Horizon 1]&lt;img src=x onerror=window.__securityMarker=1&gt;">Visible [Horizon 2] <strong>[Horizon 3]</strong></span> <code>[Horizon 1]</code></p>');
  const title = root.querySelector('[title]').getAttribute('title');
  applySemanticStyling(root);
  check(root.querySelector('[title]').getAttribute('title') === title, 'Horizon pass must preserve sanitized title boundaries');
  check(root.querySelector('[title]').textContent === 'Visible OPERATIONAL STRATEGIC', 'Only visible Horizon tokens become chips');
  check(root.querySelectorAll('.c-chip').length === 2, 'Nested text must be transformed once');
  check(root.querySelector('code').textContent === '[Horizon 1]', 'Code examples must remain literal');
  inspect(root, 'Horizon attribute regression');

  root.innerHTML = sanitize('<p><a href="https://publisher.invalid/[Horizon 1]">Publisher</a></p>');
  const authoredHref = root.querySelector('a').href;
  applySemanticStyling(root);
  check(root.querySelector('.source-link')?.href === authoredHref && !root.querySelector('.c-chip'), 'Horizon syntax inside a source href must remain unchanged');

  const source = 'https://publisher.invalid/advisory';
  const markdown = '[Publisher, 2026-10-09](' + source + ')';
  root.innerHTML = renderMarkdown(markdown);
  applySemanticStyling(root);
  const link = root.querySelector('.brief-sources-appendix .source-link');
  check(link?.href === source && link.rel === 'noopener noreferrer' && link.target === '_blank', 'Live source reference must retain its safe navigation attributes');
  root.innerHTML = renderDraftMarkdown(markdown);
  applySemanticStyling(root);
  check(!root.querySelector('a[href]'), 'Unvalidated drafts must not expose a safe-looking source link');
  root.innerHTML = sanitizeSearchSnippet('<a href="https://attacker.invalid">click</a><mark onclick="window.__securityMarker=1">hit</mark><img src=x onerror="window.__securityMarker=1">');
  check([...root.querySelectorAll('*')].every(node => node.tagName === 'MARK' && !node.attributes.length), 'Search excerpts allow only attribute-free marks');
  inspect(root, 'search excerpt');
  root.remove();
  return { cases };
}

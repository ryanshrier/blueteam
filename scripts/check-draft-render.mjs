// Exercise the real recovery dialog with synthetic API receipts in an isolated
// browser. Never load operator state or invoke a model/provider.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const browserPath = findBrowser();
assert(browserPath, 'Chrome/Chromium/Edge required. Set CHROME_PATH.');
const app = createFixtureApp();
const styles = ['fonts', 'tokens', 'app', 'frontend-refinement', 'briefing-refinement'];
app.get('/draft-fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">${styles.map(name => `<link rel="stylesheet" href="/${name}.css">`).join('')}</head><body><main><h1>Synthetic draft recovery fixture</h1></main></body></html>`));
const server = app.listen(0, '127.0.0.1');
await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
const origin = `http://127.0.0.1:${server.address().port}`;
const screenshotDir = process.env.DRAFT_SCREENSHOT_DIR ? resolve(process.env.DRAFT_SCREENSHOT_DIR) : null;
const errors = [];
let browser, connection;
try {
  browser = await launchBrowser(browserPath);
  const response = await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' });
  const page = await response.json();
  connection = new CdpConnection(page.webSocketDebuggerUrl);
  await Promise.all([connection.call('Page.enable'), connection.call('Runtime.enable')]);
  connection.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  connection.on('Fetch.requestPaused', event => {
    const local = event.request.url.startsWith(`${origin}/`) && !event.request.url.startsWith(`${origin}/api/`);
    if (!local) errors.push(`Unexpected request: ${event.request.url}`);
    void connection.call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId: event.requestId, ...(!local ? { errorReason: 'BlockedByClient' } : {}),
    }).catch(error => errors.push(error.message));
  });
  await connection.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  for (const width of [1280, 390]) {
    await connection.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
    const loaded = connection.waitFor('Page.loadEventFired');
    await connection.call('Page.navigate', { url: `${origin}/draft-fixture` });
    await loaded;
    const result = await connection.call('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true, expression: `(${runDraftChecks.toString()})()`,
    });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    assert.deepEqual(errors, [], 'Browser errors or unmocked API / external requests');
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      const screenshot = await connection.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(screenshotDir, `draft-control-review-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    console.log(`PASS draft recovery ${width}px: ${result.result.value.checks} checks; exact finding/evidence jump, save/reopen, publish, blocked/review, conflict, interrupted outcome`);
  }
} finally {
  connection?.close();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}

// Serialized into the browser. Dependencies and synthetic state stay local.
async function runDraftChecks() {
  const { openDraftReview } = await import('/modules/briefing/brief-drafts.js');
  let checks = 0;
  const check = (condition, message) => { checks++; if (!condition) throw new Error(message); };
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Timed out awaiting draft UI');
  };
  const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const control = { code: 'SECURITY_CONTROL_CHANGE', severity: 'trust', message: 'Review disabling an alert for a scoped maintenance window.', sourceIds: ['source-1'], location: { line: 5, excerpt: 'Suppress this one alert during the documented maintenance window.' } };
  const blocker = { code: 'SOURCE_UNSUPPORTED', severity: 'trust', message: 'This claim is not supported by captured evidence.', sourceIds: ['source-1'], location: { line: 3, excerpt: 'Unsupported claim.' } };
  const note = { code: 'STYLE_NOTE', severity: 'structure', message: 'Consider shortening the heading.', location: { line: 1 } };
  const decision = content => ({ blockers: content.includes('[BLOCKED]') ? [blocker] : [], reviewIssues: content.includes('[CONTROL]') ? [control] : [], notes: [note], canPublish: !/\[(BLOCKED|CONTROL)\]/.test(content), requiresReview: content.includes('[CONTROL]') });
  const basic = '# Defensive briefing\n\nReview the captured advisory and confirm affected inventory.\n\nA scoped assessment for the security team.\n\n[Unvalidated link](https://attacker.invalid/) <img src=x onerror="window.__draftAttack=1">';
  const artifacts = new Map();
  const calls = [];
  let mode = 'normal', lostOnce = false, close, published;
  const originalFetch = window.fetch;
  async function make(id, content = basic) {
    const sha256 = await hash(content), publicationDecision = decision(content);
    const validation = { valid: publicationDecision.canPublish, issues: [...publicationDecision.blockers, ...publicationDecision.reviewIssues, ...publicationDecision.notes] };
    const artifact = { id, status: 'draft', editionDate: '2026-10-09', createdAt: '2026-10-09T12:00:00Z', manifestSha256: 'a'.repeat(64), publicationDecision,
      revisions: [{ number: 12, content, sha256, createdAt: '2026-10-09T12:00:00Z', validation }],
      manifest: { grounding: { sources: [
        { id: 'source-1', label: 'Captured vendor advisory', url: 'https://publisher.invalid/advisory', title: 'Synthetic maintenance guidance', publishedAt: '2026-10-09', evidenceText: 'During maintenance, review this one alert and restore its normal state when the window ends.' },
        { id: 'source-2', label: '<img src=x onerror="window.__draftAttack=1">', url: 'javascript:window.__draftAttack=1', evidenceText: '<script>window.__draftAttack=1</script>' },
      ] } },
    };
    artifacts.set(id, artifact); return artifact;
  }
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options = {}) => {
    if (!String(url).startsWith('/api/brief/drafts')) return originalFetch(url, options);
    const [, id, action] = String(url).match(/^\/api\/brief\/drafts(?:\/([^/]+)(?:\/([^/]+))?)?$/) || [];
    if (!id) return reply({ items: [...artifacts.values()].filter(item => item.status === 'draft') });
    const artifact = artifacts.get(decodeURIComponent(id));
    if (!action) return reply(artifact);
    const body = JSON.parse(options.body);
    calls.push({ id, action, body });
    if (mode === 'conflict') return reply({ error: 'Another revision was saved. Reload before publishing.', code: 'E_DRAFT_CONFLICT', artifact }, 409);
    if (artifact.status === 'published') return reply({ published: true, filename: artifact.publication.filename, publication: artifact.publication, isCurrent: true, replayed: true });
    const latest = artifact.revisions.at(-1);
    check(body.baseRevision === latest.number, 'Send the monotonic saved revision number');
    if (body.content !== latest.content) artifact.revisions.push({ ...latest, number: latest.number + 1, content: body.content, sha256: await hash(body.content) });
    const current = artifact.revisions.at(-1);
    artifact.publicationDecision = decision(current.content);
    current.validation = { valid: artifact.publicationDecision.canPublish, issues: [...artifact.publicationDecision.blockers, ...artifact.publicationDecision.reviewIssues, ...artifact.publicationDecision.notes] };
    artifact.operatorSavedAt = '2026-10-09T13:00:00Z';
    artifact.lastCheck = { revision: current.number, contentSha256: current.sha256, checkedAt: artifact.operatorSavedAt, validation: current.validation };
    if (action === 'revalidate') return reply(artifact);
    check(body.inputSha256 === artifact.manifestSha256, 'Publish is bound to the captured input receipt');
    const review = body.securityControlReview;
    if (artifact.publicationDecision.blockers.length || (artifact.publicationDecision.requiresReview && !review)) return reply({ error: 'Resolve required findings before publication.', code: 'E_DRAFT_BLOCKED', artifact, validation: current.validation, reviewableIssues: artifact.publicationDecision.reviewIssues }, 422);
    if (review) check(review.contentSha256 === current.sha256 && review.reviewer === 'Test reviewer' && review.reason === 'Verified the one alert and exact maintenance scope.', 'Explicit contextual approval is bound to the latest saved text');
    artifact.status = 'published';
    artifact.publication = { revision: current.number, contentSha256: current.sha256, inputSha256: artifact.manifestSha256, filename: 'brief-2026-10-09.md', publishedAt: artifact.operatorSavedAt, eligibleForLatest: true };
    if (mode === 'lost-response' && !lostOnce) { lostOnce = true; throw new TypeError('Synthetic connection interruption'); }
    return reply({ published: true, filename: artifact.publication.filename, publication: artifact.publication, ...(mode !== 'warning' ? { isCurrent: true } : {}), replayed: false,
      warnings: mode === 'warning' ? ['Published successfully; search indexing needs attention.'] : [] });
  };
  const q = selector => document.querySelector(selector);
  async function open(id, withCallback = true) {
    published = null;
    close = openDraftReview({ id, ...(withCallback ? { onPublished: result => { published = result; } } : {}) });
    await wait(() => q('#draftRepair'));
  }
  function edit(content) {
    q('[data-draft-view="edit"]').click();
    q('#draftRepair').value = content;
    q('#draftRepair').dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function act(selector) {
    q(selector).click();
    await wait(() => published || (!q(selector)?.disabled && !q('#draftRepair')?.readOnly));
  }
  function fillReview() {
    q('[name="reviewer"]').value = 'Test reviewer';
    q('[name="reason"]').value = 'Verified the one alert and exact maintenance scope.';
    q('[name="confirmed"]').checked = true;
  }
  function fits() {
    const bounds = q('.brief-draft-dialog').getBoundingClientRect();
    const footer = q('.draft-repair-actions').getBoundingClientRect();
    check(bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, 'Dialog fits the viewport');
    check(footer.top >= bounds.top && footer.bottom <= bounds.bottom, 'Primary publication action remains visible');
    check(q('.draft-review-body').scrollWidth <= q('.draft-review-body').clientWidth + 1, 'No horizontal draft workspace overflow');
  }
  try {
    await make('clean'); await open('clean');
    check(q('[data-draft-editor]').hidden && !q('.draft-preview').hidden, 'Readable preview is the default');
    check(!q('.draft-preview a[href]') && !q('.draft-preview img') && !window.__draftAttack, 'Preview does not expose model links or executable markup');
    check(!q('.draft-findings').open && q('.draft-findings summary').textContent.includes('Editorial notes'), 'Optional editorial notes are collapsed');
    check(q('[data-draft-source="source-1"] a')?.rel === 'noopener noreferrer' && !q('[data-draft-source="source-2"] a') && !q('.draft-captured-evidence img'), 'Captured evidence links and text are safely rendered');
    fits();
    edit(basic + '\n\nSaved operator repair.');
    await act('[data-draft-save]');
    check(calls.at(-1).action === 'revalidate' && q('.draft-review-note').textContent.includes('remains unpublished'), 'Save keeps work unpublished');
    close(); await open('clean');
    check(q('#draftRepair').value.includes('Saved operator repair.'), 'Saved work survives closing and reopening');
    edit(basic + '\n\nReady for publication.');
    const before = calls.length;
    await act('[data-draft-publish]');
    check(calls.length === before + 1 && calls.at(-1).action === 'publish', 'Publish sends one combined save/check/publish action');
    check(published?.isCurrent && published?.filename && !q('.brief-draft-dialog'), 'Publication closes recovery and exposes current reader outcome');

    await make('conflict'); await open('conflict'); mode = 'conflict';
    edit(basic + '\n\nUnsaved conflict repair.'); await act('[data-draft-publish]');
    check(q('#draftRepair').value.includes('Unsaved conflict repair.') && q('#draftRepairStatus').textContent.includes('remain in this tab'), 'Conflict preserves editable work');
    close(); await open('conflict');
    check(q('#draftRepair').value.includes('Unsaved conflict repair.'), 'Conflict work survives closing the dialog');
    close(); mode = 'normal';

    await make('blocked', basic + '\n\n[BLOCKED] [CONTROL]'); await open('blocked');
    check(q('.draft-review-folio').textContent.includes('fixes needed') && !q('[data-control-review]'), 'Required fixes precede specific review and cannot be waived');
    edit(basic + '\n\n[BLOCKED] Saved unresolved repair.'); await act('[data-draft-publish]');
    check(q('.draft-review-note').textContent.includes('Draft saved · not published') && q('#draftRepair').value.includes('Saved unresolved repair.'), 'Blocked publish shows the durable saved, unpublished result');
    close();

    const scoreLine = '**What happened:** The [captured advisory](https://publisher.invalid/cvss) discusses CVE-2026-12345 and CVE-2026-67890. A CVSS v3.1 score of **9.8** is reported without identifying which vulnerability it describes.';
    const scoreLines = ['# Defensive briefing — retained evidence', '', '## KEY JUDGMENTS', '',
      '### Signal 2 — [Horizon 1] Review the two gateway vulnerabilities', '',
      '**Assessment:** Confirm the affected builds before deciding on a response.', '', scoreLine, '',
      '**The line:** Keep the score tied to its supported vulnerability.'];
    const scoreIssue = { code: 'CVE_CVSS_AMBIGUOUS', severity: 'trust',
      message: 'Signal 2: CVSS v3.1 9.8 needs one explicit CVE association in this passage.',
      location: { scope: 'paragraph', line: scoreLines.indexOf(scoreLine) + 1, excerpt: 'A CVSS v3.1 score of 9.8 is reported without identifying which vulnerability it describes.' },
      sourceIds: ['source-cvss'] };
    const scoreDraft = await make('cvss-location', scoreLines.join('\n'));
    scoreDraft.publicationDecision = { blockers: [scoreIssue], reviewIssues: [], notes: [], canPublish: false, requiresReview: false };
    scoreDraft.revisions[0].validation = { valid: false, issues: [scoreIssue] };
    scoreDraft.manifest.grounding.sources.push({ id: 'source-cvss', label: 'Captured CVSS advisory',
      title: 'Two synthetic gateway vulnerabilities', url: 'https://publisher.invalid/cvss',
      evidenceText: 'CVE-2026-12345 has a CVSS v3.1 score of 9.8. CVE-2026-67890 has a CVSS v3.1 score of 7.5.' });
    await open('cvss-location');
    const reference = q('.draft-reference-panel');
    if (!reference.open) reference.querySelector('summary').click();
    const finding = q('[data-draft-line]');
    check(finding.textContent.includes(scoreIssue.message) && finding.textContent.includes(`Line ${scoreIssue.location.line}`), 'Specific CVSS finding and raw Markdown line number are visible');
    check(finding.closest('li').querySelector('blockquote').textContent === scoreIssue.location.excerpt, 'Finding preserves its exact diagnostic excerpt');
    q('[data-draft-source="source-1"]').open = true;
    const beforeFinding = calls.length;
    finding.click();
    const scoreEditor = q('#draftRepair');
    const scoreStart = scoreLines.slice(0, scoreIssue.location.line - 1).join('\n').length + 1;
    check(!q('[data-draft-editor]').hidden && q('.draft-preview').hidden && document.activeElement === scoreEditor, 'Finding switches from readable preview to focused editor');
    check(scoreEditor.selectionStart === scoreStart && scoreEditor.selectionEnd === scoreStart + scoreLine.length
      && scoreEditor.value.slice(scoreEditor.selectionStart, scoreEditor.selectionEnd) === scoreLine, 'Finding selects exactly the saved raw Markdown score line, including link and formatting');
    check(q('.draft-captured-evidence').open && q('[data-draft-source="source-cvss"]').open
      && !q('[data-draft-source="source-1"]').open && !q('[data-draft-source="source-2"]').open, 'Finding opens only its matching captured source');
    check(reference.open === (innerWidth > 900), 'Phone finding navigation focuses editing while desktop keeps references open');
    if (!reference.open) reference.querySelector('summary').click();
    const capturedPassage = q('[data-draft-source="source-cvss"] blockquote');
    check(reference.open && capturedPassage.getClientRects().length > 0
      && capturedPassage.textContent.includes('CVE-2026-12345 has a CVSS v3.1 score of 9.8'), 'Matching evidence remains accessible when the phone reference panel is reopened');
    check(calls.length === beforeFinding && !q('[data-control-review]'), 'Inspecting a CVSS blocker neither submits a request nor creates an approval flow');
    close();

    await make('control', basic + '\n\n[CONTROL]'); await open('control');
    const beforeReview = calls.length;
    q('[data-draft-publish]').click();
    check(!q('[name="confirmed"]').checked && calls.length === beforeReview, 'Control review is explicit and never preapproved');
    fillReview(); edit(basic + '\n\n[CONTROL] Clarified maintenance scope.');
    check(!q('[name="confirmed"]').checked && !q('[data-control-changed]').hidden, 'Changing text invalidates approval');
    await act('[data-draft-publish]');
    check(!calls.at(-1).body.securityControlReview && q('.draft-review-note').textContent.includes('not published'), 'Edited text is rechecked before it can be reviewed');
    fillReview(); await act('[data-draft-publish]');
    check(published?.filename && calls.at(-1).body.securityControlReview?.contentSha256 === artifacts.get('control').revisions.at(-1).sha256, 'Reviewed exact text publishes');

    await make('interrupted'); await open('interrupted'); mode = 'lost-response';
    await act('[data-draft-publish]');
    check(q('#draftRepairStatus').textContent.includes('retry Publish briefing with the same text'), 'Interrupted publication has a safe recovery action');
    const retryBody = JSON.stringify(calls.at(-1).body);
    await act('[data-draft-publish]');
    check(published?.replayed && retryBody === JSON.stringify(calls.at(-1).body), 'Retry recovers the existing publication without changing the request');

    await make('warning'); await open('warning', false); mode = 'warning';
    await act('[data-draft-publish]');
    check(q('.draft-review-body').textContent.includes('current display status unavailable') && q('.draft-review-body').textContent.includes('search indexing needs attention'), 'Committed publication preserves follow-up warnings and unknown current status');
    close();

    mode = 'normal';
    await make('screenshot', basic + '\n\n[CONTROL]'); await open('screenshot');
    q('.draft-reference-panel').open = true;
    q('[data-control-review]').scrollIntoView({ block: 'nearest' });
    fits();
    return { checks };
  } finally {
    // The final inert fixture stays visible only for the optional screenshot.
    window.fetch = originalFetch;
  }
}

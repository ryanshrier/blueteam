// Real reader UI with synthetic, browser-local API responses. No operator data,
// writes, model calls, or external requests are permitted by this fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';
import { createFixtureRequestGuard } from './fixture-request-guard.mjs';
import { briefPresentation } from '../lib/brief-reading-checks.js';

const actionContent = `# Shared action fixture
## BLUF
Verify deployed inventory before choosing a response.
## EXECUTIVE SUMMARY
- **Threat picture:** Two deployments require different responses.
- **Exposure:** Local applicability remains unverified.
- **Required decisions:** An obsolete provider summary must not supply the reader action queue.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Verify the gateway before remediation
**Assessment:** Deployment determines local applicability.
**Confidence:** Moderate — local exposure is unverified.
**What happened:** The [Vendor advisory, 2026-10-09](https://publisher.invalid/advisory) describes an affected gateway.
**Recommended actions:**
- Operations — verify inventory; only if affected, isolate the gateway; Dependencies: preserve relevant logs — recommended target October 24, 2026.
- Incident response — if compromise is confirmed, restore from a verified safe backup; retain isolation until validation completes — recommended target October 26, 2026.
**Decision window:** 72 hours
**The line:** Establish scope before remediation.
### Signal 2 — [Horizon 2] Track the hosted rollout
**Assessment:** Hosted rollout evidence remains incomplete.
**Confidence:** Moderate — deployment breadth remains unknown.
**What happened:** A [Vendor note, 2026-10-09](https://publisher.invalid/note) describes a staged update.
**Recommended actions:**
- Service owner — verify the hosted tenant update before closing the response — recommended target October 27, 2026.
**Decision window:** 7 days
**The line:** Confirm the tenant state.
`;
const actionPresentation = briefPresentation({ original: actionContent, content: actionContent,
  manifest: { publicationValidation: { validationPolicyVersion: 2, issues: [
    { code: 'PRIORITY_COVERAGE_PARTIAL', severity: 'review', message: 'Optional bounded coverage accounting note.' },
    { code: 'CVE_CVSS_AMBIGUOUS', severity: 'review', signal: 1, message: 'Verify the score association against the retained advisory.',
      location: { line: actionContent.split('\n').findIndex(line => line.startsWith('**Assessment:**')) + 1 } },
  ] } }, disposition: { status: 'eligible', eligibleForLatest: true } });
const mixedContent = `# Mixed provider headings
## EXECUTIVE SUMMARY
- **Threat:** Confirm local applicability.
- **Required decisions:** This duplicate is replaced by shared records.
## KEY JUDGMENTS
> ### Signal 77 — Quoted example, not a judgment

- ### Signal 88 — List example, not a judgment

<h3>Signal 66 — Raw HTML example, not a judgment</h3>

${[1,2,3,4].map(number => `### ${number % 2 === 0 ? `Signal ${number} — ` : ''}[Horizon 1] Service ${number}
**Assessment:** Confirm local applicability.
**Recommended actions:**
- Operations — verify deployment before restricting access — recommended target October 24, 2026.
**Decision window:** 72 hours
`).join('\n')}
## DEVELOPING SITUATIONS
### Signal 99 — Supporting report outside the judgments
**Trajectory:** Uncertain
`;
const mixedFinding = (heading, message, extra = {}) => ({ code: 'CVE_CVSS_AMBIGUOUS', severity: 'review', message,
  location: { line: mixedContent.split('\n').findIndex(line => line.includes(heading)) + 2 }, ...extra });
const firstMixedLimit = 'Service 1 score association needs verification.';
const thirdMixedLimit = 'Service 3 deployment remains unverified.';
const mixedIssues = [
  mixedFinding('[Horizon 1] Service 1', firstMixedLimit, { signal: 4 }),
  mixedFinding('[Horizon 1] Service 3', thirdMixedLimit),
  mixedFinding('Supporting report outside', 'Supporting report requires separate confirmation.'),
  { code: 'PRIORITY_COVERAGE_PARTIAL', severity: 'review', message: 'Optional mixed-heading coverage accounting.' },
];
const actionFixture = { content: actionContent, presentation: actionPresentation,
  mixed: { content: mixedContent, presentation: briefPresentation({ original: mixedContent, content: mixedContent,
    manifest: { publicationValidation: { validationPolicyVersion: 2, issues: mixedIssues } }, disposition: { status: 'eligible', eligibleForLatest: true } }) },
  mixedLimits: [firstMixedLimit, thirdMixedLimit] };

const app = createFixtureApp();
app.get('/reader-state-fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">${['fonts','tokens','app','frontend-refinement','briefing-refinement'].map(name=>`<link rel="stylesheet" href="/${name}.css">`).join('')}</head><body><main id="main" tabindex="-1"></main><div id="toastContainer"></div></body></html>`));
const server = app.listen(0, '127.0.0.1');
await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.READER_SCREENSHOT_DIR ? resolve(process.env.READER_SCREENSHOT_DIR) : null;
let browser, connection, requestGuard;
const errors = [];
try {
  const path = findBrowser(); assert(path, 'Chrome/Chromium/Edge required. Set CHROME_PATH.');
  browser = await launchBrowser(path);
  const response = await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' });
  connection = new CdpConnection((await response.json()).webSocketDebuggerUrl);
  await Promise.all([connection.call('Page.enable'), connection.call('Runtime.enable')]);
  await connection.call('Page.bringToFront');
  connection.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  requestGuard = createFixtureRequestGuard(connection, { origin, errors });
  await requestGuard.enable();
  for (const width of [1280,390]) {
    await connection.call('Emulation.setDeviceMetricsOverride', { width,height:900,deviceScaleFactor:1,mobile:width<600 });
    const loaded = connection.waitFor('Page.loadEventFired');
    await connection.call('Page.navigate', { url:`${origin}/reader-state-fixture` }); await loaded;
    const result = await connection.call('Runtime.evaluate', { awaitPromise:true,returnByValue:true,expression:`(${runReaderChecks.toString()})(${JSON.stringify(actionFixture)})` });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    await requestGuard.settle();
    assert.deepEqual(errors, [], 'No browser exceptions or real API / external requests');
    if (output) {
      await mkdir(output, {recursive:true});
      for (const state of ['corrected','superseded']) {
        const shown = await connection.call('Runtime.evaluate', {awaitPromise:true,expression:`window.__showReaderState(${JSON.stringify(state)})`});
        assert(!shown.exceptionDetails,shown.exceptionDetails?.exception?.description);
        const shot=await connection.call('Page.captureScreenshot',{format:'png'});
        await writeFile(resolve(output,`reader-${state}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
    }
    await connection.call('Runtime.evaluate',{expression:'window.__finishReaderState()'});
    await requestGuard.settle();
    assert.deepEqual(errors, [], 'No browser exceptions or real API / external requests after reader cleanup');
    console.log(`PASS reader state ${width}px: ${result.result.value.checks} checks; shared exceptions, current/history, evidence jump, exact qualifications, safe record links`);
  }
} finally {
  requestGuard?.dispose();
  connection?.close(); if(browser) await browser.close();
  server.closeAllConnections(); await new Promise(done=>server.close(done));
}

async function runReaderChecks(actionFixture) {
  const {render,unmount}=await import('/modules/briefing/briefing-view.js');
  const {decisionCardContent,decisionCopyText}=await import('/modules/briefing/brief-renderer.js');
  const {expandReaderDisclosures}=await import('/modules/briefing/brief-export.js');
  const {setState}=await import('/modules/core/store.js');
  let checks=0, current, pending=false, generation=null, newer=null, publicationRevision='initial', archiveFailure=false;
  const check=(condition,message)=>{ checks++; if(!condition) throw new Error(message); };
  const until=async predicate=>{ for(let i=0;i<200;i++){ if(predicate())return; await new Promise(done=>setTimeout(done,10)); } throw new Error('Reader fixture timed out'); };
  const q=selector=>document.querySelector(selector);
  const filename='brief-2026-10-09.md';
  const certainty='High for the advisory; Moderate for local impact. Deployment breadth remains unknown.';
  const single='Moderate — independent deployment evidence remains unavailable.';
  const markdown=`# Synthetic defensive briefing
## BLUF
Check affected inventory before scheduling remediation.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Confirm the affected gateway
**Assessment:** Inventory determines whether local remediation is needed.
**Confidence:** ${certainty}
**What happened:** The [Vendor advisory, 2026-10-09](https://publisher.invalid/advisory) describes a fixed build.
**Defender impact:** Preserve relevant logs and confirm local applicability.

**Federal remediation:** Captured CISA KEV dates apply only to Federal Civilian Executive Branch (FCEB) agencies. Internal recommended targets are separate.

- CVE-2026-83548: FCEB remediation due 2026-11-04. [CISA KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
- CVE-2026-83549: FCEB remediation due 2026-11-12. [CISA KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)

**Recommended actions:**
- Operations — check affected inventory — today.
**Decision window:** 72 hours
**The line:** Confirm scope before remediation.
### Signal 2 — [Horizon 2] Watch deployment evidence
**Assessment:** The deployment record is incomplete.
**Confidence:** ${single}
**What happened:** A [Vendor note, 2026-10-09](https://publisher.invalid/note) describes the rollout.
**Recommended actions:**
- Operations — request deployment evidence — this week.
**Decision window:** 7 days
**The line:** Retain uncertainty until the record is available.
## WATCHLIST
- New exploitation is reported.
`;
  const line=markdown.split('\n').findIndex(value=>value.startsWith('**Assessment:**'))+1;
  const issue={code:'APPLICABILITY_ACTION_UNCONDITIONAL',audience:'reader',consequence:'note',acknowledged:false,message:'Local exposure has not been established by the retained evidence.',location:{line,excerpt:'Inventory determines whether local remediation is needed.'}};
  const base=()=>({filename,content:markdown,generatedAt:'2026-10-09T12:00:00Z',meta:{warnings:['Legacy style note.']},inputManifest:{status:'unavailable',integrity:'missing'},disposition:{status:'eligible',eligibleForLatest:true},sourceCheckStatus:'checked-supported-forms',
    presentation:{schemaVersion:1,revision:'fixture',copy:{kind:'operator-repaired',contentSha256:'b'.repeat(64),originalSha256:'b'.repeat(64)},currentChecks:{status:'checked',basis:'publication',issues:[],warnings:[]},history:[{kind:'original-generation',label:'Original generation',warnings:['Earlier generation was incomplete.'],issues:[]}],approval:{status:'not-recorded'},operationalNotes:[]}});
  const originalFetch=window.fetch;
  window.fetch=async(url,options={})=>{
    if(!String(url).startsWith('/api/'))return originalFetch(url,options);
    check(!options.method||options.method==='GET','Reader performs only read requests');
    let data;
    if(url==='/api/settings')data={ai:{enabled:true}};
    else if(url==='/api/brief/status')data={persistence:'ok',publicationRevision,active:generation?.status==='running',latest:generation,draftRecovery:{items:pending?[{id:'new-draft',status:'draft',editionDate:'2026-10-09'}]:[]}};
    else if(url==='/api/briefs'){
      if(archiveFailure)throw new Error('Synthetic transient archive failure');
      data=[...(newer?[newer]:[]),{filename,disposition:current.disposition}];
    }
    else if(url===`/api/brief/${filename}`)data=current;
    else if(newer&&url===`/api/brief/${newer.filename}`)data=newer;
    else if(url==='/api/headlines')data={headlines:[],generatedAt:'2026-10-09T12:00:00Z'};
    else throw new Error(`Unexpected synthetic endpoint ${url}`);
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  async function show(state,hash=''){
    unmount(); current=base(); pending=state==='draft'; generation=null; newer=null; publicationRevision='initial'; archiveFailure=false;
    if(state==='actions')Object.assign(current,actionFixture);
    if(state==='mixed-actions')Object.assign(current,actionFixture.mixed);
    if(state==='published'){current.presentation.copy.kind='published';current.presentation.history=[];}
    if(state==='corrected'){
      current.reviewedContent=markdown; current.sourceCheckStatus='findings';
      current.review={status:'editorially-corrected',reviewer:'Synthetic editor',reviewedAt:'2026-10-09T13:00:00Z',scope:'Corrected scope against captured evidence.',notes:[{id:'review-scope',anchor:'judgment-1',label:'Clarified scope',reason:'Only affected inventory is relevant.'}]};
      current.presentation.copy.kind='editorially-corrected'; current.presentation.currentChecks={status:'checked',basis:'corrected-copy',issues:[issue,{code:'CONFIDENCE_INVALID',audience:'operator',consequence:'note',message:'Normalize the confidence field.',location:{line}}],warnings:[issue.message,'Normalize the confidence field.']};
      current.presentation.history=[{kind:'original-publication',label:'Original publication',warnings:['Old unsupported version claim.'],issues:[{message:'Old unsupported version claim.',location:{line,excerpt:'Original version text.'}}]}];
    }
    if(state==='superseded')current.disposition={status:'superseded',eligibleForLatest:false,reason:'A replacement corrects the affected version range.',replacementFilename:'brief-2026-10-09-02.md'};
    if(state==='invalid'){current.inputManifest.integrity='invalid';current.disposition={status:'review-required',eligibleForLatest:false,reason:'The saved input receipt does not match this edition.'};current.presentation.currentChecks.status='unavailable';}
    if(state==='unavailable'){current.review={status:'unavailable',message:'The correction digest could not be verified. Original text displayed.'};current.disposition={status:'review-required',eligibleForLatest:false};}
    history.replaceState({},'',`/briefing/${filename}${hash}`);setState({mode:'briefing',isGenerating:false,currentBrief:null});render(q('#main'));
    await until(()=>q('#briefContent')?._validatedBriefContent===current.content&&q('#edition-record'));
    q('#briefOverviewMode').click();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));scrollTo(0,0);
  }
  await show('clean');
  const generate=q('#briefGenerate'), generateBox=generate.getBoundingClientRect();
  check(!generate.closest('details')&&generate.getClientRects().length>0,'Generate is available without opening Edition tools');
  check(generateBox.height>=44&&generateBox.left>=0&&generateBox.right<=innerWidth+1,'Generate touch target fits the viewport');
  const tools=q('#briefEditionTools'), drafts=q('#briefDrafts');
  check(!tools.open&&drafts.closest('details')===tools,'Draft review belongs to the closed Edition tools');
  tools.querySelector('summary').click();
  const draftsBox=drafts.getBoundingClientRect();
  check(drafts.getClientRects().length>0&&draftsBox.height>=44&&draftsBox.left>=0&&draftsBox.right<=innerWidth+1,'Draft review is reachable inside Edition tools with a fitting touch target');
  // Safari can focus the focusable main ancestor during a button pointer
  // activation. Reproduce that ordering against the real mounted controls.
  const printOpener=q('#briefExport');
  printOpener.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse'}));
  q('#main').focus();
  check(tools.open,'Pointer activation keeps Edition tools open when focus moves to the main ancestor');
  printOpener.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse'}));
  printOpener.click();
  await until(()=>q('.np-frame')?.contentDocument?.querySelector('.np-colophon'));
  check(tools.open&&q('.np-overlay').contains(document.activeElement),'Print opens from the visible menu and owns focus');
  q('.np-ov-close').click();
  check(!q('.np-overlay')&&document.activeElement===printOpener&&tools.open,'Closing Print restores its visible menu control');
  q('#main').focus();
  check(!tools.open,'Outside focus dismisses Edition tools after pointer activation finishes');
  check(q('#briefPublicationState').hidden,'Clean repaired edition has no material warning');
  check(q('#edition-record').textContent.includes('checks recorded for this copy')&&!q('#edition-record').textContent.includes('unavailable'),'Repaired checks are accurately recorded');
  check(!q('#edition-record').open,'Edition record is optional by default');
  const disclosure=q('#briefAiDisclosure');
  check(!disclosure.hidden&&disclosure.textContent==='AI-generated draft with subsequent edits · Edition record','Repaired edition has one quiet, accurate shared AI disclosure');
  check(q('.briefing-view').textContent.split('AI-generated').length===2,'Reader AI disclosure appears once');
  const feature=q('.brief-overview-feature');
  check(feature.textContent.split(certainty).length===2,'Mixed authored confidence appears once in Overview');
  check(!feature.querySelector('details').textContent.includes(certainty),'Opening evidence does not repeat confidence');
  check(q('#overview-judgment-2').closest('article').querySelector('.brief-overview-qualification').textContent.includes(single),'Single-rating material qualification remains visible');
  q('#briefReadingMode').click();
  check(q('.brief-judgment-card').innerText.split(certainty).length===2,'Full report preserves confidence without a visible duplicate');
  check(disclosure.getClientRects().length>0&&!disclosure.closest('.briefing-layout'),'Full report uses the same shared AI disclosure');
  const firstCard=q('.brief-judgment-card'), federal=firstCard.querySelector('[data-brief-field="federal remediation"]');
  check(federal?.getClientRects().length>0&&federal.textContent.includes('Internal recommended targets are separate'),'Federal dates remain visible with their own scope');
  const decision=decisionCardContent(firstCard), copied=decisionCopyText({...decision,editionUrl:`${location.origin}/briefing/${filename}`});
  check(decision.federalRemediation.includes('CVE-2026-83548: FCEB remediation due 2026-11-04')&&decision.federalRemediation.includes('CVE-2026-83549: FCEB remediation due 2026-11-12'),'Copy preserves both exact per-CVE federal dates');
  check(!decision.federalRemediation.includes('Operations')&&copied.includes('Federal remediation:')&&copied.includes('check affected inventory'),'Copy separates federal context from the complete internal recommendation');
  check(decision.sources.some(source=>source.href==='https://www.cisa.gov/known-exploited-vulnerabilities-catalog'),'Copy retains the catalog citation');
  const printable=firstCard.cloneNode(true);expandReaderDisclosures(printable);
  check(printable.textContent.includes('FCEB remediation due 2026-11-04')&&printable.textContent.includes('FCEB remediation due 2026-11-12')&&printable.textContent.includes('Internal recommended targets are separate'),'Print content retains exact dates and scope');
  for(const state of ['superseded','invalid','unavailable']){
    await show(state);const notice=q('#briefPublicationState');const text=notice.textContent;
    check(!notice.hidden&&text.length>30,`${state}: Overview retains the exception reason`);
    check(!q('#briefContent .brief-disposition-notice')&&!q('#briefContent .brief-review-summary'),`${state}: no duplicate report banner`);
    q('#briefReadingMode').click();check(!notice.hidden&&notice.textContent===text,`${state}: Full report retains identical exception`);
    if(state==='superseded')check(notice.querySelector('[data-brief-route]').getAttribute('href')==='/briefing/brief-2026-10-09-02.md','Replacement stays directly reachable in both views');
  }
  await show('corrected');
  check(q('#briefAiDisclosure').textContent==='AI-generated draft with subsequent edits · Edition record','Corrected copy acknowledges subsequent edits');
  check(q('#briefPublicationState').hidden,'Resolved historical findings do not produce an amber current-copy banner');
  check(!q('#briefOverview').textContent.includes('Normalize the confidence')&&!q('#briefContent').textContent.includes('Normalize the confidence'),'Routine notes stay in the record');
  check(q('.brief-overview-feature .brief-evidence-limit').textContent.includes(issue.message)&&q('#briefContent .brief-evidence-limit').textContent.includes(issue.message),'Located reader-material limit remains beside its judgment in both views');
  const historical=q('#edition-record').textContent.includes('Old unsupported version claim.');check(historical,'Historical finding remains inspectable');
  const historyGroup=[...q('#edition-record').querySelectorAll('details')].find(node=>node.querySelector('summary')?.textContent==='Original publication');
  check(!historyGroup.querySelector('[data-record-passage]'),'Historical line numbers never link to the current passage');
  q('[data-open-edition-record]').click();check(q('#edition-record').open&&document.activeElement===q('#edition-record > summary'),'Record opens accessibly from Edition tools');
  q('#edition-record [data-record-passage]').click();
  check(q('#briefOverview').hidden&&!q('.briefing-layout').hidden&&document.activeElement.id==='judgment-1','Finding jump opens and focuses the current report passage');
  await show('corrected','#editorial-review');
  check(q('#edition-record').open,'Legacy review links open the shared record');
  await show('corrected','#edition-record');check(q('#edition-record').open,'Shared record links work on load');
  await show('draft');
  check(q('#briefAttemptStatus').textContent.includes('Saved draft · unpublished')&&q('#briefAttemptStatus [data-review-draft="new-draft"]'),'Separate operator task identifies the saved unpublished draft and its recovery action');
  check(q('#briefAttemptSlot').compareDocumentPosition(q('#briefOverview'))&Node.DOCUMENT_POSITION_FOLLOWING,'Draft task occupies the same position before both reading modes');
  q('#briefReadingMode').click();check(!q('#briefAttemptStatus').hidden&&q('#briefPublicationState').hidden,'New draft does not mark the published edition as blocked');
  check(document.documentElement.scrollWidth<=innerWidth+1,'Reader has no horizontal overflow');
  await show('published');
  check(q('#briefAiDisclosure').textContent==='AI-generated briefing · Edition record','Unedited publication has a concise AI disclosure');
  q('#briefAiDisclosure a').click();check(q('#edition-record').open&&document.activeElement===q('#edition-record > summary'),'Disclosure link opens the edition record accessibly');
  generation={id:'remote-job',status:'running',phase:'collecting'};
  window.dispatchEvent(new Event('focus'));
  await until(()=>q('#briefAttemptStatus').textContent.includes('Collecting current source evidence'));
  check(q('#briefGenerate').disabled,'A generation started elsewhere locks the visible Generate button');
  newer={...base(),filename:'brief-2026-10-09-02.md'};
  generation={...generation,status:'complete',filename:newer.filename};
  publicationRevision='remote-completed';
  window.dispatchEvent(new Event('focus'));
  await until(()=>!q('#briefLatestNotice').hidden);
  check(location.pathname.endsWith(filename),'Remote completion leaves the selected reading document in place');
  check(q('#briefMeta').textContent.includes('Archived briefing'),'Previous edition no longer claims current publication');
  check(q('#briefHistory').querySelector(`option[value="${newer.filename}"]`),'Remote publication appears in edition history');
  check(!q('#briefGenerate').disabled,'Generate unlocks when server accounting confirms completion');
  q('#briefLatestNotice a').click();
  await until(()=>location.pathname.endsWith(newer.filename)&&q('#briefMeta').textContent.includes('Current published briefing'));
  check(q('#briefLatestNotice').hidden,'Opening latest updates identity and clears the new-edition notice without reload');
  const selected=location.pathname;
  newer={...base(),filename:'brief-2026-10-09-03.md'};
  publicationRevision='older-draft-published'; archiveFailure=true;
  window.dispatchEvent(new Event('focus'));
  await until(()=>q('#briefMeta').textContent.includes('Saved briefing'));
  check(!q('#briefMeta').textContent.includes('Current published'),'Failed archive refresh does not leave a stale Current claim');
  await new Promise(done=>setTimeout(done,0));
  archiveFailure=false;
  window.dispatchEvent(new Event('focus'));
  await until(()=>!q('#briefLatestNotice').hidden&&q('#briefLatestNotice a').getAttribute('href').endsWith(newer.filename));
  check(location.pathname===selected&&q('#briefMeta').textContent.includes('Archived briefing'),'Older draft publication is detected despite an unchanged latest job, preserving the selected document');
  check(q('#briefHistory').querySelector(`option[value="${newer.filename}"]`),'A failed archive refresh retries on focus without generation');
  check(document.documentElement.scrollWidth<=innerWidth+1,'Remote status and new-edition controls fit the viewport');
  await show('actions');
  q('#briefReadingMode').click();
  const executive=q('.brief-exec-panel');
  check(!!executive,'Shared actions render a compact executive view');
  check(!executive.textContent.includes('obsolete provider summary'),'Executive view uses the canonical action record, not provider summary parsing');
  check(!executive.textContent.includes('restore from a verified safe backup'),'Executive view does not duplicate full qualified actions');
  check(executive.textContent.includes('Verify the gateway before remediation')&&executive.textContent.includes('Track the hosted rollout'),'Executive view groups by both actual assessments');
  for(const value of ['Operations','Incident response','Service owner','October 24, 2026','October 26, 2026','October 27, 2026'])check(executive.textContent.includes(value),`Executive view retains distinct owner/target: ${value}`);
  const links=[...executive.querySelectorAll('a')].filter(link=>link.getAttribute('href')?.startsWith('#judgment-'));
  check(executive.querySelectorAll('.brief-exec-groups > li').length===2&&links.length>=2&&links.every(link=>q(link.getAttribute('href'))),'Each compact group links to a real complete assessment');
  check(q('#briefContent').textContent.includes('only if affected, isolate the gateway')&&q('#briefContent').textContent.includes('retain isolation until validation completes'),'Complete conditional containment and recovery remain in the reader');
  const actionIds=[...new Set([...q('#briefContent').querySelectorAll('[data-action-id]')].map(node=>node.dataset.actionId))].sort();
  check(JSON.stringify(actionIds)===JSON.stringify(['S1.A1','S1.A2','S2.A1']),'Full reader actions reconcile with the shared record identities');
  check(!q('#briefContent').textContent.includes('Optional bounded coverage accounting note.')&&q('#edition-record').textContent.includes('Optional bounded coverage accounting note.'),'Partial coverage stays quiet in the edition record');
  check(q('#briefContent').textContent.includes('Verify the score association against the retained advisory.'),'Reader keeps the factual qualification');
  check(document.documentElement.scrollWidth<=innerWidth+1,'Compact executive groups fit the viewport');
  q('#briefExport').click();
  await until(()=>q('.np-frame')?.contentDocument?.querySelector('.np-exec-panel'));
  const printed=q('.np-frame').contentDocument, printExecutive=printed.querySelector('.np-exec-panel');
  check(printExecutive.querySelector('.np-exec-queue').textContent===executive.querySelector('.brief-exec-queue').textContent
    &&printExecutive.querySelector('.np-exec-facts').textContent===executive.querySelector('.brief-exec-facts').textContent,'Print and reader use the same executive groups, facts and targets');
  for(const qualification of ['only if affected, isolate the gateway','Dependencies: preserve relevant logs','if compromise is confirmed, restore from a verified safe backup','retain isolation until validation completes'])check(printed.body.textContent.includes(qualification),`Print preserves full response qualification: ${qualification}`);
  check(JSON.stringify([...new Set([...printed.querySelectorAll('[data-action-id]')].map(node=>node.dataset.actionId))].sort())===JSON.stringify(actionIds),'Print retains the exact reader action identities');
  check(!printed.body.textContent.includes('Optional bounded coverage accounting note.'),'Print does not repeat optional accounting notes');
  check(printed.body.textContent.includes('Verify the score association against the retained advisory.'),'Print retains factual qualifications');
  q('.np-overlay').close();
  await show('mixed-actions');
  const mixedOverview=q('#briefOverview');
  for(const [signal,message] of [[1,actionFixture.mixedLimits[0]],[3,actionFixture.mixedLimits[1]]]){
    const story=mixedOverview.querySelector(`#overview-judgment-${signal}`)?.closest('article');
    check(story?.textContent.includes(message),`Generic judgment ${signal} retains its caveat in Overview`);
  }
  q('#briefReadingMode').click();
  const mixedCards=[...q('#briefContent').querySelectorAll('.brief-judgment-card')];
  check(mixedCards.length===4,'Mixed provider heading styles produce exactly four judgment cards');
  for(let index=0;index<4;index++){
    const heading=mixedCards[index].querySelector('h3'),expected=`S${index+1}.A1`;
    check(heading.id===`judgment-${index+1}`&&heading.dataset.signal===String(index+1),`Mixed heading ${index+1} has its own ordinal and anchor`);
    check(mixedCards[index].querySelector('[data-action-id]')?.dataset.actionId===expected,`Mixed heading ${index+1} retains its own action even when recommendation text is identical`);
  }
  const headingIds=[...q('#briefContent').querySelectorAll('h3[id]')].map(node=>node.id);
  check(new Set(headingIds).size===headingIds.length,'Mixed provider headings never produce duplicate anchors');
  const outside=[...q('#briefContent').querySelectorAll('h3')].find(node=>node.textContent.includes('Supporting report outside'));
  check(!outside?.dataset.judgment&&!outside?.closest('.brief-judgment-card'),'A Signal-looking heading outside Key judgments receives no judgment identity');
  check([...q('#briefContent').querySelectorAll('blockquote h3, li h3')].every(node=>!node.dataset.judgment&&!node.closest('.brief-judgment-card')),'Quoted and list example headings never acquire action identities');
  for(let index=0;index<4;index++){
    const card=mixedCards[index],expected=index===0?actionFixture.mixedLimits[0]:index===2?actionFixture.mixedLimits[1]:null;
    const copied=decisionCopyText({...decisionCardContent(card),editionUrl:`${location.origin}/briefing/${filename}`,
      presentation:current.presentation,signal:index+1,sourceContent:current.content});
    for(const message of actionFixture.mixedLimits){
      check(card.textContent.includes(message)===(message===expected),`Judgment ${index+1} carries only its own located reader caveat`);
      check(copied.includes(message)===(message===expected),`Decision copy ${index+1} carries only its own caveat`);
    }
    check(!copied.includes('Supporting report requires separate confirmation.')&&!copied.includes('Optional mixed-heading coverage accounting.'),'Decision copies exclude unrelated supporting findings and editorial bookkeeping');
  }
  check(!mixedOverview.textContent.includes('Optional mixed-heading coverage accounting.')&&!q('#briefContent').textContent.includes('Optional mixed-heading coverage accounting.'),'Editorial accounting stays quiet across both reading modes');
  check(q('#edition-record').textContent.includes('Optional mixed-heading coverage accounting.'),'Quiet editorial finding remains inspectable');
  const firstFinding=[...q('#edition-record').querySelectorAll('[data-issue-message]')].find(node=>node.dataset.issueMessage===actionFixture.mixedLimits[0]);
  firstFinding.querySelector('[data-record-passage]').click();
  check(document.activeElement.id==='judgment-1','Generic-heading finding jumps to the correct current assessment');
  q('#briefExport').click();
  await until(()=>q('.np-frame')?.contentDocument?.querySelector('.np-exec-panel'));
  const mixedPrint=q('.np-frame').contentDocument;
  check(JSON.stringify([...new Set([...mixedPrint.querySelectorAll('[data-action-id]')].map(node=>node.dataset.actionId))].sort())===JSON.stringify(['S1.A1','S2.A1','S3.A1','S4.A1']),'Mixed heading action identities survive print');
  for(const message of actionFixture.mixedLimits)check(mixedPrint.body.textContent.includes(message),'Print preserves material generic-heading caveats');
  check(!mixedPrint.body.textContent.includes('Optional mixed-heading coverage accounting.'),'Print keeps optional editorial accounting quiet');
  q('.np-overlay').close();
  window.__showReaderState=show;window.__finishReaderState=()=>{unmount();window.fetch=originalFetch;};
  return{checks};
}

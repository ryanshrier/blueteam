// Real reader UI with synthetic, browser-local API responses. No operator data,
// writes, model calls, or external requests are permitted by this fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureApp } from './serve-visual-fixtures.mjs';
import { CdpConnection, findBrowser, launchBrowser } from './check-landing-render.mjs';

const app = createFixtureApp();
app.get('/reader-state-fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">${['fonts','tokens','app','frontend-refinement','briefing-refinement'].map(name=>`<link rel="stylesheet" href="/${name}.css">`).join('')}</head><body><main id="main" tabindex="-1"></main><div id="toastContainer"></div></body></html>`));
const server = app.listen(0, '127.0.0.1');
await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.READER_SCREENSHOT_DIR ? resolve(process.env.READER_SCREENSHOT_DIR) : null;
let browser, connection;
const errors = [];
try {
  const path = findBrowser(); assert(path, 'Chrome/Chromium/Edge required. Set CHROME_PATH.');
  browser = await launchBrowser(path);
  const response = await fetch(`${browser.debugOrigin}/json/new?about:blank`, { method: 'PUT' });
  connection = new CdpConnection((await response.json()).webSocketDebuggerUrl);
  await Promise.all([connection.call('Page.enable'), connection.call('Runtime.enable')]);
  connection.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  connection.on('Fetch.requestPaused', event => {
    const local = event.request.url.startsWith(`${origin}/`) && !event.request.url.startsWith(`${origin}/api/`);
    if (!local) errors.push(`Unexpected request: ${event.request.url}`);
    void connection.call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId:event.requestId, ...(!local ? {errorReason:'BlockedByClient'}:{}) }).catch(error=>errors.push(error.message));
  });
  await connection.call('Fetch.enable', { patterns:[{urlPattern:'*',requestStage:'Request'}] });
  for (const width of [1280,390]) {
    await connection.call('Emulation.setDeviceMetricsOverride', { width,height:900,deviceScaleFactor:1,mobile:width<600 });
    const loaded = connection.waitFor('Page.loadEventFired');
    await connection.call('Page.navigate', { url:`${origin}/reader-state-fixture` }); await loaded;
    const result = await connection.call('Runtime.evaluate', { awaitPromise:true,returnByValue:true,expression:`(${runReaderChecks.toString()})()` });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
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
    console.log(`PASS reader state ${width}px: ${result.result.value.checks} checks; shared exceptions, current/history, evidence jump, exact qualifications, safe record links`);
  }
} finally {
  connection?.close(); if(browser) await browser.close();
  server.closeAllConnections(); await new Promise(done=>server.close(done));
}

async function runReaderChecks() {
  const {render,unmount}=await import('/modules/briefing/briefing-view.js');
  const {setState}=await import('/modules/core/store.js');
  let checks=0, current, pending=false;
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
    if(url==='/api/settings')data={ai:{enabled:false}};
    else if(url==='/api/brief/status')data={persistence:'ok',active:false,latest:null,draftRecovery:{items:pending?[{id:'new-draft',status:'draft',editionDate:'2026-10-09'}]:[]}};
    else if(url==='/api/briefs')data=[{filename,disposition:current.disposition}];
    else if(url===`/api/brief/${filename}`)data=current;
    else if(url==='/api/headlines')data={headlines:[],generatedAt:'2026-10-09T12:00:00Z'};
    else throw new Error(`Unexpected synthetic endpoint ${url}`);
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  async function show(state,hash=''){
    unmount(); current=base(); pending=state==='draft';
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
    await until(()=>q('#briefContent')?._validatedBriefContent===markdown&&q('#edition-record'));
    q('#briefOverviewMode').click();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));scrollTo(0,0);
  }
  await show('clean');
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
  check(q('#briefAttemptStatus').textContent.includes('New draft awaiting review'),'Separate operator task names the new draft');
  check(q('#briefAttemptSlot').compareDocumentPosition(q('#briefOverview'))&Node.DOCUMENT_POSITION_FOLLOWING,'Draft task occupies the same position before both reading modes');
  q('#briefReadingMode').click();check(!q('#briefAttemptStatus').hidden&&q('#briefPublicationState').hidden,'New draft does not mark the published edition as blocked');
  check(document.documentElement.scrollWidth<=innerWidth+1,'Reader has no horizontal overflow');
  await show('published');
  check(q('#briefAiDisclosure').textContent==='AI-generated briefing · Edition record','Unedited publication has a concise AI disclosure');
  q('#briefAiDisclosure a').click();check(q('#edition-record').open&&document.activeElement===q('#edition-record > summary'),'Disclosure link opens the edition record accessibly');
  window.__showReaderState=show;window.__finishReaderState=()=>{unmount();window.fetch=originalFetch;};
  return{checks};
}

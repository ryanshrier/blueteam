import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRejectedBrief, readBriefDraft, listBriefDrafts, revalidateBriefDraft, validationSourceFromManifest, DRAFT_RETENTION, draftValidation, recordDraftPublication } from '../lib/brief-drafts.js';
import { validateBrief } from '../lib/validation.js';

const replay = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-06.json', import.meta.url),'utf8'));
const validate = (content, manifest) => validateBrief(content, manifest.edition.date, validationSourceFromManifest(manifest));
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brief-draft-recovery-')); });
afterEach(() => { rmSync(dir, { recursive:true, force:true }); });
const save = (content = replay.content) => saveRejectedBrief(dir, {content,manifest:replay.manifest,validation:validate(content,replay.manifest)});

describe('durable rejected briefing repair', () => {
  test('revalidation repairs safe formatting before checking and preserves the original and captured inputs', () => {
    const original = '## CONVERGENCE\n\nNo supported convergence is established in the retained evidence.\n\n## WATCHLIST\n\n- First item\n- Second item';
    const saved = save(original);
    let checked;
    const updated = revalidateBriefDraft(dir, saved.id, { baseRevision: 1 }, content => {
      checked = content;
      return { valid: true, warnings: [], issues: [] };
    });
    expect(checked).toContain('No supported intersection was found in the retained evidence.');
    expect(checked).toContain('- First item\n\n- Second item');
    expect(updated.revisions[0]).toEqual(saved.revisions[0]);
    expect(updated.manifestSha256).toBe(saved.manifestSha256);
    expect(updated.revisions[1]).toMatchObject({ content: checked, formattingRepaired: true });
    const repeated = revalidateBriefDraft(dir, saved.id, { baseRevision: 2 }, validate);
    expect(repeated.revisions).toEqual(updated.revisions);
    expect(repeated.lastCheck).toMatchObject({ revision: 2, contentSha256: updated.revisions[1].sha256 });
  });

  test('reload recovers exact public inputs, original draft and located failures', () => {
    const saved = save();
    const loaded = readBriefDraft(dir, saved.id);
    expect(loaded.manifest).toEqual(replay.manifest);
    expect(loaded.revisions[0].content).toBe(replay.content);
    expect(loaded.revisions[0].validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'FACT_CVE_COUNT_MISMATCH',location:expect.objectContaining({line:11})})]));
    expect(listBriefDrafts(dir)).toEqual([expect.objectContaining({id:saved.id,revisionCount:1,status:'draft',editorialReviewStatus:'not-reviewed'})]);
  });

  test('revalidation appends an immutable revision using identical captured inputs without a provider', () => {
    const saved = save();
    const updated = revalidateBriefDraft(dir, saved.id, {content:replay.content.replace('Nine separate CVEs','Ten separate CVEs'),baseRevision:1}, validate);
    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[0]).toEqual(saved.revisions[0]);
    expect(updated.manifestSha256).toBe(saved.manifestSha256);
    expect(updated.revisions[1].validation.issues.map(issue=>issue.code)).not.toContain('FACT_CVE_COUNT_MISMATCH');
    expect(updated.status).toBe('draft');
    expect(revalidateBriefDraft(dir,saved.id,{},validate).revisions).toEqual(updated.revisions);
    expect(() => revalidateBriefDraft(dir,saved.id,{baseRevision:1},validate)).toThrow('newer repair');
  });

  test('passing supported checks remains an unpublished and unreviewed draft', () => {
    const saved = save();
    const checked = revalidateBriefDraft(dir,saved.id,{},()=>({valid:true,warnings:[],issues:[],coverage:{notEstablished:['editorial review']}}));
    expect(checked.status).toBe('draft');
    expect(draftValidation(checked).editorialReviewStatus).toBe('not-reviewed');
    expect(listBriefDrafts(dir)[0]).toMatchObject({ canPublish: true, blockerCount: 0, reviewCount: 0 });
    expect(listBriefDrafts(dir)[0].url).toBe(`/api/brief/drafts/${saved.id}`);
  });

  test('digest changes and traversal are rejected before exposing retained data', () => {
    const saved = save();
    const path = join(dir,'.rejected-drafts',`${saved.id}.json`);
    const edited = {...saved,manifest:{...saved.manifest,edition:{date:'2030-01-01'}}};
    writeFileSync(path,JSON.stringify(edited));
    expect(()=>readBriefDraft(dir,saved.id)).toThrow('integrity');
    expect(listBriefDrafts(dir)).toEqual([]);
    expect(()=>readBriefDraft(dir,'../outside')).toThrow('identifier');
  });

  test('content stays bounded while repeated checks and continued editing preserve the original', () => {
    expect(()=>save('x'.repeat(DRAFT_RETENTION.maxContentBytes+1))).toThrow('retention limit');
    const saved = save('Original retained content');
    const clean = () => ({valid:true,warnings:[],issues:[]});
    for(let index=0;index<12;index++) revalidateBriefDraft(dir,saved.id,{ baseRevision: 1 },clean);
    expect(readBriefDraft(dir, saved.id).revisions).toEqual(saved.revisions);
    for(let index=1;index<12;index++) revalidateBriefDraft(dir,saved.id,{content:`Repair ${index}`,baseRevision:index},clean);
    const retained = readBriefDraft(dir, saved.id);
    expect(retained.revisions).toHaveLength(DRAFT_RETENTION.maxRevisions);
    expect(retained.revisions[0]).toEqual(saved.revisions[0]);
    expect(retained.revisions.at(-1)).toMatchObject({ number: 12, content: 'Repair 11' });
    expect(() => revalidateBriefDraft(dir,saved.id,{baseRevision:8},clean)).toThrow('newer repair');
    expect(listBriefDrafts(dir)[0]).toMatchObject({ revision: 12, revisionCount: 8 });
  });

  test('deliberately saved work survives age and automatic recovery cleanup', () => {
    const saved = save();
    const checked = revalidateBriefDraft(dir,saved.id,{},()=>({valid:true,warnings:[],issues:[]}));
    const path = join(dir,'.rejected-drafts',`${saved.id}.json`);
    const old = new Date(Date.now() - 90 * 86400000);
    checked.operatorSavedAt = old.toISOString();
    writeFileSync(path,JSON.stringify(checked));
    utimesSync(path,old,old);
    for (let index=0;index<DRAFT_RETENTION.maxDrafts+2;index++) save('Automatic recovery');
    expect(readBriefDraft(dir,saved.id).revisions[0]).toEqual(saved.revisions[0]);
    expect(listBriefDrafts(dir).map(item=>item.id)).toContain(saved.id);
    expect(listBriefDrafts(dir)).toHaveLength(DRAFT_RETENTION.maxDrafts+1);
  });

  test('a new check replaces current findings without rewriting the original rejection evidence', () => {
    const saved = save();
    const checked = revalidateBriefDraft(dir,saved.id,{},()=>({valid:true,warnings:[],issues:[]}));
    expect(checked.revisions[0]).toEqual(saved.revisions[0]);
    expect(draftValidation(readBriefDraft(dir,saved.id)).issues).toEqual([]);
    expect(checked.manifest).toEqual(saved.manifest);
  });

  test('the bounded finding list cannot hide a severe issue behind editorial notes', () => {
    const issues = Array.from({length:220}, (_,index)=>({code:'REVIEW',severity:'review',message:`Editorial note ${index}`}));
    issues.push({code:'UNSAFE_CITATION',severity:'trust',message:'Uncaptured destination'});
    const saved = saveRejectedBrief(dir,{content:'Draft',manifest:replay.manifest,validation:{valid:false,issues,warnings:[]}});
    expect(saved.revisions[0].validation.issues).toHaveLength(200);
    expect(saved.revisions[0].validation.issues[0].code).toBe('UNSAFE_CITATION');
    expect(listBriefDrafts(dir)[0]).toMatchObject({canPublish:false,blockerCount:1});
  });

  test('publication recording binds the exact revision and inputs, is idempotent, and closes editing', () => {
    const saved = save();
    const current = saved.revisions.at(-1);
    const input = {revision:current.number,contentSha256:current.sha256,inputSha256:saved.manifestSha256,filename:'brief-2026-09-06-01.md',publishedAt:new Date().toISOString()};
    expect(()=>recordDraftPublication(dir,saved.id,{...input,contentSha256:'0'.repeat(64)})).toThrow('changed');
    const published = recordDraftPublication(dir,saved.id,input);
    expect(published.status).toBe('published');
    expect(readBriefDraft(dir,saved.id).publication).toEqual(input);
    expect(recordDraftPublication(dir,saved.id,{...input,publishedAt:new Date(Date.now()+1000).toISOString()})).toEqual(published);
    expect(listBriefDrafts(dir)).toEqual([]);
    expect(()=>revalidateBriefDraft(dir,saved.id,{},validate)).toThrow('already been published');
    expect(()=>recordDraftPublication(dir,saved.id,{...input,filename:'brief-2026-09-06-02.md'})).toThrow('already has');
  });

  test('credential-shaped accidental model output is redacted with provenance', () => {
    const original = 'Draft token sk-ant-' + 'synthetic-test-only';
    const saved = save(original);
    expect(saved.contentRedacted).toBe(true);
    expect(saved.revisions[0].content).toBe('Draft token [REDACTED]');
    expect(saved.originalOutputSha256).not.toBe(saved.revisions[0].sha256);
  });

  test('unallowlisted config/client keys cannot enter retained input diagnostics', () => {
    const saved = saveRejectedBrief(dir,{content:'draft',manifest:{...replay.manifest,config:{apiKey:'not-a-provider-pattern'},client:{password:'private'},collection:{headers:{Authorization:'private'}}},validation:{valid:false,issues:[],warnings:[]}});
    expect(saved.manifest.config).toBeUndefined();
    expect(saved.manifest.client).toBeUndefined();
    expect(saved.manifest.collection.headers).toBe('[REDACTED]');
    expect(JSON.stringify(saved.manifest)).not.toContain('private');
    expect(saved.manifestRedacted).toBe(true);
  });
});

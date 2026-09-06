import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRejectedBrief, readBriefDraft, listBriefDrafts, revalidateBriefDraft, validationSourceFromManifest, DRAFT_RETENTION } from '../lib/brief-drafts.js';
import { validateBrief } from '../lib/validation.js';

const replay = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-06.json', import.meta.url),'utf8'));
const validate = (content, manifest) => validateBrief(content, manifest.edition.date, validationSourceFromManifest(manifest));
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brief-draft-recovery-')); });
afterEach(() => { rmSync(dir, { recursive:true, force:true }); });
const save = (content = replay.content) => saveRejectedBrief(dir, {content,manifest:replay.manifest,validation:validate(content,replay.manifest)});

describe('durable rejected briefing repair', () => {
  test('reload recovers exact public inputs, original draft and located failures', () => {
    const saved = save();
    const loaded = readBriefDraft(dir, saved.id);
    expect(loaded.manifest).toEqual(replay.manifest);
    expect(loaded.revisions[0].content).toBe(replay.content);
    expect(loaded.revisions[0].validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'FACT_CVE_COUNT_MISMATCH',location:expect.objectContaining({line:11})})]));
    expect(listBriefDrafts(dir)).toEqual([expect.objectContaining({id:saved.id,revisionCount:1,status:'rejected',editorialReviewStatus:'not-reviewed'})]);
  });

  test('revalidation appends an immutable revision using identical captured inputs without a provider', () => {
    const saved = save();
    const updated = revalidateBriefDraft(dir, saved.id, {content:replay.content.replace('Nine separate CVEs','Ten separate CVEs'),baseRevision:1}, validate);
    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[0]).toEqual(saved.revisions[0]);
    expect(updated.manifestSha256).toBe(saved.manifestSha256);
    expect(updated.revisions[1].validation.issues.map(issue=>issue.code)).not.toContain('FACT_CVE_COUNT_MISMATCH');
    expect(updated.status).toBe('rejected');
    expect(revalidateBriefDraft(dir,saved.id,{},validate).revisions[2].kind).toBe('revalidation');
    expect(() => revalidateBriefDraft(dir,saved.id,{baseRevision:1},validate)).toThrow('newer repair');
  });

  test('passing supported checks remains an unpublished and unreviewed draft', () => {
    const saved = save();
    const checked = revalidateBriefDraft(dir,saved.id,{},()=>({valid:true,warnings:[],issues:[],coverage:{notEstablished:['editorial review']}}));
    expect(checked.status).toBe('checked-draft');
    expect(checked.revisions.at(-1).validation.editorialReviewStatus).toBe('not-reviewed');
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

  test('content and revision limits prevent unbounded retained editing', () => {
    expect(()=>save('x'.repeat(DRAFT_RETENTION.maxContentBytes+1))).toThrow('retention limit');
    const saved = save();
    for(let index=1;index<DRAFT_RETENTION.maxRevisions;index++) revalidateBriefDraft(dir,saved.id,{},()=>({valid:true,warnings:[],issues:[]}));
    expect(()=>revalidateBriefDraft(dir,saved.id,{},validate)).toThrow('revision limit');
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

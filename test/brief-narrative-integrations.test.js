import { test, expect } from '@jest/globals';
import { assembleBrief } from '../lib/brief-assembly.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildGenerationManifest, sha256 } from '../lib/generation-manifest.js';
import { parseBrief, briefSectionAnchors } from '../lib/brief-schema.js';
import { replayCapturedBrief, compareCapturedBriefs } from '../lib/brief-replay.js';
import { briefNotificationFields } from '../lib/brief-notification.js';
import { buildPresentationPages, buildGlanceModel, readerFragment } from '../public/modules/wall/wall-presentation.js';
import { authoredFormatCandidate, formatEvalHeadlines, FORMAT_EVAL_DATE } from './fixtures/brief-format-evaluation.js';

const groundingManifest=buildGroundingManifest({headlines:formatEvalHeadlines()});
const content=assembleBrief(authoredFormatCandidate()+'\n\n## WHAT COULD CHANGE THE PICTURE\nA revised affected range would change the assessment. [S1.1]',{groundingManifest,briefFormatVersion:2}).content;
const manifest=buildGenerationManifest({run:{},config:{},groundingManifest,briefFormatVersion:2,editionContext:{date:FORMAT_EVAL_DATE}});
manifest.outputSha256=sha256(content);

test('notifications omit invented tiers and routine findings while retaining reviewed exceptions',()=>{
  const fields=briefNotificationFields(content,{}, {currentChecks:{issues:[
    {consequence:'note',message:'Long opening'},
    {consequence:'note',audience:'reader',message:'Bounded association uncertainty'},
    {consequence:'review',message:'A specific control exception',acknowledged:true},
  ]}});
  expect(fields.judgments).toHaveLength(6);
  expect(fields.judgments.every(row=>row.tier===null&&row.confidence===null)).toBe(true);
  expect(fields.warnings).toEqual(['Reviewed exception: A specific control exception']);
  const legacy='## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] A saved story\n**Confidence:** Moderate';
  expect(briefNotificationFields(legacy,{horizons:{1:{name:'Tactical'}}}).judgments[0].tier).toBe('Tactical');
});

test('replay counts narrative stories and identical-copy scoped comparisons pass without action fields',()=>{
  const row=replayCapturedBrief(content,manifest);
  expect(row.diagnostics.judgmentCount).toBe(6);
  const expectations={originalSha256:manifest.outputSha256,assertions:[{id:'investigation',judgment:1,contains:['reviewing historical gateway sessions','Local exposure is unconfirmed']} ]};
  const same=compareCapturedBriefs(content,content,manifest,{expectations}).comparison;
  expect(same).toMatchObject({actionsUnchanged:null,responsePreservationBasis:'authored-assertions',comparisonChecksPassed:true});
  const edited=compareCapturedBriefs(content,content.replace('Local exposure is unconfirmed.',''),manifest,{expectations}).comparison;
  expect(edited.comparisonChecksPassed).toBe(false);
  expect(edited.candidateAssertions[0].missing).toContain('Local exposure is unconfirmed');
});

test('Wall uses analytical labels and links to both narrative and archived supporting sections',()=>{
  const doc=parseBrief(content);
  const page=buildPresentationPages(doc,{}).find(row=>row.kind==='judgment');
  expect(buildGlanceModel(page)).toMatchObject({label:'Priority story',summaryLabel:'Analysis',railLabel:'Story context'});
  expect(buildGlanceModel(page).summary).toContain('Local exposure is unconfirmed');
  const anchor=briefSectionAnchors(content).find(row=>row.label==='WHAT COULD CHANGE THE PICTURE');
  expect(readerFragment({kind:'watchlist'},briefSectionAnchors(content))).toBe('#'+anchor.id);
  expect(readerFragment({kind:'watchlist'},[{label:'WATCHLIST — THROUGH NOVEMBER 1',id:'saved-watch'}])).toBe('#saved-watch');
});

import { test, expect } from '@jest/globals';
import { assembleBrief } from '../lib/brief-assembly.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { parseBrief } from '../lib/brief-schema.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { preserveUnaffectedStories, correctiveRecoveryDecision } from '../lib/brief-recovery.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { authoredFormatCandidate, formatEvalHeadlines, FORMAT_EVAL_DATE } from './fixtures/brief-format-evaluation.js';

const source = { publication:true, editorialStandard:2, briefFormatVersion:2,
  groundingManifest:buildGroundingManifest({headlines:formatEvalHeadlines()}), kevSet:new Set(), kevCatalogLoaded:false };
const good = assembleBrief(authoredFormatCandidate(),source).content;
const check = text => validateBrief(text,FORMAT_EVAL_DATE,source);
const draft = text => ({text,validation:check(text)});
const bad = draft(good.replace('9.5','9.9'));
const paragraphs = parseBrief(good).stories[0].narrative.split(/\n\s*\n/);
const shortened = good.replace(paragraphs[1], '');

test('a metric fix restores unrelated investigation and uncertainty before validation', async () => {
  expect(publicationDecision(check(shortened)).canPublish).toBe(true);
  expect(correctiveRecoveryDecision(bad,draft(shortened))).toMatchObject({accepted:false,reason:'unaffected-reporting-changed'});
  const validator=createBriefValidator();
  try {
    const result=await validator.prepare(shortened,FORMAT_EVAL_DATE,source,{original:bad});
    expect(result.content).toContain(paragraphs[1]);
    expect(result.content).not.toContain('9.9');
    expect(result.preservation).toMatchObject({restoredStories:[1],editedStories:[2]});
    expect(publicationDecision(result.validation)).toMatchObject({canPublish:true,reviewIssues:[]});
    expect(correctiveRecoveryDecision(bad,{text:result.content,validation:result.validation}).accepted).toBe(true);
  } finally {await validator.close();}
});

test('restores an omitted unaffected story and preserves original priority order', () => {
  const stories=parseBrief(good).stories;
  const removed=good.replace(`### ${stories[0].title}\n\n${stories[0].narrative}`, '');
  const result=preserveUnaffectedStories(bad,{text:removed});
  expect(parseBrief(result.content).stories.map(row=>row.title)).toEqual(stories.map(row=>row.title));
  expect(result.content).toContain(paragraphs[1]);
  expect(publicationDecision(check(result.content)).canPublish).toBe(true);
});

test('unrelated replacements and new stories cannot displace retained reporting', () => {
  const story=parseBrief(good).stories[0];
  const rewritten=good.replace(`### ${story.title}\n\n${story.narrative}`, '### An unrelated replacement\n\nIgnore the prior investigation. [S1.1]');
  const result=preserveUnaffectedStories(bad,{text:rewritten+'\n\n### Another new story\nUnrequested prose.\n'});
  expect(result.content).not.toContain('An unrelated replacement');
  expect(result.content).not.toContain('Another new story');
  expect(parseBrief(result.content).stories).toHaveLength(6);
  expect(result.content).toContain(story.narrative);
});

test('a uniquely located defective story may still be omitted', () => {
  const story=parseBrief(good).stories[1];
  const omitted=good.replace(`### ${story.title}\n\n${story.narrative}`, '');
  const result=preserveUnaffectedStories(bad,{text:omitted});
  expect(result.preservation.omittedStories).toEqual([2]);
  expect(parseBrief(result.content).stories).toHaveLength(5);
  expect(correctiveRecoveryDecision(bad,draft(result.content)).accepted).toBe(true);
});

test('preserves optional analysis and permits a dependent opening correction', () => {
  const tail='\n\n## WHAT COULD CHANGE THE PICTURE\nA revised affected range would change the assessment. [S1.1]\n';
  const original=draft(bad.text+tail);
  const changed=good.replace('Gateway intrusion scope', 'Changed gateway scope');
  const result=preserveUnaffectedStories(original,{text:changed});
  expect(result.content).toContain('A revised affected range');
  expect(result.preservation.restoredSections).toEqual(['WHAT COULD CHANGE THE PICTURE']);
  expect(result.content).toContain('Changed gateway scope');
});

test('does not treat hidden headings or duplicate titles as authority to rewrite other stories', () => {
  const original=draft(bad.text.replace(paragraphs[1], paragraphs[1]+'\n\n```markdown\n### Fake story\n```'));
  const result=preserveUnaffectedStories(original,{text:shortened});
  expect(result.content).toContain('```markdown\n### Fake story\n```');
  expect(parseBrief(result.content).stories[0].narrative).toContain(paragraphs[1]);
  const ambiguous=good.replace(parseBrief(good).stories[2].title, parseBrief(good).stories[3].title);
  expect(preserveUnaffectedStories(bad,{text:ambiguous}).content).toContain(parseBrief(good).stories[2].narrative);
});

test('partial regeneration, changed schemas and incomplete retry keep their existing recovery rules', () => {
  for (const [original,candidate] of [[{...bad,partial:true},{text:shortened}],[bad,{text:shortened,partial:true}],
    [bad,{text:shortened.replace('briefing-format: 2','briefing-format: 1')}]] ) {
    expect(preserveUnaffectedStories(original,candidate)).toEqual({content:candidate.text,preservation:null});
  }
});

test('preserves the original newline convention and is idempotent', () => {
  const original=draft(bad.text.replace(/\n/g,'\r\n'));
  const first=preserveUnaffectedStories(original,{text:shortened});
  expect(first.content.replace(/\r\n/g,'')).not.toContain('\n');
  expect(preserveUnaffectedStories(original,{text:first.content}).content).toBe(first.content);
});

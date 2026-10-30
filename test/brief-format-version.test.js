import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { assembleBrief } from '../lib/brief-assembly.js';
import { briefFormatVersion, stampBriefFormat, parseBrief, parseJudgments } from '../lib/brief-schema.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildSystemPrompt, buildUserPrompt } from '../lib/prompts.js';
import { buildGenerationManifest } from '../lib/generation-manifest.js';
import { prepareDraftRevision, validationSourceFromManifest } from '../lib/brief-drafts.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { correctiveRecoveryDecision } from '../lib/brief-recovery.js';
import { overviewModel, renderOverview } from '../public/modules/briefing/brief-overview.js';
import { briefSourceIndex, sourceFindingLocation } from '../public/modules/briefing/brief-source-index.js';
import { wallDocumentHtml } from '../public/modules/wall/wall-actions.js';
import { FORMAT_EVAL_DATE, authoredFormatCandidate, formatEvalHeadlines } from './fixtures/brief-format-evaluation.js';
import { FORMAT_EVAL_CASES } from './fixtures/brief-format-evaluation.js';

const config = { analysisSettings: {} };
const groundingManifest = buildGroundingManifest({ headlines: formatEvalHeadlines() });
const source = { publication: true, editorialStandard: 2, briefFormatVersion: 2, groundingManifest, kevSet: new Set(), kevCatalogLoaded: false };
const raw = authoredFormatCandidate();
const content = assembleBrief(raw, source).content;
const check = text => validateBrief(text, FORMAT_EVAL_DATE, source);

test('version 2 passes real publication checks without mandatory actions, dates or an audit projection', () => {
  const validation = check(content);
  expect(publicationDecision(validation)).toMatchObject({ canPublish: true, blockers: [], reviewIssues: [] });
  expect(validation.briefFormatVersion).toBe(2);
  expect(validation.judgmentEvidence).toHaveLength(6);
  expect(validation.issues.some(issue => /FIELD_MISSING|ACTION_INVALID|DECISION_WINDOW|CONVERGENCE/.test(issue.code))).toBe(false);
  const parsed = parseBrief(content);
  expect(parsed.stories).toHaveLength(6);
  expect(parsed.actions).toEqual([]);
  expect(parsed.stories.every(story => story.horizon === null && !story.decision && !story.confidence)).toBe(true);
  expect(parsed.stories[0].paragraphs).toHaveLength(2);
  expect(parsed.stories[0].citations.length).toBeGreaterThan(0);
});

test.each([
  ['wrong score', '9.5', '9.9'],
  ['wrong CVE', 'CVE-2026-12345', 'CVE-2026-99999'],
  ['wrong assessment type', 'Secondary', 'Primary'],
  ['wrong finality', '(provisional)', '(final)'],
  ['unknown citation', '[S1.1]', '[S999.1]'],
])('version 2 retains blocking evidence checks: %s', (_name, before, after) => {
  const altered = assembleBrief(raw.replace(before, after), source).content;
  expect(publicationDecision(check(altered)).blockers.length).toBeGreaterThan(0);
});

test('reporting a control proposal is allowed; a separate execution instruction still needs review', () => {
  expect(check(content).issues.filter(issue => issue.code === 'SECURITY_CONTROL_CHANGE')).toEqual([]);
  const qualified = content.replace('The unresolved decision is whether that tradeoff fits local operating constraints and authorization.', 'This is a proposed control exception, not an authorized customer change or a general recommendation to disable EDR.');
  expect(check(qualified).issues.filter(issue => issue.code === 'SECURITY_CONTROL_CHANGE')).toEqual([]);
  for (const directive of ['Disable EDR now across all hosts.', '### Disable EDR now', 'The vendor proposes temporarily disabling EDR. Disable MFA too.', 'If affected, disable EDR until the upgrade completes.']) {
    const checks = check(content.replace('## PRIORITY STORIES', `## PRIORITY STORIES\n\n${directive}`));
    expect(publicationDecision(checks).reviewIssues.map(issue => issue.code)).toContain('SECURITY_CONTROL_CHANGE');
  }
});

test('reader preserves all narrative qualifications and citations without legacy placeholders', () => {
  const model = overviewModel({ content });
  const html = renderOverview({ content });
  expect(model.judgments).toHaveLength(6);
  expect(model.preface).not.toContain('briefing-format');
  expect(html).toContain('Local exposure is unconfirmed');
  expect(html).not.toMatch(/Not assessed|Owner not specified|Decision window/);
  const wall = wallDocumentHtml(parseBrief(content));
  expect(wall).toContain('revoking or rotating exposed credentials');
  expect(wall).not.toMatch(/No action was authored|Owner not specified|Confidence \/ basis/);
  const index = briefSourceIndex(content, marked.lexer(content));
  expect(index.judgments).toHaveLength(6);
  const location = sourceFindingLocation(index, { location: { line: index.judgments[1].line + 1 } });
  expect(location.signal).toBe(2);
});

test('unmarked archives keep legacy parsing; receipts and markers cannot silently change format', () => {
  expect(briefFormatVersion(raw)).toBe(1);
  expect(parseJudgments(raw)).toEqual([]);
  const legacy = readFileSync(new URL('../docs/sample-briefing.md', import.meta.url), 'utf8');
  expect(parseJudgments(legacy).length).toBeGreaterThan(0);
  expect(briefFormatVersion(legacy)).toBe(1);
  expect(stampBriefFormat(legacy, 1)).toBe(legacy);
  expect(check(raw).issues.map(issue => issue.code)).toContain('BRIEF_FORMAT_MISMATCH');
  expect(check(content.replace('briefing-format: 2', 'briefing-format: 99')).issues.map(issue => issue.code)).toContain('BRIEF_FORMAT_UNSUPPORTED');
  expect(validateBrief(content, FORMAT_EVAL_DATE, { ...source, briefFormatVersion: 1 }).issues.map(issue => issue.code)).toContain('BRIEF_FORMAT_MISMATCH');
});

test('generation has one analytical prompt with no format selection', () => {
  const system = buildSystemPrompt(config, { date: FORMAT_EVAL_DATE });
  const user = buildUserPrompt({ headlines: formatEvalHeadlines(), config, editionContext: { date: FORMAT_EVAL_DATE } });
  expect(system).toContain('Do not assign departments');
  expect(system).toContain('provisional');
  expect(system).not.toContain('## KEY JUDGMENTS');
  expect(user).toContain('conditional');
  expect(user).not.toContain('otherwise explicitly state no supported intersection');
  expect(buildSystemPrompt({ analysisSettings: {} }, { date: FORMAT_EVAL_DATE })).not.toContain('## KEY JUDGMENTS');
});

test('worker preparation, retained checks and draft edits stay bound to the captured format', async () => {
  const validator = createBriefValidator();
  try {
    const prepared = await validator.prepare(raw, FORMAT_EVAL_DATE, source);
    expect(publicationDecision(prepared.validation).canPublish).toBe(true);
    const manifest = buildGenerationManifest({ run: {}, config, groundingManifest, briefFormatVersion: 2, editionContext: { date: FORMAT_EVAL_DATE } });
    expect(manifest.generationSettings.briefFormatVersion).toBe(2);
    const before = JSON.stringify(manifest);
    const retained = await validator.retained(prepared.content, manifest);
    expect(publicationDecision(retained.validation).canPublish).toBe(true);
    expect(JSON.stringify(manifest)).toBe(before);
    const artifact = { manifest, revisions: [{ number: 1, content: prepared.content }] };
    const unchanged = prepareDraftRevision(artifact, prepared.content);
    expect(unchanged.retained).toBe(prepared.content);
    const edited = prepareDraftRevision(artifact, raw.replace('Local exposure is unconfirmed.', 'Local exposure remains unconfirmed.'));
    expect(briefFormatVersion(edited.retained)).toBe(2);
    expect(publicationDecision(check(edited.retained)).canPublish).toBe(true);
    delete manifest.generationSettings.briefFormatVersion;
    expect(validationSourceFromManifest(manifest).briefFormatVersion).toBe(1);
  } finally { await validator.close(); }
});

test('repair cannot drop unaffected stories or change the edition format', () => {
  const original = { text: content, validation: { validationPolicyVersion: 4, issues: [{ code: 'CVSS_UNSUPPORTED', severity: 'trust', message: 'Signal 2 wrong score' }] } };
  const emptyChecks = { validationPolicyVersion: 4, issues: [] };
  expect(correctiveRecoveryDecision(original, { text: content.replace(/### [^\n]+\n[\s\S]*?(?=###)/, ''), validation: emptyChecks }).accepted).toBe(false);
  expect(correctiveRecoveryDecision(original, { text: content.replace('briefing-format: 2', 'briefing-format: 1'), validation: emptyChecks }).reason).toBe('format-changed');
});

test.each(['## TODAY\'S PICTURE\n\n## PRIORITY STORIES', '## TODAY\'S PICTURE\nA lead.\n## PRIORITY STORIES\n### Empty story'])('empty narrative output remains blocked', body => {
  expect(publicationDecision(check(stampBriefFormat(body, 2))).canPublish).toBe(false);
});

test('a short substantive strategic edition needs no action, minimum length or horizon quota', () => {
  const text = `# Briefing\n## TODAY'S PICTURE\nThe consultation opens a policy question without establishing a new obligation.\n## PRIORITY STORIES\n### A consultation opens a policy question\n${FORMAT_EVAL_CASES[3].candidate}`;
  const prepared = assembleBrief(text, source).content;
  expect(prepared.length).toBeLessThan(2000);
  expect(publicationDecision(check(prepared)).canPublish).toBe(true);
  expect(parseBrief(prepared).stories).toHaveLength(1);
});

test('optional supporting prose remains visible without rigid subheadings or action fields', () => {
  const prepared = assembleBrief(`${raw}\n\n## DEVELOPING\nThe vendor has not established customer approval. [S5.1]\n\n## WHAT COULD CHANGE THE PICTURE\nA resolution of the disputed configuration would change the fix assessment. [S3.1]`, source).content;
  const parsed = parseBrief(prepared);
  expect(parsed.developing).toHaveLength(1);
  expect(parsed.developing[0].trajectoryDetail).toContain('customer approval');
  expect(parsed.watchlistEntries).toHaveLength(1);
  expect(parsed.watchlistEntries[0].citations).toHaveLength(1);
  expect(publicationDecision(check(prepared)).canPublish).toBe(true);
});

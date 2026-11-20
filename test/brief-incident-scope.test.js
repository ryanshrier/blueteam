import { expect, test } from '@jest/globals';
import { assembleBrief } from '../lib/brief-assembly.js';
import { renderBriefCitations } from '../lib/brief-citations.js';
import { repairFirstDraftIncidentScope } from '../lib/brief-incident-scope.js';
import { BRIEF_INPUT_LIMITS } from '../lib/brief-input-limits.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { publicationDecision, validateBrief } from '../lib/validation.js';
import { authoredFormatCandidate, FORMAT_EVAL_DATE, formatEvalHeadlines } from './fixtures/brief-format-evaluation.js';

const source = { publication: true, editorialStandard: 2, briefFormatVersion: 2,
  groundingManifest: buildGroundingManifest({ headlines: formatEvalHeadlines() }) };
const clean = assembleBrief(authoredFormatCandidate(), source).content;
const validatorEvidence = validateBrief(clean, FORMAT_EVAL_DATE, source).judgmentEvidence;
const local = 'Our gateways are compromised.';
const unsupported = 'All customers confirmed compromise of their payroll systems.';
const originalLead = clean.match(/## TODAY'S PICTURE\n\n([^\n]+)/)[1];
const localDraft = clean.replace('Local exposure is unconfirmed.', local);
const leadDraft = clean.replace(originalLead, unsupported);
const firstSource = source.groundingManifest.members[0];
const withEvidence = descriptions => ({ members: [{ ...firstSource,
  sourceParts: descriptions.map(passage => ({ passage, quality: { substantive: true } })) }] });
const repair = (text, grounding = source.groundingManifest) => repairFirstDraftIncidentScope(text, grounding, validatorEvidence);

test('a scoped correction needs an explicit local unknown in the cited report; an absence of data has no authority', () => {
  const corrected = repair(localDraft);
  expect(corrected.content).toBe(clean.replace('Local exposure is unconfirmed.', 'Local compromise remains unconfirmed.'));
  expect(corrected.repairs).toEqual([{ kind: 'restore-local-uncertainty', story: 1, sourceIds: ['S1.1'] }]);
  for (const passages of [
    ['One customer confirmed compromise in its own environment.'],
    ['Local compromise is confirmed.'],
    ['Local compromise is unknown.', 'The operator subsequently confirmed local compromise.'],
    ['The vendor cannot confirm local deployment.'],
  ]) expect(repair(localDraft, withEvidence(passages)).content).toBe(localDraft);
  const conflict = withEvidence(['Local compromise is unknown.']);
  conflict.members.push({ id: 'S2.1', passage: 'A local incident report says local compromise is confirmed.', quality: { substantive: true } });
  expect(repair(localDraft, conflict).content).toBe(localDraft);
});

test.each([
  'If our gateways are compromised, evidence retention matters.',
  'The researchers say their gateways are compromised.',
  'The responders wrote, “They were right. Our gateways are compromised.”',
  "The responders wrote, 'They were right. Our gateways are compromised.'",
  'Their example reads `Our gateways are compromised.`',
  'Our gateways are compromised only in the exercise scenario.',
])('preserves conditional, attributed and illustrative prose (%s)', sentence => {
  const content = clean.replace('Local exposure is unconfirmed.', sentence);
  expect(repair(content)).toEqual({ content, repairs: [] });
});

test('an unrelated blanket incident lead can borrow only a complete, directly cited story opening', () => {
  const corrected = repair(leadDraft);
  expect(corrected.repairs).toMatchObject([{ kind: 'use-cited-story-opening', story: 1 }]);
  const expected = 'Vendor responders report exploitation of CVE-2026-12345 in exposed Gateway versions 1.0 through 1.2; version 1.3 fixes the bypass. One investigated intrusion reached virtualization management.';
  expect(corrected.content).toBe(clean.replace(originalLead, expected));
  const terminal = clean.match(/One investigated intrusion reached virtualization management\. ([^\n]+)/)[1];
  const indirectlyCited = leadDraft.replace('management. ' + terminal, 'management.').replace('Local exposure is unconfirmed.', 'Local exposure is unconfirmed. ' + terminal);
  expect(repair(indirectlyCited).content).toBe(indirectlyCited);
  expect(repair(leadDraft, withEvidence([unsupported])).content).toBe(leadDraft);
  expect(repair(leadDraft, withEvidence(['Each customer reported exposure at the affected site.'])).content).toBe(leadDraft);
  const otherCapture = { id: 'S9.1', quality: { substantive: true }, passage: 'Each client notified investigators of unauthorized access at its main office.' };
  expect(repair(leadDraft, { members: [firstSource, otherCapture] }).content).toBe(leadDraft);
  expect(repair(leadDraft, { members: [{ ...firstSource, sourceParts: [], passage: firstSource.title, quality: { substantive: false } }] }).content).toBe(leadDraft);
  const unclassified = { members: [{ ...firstSource, quality: undefined }] };
  expect(repair(leadDraft, unclassified).content).toBe(leadDraft);
  expect(repair(localDraft, unclassified).content).toBe(localDraft);
  expect(repair(clean)).toEqual({ content: clean, repairs: [] });
});

test('a repaired lead records only the sources cited by its opening', () => {
  const laterCitation = renderBriefCitations('[S2.1]', source.groundingManifest).content;
  const draft = leadDraft.replace('Local exposure is unconfirmed.', 'Local exposure is unconfirmed. ' + laterCitation);
  const evidence = validateBrief(draft, FORMAT_EVAL_DATE, source).judgmentEvidence;
  expect(evidence[0].sourceIds).toEqual(expect.arrayContaining(['S1.1', 'S2.1']));
  expect(repairFirstDraftIncidentScope(draft, source.groundingManifest, evidence).repairs)
    .toEqual([{ kind: 'use-cited-story-opening', story: 1, sourceIds: ['S1.1'] }]);
});

test('a worker revalidates the complete first draft; retained, partial and ambiguous-source paths preserve their input', async () => {
  const validator = createBriefValidator();
  try {
    const first = await validator.prepare(localDraft, FORMAT_EVAL_DATE, source, { firstDraft: true });
    expect(first.content).toBe(repair(localDraft).content);
    expect(publicationDecision(first.validation).canPublish).toBe(true);
    expect(first.validation.judgmentEvidence).toEqual(validatorEvidence);
    for (const options of [{}, { firstDraft: true, partial: true }]) {
      expect((await validator.prepare(localDraft, FORMAT_EVAL_DATE, source, options)).content).toBe(localDraft);
    }
    const unsafe = leadDraft.replace('Local exposure is unconfirmed.', 'Local exposure is unconfirmed. [S999.1]');
    const blocked = await validator.prepare(unsafe, FORMAT_EVAL_DATE, source, { firstDraft: true });
    expect(publicationDecision(blocked.validation).canPublish).toBe(false);
    expect(blocked.content).toContain(unsupported);
  } finally { await validator.close(); }
});

test('an optional longer lead cannot push an otherwise publishable edition past the input limit', async () => {
  const head = leadDraft + '\n\n<!--', tail = '-->';
  const bytes = BRIEF_INPUT_LIMITS.maxBytes - 16 - Buffer.byteLength(head + tail);
  const nearLimit = head + 'a'.repeat(bytes) + tail;
  const validator = createBriefValidator();
  try {
    const result = await validator.prepare(nearLimit, FORMAT_EVAL_DATE, source, { firstDraft: true, assemble: false });
    expect(result.content).toBe(nearLimit);
    expect(result.automaticRepairs).toEqual([]);
    expect(publicationDecision(result.validation).canPublish).toBe(true);
  } finally { await validator.close(); }
});

import { expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildPriorityCoverage } from '../lib/brief-coverage.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { publishDraftEdition } from '../lib/brief-publication.js';
import { sha256 } from '../lib/generation-manifest.js';
import { BRIEF_EVALUATION_CASES, referenceBrief, EVAL_DATE } from './fixtures/brief-evaluation.js';

const scenario = BRIEF_EVALUATION_CASES[0];
const baseline = referenceBrief(scenario);
const headlines = scenario.headlines.map(headline => ({ ...headline, score: 95, urgency: 'critical' }));
const groundingManifest = buildGroundingManifest({ headlines });
const priorityCoverage = buildPriorityCoverage({ headlines, groundingManifest, editionDate: EVAL_DATE, maxItems: 1 });
const source = {
  publication: true, editorialStandard: 2, groundingManifest, priorityCoverage,
  kevSet: new Set(['CVE-2026-12345']), kevCatalogLoaded: true,
  kevTiming: { 'CVE-2026-12345': { dateAdded: '2026-09-04', dueDate: '2026-09-08' } },
  briefingMetadata: {
    schemaVersion: 1,
    executiveActions: [{ decision: 1, actionIds: ['S1.A1', 'S2.A1', 'S3.A1'] }],
    coverage: priorityCoverage.items.map(item => ({ priorityId: item.id, status: 'deferred',
      reason: 'Retain this event as a source lead for a later focused edition.' })),
  },
};

test('capacity limits and reasoned deferrals alone leave a sourced briefing publishable', () => {
  expect(priorityCoverage.materialOverflowCount).toBeGreaterThan(0);
  const decision = publicationDecision(validateBrief(baseline, EVAL_DATE, source));
  expect(decision).toMatchObject({ canPublish: true, blockers: [], reviewIssues: [] });
  expect(decision.notes.map(issue => issue.code)).toEqual(expect.arrayContaining([
    'PRIORITY_COVERAGE_OVERFLOW', 'PRIORITY_COVERAGE_DEFERRED',
  ]));
});

test.each([
  ['a fabricated CVE', text => text.replace('CVE-2026-12345 affects Gateway', 'CVE-2026-54321 affects Gateway'), 'CVE_CITATION_MISMATCH'],
  ['a contradictory federal deadline', text => text.replace('**What happened:**',
    '**What happened:** CVE-2026-12345 FCEB remediation due September 9, 2026. '), 'KEV_DEADLINE_MISMATCH'],
  ['an invented citation destination', text => text.replace('https://example.test/evaluation/vendor',
    'https://uncaptured.example/advisory'), 'CITATION_IDENTITY_INVALID'],
])('coverage notes and exact-copy review cannot waive %s', (_label, change, code) => {
  const content = change(baseline).replace('document applicability and identify the owner of the follow-up',
    'temporarily disable endpoint protection and audit logging across the fleet');
  const validation = validateBrief(content, EVAL_DATE, source);
  const decision = publicationDecision(validation);
  expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  expect(decision.reviewIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'SECURITY_CONTROL_CHANGE' }),
  ]));
  expect(decision.notes.map(issue => issue.code)).toEqual(expect.arrayContaining([
    'PRIORITY_COVERAGE_OVERFLOW', 'PRIORITY_COVERAGE_DEFERRED',
  ]));
  const artifact = { manifest: { edition: { date: EVAL_DATE } }, manifestSha256: sha256('captured fixture inputs'),
    revisions: [{ number: 1, content, sha256: sha256(content) }] };
  const request = { baseRevision: 1, inputSha256: artifact.manifestSha256,
    editorialReview: { reviewer: 'Fixture editor', reason: 'Reviewed the exact security-control exception.',
      contentSha256: sha256(content), issueCodes: [...new Set(decision.reviewIssues.map(issue => issue.code))] } };
  // A valid review is supplied, but the factual blocker must stop publication
  // before archive paths or any other persistence operation are needed.
  expect(() => publishDraftEdition({ artifact, validation, request })).toThrow(expect.objectContaining({
    code: 'E_DRAFT_BLOCKED', decision: expect.objectContaining({ blockers: expect.arrayContaining([
      expect.objectContaining({ code }),
    ]) }),
  }));
});

import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { briefReplayDiagnostics, compareCapturedBriefs } from '../lib/brief-replay.js';
import { buildMarketingSampleReceipt } from './visual/marketing-brief-receipt.js';
import { MARKETING_BRIEF } from './visual/marketing-brief.js';
import { sha256 } from '../lib/generation-manifest.js';

// This authored exercise intentionally keeps its complete conditional action
// unchanged. It is not a captured model response or a semantic-equivalence test.
function example() {
  const original = MARKETING_BRIEF.replace('verify or isolate every example gateway',
    'verify every example gateway; isolate only if its management interface is exposed; preserve logs before recovery');
  const candidate = original.replace(/\*\*Relevance:\*\*[^\n]+\n\n/g, '');
  const manifest = { ...buildMarketingSampleReceipt(), outputSha256: sha256(original) };
  const expectations = {
    originalSha256: sha256(original),
    assertions: [
      { id: 'unknown-local-build-and-exposure', judgment: 1, field: 'Confidence',
        contains: ['installed builds and public reachability still require verification'],
        excludes: ['the gateways are confirmed compromised'] },
      { id: 'conditional-containment-and-preservation', judgment: 1, field: 'Recommended actions',
        contains: ['isolate only if its management interface is exposed', 'preserve logs before recovery'] },
      { id: 'planning-is-not-an-approved-program', judgment: 3, field: 'What happened',
        contains: ['neither is approved'], excludes: ['the owner and retention period are approved'] },
    ],
  };
  return { original, candidate, manifest, expectations };
}

test('word diagnostics separate repeated executive decisions and include authored priority rationale', () => {
  const result = briefReplayDiagnostics(MARKETING_BRIEF);
  expect(result.wordCounts.executiveDecisionWords).toBeGreaterThan(0);
  expect(result.wordCounts.bodyWithoutExecutiveDecisions + result.wordCounts.executiveDecisionWords).toBe(result.wordCounts.totalVisibleWords);
  expect(result.confidenceDistribution).toEqual({ High: 1, Moderate: 1, Low: 1 });
  expect(result.prioritization[0]).toMatchObject({ decisionWindow: 'Current shift.', confidence: { value: 'High' } });
  expect(result.prioritization[0].initialAction).toContain('verify or isolate');
  expect(result.appActionRecordCount).toBe(5);
  expect(result).not.toHaveProperty('qualityScore');
  expect(briefReplayDiagnostics(MARKETING_BRIEF + '\n<!-- hidden extra words -->\n```\nexample words\n```').wordCounts.totalVisibleWords)
    .toBe(result.wordCounts.totalVisibleWords);
});

test('shortening can pass explicit comparisons without changing complete actions or editorial policy', () => {
  const { original, candidate, manifest, expectations } = example();
  const result = compareCapturedBriefs(original, candidate, manifest, { expectations });
  expect(result.comparison).toMatchObject({ actionsUnchanged: true, expectationsBound: true, factualChecksPass: true, comparisonChecksPassed: true });
  expect(result.comparison.bodyWordsRemoved).toBeGreaterThan(0);
  expect(result.baseline.currentChecks.canPublish).toBe(true);
  expect(result.candidate.currentChecks.canPublish).toBe(true);
  expect(result.limits.join(' ')).toContain('do not replace');
});

test.each([
  ['containment condition', 'isolate only if its management interface is exposed', 'isolate it'],
  ['preservation before recovery', '; preserve logs before recovery', ''],
])('a shorter draft that drops %s cannot pass the comparison', (_label, before, after) => {
  const { original, candidate, manifest, expectations } = example();
  const result = compareCapturedBriefs(original, candidate.replace(before, after), manifest, { expectations });
  expect(result.comparison.bodyWordsRemoved).toBeGreaterThan(0);
  expect(result.comparison).toMatchObject({ actionsUnchanged: false, comparisonChecksPassed: false });
  expect(result.comparison.changedOrMissingActionIds).toEqual(['S1.A1']);
});

test('high source confidence cannot silently turn unknown local exposure into confirmed compromise', () => {
  const { original, candidate, manifest, expectations } = example();
  const wrongScope = candidate.replace('Their installed builds and public reachability still require verification within the exercise.', 'The gateways are confirmed compromised.');
  const result = compareCapturedBriefs(original, wrongScope, manifest, { expectations });
  expect(result.comparison.actionsUnchanged).toBe(true);
  expect(result.comparison.bodyWordsRemoved).toBeGreaterThan(0);
  expect(result.comparison.candidateAssertions[0]).toMatchObject({ passed: false, forbidden: ['the gateways are confirmed compromised'] });
  expect(result.comparison.comparisonChecksPassed).toBe(false);
});

test('a plan cannot become an approved program merely because the shorter wording still parses', () => {
  const { original, candidate, manifest, expectations } = example();
  const wrongScope = candidate.replace('neither is approved.', 'the owner and retention period are approved.');
  expect(compareCapturedBriefs(original, wrongScope, manifest, { expectations }).comparison.comparisonChecksPassed).toBe(false);
});

test('moving a scope caveat into a hidden comment does not satisfy the authored assertion', () => {
  const { original, candidate, manifest, expectations } = example();
  const hidden = candidate.replace('neither is approved.', '<!-- neither is approved. --> The owner and retention period are approved.');
  const result = compareCapturedBriefs(original, hidden, manifest, { expectations });
  expect(result.comparison.candidateAssertions[2]).toMatchObject({ passed: false, missing: ['neither is approved'] });
  expect(result.comparison.comparisonChecksPassed).toBe(false);
});

test('missing, stale or already-failing authored assertions cannot certify a comparison', () => {
  const { original, candidate, manifest, expectations } = example();
  expect(compareCapturedBriefs(original, candidate, manifest).comparison.comparisonChecksPassed).toBe(false);
  expect(compareCapturedBriefs(original, candidate, manifest, { expectations: { ...expectations, originalSha256: '0'.repeat(64) } }).comparison.expectationsBound).toBe(false);
  const failed = { ...expectations, assertions: [{ id: 'untrue-baseline', contains: ['There are no unresolved findings anywhere'] }] };
  const result = compareCapturedBriefs(original, candidate, manifest, { expectations: failed });
  expect(result.comparison.baselineAssertions[0].passed).toBe(false);
  expect(result.comparison.comparisonChecksPassed).toBe(false);
  expect(() => compareCapturedBriefs(original + '\n', candidate, manifest, { expectations })).toThrow(/does not match/);
});

test('the actual retained September edition still fails factual checks despite unchanged actions and matching assertions', () => {
  const retained = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-05.json', import.meta.url), 'utf8'));
  const { original } = retained;
  const manifest = { ...retained.manifest, outputSha256: sha256(original) };
  const expectations = { originalSha256: sha256(original), assertions: [{ id: 'retained-identity', contains: ['SonicWall'] }] };
  const result = compareCapturedBriefs(original, original, manifest, { expectations });
  expect(result.comparison.candidateAssertions[0].passed).toBe(true);
  expect(result.comparison.factualChecksPass).toBe(false);
  expect(result.comparison.comparisonChecksPassed).toBe(false);
  expect(result.candidate.currentChecks.blockerCount).toBeGreaterThan(0);
});

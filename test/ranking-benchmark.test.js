import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { configureRankingBenchmark, beginRankingBenchmark, getRankingBenchmarkStatus, readRankingCaptures, writePrivateJson } from '../lib/ranking-benchmark.js';
import { buildRankingReviewExport, importRankingReview, buildRankingAdjudication, buildRankingSplitTemplate, evaluateRankingBenchmark } from '../lib/ranking-review.js';
import { runRankingBenchmarkCli } from '../scripts/ranking-benchmark.mjs';

let directory, clock;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bt-ranking-test-'));
  clock = Date.now();
  configureRankingBenchmark({ directory, minIntervalMs: 0 });
});
afterEach(() => {
  configureRankingBenchmark();
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('bt-ranking-test-')) throw new Error('Unsafe fixture cleanup');
  rmSync(target, { recursive: true, force: true });
});
const headline = (title, index) => ({ title, source: 'Synthetic retained fixture', link: `https://fixture.invalid/article/${index}`,
  description: `Retained evidence for ${title}. This is synthetic test data.`, date: new Date().toISOString(), retrievedAt: new Date().toISOString(),
  horizon: 1, weight: 1, score: 50, urgency: 'routine' });
function captureRun({ count = 4, selectedIndices = [0, 1, 2], editorial = false, idOffset = 0, observedAt = clock } = {}) {
  const candidates = Array.from({ length: count }, (_, index) => headline(`Signal ${index + idOffset}`, index + idOffset));
  const omitted = headline('Excluded recurring item', `excluded-${idOffset}`);
  const collected = editorial ? [...candidates, omitted] : candidates;
  const recorder = beginRankingBenchmark({ observedAt, config: { analysisSettings: { webhook: { url: 'https://secret.invalid/token' }, providerKey: 'secret-value' } },
    watchProfile: { technologies: ['Example Gateway'], providerKey: 'secret-profile-key' },
    scoringConfiguration: { secret: 'secret-scoring-value', axisWeights: { recency: 0.22 } } });
  recorder.collection({ collected, admitted: candidates, candidates });
  recorder.beforeEnrichment({ candidates, selected: selectedIndices.map(index => candidates[index]), scoringClock: observedAt + 10 });
  candidates[0].articleBody = 'An article retrieved after the initial selection.';
  candidates[0].score = 99;
  const result = recorder.complete({ candidates, selected: selectedIndices.map(index => candidates[index]), enrichmentPool: [candidates[0]], scoringClock: observedAt + 20 });
  return { recorder, result, candidates };
}
function review(captures, reviewerId, priorities = ['critical', 'relevant', 'unknown', null], incidentOverride = {}) {
  const document = buildRankingReviewExport(captures, { seed: reviewerId });
  document.reviewer = { id: reviewerId, name: `Synthetic reviewer ${reviewerId}`, independent: true, reviewedAt: new Date(clock).toISOString() };
  for (const item of document.items) {
    const index = Number(item.evidence.title.match(/\d+$/)?.[0] || 0);
    const priority = priorities[index % priorities.length];
    if (priority === null) continue;
    item.label = { priority, incidentId: incidentOverride[index] || (priority === 'unknown' ? '' : `incident-${index}`),
      rationale: 'Synthetic test judgment based only on this fixture.', evidenceRefs: [item.evidenceRef] };
  }
  return importRankingReview(document, captures);
}
function allTest(captures) {
  const split = buildRankingSplitTemplate(captures);
  split.assignments.forEach(row => { row.split = 'test'; });
  return split;
}

test('captures all stages and excluded observations without copying provider or webhook secrets', () => {
  const { result, candidates } = captureRun({ editorial: true });
  expect(result).toMatchObject({ status: 'captured', candidateCount: 5 });
  candidates[0].title = 'Changed after capture';
  const [capture] = readRankingCaptures(directory);
  expect(capture.observations).toHaveLength(5);
  expect(capture.candidates).toHaveLength(5);
  const first = capture.candidates[0];
  expect(first.baseline.articleBody).toBe('');
  expect(first.beforeEnrichment.score).toBe(50);
  expect(first.final.score).toBe(99);
  expect(first.final.title).toBe('Signal 0');
  expect(capture.candidates[4]).toMatchObject({ editoriallyExcluded: true, finalSelected: false, stageReasons: ['editorial-recurring-feature'] });
  expect(capture.initialScoringClock).toBe(new Date(clock + 10).toISOString());
  expect(capture.finalScoringClock).toBe(new Date(clock + 20).toISOString());
  expect(capture.implementationSha256['lib/scoring.js']).toMatch(/^[a-f0-9]{64}$/);
  expect(capture.implementationSha256['lib/claims.js']).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(capture)).not.toMatch(/secret-value|secret\.invalid|secret-profile|secret-scoring|webhook|providerKey/);
  expect(getRankingBenchmarkStatus()).toMatchObject({ state: 'captured', candidateCount: 5 });
  if (process.platform !== 'win32') expect(statSync(join(directory, readdirSync(directory)[0])).mode & 0o777).toBe(0o600);
});

test('preserves source publication/revision and captured positive KEV facts for review', () => {
  const item = headline('Revision', 1);
  item.date = ''; item.publishedAt = '2026-10-01T12:00:00Z';
  item.revisionAdmission = { basis: 'changed-operational-text', materiality: 'candidate-not-verified', updatedAt: new Date(clock).toISOString(), previousRevisionId: 'rev_123' };
  item.sourceMembers = [{ ...item }];
  item.kevRecords = [{ cve: 'CVE-2026-1234', dateAdded: '2026-10-01', dueDate: '2026-10-22' }];
  const recorder = beginRankingBenchmark({ observedAt: clock });
  recorder.collection({ collected: [item], admitted: [item], candidates: [item] });
  recorder.beforeEnrichment({ candidates: [item], selected: [item], scoringClock: clock });
  recorder.complete({ candidates: [item], selected: [item], enrichmentPool: [item], scoringClock: clock });
  const [capture] = readRankingCaptures(directory);
  expect(capture.candidates[0].final.sourceMembers[0]).toMatchObject({ publishedAt: item.publishedAt, revisionAdmission: item.revisionAdmission });
  const exported = buildRankingReviewExport([capture]);
  expect(exported.items[0].evidence.kevRecords[0]).toMatchObject({ cve: 'CVE-2026-1234', dueDate: '2026-10-22' });
});

test('bounds retention and sampling and rejects an oversized pool instead of truncating it', () => {
  configureRankingBenchmark({ directory, maxRuns: 2, minIntervalMs: 0 });
  captureRun({ observedAt: clock }); captureRun({ observedAt: clock + 1 }); captureRun({ observedAt: clock + 2 });
  expect(readRankingCaptures(directory)).toHaveLength(2);
  configureRankingBenchmark({ directory });
  expect(beginRankingBenchmark({ observedAt: clock + 3 }).complete()).toEqual({ status: 'skipped', reason: 'capture-interval' });
  configureRankingBenchmark({ directory, maxCandidates: 2, minIntervalMs: 0 });
  expect(captureRun({ observedAt: clock + 4 }).result.status).toBe('unavailable');
  expect(readRankingCaptures(directory)).toHaveLength(2);
  expect(getRankingBenchmarkStatus().reason).toBe('capture-incomplete-or-over-limit');
});

test('incomplete phases and changed candidate pool never save a complete capture', () => {
  const recorder = beginRankingBenchmark({ observedAt: clock });
  const item = headline('A', 1);
  recorder.collection({ collected: [item], admitted: [item], candidates: [item] });
  expect(recorder.complete({ candidates: [item], selected: [item], enrichmentPool: [item] }).status).toBe('unavailable');
  expect(readRankingCaptures(directory)).toEqual([]);
  expect(beginRankingBenchmark({ observedAt: 1e99 })).toBeNull();
});

test('byte bounds stop materializing large member lists and capture failures survive interval skips', () => {
  configureRankingBenchmark({ directory, maxCaptureBytes: 32000 });
  const item = headline('Huge group', 1);
  let inspected = 0;
  item.sourceMembers = Array.from({ length: 500 }, () => ({ get title() { inspected++; return 'Member'; }, passage: 'x'.repeat(20000) }));
  const recorder = beginRankingBenchmark({ observedAt: clock });
  recorder.collection({ collected: [item], admitted: [item], candidates: [item] });
  expect(inspected).toBeLessThan(5);
  expect(recorder.complete({ candidates: [item], selected: [item], enrichmentPool: [item] }).status).toBe('unavailable');
  expect(beginRankingBenchmark({ observedAt: clock + 1000 }).complete()).toMatchObject({ status: 'skipped' });
  expect(getRankingBenchmarkStatus()).toMatchObject({ state: 'unavailable', reason: 'capture-incomplete-or-over-limit' });
  expect(readRankingCaptures(directory)).toEqual([]);
});

test('capture checksum changes are detected before exports', () => {
  captureRun();
  const path = join(directory, readdirSync(directory)[0]);
  const document = JSON.parse(readFileSync(path, 'utf8'));
  document.capture.candidates[0].final.score = 10;
  writeFileSync(path, JSON.stringify(document));
  expect(() => readRankingCaptures(directory)).toThrow('Invalid or incomplete');
});

test('blinded exports omit ranking and stage decisions; reviewers cannot modify frozen evidence', () => {
  captureRun();
  const captures = readRankingCaptures(directory);
  const exported = buildRankingReviewExport(captures);
  expect(JSON.stringify(exported.items)).not.toMatch(/"(?:score|scoreComponents|finalRank|finalSelected|stageReasons|urgency|regexAssessment|enrichmentEligible|initialSelected)":/);
  expect(exported.items.every(item => item.label.priority === null)).toBe(true);
  expect(exported.reviewer.independent).toBe(false);
  exported.reviewer = { id: 'a', name: 'Synthetic A', independent: true, reviewedAt: new Date(clock).toISOString() };
  exported.items[0].evidence.title = 'Changed evidence';
  expect(() => importRankingReview(exported, captures)).toThrow('Review evidence was changed');
});

test('offline metrics report judged denominators, unknown and unjudged coverage without inventing negatives', () => {
  captureRun();
  const captures = readRankingCaptures(directory);
  const report = evaluateRankingBenchmark(captures, [review(captures, 'a'), review(captures, 'b')], { split: allTest(captures) });
  expect(report.groups.test).toMatchObject({ candidates: 4, judged: 2, unknown: 1, unjudged: 1,
    annotationCoverage: { numerator: 2, denominator: 4, value: 0.5 },
    top10: { slots: 3, judgedSlots: 2, unjudgedOrUnknownSlots: 1, precisionAmongJudged: { numerator: 2, denominator: 2, value: 1 } },
    criticalRecallAmongJudged: { numerator: 1, denominator: 1, value: 1 } });
  expect(Object.keys(report.groups.test.profiles)).toHaveLength(1);
  expect(report.caveats.join(' ')).toContain('No train/test separation');
});

test('same reviewer twice is rejected and conflicting labels need a third independent adjudicator', () => {
  captureRun({ count: 1, selectedIndices: [0] });
  const captures = readRankingCaptures(directory);
  const a = review(captures, 'a', ['critical']), b = review(captures, 'b', ['not-relevant']);
  expect(() => evaluateRankingBenchmark(captures, [a, a], { split: allTest(captures) })).toThrow('two distinct');
  const held = evaluateRankingBenchmark(captures, [a, b], { split: allTest(captures) });
  expect(held.groups.test).toMatchObject({ judged: 0, unresolvedDisagreements: 1, top10: { precisionAmongJudged: { denominator: 0, value: null } } });
  const adjudication = buildRankingAdjudication(captures, [a, b]);
  const row = adjudication.decisions[0];
  adjudication.adjudicator = { ...a.reviewer };
  row.label = { priority: 'relevant', incidentId: 'incident-0', rationale: 'Synthetic adjudicated test case.', evidenceRefs: [row.evidenceRef] };
  expect(() => evaluateRankingBenchmark(captures, [a, b], { split: allTest(captures), adjudication })).toThrow('Adjudicator must be distinct');
  adjudication.adjudicator = { ...a.reviewer, id: 'c', name: 'Synthetic reviewer c' };
  expect(evaluateRankingBenchmark(captures, [a, b], { split: allTest(captures), adjudication }).groups.test.judged).toBe(1);
  const originalTitle = row.evidence.title;
  row.evidence.title = 'Edited adjudication evidence';
  expect(() => evaluateRankingBenchmark(captures, [a, b], { split: allTest(captures), adjudication })).toThrow('Adjudication references changed evidence');
  row.evidence.title = originalTitle;
  adjudication.reviewSha256[0] = 'changed';
  expect(() => evaluateRankingBenchmark(captures, [a, b], { split: allTest(captures), adjudication })).toThrow('Adjudication is stale');
});

test('incident and source leakage plus reversed temporal splits are rejected', () => {
  captureRun({ count: 1, selectedIndices: [0], observedAt: clock });
  captureRun({ count: 1, selectedIndices: [0], observedAt: clock + 1 });
  let captures = readRankingCaptures(directory);
  let split = allTest(captures); split.assignments[0].split = 'train';
  expect(() => evaluateRankingBenchmark(captures, [review(captures, 'a', ['critical']), review(captures, 'b', ['critical'])], { split })).toThrow('Incident/source leakage');
  split.assignments[0].split = 'test'; split.assignments[1].split = 'train';
  expect(() => evaluateRankingBenchmark(captures, [review(captures, 'a', ['critical']), review(captures, 'b', ['critical'])], { split })).toThrow('Temporal leakage');
});

test('reports incident recall once per run and duplicate top slots separately', () => {
  captureRun({ count: 4, selectedIndices: [0, 1, 2] });
  const captures = readRankingCaptures(directory);
  const labels = ['critical', 'critical', 'not-relevant', 'critical'];
  const report = evaluateRankingBenchmark(captures, [review(captures, 'a', labels, { 1: 'incident-0' }), review(captures, 'b', labels, { 1: 'incident-0' })], { split: allTest(captures) });
  expect(report.groups.test).toMatchObject({ criticalRecallAmongJudged: { numerator: 1, denominator: 2, value: 0.5 },
    top10: { duplicateSlotsAmongJudged: { numerator: 1, denominator: 3 }, precisionAmongJudged: { numerator: 2, denominator: 3 } } });
});

test('CLI is offline and refuses overwriting existing review output', () => {
  captureRun();
  const out = join(directory, 'review.json');
  runRankingBenchmarkCli(['export', '--captures', directory, '--out', out], { log: () => {} });
  expect(JSON.parse(readFileSync(out, 'utf8')).kind).toBe('ranking-review-template');
  expect(() => runRankingBenchmarkCli(['export', '--captures', directory, '--out', out], { log: () => {} })).toThrow();
  expect(() => writePrivateJson(out, {})).toThrow();
});

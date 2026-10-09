import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveBrief, listBriefEditions, loadRecentBriefs } from '../lib/history.js';
import { buildGenerationManifest, generationManifestFilename, sha256 } from '../lib/generation-manifest.js';
import { loadBriefReadingState, readingDisposition } from '../lib/brief-reading-checks.js';
import { saveBriefDisposition } from '../lib/brief-review.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief } from '../lib/validation.js';
import { BRIEF_EVALUATION_CASES, referenceBrief } from './fixtures/brief-evaluation.js';

const getClient = jest.fn(() => null);
const getFreshRun = jest.fn();
const webhook = jest.fn(async () => {});
const metadata = new Map();
const completeScheduled = jest.fn();
const getBriefMetadata = jest.fn(() => null);
jest.unstable_mockModule('../lib/config.js', () => ({ getConfig: () => ({}), getConfigVersion: () => 1, getHorizonName: (_c, h) => `Tier ${h}` }));
jest.unstable_mockModule('../lib/refresher.js', () => ({ getFreshRun, getLatestRun: () => null, getRunAgeMs: () => Infinity, refreshNow: jest.fn() }));
jest.unstable_mockModule('../lib/db.js', () => ({
  getMeta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value),
  getBriefMeta: getBriefMetadata, saveBriefMeta: jest.fn(), indexBrief: jest.fn(), searchBriefs: () => [],
  countKEVAddedToday: () => 0, getRecentKEV: () => [], getKEVSet: () => new Set(), getKEVDueDates: () => ({}), getKEVRecords: () => ({}),
  getScheduledBriefJob: () => null, completeScheduledBriefJob: completeScheduled,
}));
jest.unstable_mockModule('../lib/alerts.js', () => ({ dispatchBriefWebhook: webhook }));
jest.unstable_mockModule('../lib/logger.js', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../lib/landscape.js', () => ({ buildLandscape: (_run, brief) => ({ brief }), pipelineStaleAfterMs: () => 1200000 }));
const { createBriefRouter, streamWithRecovery } = await import('../routes/brief.js');
const { createLandscapeRouter, _resetLandscapeMemoForTests } = await import('../routes/landscape.js');

let dir, reviews, server;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brief-publication-state-'));
  reviews = join(dir, 'reviews'); mkdirSync(reviews);
  metadata.clear(); getClient.mockReset().mockReturnValue(null); getFreshRun.mockReset(); webhook.mockClear(); completeScheduled.mockClear(); _resetLandscapeMemoForTests();
  getBriefMetadata.mockReset().mockReturnValue(null);
});
afterEach(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
  rmSync(dir, { recursive: true, force: true });
});
async function serve() {
  const app = express(); app.use(express.json());
  app.use('/api', createBriefRouter({ historyDir: dir, reviewDir: reviews, getAiClient: getClient, cooldown: { check: () => true }, scheduledJobToken: 'test-schedule' }));
  app.use('/api', createLandscapeRouter({ historyDir: dir, reviewDir: reviews, cooldown: { check: () => true } }));
  server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  return `http://127.0.0.1:${server.address().port}/api`;
}
const item = BRIEF_EVALUATION_CASES[0];
const original = referenceBrief(item).replace('The vendor confirms exploitation in original reporting.', 'The vendor confirms exploitation in original reporting. [Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor)');
const oldBluf = 'Use the sourced gateway update, remote-support workflow, and disclosure consultation to prioritize applicability checks; none of the supplied reports establishes that this organization was compromised.';
function archive({ scheduled = false, material = false } = {}) {
  const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
  const checks = validateBrief(original, '2026-09-05', { publication: true, editorialStandard: 2, groundingManifest, kevSet: new Set(), kevCatalogLoaded: true });
  expect(checks.issues.filter(issue => ['trust', 'structure'].includes(issue.severity))).toEqual([]);
  const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, config: {}, editionContext: { date: '2026-09-05', timezone: 'UTC', scheduled }, groundingManifest });
  Object.assign(manifest, { editorialStandard: 2, generatedAt: '2026-09-05T12:00:00Z', verification: { kevCatalogLoaded: true, selectedKevCves: [] },
    publicationValidation: { ...checks, partial: false, hardFail: false, trustFail: false, coverage: { ...checks.coverage, materialReviewRequired: material || checks.coverage.materialReviewRequired } } });
  return saveBrief(dir, original, { date: '2026-09-05', scheduled, manifest });
}
function correct(filename, replacement) {
  writeFileSync(join(reviews, filename.replace('.md', '.review.json')), JSON.stringify({ schemaVersion: 1, originalSha256: sha256(original), reviewer: 'Synthetic reviewer', reviewedAt: '2026-09-06T12:00:00Z',
    corrections: [{ id: 'bluf', original: oldBluf, replacement, reason: 'Correct the topic summary.' }] }));
}

describe('one verified saved reading state', () => {
  test.each(['invalid JSON', 'mismatched output'])('a %s receipt cannot restore automatic eligibility or be overridden by human eligibility', kind => {
    const filename = archive({ material: true });
    const path = join(dir, generationManifestFilename(filename));
    if (kind === 'invalid JSON') writeFileSync(path, '{');
    else writeFileSync(join(dir, filename), `${original}\nChanged after publication.`);
    saveBriefDisposition(filename, readFileSync(join(dir, filename), 'utf8'), { status: 'eligible', reviewer: 'Synthetic reviewer', reason: 'Manual approval' }, reviews);
    const reading = loadBriefReadingState(dir, filename, { reviewDirectory: reviews });
    expect(reading.receipt.integrity).toBe('invalid');
    expect(reading.disposition).toMatchObject({ status: 'review-required', eligibleForLatest: false });
    const legacy = saveBrief(dir, '## BLUF\nLegacy topic.', { date: '2026-09-04' });
    expect(listBriefEditions(dir, { eligibleOnly: true, reviewDirectory: reviews }).map(row => row.filename)).toEqual([legacy]);
  });

  test('unsafe corrections are excluded consistently from list, reader, Wall, RSS, and continuity', async () => {
    const filename = archive();
    correct(filename, 'CVE-2026-99999 is actively exploited.');
    const legacy = saveBrief(dir, '## BLUF\nEarlier eligible topic.', { date: '2026-09-04' });
    const base = await serve();
    const list = await (await fetch(`${base}/briefs`)).json();
    const reader = await (await fetch(`${base}/brief/${filename}`)).json();
    expect(list.find(row => row.filename === filename).disposition.eligibleForLatest).toBe(false);
    expect(reader.disposition.eligibleForLatest).toBe(false);
    expect(reader.readingChecks.status).toBe('checked');
    expect(reader.reviewedContent).toContain('CVE-2026-99999');
    expect((await (await fetch(`${base}/landscape`)).json()).brief.filename).toBe(legacy);
    const rss = await (await fetch(`${base}/briefs.xml`)).text();
    expect(rss).not.toContain(filename); expect(rss).toContain(legacy);
    expect(loadRecentBriefs(dir, 5, { reviewDirectory: reviews }).map(row => row.filename)).toEqual([legacy]);
  });

  test('successful corrections clear automatic findings and supply the same current text to RSS, Wall and continuity', async () => {
    const filename = archive({ material: true });
    const replacement = 'Prioritize corrected topic labels and verify local applicability before changing systems.';
    correct(filename, replacement);
    const base = await serve();
    const reader = await (await fetch(`${base}/brief/${filename}`)).json();
    expect(reader.disposition.eligibleForLatest).toBe(true);
    const list = await (await fetch(`${base}/briefs`)).json();
    expect(list[0]).toMatchObject({ disposition: { eligibleForLatest: true }, bluf: replacement });
    expect((await (await fetch(`${base}/landscape`)).json()).brief.bluf).toBe(replacement);
    const rss = await (await fetch(`${base}/briefs.xml`)).text();
    expect(rss).toContain(replacement); expect(rss).not.toContain(oldBluf);
    expect(loadRecentBriefs(dir, 5, { reviewDirectory: reviews })[0].content).toBe(reader.reviewedContent);
  });

  test('empty or unavailable SQLite metadata cannot suppress receipt findings or make unknown cost zero', async () => {
    const filename = archive();
    const path = join(dir, generationManifestFilename(filename));
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const issue = { code: 'CITED_SOURCE_LIMITED', severity: 'review', message: 'Retained scope is limited.' };
    manifest.publicationValidation.issues.push(issue); manifest.publicationValidation.warnings.push(issue.message);
    manifest.costEstimate = { usd: null, status: 'unknown-final-usage' };
    writeFileSync(path, JSON.stringify(manifest));
    getBriefMetadata.mockReturnValue({ model_used: 'claude-sonnet-5', input_tokens: null, output_tokens: null, warnings: null, bluf: 'Summary', word_count: 20 });
    const base = await serve();
    const reader = await (await fetch(`${base}/brief/${filename}`)).json();
    expect(reader.meta).toMatchObject({ estimated_cost_usd: null, warnings: expect.arrayContaining([issue.message]) });
    expect(reader.presentation.currentChecks.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: issue.code, audience: 'reader' })]));
    const list = await (await fetch(`${base}/briefs`)).json();
    expect(list[0]).toMatchObject({ costUsd: null, presentation: reader.presentation });
    getBriefMetadata.mockImplementation(() => { throw new Error('SQLite unavailable'); });
    const fallback = await fetch(`${base}/brief/${filename}`);
    expect(fallback.status).toBe(200);
    const result = await fallback.json();
    expect(result.generatedAt).toBe(manifest.generatedAt);
    expect(result.presentation.currentChecks).toEqual(reader.presentation.currentChecks);
    expect(result.presentation.operationalNotes).toEqual([expect.objectContaining({ code: 'EDITION_METADATA_UNAVAILABLE' })]);
  });

  test('verified human approval can resolve material review, but not unavailable checks or trust failures', () => {
    const human = { status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'reviewed' };
    expect(readingDisposition(human, { coverage: { materialReviewRequired: true }, issues: [{ severity: 'review', code: 'CITED_SOURCE_LIMITED' }] })).toEqual(human);
    expect(readingDisposition(human, { status: 'unavailable' }).eligibleForLatest).toBe(false);
    expect(readingDisposition(human, { issues: [{ severity: 'trust' }] }).eligibleForLatest).toBe(false);
    expect(readingDisposition({ status: 'eligible', eligibleForLatest: true }, { issues: [{ severity: 'review', code: 'REVIEW' }], coverage: { materialReviewRequired: false } }).eligibleForLatest).toBe(true);
    expect(readingDisposition({ status: 'eligible', eligibleForLatest: true }, { issues: [{ severity: 'review', code: 'CITED_SOURCE_LIMITED' }], coverage: { materialReviewRequired: true } }).eligibleForLatest).toBe(true);
    expect(readingDisposition({ status: 'eligible', eligibleForLatest: true }, { issues: [{ severity: 'review', code: 'SECURITY_CONTROL_CHANGE' }] }).eligibleForLatest).toBe(false);
    expect(readingDisposition({ ...human, originalSha256: 'original', readingSha256: 'approved' }, { contentSha256: 'later', issues: [] })).toMatchObject({ eligibleForLatest: true, editorialReviewStatus: 'not-reviewed' });
    expect(readingDisposition({ ...human, originalSha256: 'original' }, { contentSha256: 'original', issues: [] }).editorialReviewStatus).toBe('reviewed');
  });

  test('approval binds the corrected reading copy and cannot resolve findings introduced by a later correction', async () => {
    const filename = archive();
    const sourceLine = original.split('\n').find(line => line.startsWith('- **Required decisions:**'));
    const writeCorrection = replacement => writeFileSync(join(reviews, filename.replace('.md', '.review.json')), JSON.stringify({
      schemaVersion: 1, originalSha256: sha256(original), reviewer: 'Synthetic reviewer', reviewedAt: '2026-09-06T12:00:00Z',
      corrections: [{ id: 'action', original: sourceLine, replacement, reason: 'Review a proposed control exception.' }],
    }));
    writeCorrection(sourceLine.replace('identify applicable systems and review owners', 'disable MFA for affected accounts'));
    const before = loadBriefReadingState(dir, filename, { reviewDirectory: reviews });
    expect(before.readingChecks.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SECURITY_CONTROL_CHANGE' })]));
    expect(before.disposition.eligibleForLatest).toBe(false);
    const base = await serve();
    const approve = () => fetch(`${base}/brief/${filename}/disposition`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'eligible', reviewer: 'Synthetic approver', reason: 'Reviewed this reading copy.', readingSha256: 'client-supplied-value-is-ignored' }) });
    const approved = await (await approve()).json();
    expect(approved.disposition).toMatchObject({ eligibleForLatest: true, readingSha256: sha256(before.content) });
    writeCorrection(sourceLine.replace('identify applicable systems and review owners', 'disable EDR on affected endpoints'));
    const changed = loadBriefReadingState(dir, filename, { reviewDirectory: reviews });
    expect(changed.disposition).toMatchObject({ eligibleForLatest: false, editorialReviewStatus: 'review-required' });
    expect(changed.readingChecks.contentSha256).not.toBe(approved.disposition.readingSha256);
    expect((await (await approve()).json()).disposition).toMatchObject({ eligibleForLatest: true, readingSha256: sha256(changed.content) });
  });

  test('mixed substantive and title-only citations remain advisory across completion, archive and webhook delivery', async () => {
    const thin = { source: 'Thin Source', title: 'Gateway announcement', description: '', link: 'https://example.test/thin', date: '2026-09-04', horizon: 1 };
    getFreshRun.mockResolvedValue({ headlines: [...item.headlines, thin], stats: {} });
    const text = original.replace('[Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor)', '[Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor) [Thin Source, September 4, 2026](https://example.test/thin)');
    getClient.mockReturnValue({ messages: { stream: async () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } };
      yield { type: 'content_block_delta', delta: { text } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } };
      yield { type: 'message_stop' };
    } }) } });
    const base = await serve();
    const response = await (await fetch(`${base}/brief`, { method: 'POST' })).text();
    const complete = response.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).find(event => event.briefComplete);
    expect(complete).toMatchObject({ disposition: { eligibleForLatest: true } });
    expect(webhook).toHaveBeenCalledTimes(1);
    const reader = await (await fetch(`${base}/brief/${complete.filename}`)).json();
    expect(reader.disposition.eligibleForLatest).toBe(true);
    expect(reader.inputManifest.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CITED_SOURCE_LIMITED' })]));
    expect(reader.presentation).toEqual(complete.presentation);
    expect(reader.sourceCheckStatus).toBe('findings');
    expect(listBriefEditions(dir, { eligibleOnly: true, reviewDirectory: reviews })).toHaveLength(1);
  });

  test.each(['missing', 'invalid', 'mismatched'])('scheduled replay refuses a %s receipt without provider spend or changing the original', async kind => {
    const filename = kind === 'missing' ? saveBrief(dir, original, { date: '2026-09-05', scheduled: true }) : archive({ scheduled: true });
    if (kind === 'invalid') writeFileSync(join(dir, generationManifestFilename(filename)), '{');
    if (kind === 'mismatched') writeFileSync(join(dir, filename), `${original}\nUnverified edit.`);
    const before = readFileSync(join(dir, filename), 'utf8');
    const base = await serve();
    const response = await fetch(`${base}/brief`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-blueteam-scheduled-token': 'test-schedule' },
      body: JSON.stringify({ scheduledJob: { jobKey: 'daily-brief:2026-09-05', editionDate: '2026-09-05', timezone: 'UTC' } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'E_SCHEDULE_INTEGRITY' });
    expect(getClient).not.toHaveBeenCalled(); expect(completeScheduled).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, filename), 'utf8')).toBe(before);
  });
});

describe('provider completion requires the real terminal event', () => {
  test.each([false, true])('actual Anthropic SDK rejects EOF with stop reason present=%s and preserves the draft', async stopReason => {
    const events = [
      { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: original } },
      ...(stopReason ? [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } }] : []),
    ];
    const client = new Anthropic({ apiKey: 'synthetic-no-network', fetch: async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }) });
    const result = await streamWithRecovery(client, { model: 'fixture-model', max_tokens: 1000, messages: [{ role: 'user', content: 'Synthetic test.' }] });
    expect(result.text).toBe(original);
    expect(result.error.code).toBe('E_PROVIDER_INCOMPLETE');
    expect(result.terminalReceived).toBe(false);
  });

  test('a full-looking draft cut off at EOF is retained, never published or marked final usage', async () => {
    getFreshRun.mockResolvedValue({ headlines: item.headlines, stats: {} });
    getClient.mockReturnValue({ messages: { stream: async () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } };
      yield { type: 'content_block_delta', delta: { text: original } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } };
      // Transport closes without the provider's message_stop.
    } }) } });
    const base = await serve();
    const body = await (await fetch(`${base}/brief`, { method: 'POST' })).text();
    const events = body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    expect(events.some(event => event.briefComplete)).toBe(false);
    expect(events.find(event => event.error)).toMatchObject({ draft: expect.any(String), draftArtifact: { id: expect.any(String) } });
    expect(listBriefEditions(dir, { reviewDirectory: reviews })).toHaveLength(0);
    expect(webhook).not.toHaveBeenCalled();
    const status = await (await fetch(`${base}/brief/status`)).json();
    expect(status.latest.attempts).toEqual([expect.objectContaining({ status: 'failed', usageComplete: false })]);
  });
});

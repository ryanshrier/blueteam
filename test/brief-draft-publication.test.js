import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveBrief } from '../lib/history.js';
import { buildGenerationManifest, readGenerationManifest, sha256 } from '../lib/generation-manifest.js';
import { saveRejectedBrief, readBriefDraft } from '../lib/brief-drafts.js';
import { createPublicationLookup } from '../lib/brief-publication.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { repairBriefFormatting, validateBrief } from '../lib/validation.js';
import { BRIEF_EVALUATION_CASES, referenceBrief } from './fixtures/brief-evaluation.js';

const getClient = jest.fn(() => null);
const getFreshRun = jest.fn();
const webhook = jest.fn(async () => {});
const indexBrief = jest.fn();
const saveBriefMeta = jest.fn();
const metadata = new Map();
const completeScheduled = jest.fn();
const onDraftPublished = jest.fn();
jest.unstable_mockModule('../lib/config.js', () => ({ getConfig: () => ({}), getConfigVersion: () => 1, getHorizonName: (_c, h) => `Tier ${h}` }));
jest.unstable_mockModule('../lib/refresher.js', () => ({ getFreshRun, getLatestRun: () => null, getRunAgeMs: () => Infinity, refreshNow: jest.fn() }));
jest.unstable_mockModule('../lib/db.js', () => ({
  getMeta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value),
  getBriefMeta: () => null, saveBriefMeta, indexBrief, searchBriefs: () => [],
  countKEVAddedToday: () => 0, getRecentKEV: () => [], getKEVSet: () => new Set(), getKEVDueDates: () => ({}), getKEVRecords: () => ({}),
  getScheduledBriefJob: () => null, completeScheduledBriefJob: completeScheduled,
}));
jest.unstable_mockModule('../lib/alerts.js', () => ({ dispatchBriefWebhook: webhook }));
jest.unstable_mockModule('../lib/logger.js', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { createBriefRouter } = await import('../routes/brief.js');
const { createGenerationJobs } = await import('../lib/generation-jobs.js');

const item = BRIEF_EVALUATION_CASES[0];
const content = repairBriefFormatting(referenceBrief(item).replace('The vendor confirms exploitation in original reporting.', 'The vendor confirms exploitation in original reporting. [Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor)'));
let dir, reviews, server, base;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brief-draft-publication-'));
  reviews = join(dir, 'reviews'); mkdirSync(reviews);
  metadata.clear();
  for (const mock of [getClient, getFreshRun, webhook, indexBrief, saveBriefMeta, completeScheduled, onDraftPublished]) mock.mockClear();
  const app = express(); app.use(express.json());
  app.use('/api', createBriefRouter({ historyDir: dir, reviewDir: reviews, getAiClient: getClient,
    cooldown: { check: () => true }, scheduledJobToken: 'test-schedule', onDraftPublished }));
  server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});
function draft({ text = content, scheduled = false, generatedAt = '2026-09-05T12:00:00Z' } = {}) {
  const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
  const validation = validateBrief(text, '2026-09-05', { publication: true, editorialStandard: 2, groundingManifest, kevSet: new Set(), kevCatalogLoaded: true });
  const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, config: {}, editionContext: { date: '2026-09-05', timezone: 'UTC', scheduled }, groundingManifest });
  Object.assign(manifest, { generationId: randomUUID(), editorialStandard: 2, generatedAt, verification: { kevCatalogLoaded: true, selectedKevCves: [] },
    providerAttempts: [{ model: 'synthetic-model', status: 'failed', usageComplete: false, usage: { inputTokens: 100, outputTokens: 50 } }],
    costEstimate: { usd: null, status: 'unknown-final-usage' }, publicationValidation: { ...validation, partial: true } });
  return saveRejectedBrief(dir, { id: manifest.generationId, content: text, manifest, validation: { ...validation, partial: true } });
}
const requestFor = (artifact, extra = {}) => ({ baseRevision: artifact.revisions.at(-1).number, inputSha256: artifact.manifestSha256, ...extra });
const post = (artifact, payload, route = 'publish') => fetch(`${base}/brief/drafts/${artifact.id}/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});
const archives = () => readdirSync(dir).filter(file => file.endsWith('.md'));

describe('explicit repair publication', () => {
  test('cached accounting recovery discovers a new commit and still rechecks the archive content', async () => {
    const artifact = draft();
    const lookup = createPublicationLookup(dir);
    const recover = lookup.findGeneration;
    const job = { id: artifact.id, editionDate: artifact.editionDate };
    expect(recover(job)).toBeNull();
    const published = await (await post(artifact, requestFor(artifact))).json();
    expect(recover(job)).toMatchObject({ filename: published.filename, operatorRepaired: true });
    expect(lookup.findDraft(artifact)).toMatchObject({ filename: published.filename });
    writeFileSync(join(dir, published.filename), `${content}\nAltered after publication.`);
    expect(recover(job)).toBeNull();
    expect(() => lookup.findDraft(artifact)).toThrow(/could not be verified/);
  });
  test('publishes fresh checks against the captured inputs without changing original partial/accounting evidence, then replays once', async () => {
    const artifact = draft({ text: content.replace('## BLUF', '## Missing section') });
    const payload = requestFor(artifact, { content });
    const response = await post(artifact, payload);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ published: true, replayed: false, isCurrent: true, warnings: [], publication: { eligibleForLatest: true, revision: 2 }, artifact: { status: 'published' } });
    const receipt = readGenerationManifest(dir, result.filename);
    expect(receipt).toMatchObject({ generationId: artifact.manifest.generationId,
      repairedDraft: { id: artifact.id, inputSha256: artifact.manifestSha256, originalPublicationValidation: { partial: true } },
      publicationValidation: { partial: false, sourceCheckStatus: 'checked-supported-forms' },
      providerAttempts: artifact.manifest.providerAttempts, costEstimate: artifact.manifest.costEstimate });
    expect(receipt.grounding).toEqual(artifact.manifest.grounding);
    expect(readFileSync(join(dir, result.filename), 'utf8')).toBe(content);
    expect(await (await post(artifact, payload)).json()).toMatchObject({ published: true, filename: result.filename, replayed: true });
    expect(archives()).toEqual([result.filename]);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(getClient).not.toHaveBeenCalled(); expect(getFreshRun).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/brief/status`)).json()).toMatchObject({ draftRecovery: { count: 0, latest: null } });
  });

  test('stores blocked edits without publishing, reports current policy, and rejects stale revisions/inputs', async () => {
    const artifact = draft();
    const response = await post(artifact, requestFor(artifact, { content: `${content}\nCVE-2026-99999 is actively exploited.` }));
    expect(response.status).toBe(422);
    const blocked = await response.json();
    expect(blocked.artifact.revisions.at(-1).number).toBe(2);
    expect(blocked.publicationDecision.blockers.length).toBeGreaterThan(0);
    expect(blocked.artifact.publicationDecision).toEqual(blocked.publicationDecision);
    expect(archives()).toEqual([]); expect(webhook).not.toHaveBeenCalled();
    expect((await post(artifact, requestFor(artifact, { content }))).status).toBe(409);
    expect((await post(blocked.artifact, requestFor(blocked.artifact, { inputSha256: '0'.repeat(64) }))).status).toBe(409);
    const fetched = await (await fetch(`${base}/brief/drafts/${artifact.id}`)).json();
    expect(fetched.publicationDecision.blockers).toEqual(blocked.publicationDecision.blockers);
  });

  test('only exact security-control review can release that review finding; it cannot waive source blockers', async () => {
    const control = content.replace('identify applicable systems and review owners', 'disable MFA for affected accounts');
    const artifact = draft({ text: control });
    const held = await post(artifact, requestFor(artifact));
    expect(held.status).toBe(422);
    const state = await held.json();
    expect(state.publicationDecision).toMatchObject({ blockers: [], requiresReview: true });
    const securityControlReview = { reviewer: 'Fixture operator', reason: 'Reviewed the explicit temporary control change and its scope.', contentSha256: sha256(control) };
    expect((await post(artifact, requestFor(artifact, { securityControlReview: { ...securityControlReview, contentSha256: '0'.repeat(64) } }))).status).toBe(422);
    const published = await (await post(artifact, requestFor(artifact, { securityControlReview }))).json();
    expect(published).toMatchObject({ published: true, publication: { eligibleForLatest: true } });
    expect(readGenerationManifest(dir, published.filename).repairedDraft.operatorReview).toMatchObject({ inputSha256: artifact.manifestSha256, contentSha256: sha256(control) });
    const blocked = draft({ text: `${control}\nCVE-2026-99999 is actively exploited.` });
    expect((await post(blocked, requestFor(blocked, { securityControlReview: { ...securityControlReview, contentSha256: blocked.revisions.at(-1).sha256 } }))).status).toBe(422);
    expect(archives()).toHaveLength(1);
  });

  test.each(['later day', 'later attempt on the same day'])('repairing older evidence does not replace a %s current edition', async mode => {
    const artifact = draft();
    const date = mode === 'later day' ? '2026-09-06' : '2026-09-05';
    const existing = saveBrief(dir, '## BLUF\nCurrent evidence.', { date });
    utimesSync(join(dir, existing), new Date(`${date}T15:00:00Z`), new Date(`${date}T15:00:00Z`));
    const result = await (await post(artifact, requestFor(artifact))).json();
    expect(result).toMatchObject({ published: true, isCurrent: false });
    const list = await (await fetch(`${base}/briefs`)).json();
    expect(list[0].filename).toBe(existing);
    expect(result.publication.publishedAt > artifact.manifest.generatedAt).toBe(true);
  });

  test.each([false, true])('scheduled repair preserves an existing reserved edition: %s', async reservedExists => {
    const artifact = draft({ scheduled: true });
    let reserved;
    if (reservedExists) reserved = saveBrief(dir, 'Previously published scheduled edition.', { date: '2026-09-05', scheduled: true });
    const result = await (await post(artifact, requestFor(artifact))).json();
    expect(result.published).toBe(true);
    expect(result.filename).toBe(`brief-2026-09-05-${reservedExists ? '01' : '00'}.md`);
    expect(onDraftPublished).toHaveBeenCalledWith(expect.objectContaining({ scheduled: !reservedExists }));
    if (reservedExists) {
      expect(readFileSync(join(dir, reserved), 'utf8')).toBe('Previously published scheduled edition.');
      expect(completeScheduled).not.toHaveBeenCalled();
    } else expect(completeScheduled).toHaveBeenCalledTimes(1);
  });

  test('an interrupted pointer update is reconciled before editing and replay indexes the immutable archive', async () => {
    const artifact = draft();
    const payload = requestFor(artifact);
    const result = await (await post(artifact, payload)).json();
    const path = join(dir, '.rejected-drafts', `${artifact.id}.json`);
    const interrupted = JSON.parse(readFileSync(path, 'utf8')); delete interrupted.publication; interrupted.status = 'draft';
    writeFileSync(path, JSON.stringify(interrupted));
    const update = await post(artifact, requestFor(artifact, { content: `${content}\nUnsaved changed text.` }), 'revalidate');
    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({ code: 'E_DRAFT_PUBLISHED', artifact: { publication: { filename: result.filename } } });
    expect(readBriefDraft(dir, artifact.id).revisions.at(-1).content).toBe(content);
    expect(await (await post(artifact, payload)).json()).toMatchObject({ replayed: true, filename: result.filename });
    expect(indexBrief).toHaveBeenLastCalledWith(result.filename, content);
    expect(webhook).toHaveBeenCalledTimes(1);
  });

  test('indexing or callback failures remain published, and repair closes the original job without making unknown usage known', async () => {
    const artifact = draft();
    const jobs = createGenerationJobs();
    jobs.start({ id: artifact.manifest.generationId, editionDate: artifact.editionDate });
    jobs.startAttempt(artifact.id, { model: 'synthetic-model' });
    jobs.usage(artifact.id, 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    jobs.finishAttempt(artifact.id, 1, { failed: true });
    jobs.finish(artifact.id, { status: 'failed', code: 'E_PROVIDER_INCOMPLETE' });
    const originalAttempts = jobs.status().latest.attempts;
    indexBrief.mockImplementationOnce(() => { throw new Error('Index temporarily unavailable'); });
    onDraftPublished.mockImplementationOnce(() => { throw new Error('Schedule temporarily unavailable'); });
    const result = await (await post(artifact, requestFor(artifact))).json();
    expect(result).toMatchObject({ published: true }); expect(result.warnings).toHaveLength(2);
    const status = await (await fetch(`${base}/brief/status`)).json();
    expect(status.latest).toMatchObject({ status: 'complete', code: 'OPERATOR_REPAIRED', filename: result.filename, billing: 'unknown-final-usage', costUsd: 0.01 });
    expect(status.latest.attempts).toEqual(originalAttempts);
  });

  test('a scheduled draft awaiting review cannot start another paid run for the same date', async () => {
    const artifact = draft({ scheduled: true });
    const response = await fetch(`${base}/brief`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-blueteam-scheduled-token': 'test-schedule' },
      body: JSON.stringify({ scheduledJob: { jobKey: 'daily-brief:2026-09-05', editionDate: '2026-09-05', timezone: 'UTC' } }) });
    const text = await response.text();
    expect(text).toContain('"awaitingReview":true'); expect(text).toContain(artifact.id);
    expect(getClient).not.toHaveBeenCalled(); expect(getFreshRun).not.toHaveBeenCalled();
    expect(archives()).toEqual([]);
  });
});

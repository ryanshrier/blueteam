import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test, expect } from '@jest/globals';
import { replayBriefArchive, replayCapturedBrief } from '../lib/brief-replay.js';
import { buildMarketingSampleReceipt } from './visual/marketing-brief-receipt.js';
import { MARKETING_BRIEF } from './visual/marketing-brief.js';
import { saveRejectedBrief } from '../lib/brief-drafts.js';
import { sha256 } from '../lib/generation-manifest.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test('replay distinguishes intact receipts, legacy editions and damaged output without mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brief-replay-')); dirs.push(dir);
  const manifest = buildMarketingSampleReceipt();
  const filename = 'brief-2026-07-24-01.md';
  Object.assign(manifest, { filename, outputSha256: sha256(MARKETING_BRIEF) });
  writeFileSync(join(dir, filename), MARKETING_BRIEF);
  writeFileSync(join(dir, filename.replace('.md', '.manifest.json')), JSON.stringify(manifest));
  writeFileSync(join(dir, 'brief-2026-07-23.md'), 'Legacy');
  const before = readFileSync(join(dir, filename), 'utf8');
  const report = replayBriefArchive(dir);
  expect(report.summary).toMatchObject({ replayed: 1, receiptUnavailable: 1, unreplayable: 0 });
  expect(report.editions[0].currentChecks.canPublish).toBe(true);
  expect(readFileSync(join(dir, filename), 'utf8')).toBe(before);
  writeFileSync(join(dir, filename), before + '\nchanged');
  expect(replayBriefArchive(dir).summary.unreplayable).toBe(1);
});

test('lexical action diagnostics and missing timings are distinct from quality scores', () => {
  const row = replayCapturedBrief(MARKETING_BRIEF, buildMarketingSampleReceipt());
  expect(row.diagnostics.judgmentCount).toBeGreaterThan(0);
  expect(row.diagnostics.structuredActionCount).toBeGreaterThan(0);
  expect(row.phaseTimingsMs).toBeNull();
  expect(row).not.toHaveProperty('accuracy');
});

test('a terminal partial response remains blocked, while later complete revisions use their own status', () => {
  const manifest = { ...buildMarketingSampleReceipt(), publicationValidation: { partial: true } };
  expect(replayCapturedBrief(MARKETING_BRIEF, manifest).currentChecks).toMatchObject({ canPublish: false, capturedPartial: true });
  expect(replayCapturedBrief(MARKETING_BRIEF, manifest, { capturedValidation: {} }).currentChecks).toMatchObject({ canPublish: true, capturedPartial: false });
});

test('recoverable drafts participate using frozen evidence without changing artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brief-replay-')); dirs.push(dir);
  const artifact = saveRejectedBrief(dir, { content: MARKETING_BRIEF, manifest: buildMarketingSampleReceipt(), validation: { valid: true, issues: [], warnings: [] } });
  const file = join(dir, '.rejected-drafts', `${artifact.id}.json`);
  const before = readFileSync(file, 'utf8');
  const report = replayBriefArchive(dir);
  expect(report.summary.draftArtifactsExamined).toBe(1);
  expect(report.drafts[0].revisions[0].status).toBe('replayed');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

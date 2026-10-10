import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeBriefReceiptPolicy, RECEIPT_POLICY_FILE } from '../lib/brief-receipts.js';
import { saveBrief } from '../lib/history.js';
import { loadBriefReadingState } from '../lib/brief-reading-checks.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'receipt-policy-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('deleting a modern receipt excludes the edition instead of making it legacy', () => {
  const filename = saveBrief(dir, 'Modern edition', { date: '2026-10-09', manifest: {
    schemaVersion: 1, publicationValidation: { issues: [{ code: 'CVE_CVSS_MISMATCH', severity: 'trust', message: 'Wrong score' }] },
  } });
  expect(loadBriefReadingState(dir, filename).disposition.eligibleForLatest).toBe(false);
  unlinkSync(join(dir, filename.replace(/\.md$/, '.manifest.json')));
  const reading = loadBriefReadingState(dir, filename);
  expect(reading.receipt.integrity).toBe('required');
  expect(reading.disposition.eligibleForLatest).toBe(false);
  expect(reading.presentation.currentChecks.status).toBe('unavailable');
});

test('the initial upgrade adopts only exact existing legacy copies', () => {
  const legacy = 'brief-2026-07-01.md';
  writeFileSync(join(dir, legacy), 'Original legacy copy');
  initializeBriefReceiptPolicy(dir, { adoptLegacy: true });
  expect(loadBriefReadingState(dir, legacy).disposition.eligibleForLatest).toBe(true);
  writeFileSync(join(dir, legacy), 'Replaced copy');
  expect(loadBriefReadingState(dir, legacy).disposition.eligibleForLatest).toBe(false);
  const imported = 'brief-2026-07-02.md';
  writeFileSync(join(dir, imported), 'New unreceipted import');
  expect(loadBriefReadingState(dir, imported).disposition.eligibleForLatest).toBe(false);
});

test('lost or corrupt policy is never silently reconstructed after initialization', () => {
  initializeBriefReceiptPolicy(dir);
  unlinkSync(join(dir, RECEIPT_POLICY_FILE));
  expect(() => initializeBriefReceiptPolicy(dir, { adoptLegacy: true })).toThrow('inventory is missing');
  expect(() => initializeBriefReceiptPolicy(dir, { wasInitialized: true })).toThrow('inventory is missing');
  writeFileSync(join(dir, RECEIPT_POLICY_FILE), '{broken');
  expect(() => initializeBriefReceiptPolicy(dir, { adoptLegacy: true })).toThrow();
});

test('first upgrade excludes known modern publications and ignores directories resembling editions', () => {
  const modern = 'brief-2026-10-08.md', legacy = 'brief-2026-07-01.md';
  writeFileSync(join(dir, modern), 'Known modern publication with lost receipt');
  writeFileSync(join(dir, legacy), 'Legacy publication');
  mkdirSync(join(dir, 'brief-2026-10-09.md'));
  initializeBriefReceiptPolicy(dir, { adoptLegacy: true,
    generationLedger: JSON.stringify({ schemaVersion: 1, jobs: [{ status: 'complete', filename: modern }] }) });
  expect(loadBriefReadingState(dir, modern).receipt.integrity).toBe('required');
  expect(loadBriefReadingState(dir, modern).disposition.eligibleForLatest).toBe(false);
  expect(loadBriefReadingState(dir, legacy).disposition.eligibleForLatest).toBe(true);
});

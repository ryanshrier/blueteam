import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { initDB, closeDB, getDB, setMeta, getMeta } from '../lib/db.js';
import { sourceIdentity, canonicalSourceUrl, observeSources, getSourceEvidence, pruneEvidence, comparePassages, EVIDENCE_PASSAGE_LIMIT } from '../lib/evidence.js';
import { deduplicateWithCorroboration } from '../lib/feeds.js';
import { createLandscapeRouter } from '../routes/landscape.js';

const DAY1 = '2026-09-01T10:00:00.000Z';
const DAY2 = '2026-09-02T10:00:00.000Z';
const sample = (extra = {}) => ({ title: 'Vendor VPN vulnerability advisory CVE-2026-1000', source: 'Vendor', link: 'https://vendor.example/advisory?utm_source=rss', feedUrl: 'https://vendor.example/feed', sourceIdentifier: 'advisory-1000', description: 'Affected versions 1.0–1.2.', passage: 'Affected versions 1.0–1.2. Apply the vendor update.', date: '2026-09-01', retrievedAt: DAY1, ...extra });

describe('retained source observations', () => {
  beforeEach(() => initDB(':memory:'));
  afterEach(() => closeDB());

  test('canonical identity drops tracking/fragment but preserves meaningful version queries', () => {
    expect(canonicalSourceUrl('HTTPS://Vendor.example:443/advisory?b=2&utm_medium=email&a=1#fix'))
      .toBe('https://vendor.example/advisory?a=1&b=2');
    expect(sourceIdentity(sample()).sourceId).toBe(sourceIdentity(sample({ link: 'https://vendor.example/advisory#v2', title: 'Corrected advisory' })).sourceId);
    expect(sourceIdentity(sample({ link: 'https://vendor.example/advisory?v=1' })).sourceId)
      .not.toBe(sourceIdentity(sample({ link: 'https://vendor.example/advisory?v=2' })).sourceId);
    expect(canonicalSourceUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalSourceUrl('https://user:secret@vendor.example/a')).toBeNull();
  });

  test('scoped source IDs link URL changes; missing URLs and IDs have stable title fingerprints', () => {
    const [first] = observeSources([sample()], { observedAt: DAY1 });
    const [moved] = observeSources([sample({ link: 'https://vendor.example/new-advisory', retrievedAt: DAY2 })], { observedAt: DAY2 });
    expect(moved.sourceId).toBe(first.sourceId);
    const noLink = sample({ link: '', feedUrl: '', sourceIdentifier: '' });
    expect(sourceIdentity(noLink).sourceId).toBe(sourceIdentity({ ...noLink, passage: 'Changed excerpt' }).sourceId);
    expect(sourceIdentity(noLink).sourceId).not.toBe(sourceIdentity({ ...noLink, source: 'Different publisher' }).sourceId);
  });

  test('same URL change stores exact before/after, times, and stable identity; repeats deduplicate', () => {
    const original = sample();
    const [first] = observeSources([original], { observedAt: DAY1 });
    const revised = sample({ passage: 'Affected versions 1.0–1.4. Apply the vendor update.', retrievedAt: DAY2, sourceUpdatedAt: DAY2 });
    const [second] = observeSources([revised], { observedAt: DAY2 });
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.revisionId).not.toBe(first.revisionId);
    const [repeat] = observeSources([{ ...revised, retrievedAt: '2026-09-03T10:00:00.000Z' }], { observedAt: '2026-09-03T10:00:00.000Z' });
    expect(repeat.revisionId).toBe(second.revisionId);
    const source = getSourceEvidence(first.sourceId);
    expect(source.revisions).toHaveLength(2);
    expect(source.firstObservedAt).toBe(DAY1);
    expect(source.lastObservedAt).toBe('2026-09-03T10:00:00.000Z');
    expect(source.revisions[0]).toMatchObject({
      revisionId: second.revisionId, passage: revised.passage, previousPassage: original.passage,
      publishedAt: '2026-09-01T00:00:00.000Z', sourceUpdatedAt: DAY2, retrievedAt: DAY2,
      changes: { before: 'Affected versions 1.0–1.', removed: '2', added: '4', after: '. Apply the vendor update.' },
    });
    expect(source.revisions[1].passage).toBe(original.passage);
    expect(original.evidence[0].revisionId).toBe(first.revisionId);
  });

  test('reverting content creates an ordered third revision; stale cached copies cannot roll it back', () => {
    const first = sample();
    const [ref] = observeSources([first], { observedAt: DAY1 });
    observeSources([sample({ passage: 'Correction: affected through 1.4', retrievedAt: DAY2 })], { observedAt: DAY2 });
    const [staleRef] = observeSources([first], { observedAt: '2026-09-03T10:00:00.000Z' });
    expect(staleRef.revisionId).toBe(ref.revisionId);
    expect(getSourceEvidence(ref.sourceId).revisions).toHaveLength(2);
    expect(getSourceEvidence(ref.sourceId).lastObservedAt).toBe(DAY2);
    observeSources([{ ...first, retrievedAt: '2026-09-03T10:00:00.000Z' }], { observedAt: '2026-09-03T10:00:00.000Z' });
    const source = getSourceEvidence(ref.sourceId);
    expect(source.revisions).toHaveLength(3);
    expect(source.revisions[0].passage).toBe(source.revisions[2].passage);
    expect(source.revisions[0].revisionId).not.toBe(source.revisions[2].revisionId);
  });

  test('an old cached member whose revision was pruned receives no fabricated newer reference', () => {
    const old = sample();
    const [ref] = observeSources([old], { observedAt: DAY1 });
    const [current] = observeSources([sample({ passage: 'New current passage', retrievedAt: DAY2 })], { observedAt: DAY2 });
    pruneEvidence({ now: DAY2, maxRevisionsPerSource: 1 });
    expect(observeSources([old], { observedAt: DAY2 })).toEqual([null]);
    expect(old.evidence).toEqual([]);
    expect(getSourceEvidence(ref.sourceId).latestRevisionId).toBe(current.revisionId);
  });

  test('grouped display can choose a longer excerpt while both original passages and attribution remain inspectable', () => {
    const a = sample({ description: 'Vendor advisory excerpt.', passage: 'Vendor advisory exact passage.' });
    const b = sample({ source: 'Independent report', sourceIdentifier: 'report-2', feedUrl: 'https://report.example/feed', link: 'https://report.example/a', description: 'A substantially longer independent description of this vulnerability.', passage: 'Independent reporting passage; exposure remains uncertain.' });
    observeSources([a, b], { observedAt: DAY1 });
    const grouped = deduplicateWithCorroboration([a, b]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].evidence).toHaveLength(2);
    expect(grouped[0].sourceMembers.map(member => member.passage).sort()).toEqual([a.passage, b.passage].sort());
    for (const member of grouped[0].sourceMembers) {
      const retained = getSourceEvidence(member.evidence[0].sourceId).revisions[0];
      expect(retained.passage).toBe(member.passage);
      expect(retained.source).toBe(member.source);
    }
    expect(a.description).toBe('Vendor advisory excerpt.');
  });

  test('two feed representations of one article retain their passages without alternating false changes', () => {
    const original = sample();
    const discovery = sample({ source: 'Discovery', feedUrl: '', sourceIdentifier: '', passage: '', description: '' });
    const [rss, search] = observeSources([original, discovery], { observedAt: DAY1 });
    expect(search.sourceId).toBe(rss.sourceId);
    expect(search.revisionId).not.toBe(rss.revisionId);
    const repeated = observeSources([original, discovery], { observedAt: DAY2 });
    expect(repeated.map(ref => ref.revisionId)).toEqual([rss.revisionId, search.revisionId]);
    expect(getSourceEvidence(rss.sourceId).revisions).toHaveLength(2);
    const [changed] = observeSources([sample({ passage: 'Vendor changed affected versions.', retrievedAt: DAY2 })], { observedAt: DAY2 });
    expect(getSourceEvidence(changed.sourceId).revisions[0].previousRevisionId).toBe(rss.revisionId);
    expect(getSourceEvidence(changed.sourceId).revisions[0].previousPassage).toBe(original.passage);
  });

  test('public inspection omits query credentials while local identity stays stable', () => {
    const [ref] = observeSources([sample({
      link: 'https://vendor.example/advisory?token=private-link-token',
      feedUrl: 'https://vendor.example/feed?api_key=private-feed-key',
      sourceIdentifier: 'https://vendor.example/id?signature=private-signature',
    })], { observedAt: DAY1 });
    const publicData = JSON.stringify({ ref, evidence: getSourceEvidence(ref.sourceId) });
    expect(publicData).not.toMatch(/private-link-token|private-feed-key|private-signature/);
    expect(publicData).toContain('REDACTED');
  });

  test('bounds passages, revision history, source count and age without fabricating pruned comparison text', () => {
    const [ref] = observeSources([sample({ passage: 'x'.repeat(EVIDENCE_PASSAGE_LIMIT + 100) })], { observedAt: DAY1 });
    expect(getSourceEvidence(ref.sourceId).revisions[0]).toMatchObject({ passageTruncated: true, passage: 'x'.repeat(EVIDENCE_PASSAGE_LIMIT) });
    for (let i = 0; i < 10; i++) {
      const time = new Date(Date.parse(DAY1) + (i + 1) * 60000).toISOString();
      observeSources([sample({ passage: `revision ${i}`, retrievedAt: time })], { observedAt: time });
    }
    const source = getSourceEvidence(ref.sourceId);
    expect(source.revisions).toHaveLength(8);
    expect(source.revisions.at(-1).previousRevisionId).not.toBeNull();
    expect(source.revisions.at(-1).previousPassage).toBeNull();
    observeSources([sample({ link: 'https://other.example/a', sourceIdentifier: 'other', retrievedAt: DAY2 })], { observedAt: DAY2 });
    pruneEvidence({ now: DAY2, maxSources: 1 });
    expect(getDB().prepare('SELECT COUNT(*) AS n FROM evidence_sources').get().n).toBe(1);
    pruneEvidence({ now: '2026-11-01T00:00:00.000Z' });
    expect(getDB().prepare('SELECT COUNT(*) AS n FROM evidence_revisions').get().n).toBe(0);
    expect(getDB().prepare('SELECT COUNT(*) AS n FROM evidence_aliases').get().n).toBe(0);
  });

  test('title-only evidence is explicit and comparisons reconstruct both passages', () => {
    const [ref] = observeSources([sample({ passage: '', description: '' })], { observedAt: DAY1 });
    expect(getSourceEvidence(ref.sourceId).revisions[0]).toMatchObject({ passageKind: 'title-only', passage: sample().title });
    for (const [before, after] of [['old', 'new'], ['', 'added'], ['removed', ''], ['abc old xyz', 'abc new xyz']]) {
      const change = comparePassages(before, after);
      expect(change.before + change.removed + change.after).toBe(before);
      expect(change.before + change.added + change.after).toBe(after);
    }
    expect(comparePassages('unchanged', 'unchanged')).toBeNull();
  });
});

test('source evidence and grouped references survive an actual database restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blueteam-evidence-'));
  try {
    const path = join(dir, 'evidence.sqlite');
    initDB(path);
    // Simulate an existing v7 database, retaining its unrelated local records.
    setMeta('existing-v7-setting', 'preserve this');
    getDB().exec('DROP TABLE evidence_aliases; DROP TABLE evidence_revisions; DROP TABLE evidence_sources; ALTER TABLE headline_archive DROP COLUMN first_snapshot_json; PRAGMA user_version = 7;');
    closeDB();
    initDB(path);
    expect(getDB().pragma('user_version', { simple: true })).toBe(9);
    expect(getMeta('existing-v7-setting')).toBe('preserve this');
    const input = sample();
    const [ref] = observeSources([input], { observedAt: DAY1 });
    setMeta('evidence-test-run', JSON.stringify(deduplicateWithCorroboration([input])));
    closeDB();
    initDB(path);
    const restored = JSON.parse(getMeta('evidence-test-run'))[0];
    expect(restored.evidence[0]).toEqual(ref);
    expect(restored.sourceMembers[0].passage).toBe(input.passage);
    expect(getSourceEvidence(ref.sourceId).revisions[0].passage).toBe(input.passage);
  } finally {
    closeDB();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /api/evidence/:sourceId', () => {
  let server; let base;
  beforeEach(async () => {
    initDB(':memory:');
    const app = express();
    app.use('/api', createLandscapeRouter({ historyDir: '', cooldown: { check: () => true } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/evidence`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); closeDB(); });

  test('returns exact retained revisions without fetching a publisher and gives honest missing/error states', async () => {
    const [ref] = observeSources([sample()], { observedAt: DAY1 });
    const response = await fetch(`${base}/${ref.sourceId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).revisions[0].passage).toBe(sample().passage);
    expect((await fetch(`${base}/invalid`)).status).toBe(400);
    expect((await fetch(`${base}/src_${'0'.repeat(64)}`)).status).toBe(404);
    closeDB();
    expect((await fetch(`${base}/${ref.sourceId}`)).status).toBe(503);
  });
});

import { describe, expect, test } from '@jest/globals';
import { applyHistoricalEvidenceContext, formatHistoricalEvidenceContext } from '../lib/evidence-continuity.js';
import { sourceEvidencePassages } from '../lib/source-passages.js';
import { buildGenerationManifest } from '../lib/generation-manifest.js';

const now = Date.parse('2026-10-09T18:00:00Z');
const current = { id: 'S12.1', title: 'SonicWall SMA1000 exploitation reported', label: 'Publisher',
  url: 'https://publisher.test/sonicwall?id=1', date: '2026-10-09T12:00:00Z', retrievedAt: '2026-10-09T17:00:00Z',
  passage: 'SonicWall SMA1000 CVE-2026-102255 exploitation has been reported.', quality: { substantive: true },
  cves: ['CVE-2026-102255'], cvssMetrics: [], sourceParts: [] };
const earlier = { ...current, id: 'S7.1', publishedAt: current.date, retrievedAt: '2026-10-09T13:00:00Z',
  passageKind: 'article-excerpts', passage: 'SonicWall SMA1000 researchers observed exploitation attempts, but successful compromise is not established. '
    + 'The report identifies affected appliance models 6210, 7210, and 8200v. '.repeat(8) };
const receipt = (source = earlier) => ({ generationId: 'previous-generation', capturedAt: '2026-10-09T14:00:00Z', grounding: { sources: [source] } });
const apply = (source = current, receipts = [receipt()]) => applyHistoricalEvidenceContext({ members: [source], cves: new Set(source.cves) }, receipts, { now });

describe('bounded historical publisher context', () => {
  test('restores dated qualifications under the current exact citation without adding factual authority', () => {
    const before = JSON.stringify(current);
    const result = apply();
    const retained = result.groundingManifest.members[0];
    expect(retained.historicalCaptures[0]).toMatchObject({ retrievedAt: earlier.retrievedAt.replace('Z', '.000Z'),
      currentFactAuthority: false, quality: { substantive: true }, retainedFrom: { sourceId: 'S7.1' } });
    expect(retained.historicalCaptures[0].passage).toContain('successful compromise is not established');
    expect(sourceEvidencePassages(retained)).toEqual([current.passage]);
    expect([...result.groundingManifest.cves]).toEqual(current.cves);
    expect(retained.cvssMetrics).toEqual([]);
    expect(JSON.stringify(current)).toBe(before);
    expect(result.diagnostics.sources).toHaveLength(1);
  });

  test.each([{ url: 'https://publisher.test/sonicwall?id=2' }, { title: 'Different SonicWall article' },
    { label: 'Different Publisher' }, { date: '2026-10-08T12:00:00Z' }, { date: '' },
    { passage: '', quality: { substantive: false } }, { collectionStale: true },
    { retrievedAt: '2026-10-09T12:00:00Z' }, { retrievedAt: '' }])('does not reuse without exact identity and usable current evidence: %j', overrides => {
    expect(apply({ ...current, ...overrides }).diagnostics.sources).toEqual([]);
  });

  test('rejects stale/future captures and reclassifies historically accepted contamination', () => {
    for (const source of [{ ...earlier, retrievedAt: '2026-10-01T13:00:00Z' }, { ...earlier, retrievedAt: '2026-10-10T13:00:00Z' },
      { ...earlier, passage: 'Advertisement '.repeat(80) }]) expect(apply(current, [receipt(source)]).diagnostics.sources).toEqual([]);
    expect(apply(current, [{ ...receipt(), capturedAt: '2026-10-01T14:00:00Z' }]).diagnostics.sources).toEqual([]);
  });

  test('does not override a newer explicit claim or add older model/version claims', () => {
    const newer = { ...current, passage: 'SonicWall reports confirmed successful compromise through CVE-2026-102255.' };
    const result = apply(newer);
    expect(result.groundingManifest.members[0].passage).toBe(newer.passage);
    const prompt = formatHistoricalEvidenceContext(result.groundingManifest);
    expect(prompt).toContain('Do not let an older qualification overrule a newer explicit statement');
    expect(prompt).toContain('Do not introduce CVEs, versions, metrics, affected models');
    expect(prompt).toContain('state the dated discrepancy');
  });

  test('a fuller current capture needs no historical supplement and previous model prose is never inspected', () => {
    expect(apply({ ...current, passage: earlier.passage }).diagnostics.sources).toEqual([]);
    expect(apply(current, [{ ...receipt(), grounding: undefined, content: earlier.passage }]).diagnostics.sources).toEqual([]);
  });

  test('receipts preserve dates and provenance of supplementary context', () => {
    const { groundingManifest } = apply();
    const manifest = buildGenerationManifest({ run: { headlines: [] }, config: {}, groundingManifest, editionContext: {}, continuityContext: '' });
    expect(manifest.grounding.sources[0].historicalCaptures[0]).toMatchObject({ currentFactAuthority: false,
      retainedFrom: { generationId: 'previous-generation', sourceId: 'S7.1' }, retrievalStatus: 'prior-receipt-not-refreshed' });
  });
});

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildGenerationManifest, generationManifestAvailability, generationManifestFilename,
  MAX_GENERATION_MANIFEST_BYTES, readGenerationManifest, recordProviderAttempt,
  recordValidation, serializeGenerationManifest, sha256,
} from '../lib/generation-manifest.js';
import { saveBrief } from '../lib/history.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { snapshotScoringConfiguration } from '../lib/scoring-snapshot.js';

const profile = { schemaVersion: 1, technologies: ['Fortinet'], sectors: ['Health'], regions: ['US'], intelligenceQuestions: ['Which versions changed?'], exclusions: [], preferredHorizons: [1], teamProfile: 'One analyst' };
const ref = { sourceId: 'src_original', revisionId: 'rev_2', source: 'Vendor', title: 'Affected versions change', canonicalUrl: 'https://vendor.example/advisory', passageKind: 'feed-excerpt', changed: true, publishedAt: '2026-09-04T10:00:00Z', retrievedAt: '2026-09-05T10:00:00Z' };
function receipt(overrides = {}) {
  const headlines = [{ title: ref.title, source: ref.source, link: ref.canonicalUrl, description: 'Version 2.1 is affected.', articleBody: 'The vendor confirmed affected versions. '.repeat(60), horizon: 1, evidence: [ref],
    cveData: 'CVE-2026-12345 CVSS 9.8', isKEV: true, kevCVE: 'CVE-2026-12345', epss: 0.6,
    sourceMembers: [{ title: ref.title, source: ref.source, link: ref.canonicalUrl, passage: 'Original vendor excerpt.', evidence: [ref] }],
    score: 90, scoreComponents: { recency: 0.8 },
  }];
  const config = { analysisSettings: { scoring: { axisWeights: { recency: 0.4 } } }, anthropicKey: 'sk-ant-do-not-save', dataDir: 'C:\\private\\settings', webhook: { url: 'https://secret.example/hook' } };
  return buildGenerationManifest({ run: { timestamp: '2026-09-05T10:00:00Z', headlines, watchProfile: profile, scoringConfiguration: snapshotScoringConfiguration(config), stats: { enrichmentFailures: ['EPSS'] } }, config, watchProfile: profile, editionContext: { date: '2026-09-05', timezone: 'local', scheduled: false }, groundTruth: 'Catalog loaded.', groundingManifest: buildGroundingManifest({ headlines }), continuityContext: 'Prior topic only', previousBriefs: [{ filename: 'brief-2026-09-04-01.md', content: 'Prior assessment' }], ...overrides });
}

describe('generation input receipt', () => {
  test('keeps the selected bounded article passage and every grouped source with revision references', () => {
    const manifest = receipt();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(manifest.generationSettings).toMatchObject({ thinkingEffort: 'low', maxTokens: 16000 });
    expect(manifest.selectedEvidence[0].passage).toEqual({ kind: 'article-excerpts', text: 'The vendor confirmed affected versions. '.repeat(60).trim(), quality: { status: 'substantive', substantive: true, reasons: ['retained-body-detail'] } });
    expect(manifest.selectedEvidence[0].sourceRevisions[0]).toMatchObject({ sourceId: 'src_original', revisionId: 'rev_2', changed: true });
    expect(manifest.selectedEvidence[0].groupMembers[0]).toMatchObject({ passage: 'Original vendor excerpt.', sourceRevisions: [expect.objectContaining({ revisionId: 'rev_2' })] });
    expect(manifest.selectedEvidence[0].enrichment).toMatchObject({ cveData: 'CVE-2026-12345 CVSS 9.8', isKEV: true, epss: 0.6 });
    expect(manifest.collection).toMatchObject({ configurationStatus: 'captured-at-collection', enrichmentFailures: ['EPSS'], scoringConfiguration: { axisWeights: { recency: 0.4 } } });
    expect(manifest.promptWatchProfile).toEqual(profile);
    const serialized = serializeGenerationManifest(manifest);
    expect(serialized).not.toMatch(/sk-ant-do-not-save|C:\\|secret\.example|anthropicKey|dataDir|webhook/);
    expect(manifest.application).toMatchObject({ name: 'blueteam-news', version: expect.any(String), implementationSha256: { prompts: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });

  test('separates collection profile from later generation profile and cannot mutate history', () => {
    const changed = { ...profile, technologies: ['Juniper'] };
    const manifest = receipt({ watchProfile: changed });
    changed.technologies.push('New setting after capture');
    expect(manifest.collection.watchProfile.technologies).toEqual(['Fortinet']);
    expect(manifest.promptWatchProfile.technologies).toEqual(['Juniper']);
  });

  test('missing historical configuration and revision references remain explicitly unknown', () => {
    const manifest = receipt({ run: { headlines: [{ title: 'Legacy headline' }] } });
    expect(manifest.collection).toMatchObject({ configurationStatus: 'unavailable', scoringConfiguration: null, watchProfile: null });
    expect(manifest.selectedEvidence[0]).toMatchObject({ revisionStatus: 'unavailable', sourceRevisions: [], enrichment: { isKEV: null } });
  });

  test('fingerprints each exact model attempt without retaining messages or secrets', () => {
    const manifest = receipt();
    const params = { model: 'model-1', max_tokens: 16000, system: 'Exact system prompt', messages: [{ role: 'user', content: 'Local sensitive prompt sk-ant-very-private' }] };
    recordProviderAttempt(manifest, params);
    params.messages[0].content = 'Corrected source input';
    recordProviderAttempt(manifest, params);
    expect(manifest.providerAttempts[0].systemPromptSha256).toBe(sha256('Exact system prompt'));
    expect(manifest.providerAttempts[0].messagesSha256).not.toBe(manifest.providerAttempts[1].messagesSha256);
    expect(JSON.stringify(manifest)).not.toContain('sk-ant-very-private');
    recordValidation(manifest, 'draft', { valid: false, warnings: ['Missing source'] });
    expect(manifest.validation).toEqual([{ draftSha256: sha256('draft'), valid: false, warnings: ['Missing source'], issues: [], coverage: null, editorialReviewStatus: 'not-reviewed' }]);
  });

  test('bounds inputs before generation instead of silently discarding selected evidence', () => {
    expect(() => receipt({ run: { headlines: Array.from({ length: 201 }, () => ({ title: 'source' })) } })).toThrow(/retention limit/);
    expect(() => serializeGenerationManifest({ large: 'x'.repeat(MAX_GENERATION_MANIFEST_BYTES) })).toThrow(/retention limit/);
  });

  test('strips credential URLs and credential-shaped evidence while retaining hashes of original prompts', () => {
    const manifest = receipt({ run: { headlines: [{ title: 'sk-ant-source-secret', link: 'https://user:private@example.com/a', description: 'Source content' }, { title: 'Token link', link: 'https://example.com/a?id=42&api_key=private-token' }] } });
    expect(manifest.selectedEvidence[0].url).toBe('');
    expect(manifest.selectedEvidence[0].title).toBe('[REDACTED]');
    expect(manifest.selectedEvidence[1].url).toContain('id=42');
    expect(JSON.stringify(manifest)).not.toMatch(/private-token|source-secret|user:private/);
  });
});

describe('saved receipt identity and legacy editions', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blueteam-manifest-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('reads a private receipt bound to the exact saved edition and detects later edits', () => {
    const manifest = receipt();
    const filename = saveBrief(dir, '# Saved assessment', { date: '2026-09-05', manifest });
    expect(readGenerationManifest(dir, filename)).toMatchObject({ generationId: manifest.generationId, filename, outputSha256: sha256('# Saved assessment') });
    expect(generationManifestAvailability(dir, filename)).toEqual({ status: 'available', url: `/api/brief/${filename}/manifest` });
    writeFileSync(join(dir, filename), '# Later edited assessment');
    expect(() => readGenerationManifest(dir, filename)).toThrow(/does not match/);
  });

  test('does not fabricate inputs for an older edition or overwrite scheduled inputs on retry', () => {
    const legacy = saveBrief(dir, 'old assessment', { date: '2026-09-04' });
    expect(readGenerationManifest(dir, legacy)).toBeNull();
    expect(generationManifestAvailability(dir, legacy)).toMatchObject({ status: 'unavailable', url: null, reason: expect.any(String) });
    const first = receipt();
    const filename = saveBrief(dir, 'first assessment', { date: '2026-09-05', scheduled: true, manifest: first });
    saveBrief(dir, 'replacement attempt', { date: '2026-09-05', scheduled: true, manifest: receipt() });
    expect(readGenerationManifest(dir, filename).generationId).toBe(first.generationId);
    expect(readFileSync(join(dir, filename), 'utf8')).toBe('first assessment');
  });

  test.each(['../config.json', '..\\config.json', '/etc/passwd', 'brief-2026-09-05.md/../config.json', 'brief-2026-09-05.md.manifest.json', 'brief-2026-09-05-1234567.md'])('rejects unsafe or unbounded manifest filename %s', filename => {
    expect(() => generationManifestFilename(filename)).toThrow(/Invalid briefing filename/);
  });
});

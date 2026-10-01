// Node-only builder for the public authored sample. Browser fixtures import
// marketing-brief.js without loading filesystem-backed implementation hashes.
import { MARKETING_BRIEF, MARKETING_SOURCES } from './marketing-brief.js';
import { buildGroundingManifest } from '../../lib/grounding.js';
import { buildGenerationManifest, recordValidation, sha256 } from '../../lib/generation-manifest.js';
import { validationSourceFromManifest } from '../../lib/brief-drafts.js';
import { validateBrief, hasHardFail, hasTrustCriticalFailure } from '../../lib/validation.js';

export function buildMarketingSampleReceipt({ regeneratedAt = new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(regeneratedAt))) throw new TypeError('A valid sample regeneration timestamp is required');
  const scenarioTimestamp = '2026-07-24T12:00:00Z';
  const manifest = buildGenerationManifest({
    run: { timestamp: scenarioTimestamp, headlines: MARKETING_SOURCES },
    config: {
      organization: { profile: 'Fictional public demonstration', sector: 'Synthetic exercise' },
      analysisSettings: { preferredModel: 'synthetic-fixture', model: 'synthetic-fixture', thinkingEffort: 'off', continuityDepth: 0 },
    },
    editionContext: { date: '2026-07-24', timezone: 'UTC', scheduled: false },
    groundingManifest: buildGroundingManifest({ headlines: MARKETING_SOURCES }),
  });
  Object.assign(manifest, {
    generationId: '00000000-0000-4000-8000-000000000001',
    capturedAt: scenarioTimestamp,
    generatedAt: scenarioTimestamp,
    synthetic: true,
    syntheticRegeneratedAt: regeneratedAt,
    syntheticNote: 'Authored fictional demonstration; no provider was called. Edition, source, collection, capturedAt, and generatedAt dates describe the July 24, 2026 scenario, not a real collection or generation. syntheticRegeneratedAt records when this sample receipt was rebuilt and checked against the recorded application implementation. Passing supported checks does not verify real-world events or complete analyst review.',
    filename: 'brief-2026-07-24-01.md',
    outputSha256: sha256(MARKETING_BRIEF),
    modelUsed: 'synthetic-fixture',
    editorialStandard: 2,
    verification: { kevCatalogLoaded: false, selectedKevCves: [], kevTiming: {} },
    costEstimate: { usd: 0, currency: 'USD', basis: 'Authored fixture; no provider calls or billed generation.' },
  });
  Object.assign(manifest.generationSettings, { provider: 'none', maxTokens: null });

  const validation = validateBrief(MARKETING_BRIEF, manifest.edition.date, validationSourceFromManifest(manifest));
  recordValidation(manifest, MARKETING_BRIEF, validation);
  const hardFail = hasHardFail(validation.issues);
  const trustFail = hasTrustCriticalFailure(validation.issues);
  manifest.judgmentEvidence = validation.judgmentEvidence;
  manifest.publicationValidation = {
    valid: validation.valid, warnings: validation.warnings, issues: validation.issues,
    hardFail, trustFail, partial: false, coverage: validation.coverage,
    sourceCheckStatus: hardFail || trustFail ? 'findings' : 'passed-supported-checks',
    editorialReviewStatus: 'not-reviewed',
  };
  if (!validation.valid || hardFail || trustFail) {
    throw new Error(`Authored sample fails current publication checks: ${validation.issues.map(issue => issue.message).join('; ')}`);
  }
  return manifest;
}

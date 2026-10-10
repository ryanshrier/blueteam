// Read-only evaluation of retained editions and recoverable drafts. No provider,
// current feed, settings, database initialization, or archive mutation is used.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readGenerationManifest, validBriefFilename, sha256 } from './generation-manifest.js';
import { readBriefDraft, validDraftId, validationSourceFromManifest, validationManifestForDraft } from './brief-drafts.js';
import { validateBrief, publicationDecision } from './validation.js';
import { canonicalActions } from './brief-editorial.js';
import { SECTIONS, section, splitEntries } from './brief-schema.js';

const tally = issues => {
  const result = {};
  for (const issue of issues || []) result[issue.code] = (result[issue.code] || 0) + 1;
  return result;
};

export function replayCapturedBrief(content, manifest, { capturedValidation = manifest.publicationValidation } = {}) {
  const checked = validateBrief(content, manifest.edition?.date, validationSourceFromManifest(manifest, content));
  const decision = publicationDecision({ ...checked, partial: capturedValidation?.partial === true });
  const original = [...(manifest.validation || [])].reverse().find(row => row.draftSha256 === sha256(content));
  const sources = manifest.grounding.sources;
  const ids = [...new Set(sources.flatMap(source => source.cves || []))];
  return {
    status: 'replayed', contentSha256: sha256(content),
    currentChecks: { canPublish: decision.canPublish, requiresReview: decision.requiresReview,
      blockerCount: decision.blockers.length, reviewCount: decision.reviewIssues.length, issueCodes: tally(checked.issues),
      capturedPartial: capturedValidation?.partial === true },
    capturedChecks: original ? { valid: original.valid, issueCodes: tally(original.issues) } : null,
    priorityCoverage: checked.priorityCoverage,
    sourceQuality: checked.sourceQuality,
    diagnostics: {
      judgmentCount: splitEntries(section(content, SECTIONS.keyJudgments)).length,
      structuredActionCount: canonicalActions(content).length,
      capturedSourceCount: sources.length,
      sourceCvesMentioned: ids.filter(id => content.toUpperCase().includes(id.toUpperCase())).length,
      sourceCvesAvailable: ids.length,
      // These are lexical diagnostics, not evidence of semantic correctness.
      actionConditionMarkers: canonicalActions(content).filter(action => /\bif\b|\bwhen\b|\bonly\b|\bconfirm\b/i.test(action.text)).length,
      evidenceRevisionCount: new Set(sources.flatMap(source => (source.sourceRevisions || []).map(ref => ref.revisionId)).filter(Boolean)).size,
    },
    providerAttempts: manifest.providerAttempts?.length ?? null,
    costUsd: Number.isFinite(manifest.costEstimate?.usd) ? manifest.costEstimate.usd : null,
    phaseTimingsMs: manifest.phaseTimingsMs || null,
    selection: manifest.collection?.selection || null,
  };
}

export function replayBriefArchive(historyDir, { limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Replay limit must be 1–500');
  const files = readdirSync(historyDir).filter(validBriefFilename).sort().reverse();
  const editions = files.slice(0, limit).map(filename => {
    try {
      if (statSync(join(historyDir, filename)).size > 500000) throw new Error('Edition exceeds replay size limit');
      const manifest = readGenerationManifest(historyDir, filename);
      if (!manifest) return { filename, status: 'receipt-unavailable' };
      return { filename, ...replayCapturedBrief(readFileSync(join(historyDir, filename), 'utf8'), manifest) };
    } catch (error) { return { filename, status: 'unreplayable', reason: error.message }; }
  });
  const drafts = [];
  const dir = join(historyDir, '.rejected-drafts');
  const draftFiles = existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json') && validDraftId(file.slice(0, -5))).sort() : [];
  for (const filename of draftFiles.slice(0, limit)) {
    const id = filename.slice(0, -5);
    try {
      const artifact = readBriefDraft(historyDir, id);
      if (!artifact) { drafts.push({ id, status: 'outside-retention' }); continue; }
      drafts.push({ id, publication: artifact.publication?.filename || null,
        operatorSaved: Boolean(artifact.operatorSavedAt), revisionCount: artifact.revisions.length,
        revisions: artifact.revisions.map(revision => ({ number: revision.number, ...replayCapturedBrief(revision.content,
          validationManifestForDraft({ ...artifact, revisions: [revision] }), { capturedValidation: revision.validation }) })) });
    } catch (error) { drafts.push({ id, status: 'unreplayable', reason: error.message }); }
  }
  return { schemaVersion: 1, evaluatedAt: new Date().toISOString(), mode: 'offline-retained-evidence',
    summary: { editionsFound: files.length, editionsExamined: editions.length,
      replayed: editions.filter(row => row.status === 'replayed').length,
      receiptUnavailable: editions.filter(row => row.status === 'receipt-unavailable').length,
      unreplayable: editions.filter(row => row.status === 'unreplayable').length,
      currentlyRequireReview: editions.filter(row => row.currentChecks?.requiresReview).length,
      currentlyBlocked: editions.filter(row => row.currentChecks && !row.currentChecks.canPublish).length,
      draftArtifactsFound: draftFiles.length, draftArtifactsExamined: drafts.length,
      retainedDraftsWithOperatorSaves: drafts.filter(row => row.operatorSaved).length },
    limits: ['Historical selected evidence cannot establish recall for candidates not retained.',
      'Action and CVE counts are lexical diagnostics, not scores of usefulness or supported meaning.',
      'Retained drafts are a retention-limited sample; operator saves do not establish the overall manual intervention rate.',
      'Missing timings, costs, and receipts stay unknown; no archive is rewritten.'],
    editions, drafts };
}

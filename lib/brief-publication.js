// Publication reuses the archive's receipt-first commit boundary. It never
// invokes a provider, refreshes captured evidence, or changes usage accounting.
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveBrief, scheduledBriefFilename } from './history.js';
import { readGenerationManifest, sha256, validBriefFilename } from './generation-manifest.js';
import { saveBriefDisposition } from './brief-review.js';
import { publicationDecision } from './validation.js';

const conflict = message => Object.assign(new Error(message), { code: 'E_DRAFT_CONFLICT' });

// Status polling shares one filename-only lookup across all jobs and drafts.
// Archive entries are immutable; directory changes invalidate the lookup.
// Cached names are hints only: verify each matching receipt again before trust.
export function createPublicationLookup(historyDir) {
  let version = null;
  const generations = new Map();
  const drafts = new Map();
  const refresh = () => {
    if (!existsSync(historyDir)) { generations.clear(); drafts.clear(); version = null; return; }
    const currentVersion = statSync(historyDir, { bigint: true }).mtimeNs.toString();
    if (currentVersion === version) return;
    generations.clear(); drafts.clear();
    for (const filename of readdirSync(historyDir).filter(validBriefFilename)) {
      try {
        const manifest = readGenerationManifest(historyDir, filename);
        if (manifest?.generationId) generations.set(manifest.generationId, filename);
        if (manifest?.repairedDraft?.id) drafts.set(manifest.repairedDraft.id, filename);
      } catch { /* invalid archives never resolve accounting */ }
    }
    version = currentVersion;
  };
  return {
    findGeneration(job) {
      refresh();
      const filename = generations.get(job.id);
      if (!filename || !filename.startsWith(`brief-${job.editionDate}`)) return null;
      try {
        const manifest = readGenerationManifest(historyDir, filename);
        if (manifest?.generationId === job.id) return { filename, generatedAt: manifest.generatedAt,
          costUsd: manifest.costEstimate?.usd, operatorRepaired: Boolean(manifest.repairedDraft) };
      } catch { /* a cached name cannot bypass archive integrity */ }
      return null;
    },
    findDraft(artifact) {
      if (!artifact.publication?.filename) refresh();
      const filename = artifact.publication?.filename || drafts.get(artifact.id);
      if (filename) {
        try {
          const manifest = readGenerationManifest(historyDir, filename);
          if (manifest?.repairedDraft?.id === artifact.id) return { filename, manifest };
        } catch { /* an unverifiable candidate cannot count as published */ }
        // A known committed name must never lead to buying or publishing again.
        throw conflict('The published edition could not be verified. Restore its matching receipt before retrying.');
      }
      return null;
    },
  };
}

export function verifyPublicationReplay(found, artifact, request) {
  const saved = found.manifest.repairedDraft;
  const current = artifact.revisions.at(-1);
  const submittedHash = sha256(request.content ?? current.content);
  const originalSubmission = request.baseRevision === saved.baseRevision && submittedHash === saved.submittedSha256;
  const exactPublishedCopy = request.baseRevision === saved.revision && submittedHash === saved.contentSha256;
  if (current.number !== saved.revision || current.sha256 !== saved.contentSha256
    || request.inputSha256 !== saved.inputSha256 || saved.inputSha256 !== artifact.manifestSha256
    || (!originalSubmission && !exactPublishedCopy)) throw conflict('This draft was already published from a different revision. Open the published edition.');
  return { revision: saved.revision, contentSha256: saved.contentSha256, inputSha256: saved.inputSha256,
    filename: found.filename, publishedAt: found.manifest.generatedAt };
}

export function publishDraftEdition({ historyDir, reviewDir, artifact, validation, request, now = new Date().toISOString() }) {
  const current = artifact.revisions.at(-1);
  const decision = publicationDecision(validation);
  const review = request.securityControlReview;
  let operatorReview = null;
  if (decision.requiresReview && review && typeof review === 'object' && !Array.isArray(review)
    && review.contentSha256 === current.sha256 && typeof review.reviewer === 'string' && review.reviewer.trim()
    && review.reviewer.length <= 200 && typeof review.reason === 'string' && review.reason.trim() && review.reason.length <= 8000
    && decision.reviewIssues.every(issue => issue.code === 'SECURITY_CONTROL_CHANGE')) {
    operatorReview = { reviewer: review.reviewer.trim(), reason: review.reason.trim(), reviewedAt: now,
      contentSha256: current.sha256, inputSha256: artifact.manifestSha256, issueCodes: ['SECURITY_CONTROL_CHANGE'] };
  }
  if (decision.blockers.length || (decision.requiresReview && !operatorReview)) {
    throw Object.assign(new Error(decision.blockers.length ? 'The saved draft still has publication blockers.' : 'Review the security control change before publishing this exact draft.'),
      { code: 'E_DRAFT_BLOCKED', decision });
  }
  const original = artifact.manifest;
  const scheduled = original.edition?.scheduled === true && !existsSync(join(historyDir, scheduledBriefFilename(original.edition.date)));
  const manifest = { ...original,
    edition: { ...original.edition, scheduled }, generatedAt: now,
    repairedDraft: { id: artifact.id, revision: current.number, contentSha256: current.sha256,
      inputSha256: artifact.manifestSha256, originalOutputSha256: artifact.originalOutputSha256,
      baseRevision: request.baseRevision, submittedSha256: sha256(request.content ?? current.content),
      originalGeneratedAt: original.generatedAt || null, originalScheduled: original.edition?.scheduled === true,
      originalPublicationValidation: original.publicationValidation || null, ...(operatorReview ? { operatorReview } : {}) },
    judgmentEvidence: validation.judgmentEvidence || [],
    publicationValidation: { ...validation, partial: false, hardFail: false, trustFail: false,
      sourceCheckStatus: 'checked-supported-forms', editorialReviewStatus: operatorReview ? 'reviewed' : 'not-reviewed' },
  };
  const filename = saveBrief(historyDir, current.content, {
    date: original.edition.date, scheduled, manifest,
    beforeCommit: operatorReview ? name => {
      saveBriefDisposition(name, current.content, { status: 'eligible', scope: 'security-control-change', ...operatorReview }, reviewDir);
      const directory = reviewDir || fileURLToPath(new URL('../reviews/', import.meta.url));
      return () => unlinkSync(join(directory, name.replace(/\.md$/, '.disposition.json')));
    } : undefined,
  });
  return { filename, manifest, scheduled, publication: { revision: current.number, contentSha256: current.sha256,
    inputSha256: artifact.manifestSha256, filename, publishedAt: now } };
}

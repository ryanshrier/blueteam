// Private, bounded recovery artifacts. Saving/rechecking never calls a provider
// and never archives, indexes, broadcasts, or publishes the retained content.
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, MAX_GENERATION_MANIFEST_BYTES } from './generation-manifest.js';
import { repairBriefFormatting, normalizeBriefCitations, publicationDecision, VALIDATION_POLICY_VERSION, validationPolicyVersion } from './validation.js';
import { reclassifyRetainedSource, EVIDENCE_QUALITY_POLICY_VERSION } from './evidence-quality.js';
import { extractBriefMetadata, rebindBriefMetadata, normalizeBriefMetadataIssues } from './brief-metadata.js';
import { assembleBrief, BRIEF_COMPOSITION_VERSION } from './brief-assembly.js';
import { renderBriefCitations } from './brief-citations.js';
import { captureBriefActionRecords } from './brief-composition.js';
import { assertBriefInput } from './brief-input-limits.js';
import { restoreGroundingCitationUrls } from './grounding.js';

// A draft retains one complete input receipt plus bounded repair revisions.
// Keep this envelope larger than the receipt limit; never prune captured facts
// simply to make a rejected draft recoverable.
export const DRAFT_RETENTION = Object.freeze({ days: 30, maxDrafts: 20, maxRevisions: 8, maxContentBytes: 500000, maxArtifactBytes: 32 * 1024 * 1024 });
export const validDraftId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const secretText = value => String(value).replace(/\bsk-[\w-]+/g, '[REDACTED]')
  .replace(/\bBearer\s+[A-Za-z\d_.~+/-]{12,}/gi, 'Bearer [REDACTED]');
const manifestKeys = ['schemaVersion', 'generationId', 'capturedAt', 'application', 'edition', 'collection', 'promptWatchProfile', 'promptConfiguration', 'generationSettings', 'selectedEvidence', 'deterministicFacts', 'grounding', 'continuity', 'retention', 'providerAttempts', 'validation', 'editorialStandard', 'inputDelta', 'verification', 'generatedAt', 'modelUsed', 'responseModel', 'judgmentEvidence', 'publicationValidation', 'costEstimate', 'briefingReadiness', 'phaseTimingsMs', 'recovery', 'priorityCoverage', 'briefingMetadata', 'briefingMetadataIssues', 'briefingMetadataContentSha256', 'actionRecords'];
function safeCapturedManifest(manifest) {
  const allowed = Object.fromEntries(manifestKeys.filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  return JSON.parse(JSON.stringify(allowed, (key, value) => {
    if (/^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|credentials?|headers|env|environment|client|config)$/i.test(key)) return '[REDACTED]';
    return typeof value === 'string' ? secretText(value) : value;
  }));
}
const safeContent = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > DRAFT_RETENTION.maxContentBytes) throw new Error('Draft content exceeds its retention limit');
  assertBriefInput(value);
  return secretText(value);
};
const revisionMetadataKeys = ['briefingMetadata', 'briefingMetadataIssues', 'briefingMetadataContentSha256', 'briefingMetadataSha256'];
const metadataValue = (metadata, issues) => ({ briefingMetadata: metadata ?? null, briefingMetadataIssues: issues || [] });
const metadataDigest = value => sha256(JSON.stringify({ ...metadataValue(value.briefingMetadata, value.briefingMetadataIssues),
  briefingMetadataContentSha256: value.briefingMetadataContentSha256 }));
const hasRevisionMetadata = revision => revisionMetadataKeys.some(key => Object.hasOwn(revision, key));
function validRevisionMetadata(revision) {
  if (!hasRevisionMetadata(revision)) return true; // archives predating this record
  return revisionMetadataKeys.every(key => Object.hasOwn(revision, key))
    && (revision.briefingMetadata === null || (typeof revision.briefingMetadata === 'object' && !Array.isArray(revision.briefingMetadata)))
    && Array.isArray(revision.briefingMetadataIssues) && revision.briefingMetadataIssues.length <= 20
    && revision.briefingMetadataContentSha256 === revision.sha256
    && revision.briefingMetadataSha256 === metadataDigest(revision);
}

/** Overlay revision bookkeeping without rewriting the captured input receipt. */
export function validationManifestForDraft(artifact) {
  const current = artifact.revisions.at(-1);
  const actionRecords = captureBriefActionRecords(current.content);
  if (!hasRevisionMetadata(current)) {
    // Legacy copies without a derivable action record need no overlay. If the
    // receipt carries an obsolete record, explicitly clear it for this copy.
    if (!actionRecords && artifact.manifest.actionRecords == null) return artifact.manifest;
    return { ...artifact.manifest, actionRecords };
  }
  if (!validRevisionMetadata(current)) throw new Error('Draft metadata integrity check failed');
  return { ...artifact.manifest, ...metadataValue(current.briefingMetadata, current.briefingMetadataIssues),
    briefingMetadataContentSha256: current.briefingMetadataContentSha256, actionRecords };
}
const directory = historyDir => join(historyDir, '.rejected-drafts');
const artifactPath = (historyDir, id) => {
  if (!validDraftId(id)) throw new Error('Invalid draft identifier');
  return join(directory(historyDir), `${id}.json`);
};
const safeChecks = validation => {
  const decision = publicationDecision(validation);
  // Bounds must never let a long list of editorial notes hide the blocker
  // that appears after them. Retain consequential findings first.
  const orderedIssues = [...decision.blockers, ...decision.reviewIssues, ...decision.notes];
  return { validationPolicyVersion: validationPolicyVersion(validation), valid: validation?.valid === true,
  ...(validation?.partial ? { partial: true } : {}),
  ...(validation?.hardFail ? { hardFail: true } : {}),
  ...(validation?.trustFail ? { trustFail: true } : {}),
  warnings: (validation?.warnings || []).slice(0, 200).map(value => secretText(value).slice(0, 4096)),
  issues: orderedIssues.slice(0, 200).map(issue => ({ code: String(issue.code).slice(0, 128), severity: String(issue.severity).slice(0, 32), message: secretText(issue.message).slice(0, 4096),
    ...(typeof issue.claimKey === 'string' ? { claimKey: secretText(issue.claimKey).slice(0, 300) } : {}),
    location: { scope: String(issue.location?.scope || 'document').slice(0, 32), line: Math.max(1, Math.floor(issue.location?.line || 1)), excerpt: secretText(issue.location?.excerpt || '').slice(0, 300) },
    ...(Array.isArray(issue.sourceIds) ? { sourceIds: issue.sourceIds.slice(0, 30).map(value => String(value).slice(0, 128)) } : {}),
  })), coverage: validation?.coverage || null,
  ...(validation?.priorityCoverage ? { priorityCoverage: validation.priorityCoverage } : {}),
  ...(validation?.sourceQuality ? { sourceQuality: validation.sourceQuality } : {}),
  sourceCheckStatus: validation?.sourceCheckStatus || 'checked-supported-forms', editorialReviewStatus: 'not-reviewed' };
};

function writeArtifact(historyDir, artifact) {
  if (!existsSync(historyDir) || !statSync(historyDir).isDirectory()) throw new Error('The configured Briefing directory is unavailable');
  const dir = directory(historyDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = artifactPath(historyDir, artifact.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(artifact);
  if (Buffer.byteLength(serialized) + 1 > DRAFT_RETENTION.maxArtifactBytes) throw new Error('Draft artifact exceeds its retention limit');
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, `${serialized}\n`, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, target);
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
}

export function readBriefDraft(historyDir, id) {
  const path = artifactPath(historyDir, id);
  if (!existsSync(path)) return null;
  if (statSync(path).size > DRAFT_RETENTION.maxArtifactBytes) throw new Error('Oversized draft artifact');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schemaVersion !== 1 || value.id !== id || !Array.isArray(value.revisions) || !value.revisions.length
    || value.revisions.length > DRAFT_RETENTION.maxRevisions || !value.manifest?.grounding?.sources
    || value.manifestSha256 !== sha256(JSON.stringify(value.manifest))
    || value.revisions.some((revision, index) => !Number.isSafeInteger(revision.number) || revision.number < 1
      || (index === 0 ? revision.number !== 1 : revision.number <= value.revisions[index - 1].number)
      || typeof revision.content !== 'string' || revision.sha256 !== sha256(revision.content)
      || !validRevisionMetadata(revision))) throw new Error('Draft artifact integrity check failed');
  const current = value.revisions.at(-1);
  if (value.lastCheck && (value.lastCheck.revision !== current.number || value.lastCheck.contentSha256 !== current.sha256
    || (hasRevisionMetadata(current) && value.lastCheck.briefingMetadataSha256 !== current.briefingMetadataSha256)
    || !Number.isFinite(Date.parse(value.lastCheck.checkedAt)))) throw new Error('Draft check integrity check failed');
  if (value.publication && (!/^brief-\d{4}-\d{2}-\d{2}(?:-\d{1,6})?\.md$/.test(value.publication.filename || '')
    || value.publication.revision !== current.number || value.publication.contentSha256 !== current.sha256
    || value.publication.inputSha256 !== value.manifestSha256 || !Number.isFinite(Date.parse(value.publication.publishedAt)))) throw new Error('Draft publication integrity check failed');
  const updatedAt = value.operatorSavedAt || current.createdAt;
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid draft retention timestamp');
  if (!value.operatorSavedAt && !value.publication && Date.parse(updatedAt) < Date.now() - DRAFT_RETENTION.days * 86400000) return null;
  value.status = value.publication ? 'published' : 'draft';
  return value;
}

export function draftValidation(artifact) {
  const current = artifact.revisions.at(-1);
  return artifact.lastCheck?.revision === current.number && artifact.lastCheck.contentSha256 === current.sha256
    ? artifact.lastCheck.validation : current.validation;
}

export function summarizeBriefDraft(artifact) {
  const current = artifact.revisions.at(-1);
  const validation = draftValidation(artifact);
  const decision = publicationDecision(validation);
  return { id: artifact.id, createdAt: artifact.createdAt, updatedAt: artifact.operatorSavedAt || current.createdAt, status: artifact.publication ? 'published' : 'draft',
    partial: validation?.partial === true, code: artifact.code,
    editionDate: artifact.editionDate, sourceCheckStatus: validation.valid ? 'passed-supported-checks' : 'findings',
    editorialReviewStatus: 'not-reviewed', issueCount: validation.issues.length, revisionCount: artifact.revisions.length, revision: current.number,
    blockerCount: decision.blockers.length, reviewCount: decision.reviewIssues.length, noteCount: decision.notes.length,
    canPublish: decision.canPublish, requiresReview: decision.requiresReview,
    ...(artifact.operatorSavedAt ? { operatorSavedAt: artifact.operatorSavedAt } : {}),
    ...(artifact.publication ? { publication: artifact.publication } : {}),
    url: `/api/brief/drafts/${artifact.id}`, inputSha256: artifact.manifestSha256, originalSha256: artifact.revisions[0].sha256,
    costUsd: artifact.manifest.costEstimate?.usd ?? null, retention: DRAFT_RETENTION };
}

export function listBriefDrafts(historyDir) {
  if (!existsSync(directory(historyDir))) return [];
  const items = [];
  for (const file of readdirSync(directory(historyDir))) {
    const id = file.replace(/\.json$/, '');
    if (!validDraftId(id) || file !== `${id}.json`) continue;
    try { const artifact = readBriefDraft(historyDir, id); if (artifact && !artifact.publication) items.push(summarizeBriefDraft(artifact)); }
    catch { /* a damaged artifact must not be exposed as a verified draft */ }
  }
  let automaticCount = 0;
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(item => item.operatorSavedAt || automaticCount++ < DRAFT_RETENTION.maxDrafts);
}

export function saveRejectedBrief(historyDir, { id = randomUUID(), content, manifest, validation, actionRecords, code = 'E_VALIDATION', now = new Date().toISOString() }) {
  if (existsSync(artifactPath(historyDir, id))) throw new Error('A rejected draft with this identifier already exists');
  if (!manifest?.grounding?.sources || Buffer.byteLength(JSON.stringify(manifest)) > MAX_GENERATION_MANIFEST_BYTES) throw new Error('Invalid captured input manifest');
  const retained = safeContent(content);
  // Callers supply only buildGenerationManifest's allowlisted snapshot, never a
  // live config/run/client. Credential-shaped accidental source text is redacted.
  const safeManifest = safeCapturedManifest(manifest);
  const artifact = { schemaVersion: 1, id, createdAt: now, editionDate: manifest.edition?.date || null,
    status: 'draft', code: String(code).slice(0, 128), manifest: safeManifest, manifestSha256: sha256(JSON.stringify(safeManifest)),
    retention: DRAFT_RETENTION, originalOutputSha256: sha256(content), contentRedacted: retained !== content,
    originalManifestSha256: sha256(JSON.stringify(manifest)), manifestRedacted: JSON.stringify(safeManifest) !== JSON.stringify(manifest),
    revisions: [{ number: 1, kind: 'original-rejected', createdAt: now, content: retained, sha256: sha256(retained),
      actionRecords: actionRecords === undefined ? captureBriefActionRecords(retained)
        : actionRecords?.contentSha256 === sha256(retained) ? actionRecords : null, validation: safeChecks(validation) }] };
  writeArtifact(historyDir, artifact);
  // Only known UUID artifacts in this private directory are retention targets.
  const expiry = Date.parse(now) - DRAFT_RETENTION.days * 86400000;
  const files = readdirSync(directory(historyDir)).filter(file => validDraftId(file.replace(/\.json$/, '')) && file.endsWith('.json'))
    .filter(file => {
      // Deliberately saved work is not disposable generation recovery. Read
      // only bounded, known artifacts, and leave unreadable records untouched.
      const path = join(directory(historyDir), file);
      try {
        if (statSync(path).size > DRAFT_RETENTION.maxArtifactBytes) return false;
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return !value.operatorSavedAt && !value.publication;
      } catch { return false; }
    })
    .map(file => ({ file, modified: statSync(join(directory(historyDir), file)).mtimeMs })).sort((a, b) => b.modified - a.modified);
  for (const [index, file] of files.entries()) if (file.file !== `${id}.json` && (index >= DRAFT_RETENTION.maxDrafts || file.modified < expiry)) unlinkSync(join(directory(historyDir), file.file));
  return artifact;
}

// Pure preparation shared by the bounded worker and synchronous offline tools.
// Production routes pass the worker processor to revalidateBriefDraft below.
export function prepareDraftRevision(artifact, submitted) {
  const current = artifact.revisions.at(-1);
  assertBriefInput(submitted);
  const extracted = extractBriefMetadata(submitted);
  const hasEnvelope = extracted.content !== submitted;
  const previousManifest = validationManifestForDraft(artifact);
  // Preserve an unchanged review copy and its bindings unless it still carries
  // a known source ID. Explicit recheck may render that ID into a new immutable
  // repair revision so validation never approves an unrendered saved citation.
  const captured = validationSourceFromManifest(previousManifest, extracted.content);
  const citedContent = renderBriefCitations(extracted.content, captured.groundingManifest).content;
  const edited = previousManifest.generationSettings?.compositionVersion === BRIEF_COMPOSITION_VERSION
    ? () => assembleBrief(extracted.content, captured).content
    : () => normalizeBriefCitations(citedContent, captured.groundingManifest);
  const retained = !hasEnvelope && submitted === current.content && citedContent === extracted.content
    ? current.content : safeContent(repairBriefFormatting(edited()));
  const retainedSha256 = sha256(retained);
  const previousApplies = !previousManifest.briefingMetadataContentSha256
    || previousManifest.briefingMetadataContentSha256 === current.sha256;
  const previousMetadata = metadataValue(previousApplies ? previousManifest.briefingMetadata : null,
    previousManifest.briefingMetadataIssues);
  // Rechecking the same prose preserves its record. On edits retain only
  // demonstrably unchanged decision/action and rendered-entry bindings. Other
  // associations are checked from prose; the editor never requires hidden JSON.
  const nextMetadata = hasEnvelope ? metadataValue(extracted.metadata, extracted.issues)
    : metadataValue(retained === current.content ? previousMetadata.briefingMetadata
      : rebindBriefMetadata(previousMetadata.briefingMetadata, current.content, retained),
    normalizeBriefMetadataIssues(previousMetadata.briefingMetadataIssues));
  const revisionMetadata = JSON.parse(JSON.stringify({ ...nextMetadata,
    briefingMetadataContentSha256: retainedSha256 }, (key, value) => typeof value === 'string' ? secretText(value) : value));
  revisionMetadata.briefingMetadataSha256 = metadataDigest(revisionMetadata);
  const metadataChanged = JSON.stringify(previousMetadata) !== JSON.stringify(nextMetadata);
  const changed = retained !== current.content || metadataChanged;
  const candidate = { ...current, content: retained, sha256: retainedSha256, ...revisionMetadata };
  return { retained, retainedSha256, hasEnvelope, formattingRepaired: retained !== extracted.content,
    revisionMetadata, changed, actionRecords: captureBriefActionRecords(retained),
    validationManifest: validationManifestForDraft({ ...artifact, revisions: [...artifact.revisions.slice(0, -1), candidate] }) };
}

export function revalidateBriefDraft(historyDir, id, { content, baseRevision } = {}, validate) {
  const artifact = readBriefDraft(historyDir, id);
  if (!artifact) return null;
  if (artifact.publication) throw Object.assign(new Error('This draft has already been published. Open the published briefing.'), { code: 'E_DRAFT_PUBLISHED' });
  const current = artifact.revisions.at(-1);
  if (baseRevision !== undefined && baseRevision !== current.number) throw Object.assign(new Error('A newer repair revision exists. Reload before saving.'), { code: 'E_DRAFT_CONFLICT' });
  const submitted = safeContent(content ?? current.content);
  const finishPreparation = prepared => {
    const { retained, retainedSha256, hasEnvelope, formattingRepaired, revisionMetadata, changed, actionRecords } = prepared;
    const validation = Object.hasOwn(prepared, 'validation') ? prepared.validation : validate(retained, prepared.validationManifest);
    const commitValidation = validation => {
      // Async validation releases the event loop. Recheck the persisted revision
      // before committing so another edit/publication cannot be overwritten.
      const persisted = readBriefDraft(historyDir, id);
      if (!persisted || persisted.publication || persisted.manifestSha256 !== artifact.manifestSha256
        || persisted.revisions.at(-1)?.number !== current.number || persisted.revisions.at(-1)?.sha256 !== current.sha256) {
        throw Object.assign(new Error('A newer repair revision exists. Reload before saving.'), { code: 'E_DRAFT_CONFLICT' });
      }
      const now = new Date().toISOString();
      const checks = safeChecks({ ...validation, validationPolicyVersion: validation?.validationPolicyVersion ?? VALIDATION_POLICY_VERSION });
      if (changed) {
        artifact.revisions.push({ number: current.number + 1, kind: validate?.automatic ? 'automatic-recheck' : 'operator-repair', formattingRepaired,
          ...(prepared.automaticRepairs?.length ? { automaticRepairs: prepared.automaticRepairs } : {}),
          ...(hasEnvelope ? { metadataExtracted: true } : {}), createdAt: now, content: retained, sha256: retainedSha256,
          ...revisionMetadata, actionRecords, validation: checks });
        if (artifact.revisions.length > DRAFT_RETENTION.maxRevisions) artifact.revisions.splice(1, artifact.revisions.length - DRAFT_RETENTION.maxRevisions);
      }
      const latest = artifact.revisions.at(-1);
      // The worker derives these records even for an unchanged legacy copy.
      // Reuse that exact-copy projection at publication without reparsing prose.
      latest.actionRecords = actionRecords;
      artifact.lastCheck = { revision: latest.number, contentSha256: latest.sha256,
        ...(hasRevisionMetadata(latest) ? { briefingMetadataSha256: latest.briefingMetadataSha256 } : {}), checkedAt: now, validation: checks };
      if (validate?.automatic) artifact.automaticCheckedAt = now;
      else artifact.operatorSavedAt = now;
      artifact.status = 'draft';
      writeArtifact(historyDir, artifact);
      return artifact;
    };
    return validation && typeof validation.then === 'function' ? validation.then(commitValidation) : commitValidation(validation);
  };
  // Worker preparation uses only the immutable receipt and current revision.
  // Keep historical copies and unrelated bookkeeping on the parent side; the
  // persisted full artifact still participates in every conflict/commit check.
  const prepared = typeof validate?.prepareDraft === 'function'
    ? validate.prepareDraft({ artifact: { manifest: artifact.manifest, revisions: [current] }, submitted })
    : prepareDraftRevision(artifact, submitted);
  return prepared && typeof prepared.then === 'function' ? prepared.then(finishPreparation) : finishPreparation(prepared);
}

// This is a recovery pointer, written only after the permanent edition commits.
// The immutable edition receipt remains the publication source of truth.
export function recordDraftPublication(historyDir, id, { revision, contentSha256, inputSha256, filename, publishedAt }) {
  const artifact = readBriefDraft(historyDir, id);
  if (!artifact) return null;
  const current = artifact.revisions.at(-1);
  if (revision !== current.number || contentSha256 !== current.sha256 || inputSha256 !== artifact.manifestSha256) {
    throw Object.assign(new Error('The draft changed before publication was recorded.'), { code: 'E_DRAFT_CONFLICT' });
  }
  if (!/^brief-\d{4}-\d{2}-\d{2}(?:-\d{1,6})?\.md$/.test(filename || '') || !Number.isFinite(Date.parse(publishedAt))) throw new Error('Invalid draft publication record');
  if (artifact.publication) {
    if (artifact.publication.filename !== filename) throw Object.assign(new Error('This draft already has a published edition.'), { code: 'E_DRAFT_CONFLICT' });
    return artifact;
  }
  artifact.publication = { revision, contentSha256, inputSha256, filename, publishedAt };
  artifact.status = 'published';
  writeArtifact(historyDir, artifact);
  return artifact;
}

export function validationSourceFromManifest(manifest, content) {
  if (content !== undefined) assertBriefInput(content);
  const restored = restoreGroundingCitationUrls({ members: manifest.grounding.sources,
    urls: new Set(manifest.grounding.urls || []), urlIdentities: manifest.grounding.urlIdentities }, content);
  const records = restored.members.map(record => {
    const current = reclassifyRetainedSource(record);
    return { ...current, date: current.publishedAt ?? current.date ?? '', cves: new Set(current.cves || []) };
  });
  // An edited draft may change clause/action positions. Do not silently apply
  // the original model's mapping to a different copy; re-associate that prose.
  const sameCopy = content === undefined || !manifest.briefingMetadataContentSha256
    || sha256(content) === manifest.briefingMetadataContentSha256;
  return { publication: true, editorialStandard: manifest.editorialStandard || 2, inputDelta: manifest.inputDelta,
    briefFormatVersion: manifest.generationSettings?.briefFormatVersion ?? 1,
    compositionVersion: manifest.generationSettings?.compositionVersion,
    editionTimezone: manifest.edition?.timezone,
    priorityCoverage: manifest.priorityCoverage,
    briefingMetadata: sameCopy ? manifest.briefingMetadata : null,
    briefingMetadataIssues: sameCopy ? normalizeBriefMetadataIssues(manifest.briefingMetadataIssues) : [],
    sourceQuality: { policyVersion: EVIDENCE_QUALITY_POLICY_VERSION,
      sources: records.filter(record => record.qualityAssessment?.rejectedPartCount > 0).map(record => ({ id: record.id, ...record.qualityAssessment })) },
    groundingManifest: { members: records, sources: records, cves: new Set(records.flatMap(record => [...record.cves])),
      urls: restored.urls, ...(restored.urlIdentities ? { urlIdentities: restored.urlIdentities } : {}) },
    // Only captured membership is used. Revalidation cannot upgrade an unknown
    // value using today's changed catalog or silently recapture source inputs.
    kevSet: new Set(manifest.verification?.selectedKevCves || []),
    kevCatalogLoaded: manifest.verification?.kevCatalogLoaded,
    kevCatalogStatus: manifest.verification?.kevCatalogStatus,
    kevTiming: manifest.verification?.kevTiming || {} };
}

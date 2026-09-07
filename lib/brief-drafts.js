// Private, bounded recovery artifacts. Saving/rechecking never calls a provider
// and never archives, indexes, broadcasts, or publishes the retained content.
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, MAX_GENERATION_MANIFEST_BYTES } from './generation-manifest.js';

export const DRAFT_RETENTION = Object.freeze({ days: 30, maxDrafts: 20, maxRevisions: 8, maxContentBytes: 500000, maxArtifactBytes: 8 * 1024 * 1024 });
export const validDraftId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const secretText = value => String(value).replace(/\bsk-[\w-]+/g, '[REDACTED]')
  .replace(/\bBearer\s+[A-Za-z\d_.~+/-]{12,}/gi, 'Bearer [REDACTED]');
const manifestKeys = ['schemaVersion', 'generationId', 'capturedAt', 'application', 'edition', 'collection', 'promptWatchProfile', 'promptConfiguration', 'generationSettings', 'selectedEvidence', 'deterministicFacts', 'grounding', 'continuity', 'retention', 'providerAttempts', 'validation', 'editorialStandard', 'inputDelta', 'verification', 'generatedAt', 'modelUsed', 'responseModel', 'judgmentEvidence', 'publicationValidation', 'costEstimate'];
function safeCapturedManifest(manifest) {
  const allowed = Object.fromEntries(manifestKeys.filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  return JSON.parse(JSON.stringify(allowed, (key, value) => {
    if (/^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|credentials?|headers|env|environment|client|config)$/i.test(key)) return '[REDACTED]';
    return typeof value === 'string' ? secretText(value) : value;
  }));
}
const safeContent = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > DRAFT_RETENTION.maxContentBytes) throw new Error('Draft content exceeds its retention limit');
  return secretText(value);
};
const directory = historyDir => join(historyDir, '.rejected-drafts');
const artifactPath = (historyDir, id) => {
  if (!validDraftId(id)) throw new Error('Invalid draft identifier');
  return join(directory(historyDir), `${id}.json`);
};
const safeChecks = validation => ({ valid: validation?.valid === true,
  warnings: (validation?.warnings || []).slice(0, 200).map(value => secretText(value).slice(0, 4096)),
  issues: (validation?.issues || []).slice(0, 200).map(issue => ({ code: String(issue.code).slice(0, 128), severity: String(issue.severity).slice(0, 32), message: secretText(issue.message).slice(0, 4096),
    location: { scope: String(issue.location?.scope || 'document').slice(0, 32), line: Math.max(1, Math.floor(issue.location?.line || 1)), excerpt: secretText(issue.location?.excerpt || '').slice(0, 300) },
    ...(Array.isArray(issue.sourceIds) ? { sourceIds: issue.sourceIds.slice(0, 30).map(value => String(value).slice(0, 128)) } : {}),
  })), coverage: validation?.coverage || null, sourceCheckStatus: validation?.sourceCheckStatus || 'checked-supported-forms', editorialReviewStatus: 'not-reviewed' });

function writeArtifact(historyDir, artifact) {
  if (!existsSync(historyDir) || !statSync(historyDir).isDirectory()) throw new Error('The configured Briefing directory is unavailable');
  const dir = directory(historyDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = artifactPath(historyDir, artifact.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(artifact, null, 2);
  if (Buffer.byteLength(serialized) > DRAFT_RETENTION.maxArtifactBytes) throw new Error('Draft artifact exceeds its retention limit');
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
    || value.revisions.some((revision, index) => revision.number !== index + 1 || typeof revision.content !== 'string' || revision.sha256 !== sha256(revision.content))) throw new Error('Draft artifact integrity check failed');
  const updatedAt = value.revisions.at(-1).createdAt;
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid draft retention timestamp');
  if (Date.parse(updatedAt) < Date.now() - DRAFT_RETENTION.days * 86400000) return null;
  return value;
}

export function summarizeBriefDraft(artifact) {
  const current = artifact.revisions.at(-1);
  return { id: artifact.id, createdAt: artifact.createdAt, updatedAt: current.createdAt, status: artifact.status,
    editionDate: artifact.editionDate, sourceCheckStatus: current.validation.valid ? 'passed-supported-checks' : 'findings',
    editorialReviewStatus: 'not-reviewed', issueCount: current.validation.issues.length, revisionCount: artifact.revisions.length,
    url: `/api/brief/drafts/${artifact.id}`, inputSha256: artifact.manifestSha256, originalSha256: artifact.revisions[0].sha256,
    costUsd: artifact.manifest.costEstimate?.usd ?? null, retention: DRAFT_RETENTION };
}

export function listBriefDrafts(historyDir) {
  if (!existsSync(directory(historyDir))) return [];
  const items = [];
  for (const file of readdirSync(directory(historyDir))) {
    const id = file.replace(/\.json$/, '');
    if (!validDraftId(id) || file !== `${id}.json`) continue;
    try { const artifact = readBriefDraft(historyDir, id); if (artifact) items.push(summarizeBriefDraft(artifact)); }
    catch { /* a damaged artifact must not be exposed as a verified draft */ }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, DRAFT_RETENTION.maxDrafts);
}

export function saveRejectedBrief(historyDir, { id = randomUUID(), content, manifest, validation, code = 'E_VALIDATION', now = new Date().toISOString() }) {
  if (existsSync(artifactPath(historyDir, id))) throw new Error('A rejected draft with this identifier already exists');
  if (!manifest?.grounding?.sources || Buffer.byteLength(JSON.stringify(manifest)) > MAX_GENERATION_MANIFEST_BYTES) throw new Error('Invalid captured input manifest');
  const retained = safeContent(content);
  // Callers supply only buildGenerationManifest's allowlisted snapshot, never a
  // live config/run/client. Credential-shaped accidental source text is redacted.
  const safeManifest = safeCapturedManifest(manifest);
  const artifact = { schemaVersion: 1, id, createdAt: now, editionDate: manifest.edition?.date || null,
    status: 'rejected', code: String(code).slice(0, 128), manifest: safeManifest, manifestSha256: sha256(JSON.stringify(safeManifest)),
    retention: DRAFT_RETENTION, originalOutputSha256: sha256(content), contentRedacted: retained !== content,
    originalManifestSha256: sha256(JSON.stringify(manifest)), manifestRedacted: JSON.stringify(safeManifest) !== JSON.stringify(manifest),
    revisions: [{ number: 1, kind: 'original-rejected', createdAt: now, content: retained, sha256: sha256(retained), validation: safeChecks(validation) }] };
  writeArtifact(historyDir, artifact);
  // Only known UUID artifacts in this private directory are retention targets.
  const expiry = Date.parse(now) - DRAFT_RETENTION.days * 86400000;
  const files = readdirSync(directory(historyDir)).filter(file => validDraftId(file.replace(/\.json$/, '')) && file.endsWith('.json'))
    .map(file => ({ file, modified: statSync(join(directory(historyDir), file)).mtimeMs })).sort((a, b) => b.modified - a.modified);
  for (const [index, file] of files.entries()) if (file.file !== `${id}.json` && (index >= DRAFT_RETENTION.maxDrafts || file.modified < expiry)) unlinkSync(join(directory(historyDir), file.file));
  return artifact;
}

export function revalidateBriefDraft(historyDir, id, { content, baseRevision } = {}, validate) {
  const artifact = readBriefDraft(historyDir, id);
  if (!artifact) return null;
  if (baseRevision !== undefined && baseRevision !== artifact.revisions.length) throw Object.assign(new Error('A newer repair revision exists. Reload before saving.'), { code: 'E_DRAFT_CONFLICT' });
  if (artifact.revisions.length >= DRAFT_RETENTION.maxRevisions) throw Object.assign(new Error('This draft has reached its retained revision limit. Export it before continuing a separate review.'), { code: 'E_DRAFT_REVISION_LIMIT' });
  const retained = safeContent(content ?? artifact.revisions.at(-1).content);
  const validation = validate(retained, artifact.manifest);
  artifact.revisions.push({ number: artifact.revisions.length + 1, kind: content === undefined ? 'revalidation' : 'operator-repair', createdAt: new Date().toISOString(), content: retained, sha256: sha256(retained), validation: safeChecks(validation) });
  artifact.status = validation.valid ? 'checked-draft' : 'rejected';
  writeArtifact(historyDir, artifact);
  return artifact;
}

export function validationSourceFromManifest(manifest) {
  const records = manifest.grounding.sources.map(record => ({ ...record, date: record.publishedAt ?? record.date ?? '', cves: new Set(record.cves || []) }));
  return { publication: true, editorialStandard: manifest.editorialStandard || 2, inputDelta: manifest.inputDelta,
    groundingManifest: { members: records, sources: records, cves: new Set(manifest.grounding.cves || []), urls: new Set(manifest.grounding.urls || []) },
    // Only captured membership is used. Revalidation cannot upgrade an unknown
    // value using today's changed catalog or silently recapture source inputs.
    kevSet: new Set(manifest.verification?.selectedKevCves || []), kevTiming: manifest.verification?.kevTiming || {} };
}

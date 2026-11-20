import { parentPort, workerData } from 'node:worker_threads';
import { validateBrief, publicationDecision } from './validation.js';
import { repairMetricQualifiers, repairMissingMetricCitations } from './brief-metric-repair.js';
import { prepareDraftRevision, validationSourceFromManifest } from './brief-drafts.js';
import { extractBriefMetadata } from './brief-metadata.js';
import { assembleBrief } from './brief-assembly.js';
import { captureBriefActionRecords, briefActionRecords } from './brief-composition.js';
import { delinkUnallowlistedMarkdownUrls } from './grounding.js';
import { assertBriefInput } from './brief-input-limits.js';
import { preserveUnaffectedStories } from './brief-recovery.js';
import { repairFirstDraftIncidentScope } from './brief-incident-scope.js';

// An optional local edit can add bytes or Markdown. Keep the original
// validation result when the edited copy would exceed the input budget.
function repairFitsInput(content) {
  try { assertBriefInput(content); return true; }
  catch (error) {
    if (error.code === 'E_BRIEF_INPUT_LIMIT') return false;
    throw error;
  }
}

function checkAndRepair(content, expectedDate, source) {
  const initial = validateBrief(content, expectedDate, source);
  const material = checks => { const { blockers, reviewIssues } = publicationDecision(checks); return [...blockers, ...reviewIssues]; };
  const original = material(initial);
  const cited = repairMissingMetricCitations(content, original, source.groundingManifest);
  const repaired = repairMetricQualifiers(cited.content, initial.issues);
  repaired.repairs.unshift(...cited.repairs);
  if (!repaired.repairs.length || !repairFitsInput(repaired.content)) return { content, validation: initial, automaticRepairs: [] };
  const validation = validateBrief(repaired.content, expectedDate, source);
  // Attaching a citation to a story also makes it visible to that story's
  // other claims. Only retain the binding if every original material finding
  // was located on a corrected statement and the complete copy passes.
  const remaining = material(validation);
  const originalKeys = new Set(original.map(issue => `${issue.code}:${issue.message}`));
  if ((cited.repairs.length && remaining.length) || remaining.some(issue => !originalKeys.has(`${issue.code}:${issue.message}`))) {
    return { content, validation: initial, automaticRepairs: [] };
  }
  return { content: repaired.content, validation, automaticRepairs: repaired.repairs };
}

function processRequest(request) {
  const sourceFor = source => ({ ...source, briefDictionary: request.briefDictionary });
  if (request.task === 'draft') {
    let prepared = prepareDraftRevision(request.artifact, request.submitted);
    const source = sourceFor(validationSourceFromManifest(prepared.validationManifest, prepared.retained));
    const checked = checkAndRepair(prepared.retained, prepared.validationManifest.edition?.date, source);
    if (checked.content !== prepared.retained) {
      // Rebind the submitted revision's metadata, including a newly supplied
      // envelope, instead of reverting to the original artifact's mappings.
      const candidate = { ...request.artifact.revisions.at(-1), content: prepared.retained,
        sha256: prepared.retainedSha256, ...prepared.revisionMetadata };
      const repaired = prepareDraftRevision({ ...request.artifact, revisions: [candidate] }, checked.content);
      prepared = { ...repaired, changed: true, hasEnvelope: prepared.hasEnvelope,
        formattingRepaired: prepared.formattingRepaired || repaired.formattingRepaired };
    }
    const validation = checked.automaticRepairs.length
      ? validateBrief(prepared.retained, prepared.validationManifest.edition?.date,
        sourceFor(validationSourceFromManifest(prepared.validationManifest, prepared.retained))) : checked.validation;
    // The parent commits the validated current revision against its original
    // receipt. Returning another full receipt wastes a potentially large copy.
    const { validationManifest, ...result } = prepared;
    return { ...result, validation, automaticRepairs: checked.automaticRepairs };
  }
  if (request.task === 'retained') {
    const source = sourceFor(validationSourceFromManifest(request.manifest, request.text));
    return { validation: validateBrief(request.text, request.manifest.edition?.date, source),
      actionRecords: captureBriefActionRecords(request.text) };
  }
  if (request.task === 'delink') return delinkUnallowlistedMarkdownUrls(request.text, request.groundingManifest);
  if (request.task === 'actions') return briefActionRecords(request.text, request.captured);
  if (request.task === 'prepare') {
    const extracted = request.options.extractMetadata
      ? extractBriefMetadata(request.text) : { content: request.text, metadata: request.source.briefingMetadata, issues: request.source.briefingMetadataIssues };
    const source = sourceFor({ ...request.source, briefingMetadata: extracted.metadata, briefingMetadataIssues: extracted.issues });
    let content = extracted.content;
    if (request.options.delink) content = delinkUnallowlistedMarkdownUrls(content, source.groundingManifest);
    if (request.options.assemble !== false) content = assembleBrief(content, source).content;
    const preserved = request.options.original ? preserveUnaffectedStories(request.options.original,
      { text: content, partial: request.options.partial === true }) : { content, preservation: null };
    content = preserved.content;
    assertBriefInput(content);
    let checked = checkAndRepair(content, request.expectedDate, source);
    if (request.options.firstDraft && !request.options.original && !request.options.partial && source.briefFormatVersion === 2
        && publicationDecision(checked.validation).canPublish) {
      const repaired = repairFirstDraftIncidentScope(checked.content, source.groundingManifest, checked.validation.judgmentEvidence);
      if (repaired.repairs.length && repairFitsInput(repaired.content)) {
        const validation = validateBrief(repaired.content, request.expectedDate, source);
        if (publicationDecision(validation).canPublish) checked = { content: repaired.content, validation,
          automaticRepairs: [...checked.automaticRepairs, ...repaired.repairs] };
      }
    }
    return { ...checked, preservation: preserved.preservation, metadata: extracted.metadata, issues: extracted.issues,
      actionRecords: captureBriefActionRecords(checked.content) };
  }
  if (request.task !== 'validate') throw new Error('Unknown Briefing processing task');
  return validateBrief(request.text, request.expectedDate, sourceFor(request.source));
}

try {
  const value = processRequest(workerData);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error?.code === 'E_BRIEF_INPUT_LIMIT' ? error.code : 'E_BRIEF_VALIDATION',
    message: error?.code === 'E_BRIEF_INPUT_LIMIT' ? error.message : 'Briefing validation could not complete.' });
}

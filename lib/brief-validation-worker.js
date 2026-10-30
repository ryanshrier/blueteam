import { parentPort, workerData } from 'node:worker_threads';
import { validateBrief, publicationDecision } from './validation.js';
import { repairMetricQualifiers } from './brief-metric-repair.js';
import { prepareDraftRevision, validationSourceFromManifest } from './brief-drafts.js';
import { extractBriefMetadata } from './brief-metadata.js';
import { assembleBrief } from './brief-assembly.js';
import { captureBriefActionRecords, briefActionRecords } from './brief-composition.js';
import { delinkUnallowlistedMarkdownUrls } from './grounding.js';
import { assertBriefInput } from './brief-input-limits.js';
import { preserveUnaffectedStories } from './brief-recovery.js';

function checkAndRepair(content, expectedDate, source) {
  const initial = validateBrief(content, expectedDate, source);
  const repaired = repairMetricQualifiers(content, initial.issues);
  if (!repaired.repairs.length) return { content, validation: initial, automaticRepairs: [] };
  assertBriefInput(repaired.content);
  const validation = validateBrief(repaired.content, expectedDate, source);
  const material = checks => { const decision = publicationDecision(checks); return [...decision.blockers, ...decision.reviewIssues]; };
  const original = new Set(material(initial).map(issue => `${issue.code}:${issue.message}`));
  if (material(validation).some(issue => !original.has(`${issue.code}:${issue.message}`))) {
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
    const checked = checkAndRepair(content, request.expectedDate, source);
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

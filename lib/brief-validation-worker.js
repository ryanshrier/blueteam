import { parentPort, workerData } from 'node:worker_threads';
import { validateBrief } from './validation.js';
import { prepareDraftRevision, validationSourceFromManifest } from './brief-drafts.js';
import { extractBriefMetadata } from './brief-metadata.js';
import { assembleBrief } from './brief-assembly.js';
import { captureBriefActionRecords, briefActionRecords } from './brief-composition.js';
import { delinkUnallowlistedMarkdownUrls } from './grounding.js';
import { assertBriefInput } from './brief-input-limits.js';

function processRequest(request) {
  const sourceFor = source => ({ ...source, briefDictionary: request.briefDictionary });
  if (request.task === 'draft') {
    const prepared = prepareDraftRevision(request.artifact, request.submitted);
    const source = sourceFor(validationSourceFromManifest(prepared.validationManifest, prepared.retained));
    return { ...prepared, validation: validateBrief(prepared.retained, prepared.validationManifest.edition?.date, source) };
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
    assertBriefInput(content);
    return { content, metadata: extracted.metadata, issues: extracted.issues,
      validation: validateBrief(content, request.expectedDate, source), actionRecords: captureBriefActionRecords(content) };
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGenerationManifest, sha256 } from './generation-manifest.js';
import { briefDisposition, savedBriefReview } from './brief-review.js';
import { validationSourceFromManifest } from './brief-drafts.js';
import { publicationDecision, validateBrief, VALIDATION_POLICY_VERSION, validationPolicyVersion } from './validation.js';
import { missingBriefReceiptIntegrity } from './brief-receipts.js';
import { captureBriefActionRecords, briefActionRecords } from './brief-composition.js';
import { marked } from 'marked';
import { briefSourceIndex, sourceFindingLocation } from '../public/modules/briefing/brief-source-index.js';

const OPERATOR_ISSUES = new Set([
  'EXECUTIVE_DECISION_MISSING', 'CONVERGENCE_MISSING', 'CONVERGENCE_FORMAT_INVALID', 'CONVERGENCE_FIELD_MISSING',
  'JUDGMENT_HORIZON_INVALID', 'CONFIDENCE_INVALID', 'JUDGMENT_ACTION_INVALID', 'JUDGMENT_FIELD_MISSING',
  'BRIEF_METADATA_INVALID', 'ACTION_SUMMARY_MAPPING_INVALID',
  'PRIORITY_COVERAGE_MISSING', 'PRIORITY_COVERAGE_INVALID', 'PRIORITY_COVERAGE_DEFERRED',
  'PRIORITY_COVERAGE_OVERFLOW', 'PRIORITY_EVIDENCE_DEFERRED',
  'PRIORITY_COVERAGE_PARTIAL',
]);
const READER_ISSUES = new Set([
  'SECURITY_CONTROL_CHANGE', 'CITATION_IDENTITY_INVALID', 'CITATION_REFERENCE_INVALID', 'CITED_SOURCE_LIMITED', 'JUDGMENT_CITATION_MISSING',
  'JUDGMENT_EVIDENCE_WEAK', 'CONVERGENCE_EVIDENCE_WEAK', 'CVE_CITATION_MISMATCH', 'CVE_CVSS_AMBIGUOUS',
  'CVE_CVSS_MISMATCH', 'CVE_CVSS_UNVERIFIED', 'CVSS_UNSUPPORTED', 'VERSION_UNSUPPORTED', 'KEV_DEADLINE_AMBIGUOUS', 'KEV_DEADLINE_MISMATCH',
  'KEV_DEADLINE_PRECISION', 'KEV_DEADLINE_UNVERIFIED', 'EVIDENCE_CONFIDENCE_REQUIRED', 'EVIDENCE_ABSENCE_CONTRADICTED',
  'INDEPENDENCE_UNESTABLISHED', 'SOURCE_INDEPENDENCE_UNESTABLISHED', 'STATISTICAL_SCOPE_UNESTABLISHED',
  'SUPPORTING_SECTION_PROVENANCE_REQUIRED', 'APPLICABILITY_ACTION_UNCONDITIONAL', 'ACTION_RELATIVE_DEADLINE',
  'ACTION_MECHANISM_CONFLICT', 'ACTION_SUMMARY_CONFLICT', 'ACTION_SUMMARY_OWNER_CONFLICT', 'ACTION_ARTIFACT_UNSPECIFIED',
  'ACTION_SUMMARY_ASSOCIATION_REVIEW', 'ACTION_PHASE_BUNDLE_REVIEW',
  'PRIORITY_COVERAGE_UNSUPPORTED', 'PRIORITY_EVIDENCE_UNRESOLVED',
  'ACTION_DEPENDENCY_CONFLICT', 'ACTION_LOOKBACK_BASIS_REQUIRED', 'ACTION_RECOVERY_INCOMPLETE',
  'FACT_COUNT_SCOPE_UNVERIFIED', 'FACT_CVE_COUNT_MISMATCH', 'FACT_CVE_WINDOW_MISMATCH', 'FACT_CVE_WINDOW_UNVERIFIED',
  'FACT_CVSS_ASSOCIATION_UNVERIFIED', 'FACT_CVSS_UNSUPPORTED', 'FACT_EVENT_TIMELINE_UNSUPPORTED',
  'FACT_PRODUCT_COUNT_MISMATCH', 'FACT_SCALE_UNSUPPORTED', 'FACT_COMPARISON_UNSUPPORTED', 'FACT_DURATION_UNSUPPORTED',
  'ENUMERATED_COUNT_MISMATCH', 'FORECAST_UNRESOLVABLE', 'SCENARIO_NOT_LABELED', 'SCENARIO_DECISION_GAP',
  'SCENARIO_TIMELINE_UNSUPPORTED', 'DECISION_WINDOW_INVALID', 'CONTINUITY_WITHOUT_NEW_INPUT',
  'GENERATION_INCOMPLETE', 'GROUNDING', 'VALIDATION_DETAILS_UNAVAILABLE', 'VALIDATION_UNAVAILABLE', 'VALIDATION_POLICY_UNSUPPORTED',
]);

// Audience is not publication consequence. Unknown/legacy wording remains in
// the edition record; consumers must not infer harmlessness from "note".
export function issueAudience(issue) {
  if (OPERATOR_ISSUES.has(issue?.code)) return 'operator';
  if (READER_ISSUES.has(issue?.code)) return 'reader';
  return 'unclassified';
}

const operationalCode = message => {
  if (/^(?:Search index failed|Published successfully; search indexing)/.test(message)) return 'SEARCH_INDEX_UNAVAILABLE';
  if (/^(?:Briefing was saved, but generation accounting|Published successfully; generation accounting)/.test(message)) return 'GENERATION_ACCOUNTING_UNAVAILABLE';
  if (/^Published successfully; scheduled-edition accounting/.test(message)) return 'SCHEDULE_ACCOUNTING_UNAVAILABLE';
  if (/^Published successfully; the draft recovery pointer/.test(message)) return 'DRAFT_POINTER_UNAVAILABLE';
  if (/^Published successfully; current display or schedule metadata/.test(message)) return 'PUBLICATION_METADATA_UNAVAILABLE';
  if (/^(?:Edition metadata could not be saved|Published successfully; edition metadata)/.test(message)) return 'EDITION_METADATA_UNAVAILABLE';
  return null;
};

/** A read-only projection: findings retain their exact words and source-copy
 * identity. It never changes publication eligibility or the immutable receipt. */
export function briefPresentation(reading, { legacyWarnings = [], operationalNotes = [] } = {}) {
  // Archive rows intentionally discard large source receipts after verification.
  // Enrich their already-verified projection, never recreate it without inputs.
  if (reading.manifest === undefined && reading.presentation) {
    const { revision: _revision, ...base } = reading.presentation;
    const history = [...base.history];
    const notes = [...base.operationalNotes];
    const known = new Set([...base.currentChecks.warnings, ...history.flatMap(group => group.warnings)]);
    const extra = [];
    for (const message of legacyWarnings) {
      if (operationalCode(message)) operationalNotes = [...operationalNotes, message];
      else if (!known.has(message)) { known.add(message); extra.push(message); }
    }
    if (extra.length) {
      const decision = publicationDecision({ warnings: extra });
      const issues = [['block', decision.blockers], ['review', decision.reviewIssues], ['note', decision.notes]]
        .flatMap(([consequence, entries]) => entries.map(issue => ({ ...issue, audience: issueAudience(issue), consequence, acknowledged: false })));
      history.push({ kind: 'legacy-metadata', label: 'Legacy edition notes; origin and time not recorded', issues, warnings: extra });
    }
    for (const value of operationalNotes) {
      const message = typeof value === 'string' ? value : value?.message;
      if (!message) continue;
      const code = value?.code || operationalCode(message) || 'PUBLICATION_OPERATIONAL_NOTE';
      if (!notes.some(note => note.code === code && note.message === message)) notes.push({ code, message });
    }
    const result = { ...base, history, operationalNotes: notes };
    return { ...result, revision: sha256(JSON.stringify({ ...result, disposition: reading.disposition })) };
  }
  const { original, content, manifest, receipt, readingChecks, reviewed, disposition } = reading;
  const corrected = reviewed?.review?.status === 'editorially-corrected';
  const repaired = manifest?.repairedDraft;
  const originalSha256 = sha256(original);
  const contentSha256 = sha256(content);
  const checks = readingChecks || manifest?.publicationValidation;
  const checksContentSha256 = checks?.contentSha256 || (readingChecks ? contentSha256 : manifest?.outputSha256 || originalSha256);
  const unavailable = ['invalid', 'required'].includes(receipt?.integrity) || checks?.status === 'unavailable' || checks?.integrity === 'invalid';
  const notes = [];
  const rememberOperational = value => {
    const message = typeof value === 'string' ? value : value?.message;
    if (!message) return;
    const code = typeof value === 'object' && value.code ? value.code : operationalCode(message) || 'PUBLICATION_OPERATIONAL_NOTE';
    if (!notes.some(note => note.code === code && note.message === message)) notes.push({ code, message });
  };
  const approved = disposition?.editorialReviewStatus === 'reviewed'
    && disposition.eligibleForLatest === true
    && (disposition.readingSha256 || disposition.originalSha256) === contentSha256;
  const approvalHash = disposition?.readingSha256 || disposition?.originalSha256;
  const hasApproval = Boolean(approvalHash && disposition?.reviewer);
  const scoped = ['security-control-change', 'briefing-editorial'].includes(disposition?.scope) || Boolean(disposition?.inputSha256
    && repaired?.operatorReview?.inputSha256 === disposition.inputSha256);
  const approval = {
    status: approved ? 'recorded' : hasApproval ? (approvalHash !== contentSha256 ? 'stale' : 'unavailable') : 'not-recorded',
    scope: scoped ? (disposition?.scope || repaired?.operatorReview?.scope || 'security-control-change') : 'publication-disposition',
    issueCodes: disposition?.issueCodes || repaired?.operatorReview?.issueCodes || [],
    ...(hasApproval ? { reviewer: disposition.reviewer, reason: disposition.reason, reviewedAt: disposition.reviewedAt, contentSha256: approvalHash } : {}),
  };
  const projectChecks = (value, acknowledge = false) => {
    const decision = publicationDecision(value);
    const groups = [['block', decision.blockers], ['review', decision.reviewIssues], ['note', decision.notes]];
    const issues = groups.flatMap(([consequence, entries]) => entries.flatMap(issue => {
      if (operationalCode(issue.message || '')) { rememberOperational(issue.message); return []; }
      const approvedCode = approval.scope === 'security-control-change' ? issue.code === 'SECURITY_CONTROL_CHANGE'
        : approval.scope === 'briefing-editorial' ? approval.issueCodes.includes(issue.code) : true;
      return [{ ...issue, audience: issueAudience(issue), consequence, acknowledged: acknowledge && consequence === 'review' && approvedCode }];
    }));
    // Detailed findings take precedence, but unmatched legacy messages must
    // remain inspectable rather than disappearing during a schema transition.
    for (const message of value?.warnings || []) {
      if (operationalCode(message)) { rememberOperational(message); continue; }
      if (!issues.some(issue => issue.message === message)) issues.push({ code: 'LEGACY_NOTE', severity: 'review', message, audience: 'unclassified', consequence: 'note', acknowledged: false });
    }
    return { validationPolicyVersion: validationPolicyVersion(value),
      ...(value?.checkBasis ? { checkBasis: value.checkBasis } : {}),
      issues, warnings: [...new Set(issues.map(issue => issue.message).filter(Boolean))] };
  };
  const history = [];
  if (corrected && manifest?.publicationValidation) history.push({ kind: 'original-publication', label: 'Archived publication before editorial corrections',
    ...projectChecks(manifest.publicationValidation) });
  if (repaired?.originalPublicationValidation) history.push({ kind: 'original-generation', label: 'Original generation before operator repair',
    ...projectChecks(repaired.originalPublicationValidation) });
  const currentChecks = { status: unavailable ? 'unavailable' : checks ? 'checked' : 'not-recorded',
    basis: corrected ? 'corrected-copy' : 'publication',
    ...(checks ? { contentSha256: checksContentSha256 } : {}),
    ...projectChecks(unavailable ? { ...checks, status: 'unavailable' } : checks, approved) };
  const source = String(content || '').replace(/\r\n?/g, '\n');
  const sourceLines = source.split('\n');
  const sourceIndex = briefSourceIndex(source, marked.lexer(source, { gfm: true, breaks: true }));
  currentChecks.issues = currentChecks.issues.map(issue => {
    // Publication checks can still describe the original copy when a correction
    // has no usable snapshot. Keep those words inspectable without relabelling
    // their old line numbers as a location in today's reading copy.
    if (unavailable || checksContentSha256 !== contentSha256) return { ...issue,
      association: { status: 'unavailable', contentSha256: checksContentSha256 } };
    const location = sourceFindingLocation(sourceIndex, issue);
    return location ? { ...issue, association: { ...location, contentSha256,
      ...(Number.isSafeInteger(issue.location?.line) ? { sourceLine: sourceLines[issue.location.line - 1] } : {}) } } : issue;
  });
  const knownMessages = new Set([...currentChecks.warnings, ...history.flatMap(group => group.warnings)]);
  const extraLegacy = [];
  for (const message of legacyWarnings) {
    if (operationalCode(message)) { rememberOperational(message); continue; }
    if (!knownMessages.has(message)) { knownMessages.add(message); extraLegacy.push(message); }
  }
  if (extraLegacy.length) history.push({ kind: 'legacy-metadata', label: 'Legacy edition notes; origin and time not recorded', ...projectChecks({ warnings: extraLegacy }) });
  operationalNotes.forEach(rememberOperational);
  const presentation = { schemaVersion: 1,
    copy: { kind: corrected ? 'editorially-corrected' : repaired ? 'operator-repaired' : 'published', contentSha256, originalSha256 },
    actionRecords: briefActionRecords(content, corrected ? readingChecks?.actionRecords : manifest?.actionRecords),
    currentChecks, history, approval, operationalNotes: notes };
  // Fresh corrected-copy checkedAt timestamps deliberately do not alter this
  // revision. Only meaningful reading, findings, approval or status changes do.
  return { ...presentation, revision: sha256(JSON.stringify({ ...presentation, disposition })) };
}

export function presentationSourceCheckStatus(presentation) {
  return presentation.currentChecks.status !== 'checked' ? 'unavailable'
    : presentation.currentChecks.issues.length ? 'findings' : 'passed-supported-checks';
}

function evaluateReadingCopy(original, reviewed, manifest, policyVersion, checkBasis) {
  if (!reviewed?.reviewedContent || reviewed.review?.status !== 'editorially-corrected') return null;
  const identity = { contentSha256: sha256(reviewed.reviewedContent), originalSha256: sha256(original), checkerVersion: 1,
    validationPolicyVersion: policyVersion, checkBasis };
  if (!manifest?.grounding?.sources || manifest.outputSha256 !== identity.originalSha256) {
    return { ...identity, status: 'unavailable', warnings: ['The corrected reading copy could not be checked against verified captured inputs.'] };
  }
  let checked;
  try { checked = validateBrief(reviewed.reviewedContent, manifest.edition?.date, {
    ...validationSourceFromManifest(manifest, reviewed.reviewedContent), validationPolicyVersion: policyVersion,
  }); }
  catch { return { ...identity, status: 'unavailable', warnings: ['The corrected reading copy could not be checked against its captured inputs.'] }; }
  return { ...identity, inputSha256: sha256(JSON.stringify(manifest)), checkedAt: new Date().toISOString(),
    status: 'checked', valid: checked.valid, warnings: checked.warnings, issues: checked.issues, coverage: checked.coverage,
    actionRecords: captureBriefActionRecords(reviewed.reviewedContent) };
}

/** Explicit current-policy evaluation. The caller may retain this snapshot in
 * the correction overlay; this function never changes the archive or review. */
export function recheckReadingCopy(original, reviewed, manifest) {
  return evaluateReadingCopy(original, reviewed, manifest, VALIDATION_POLICY_VERSION, 'explicit-recheck');
}

// Prefer exact-copy retained findings. Pre-snapshot overlays retain the original
// receipt's policy (unversioned means 1), labeled as a compatibility replay. The
// legacy parser itself is not frozen; new overlays should retain an explicit
// recheck so later reads do not reinterpret their prose using new code.
export function readingCopyChecks(original, reviewed, manifest) {
  if (!reviewed?.reviewedContent || reviewed.review?.status !== 'editorially-corrected') return null;
  const snapshot = reviewed.review.readingChecks;
  if (snapshot === undefined) return evaluateReadingCopy(original, reviewed, manifest,
    validationPolicyVersion(manifest?.publicationValidation || manifest?.generationSettings), 'legacy-replay');
  const identity = { contentSha256: sha256(reviewed.reviewedContent), originalSha256: sha256(original), checkerVersion: 1 };
  const validSnapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && manifest?.grounding?.sources && manifest.outputSha256 === identity.originalSha256
    && snapshot.contentSha256 === identity.contentSha256 && snapshot.originalSha256 === identity.originalSha256
    && snapshot.inputSha256 === sha256(JSON.stringify(manifest)) && snapshot.checkerVersion === 1
    && snapshot.status === 'checked' && typeof snapshot.valid === 'boolean'
    && Number.isFinite(Date.parse(snapshot.checkedAt))
    && Array.isArray(snapshot.warnings) && snapshot.warnings.every(value => typeof value === 'string')
    && Array.isArray(snapshot.issues) && snapshot.issues.every(issue => issue && typeof issue.code === 'string'
      && ['trust', 'structure', 'review', 'note'].includes(issue.severity) && typeof issue.message === 'string');
  if (!validSnapshot) return { ...identity, validationPolicyVersion: validationPolicyVersion(snapshot),
    status: 'unavailable', integrity: 'invalid', warnings: ['The corrected copy’s retained checks do not match this copy and its captured inputs. Explicitly recheck this copy.'] };
  return { ...snapshot, ...identity, validationPolicyVersion: validationPolicyVersion(snapshot), checkBasis: 'retained-checks' };
}

export function readingDisposition(disposition, checks, review, receiptIntegrity, receiptInputSha256) {
  if (disposition?.status === 'superseded') return disposition;
  if (receiptIntegrity === 'invalid' || receiptIntegrity === 'required') return { ...disposition, status: 'review-required', eligibleForLatest: false,
    editorialReviewStatus: 'review-required', reason: 'The saved input receipt could not be verified against this edition. Restore or inspect the original and receipt before reuse.' };
  // New draft approvals also belong to the captured inputs. A crash before the
  // archive commit must not let an orphan approval attach to a reused filename
  // containing identical prose from a different evidence snapshot.
  if (disposition?.inputSha256 !== undefined
      && (receiptIntegrity !== 'verified' || disposition.inputSha256 !== receiptInputSha256)) {
    return { ...disposition, status: 'review-required', eligibleForLatest: false,
      editorialReviewStatus: 'review-required', reason: 'The saved approval does not match this edition’s verified captured inputs. Review this exact copy and evidence before publication.' };
  }
  // Interpret retained findings under their recorded policy. A newer policy
  // takes effect only when this exact copy is explicitly rechecked.
  const decision = publicationDecision(checks);
  // Legacy approvals cover their original edition. An approval of a corrected
  // copy must match that exact copy, not silently transfer to later edits.
  const scopeCoversFindings = disposition?.scope === 'security-control-change'
    ? decision.reviewIssues.every(issue => issue.code === 'SECURITY_CONTROL_CHANGE')
    : disposition?.scope === 'briefing-editorial'
      ? decision.reviewIssues.every(issue => disposition.issueCodes?.includes(issue.code)) : true;
  const approvedReading = disposition?.editorialReviewStatus === 'reviewed' && scopeCoversFindings
    && (!checks?.contentSha256 || (disposition.readingSha256 || disposition.originalSha256) === checks.contentSha256);
  const unresolved = decision.blockers.length > 0 || (decision.requiresReview && !approvedReading);
  if (unresolved || review?.status === 'unavailable') return { ...disposition, status: 'review-required', eligibleForLatest: false,
    editorialReviewStatus: 'review-required', reason: 'The current reading copy has unresolved or unavailable checks. Review its findings before returning it to Latest or Wall.' };
  if (disposition?.editorialReviewStatus === 'reviewed' && !approvedReading) return { ...disposition,
    editorialReviewStatus: 'not-reviewed', reason: 'The saved approval applies to an earlier reading copy. The current copy passes the supported checks but has not been approved by this disposition.' };
  return disposition;
}

// Every saved-edition consumer uses this exact reading copy and eligibility.
// A missing legacy receipt is different from a receipt that exists but fails
// verification. Human review never makes a failed receipt trustworthy.
export function loadBriefReadingState(historyDir, filename, { reviewDirectory } = {}) {
  const original = readFileSync(join(historyDir, filename), 'utf8');
  let manifest = null;
  let receiptIntegrity = 'missing';
  try {
    manifest = readGenerationManifest(historyDir, filename);
    if (manifest) receiptIntegrity = 'verified';
    else receiptIntegrity = missingBriefReceiptIntegrity(historyDir, filename, original);
  } catch { receiptIntegrity = 'invalid'; }
  return briefReadingState(filename, original, manifest, { reviewDirectory, receiptIntegrity });
}

// Generation already has the just-persisted content and receipt. Reuse the same
// decision without rereading their full evidence payload on the streaming path.
export function briefReadingState(filename, original, manifest, { reviewDirectory, receiptIntegrity = manifest ? 'verified' : 'missing' } = {}) {
  if (manifest && manifest.outputSha256 !== sha256(original)) receiptIntegrity = 'invalid';
  if (receiptIntegrity === 'invalid') manifest = null;
  const receipt = manifest ? {
    status: 'available', integrity: receiptIntegrity, url: `/api/brief/${encodeURIComponent(filename)}/manifest`,
    ...(manifest.verification ? { verification: manifest.verification } : {}),
    ...(manifest.costEstimate ? { costEstimate: manifest.costEstimate } : {}),
    ...(manifest.publicationValidation ? { validation: manifest.publicationValidation } : {}),
  } : { status: 'unavailable', integrity: receiptIntegrity, url: null,
    reason: receiptIntegrity === 'invalid' ? 'Saved input manifest could not be verified.' : receiptIntegrity === 'required'
      ? 'This edition requires its missing input manifest. Restore the matching receipt before reuse.' : 'No input manifest was saved for this legacy edition.' };
  const reviewed = savedBriefReview(filename, original, reviewDirectory);
  const readingChecks = readingCopyChecks(original, reviewed, manifest);
  const checks = readingChecks || manifest?.publicationValidation;
  const receiptInputSha256 = manifest?.repairedDraft?.contentSha256 === sha256(original)
    ? manifest.repairedDraft.inputSha256 : undefined;
  const disposition = readingDisposition(
    briefDisposition(filename, original, reviewDirectory, checks), checks, reviewed.review, receiptIntegrity,
    receiptInputSha256,
  );
  const reading = { original, content: reviewed.reviewedContent || original, reviewed, manifest, receipt, readingChecks, disposition };
  return { ...reading, presentation: briefPresentation(reading) };
}

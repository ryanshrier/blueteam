import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGenerationManifest, sha256 } from './generation-manifest.js';
import { briefDisposition, savedBriefReview } from './brief-review.js';
import { validationSourceFromManifest } from './brief-drafts.js';
import { publicationDecision, validateBrief } from './validation.js';

const OPERATOR_ISSUES = new Set([
  'EXECUTIVE_DECISION_MISSING', 'CONVERGENCE_MISSING', 'CONVERGENCE_FORMAT_INVALID', 'CONVERGENCE_FIELD_MISSING',
  'JUDGMENT_HORIZON_INVALID', 'CONFIDENCE_INVALID', 'JUDGMENT_ACTION_INVALID', 'JUDGMENT_FIELD_MISSING',
]);
const READER_ISSUES = new Set([
  'SECURITY_CONTROL_CHANGE', 'CITATION_IDENTITY_INVALID', 'CITED_SOURCE_LIMITED', 'JUDGMENT_CITATION_MISSING',
  'JUDGMENT_EVIDENCE_WEAK', 'CONVERGENCE_EVIDENCE_WEAK', 'CVE_CITATION_MISMATCH', 'CVE_CVSS_AMBIGUOUS',
  'CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED', 'VERSION_UNSUPPORTED', 'KEV_DEADLINE_AMBIGUOUS', 'KEV_DEADLINE_MISMATCH',
  'KEV_DEADLINE_PRECISION', 'KEV_DEADLINE_UNVERIFIED', 'EVIDENCE_CONFIDENCE_REQUIRED', 'EVIDENCE_ABSENCE_CONTRADICTED',
  'INDEPENDENCE_UNESTABLISHED', 'SOURCE_INDEPENDENCE_UNESTABLISHED', 'STATISTICAL_SCOPE_UNESTABLISHED',
  'SUPPORTING_SECTION_PROVENANCE_REQUIRED', 'APPLICABILITY_ACTION_UNCONDITIONAL', 'ACTION_RELATIVE_DEADLINE',
  'ACTION_MECHANISM_CONFLICT', 'ACTION_SUMMARY_CONFLICT', 'ACTION_SUMMARY_OWNER_CONFLICT', 'ACTION_ARTIFACT_UNSPECIFIED',
  'ACTION_DEPENDENCY_CONFLICT', 'ACTION_LOOKBACK_BASIS_REQUIRED', 'ACTION_RECOVERY_INCOMPLETE',
  'FACT_COUNT_SCOPE_UNVERIFIED', 'FACT_CVE_COUNT_MISMATCH', 'FACT_CVE_WINDOW_MISMATCH', 'FACT_CVE_WINDOW_UNVERIFIED',
  'FACT_CVSS_ASSOCIATION_UNVERIFIED', 'FACT_CVSS_UNSUPPORTED', 'FACT_EVENT_TIMELINE_UNSUPPORTED',
  'FACT_PRODUCT_COUNT_MISMATCH', 'FACT_SCALE_UNSUPPORTED', 'FACT_COMPARISON_UNSUPPORTED', 'FACT_DURATION_UNSUPPORTED',
  'ENUMERATED_COUNT_MISMATCH', 'FORECAST_UNRESOLVABLE', 'SCENARIO_NOT_LABELED', 'SCENARIO_DECISION_GAP',
  'SCENARIO_TIMELINE_UNSUPPORTED', 'DECISION_WINDOW_INVALID', 'CONTINUITY_WITHOUT_NEW_INPUT',
  'GENERATION_INCOMPLETE', 'GROUNDING', 'VALIDATION_DETAILS_UNAVAILABLE', 'VALIDATION_UNAVAILABLE',
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
  const unavailable = receipt?.integrity === 'invalid' || checks?.status === 'unavailable' || checks?.integrity === 'invalid';
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
  const scoped = disposition?.scope === 'security-control-change' || Boolean(disposition?.inputSha256
    && repaired?.operatorReview?.inputSha256 === disposition.inputSha256);
  const approval = {
    status: approved ? 'recorded' : hasApproval ? (approvalHash !== contentSha256 ? 'stale' : 'unavailable') : 'not-recorded',
    scope: scoped ? 'security-control-change' : 'publication-disposition',
    ...(hasApproval ? { reviewer: disposition.reviewer, reason: disposition.reason, reviewedAt: disposition.reviewedAt, contentSha256: approvalHash } : {}),
  };
  const projectChecks = (value, acknowledge = false) => {
    const decision = publicationDecision(value);
    const groups = [['block', decision.blockers], ['review', decision.reviewIssues], ['note', decision.notes]];
    const issues = groups.flatMap(([consequence, entries]) => entries.flatMap(issue => {
      if (operationalCode(issue.message || '')) { rememberOperational(issue.message); return []; }
      return [{ ...issue, audience: issueAudience(issue), consequence, acknowledged: acknowledge && consequence === 'review' }];
    }));
    // Detailed findings take precedence, but unmatched legacy messages must
    // remain inspectable rather than disappearing during a schema transition.
    for (const message of value?.warnings || []) {
      if (operationalCode(message)) { rememberOperational(message); continue; }
      if (!issues.some(issue => issue.message === message)) issues.push({ code: 'LEGACY_NOTE', severity: 'review', message, audience: 'unclassified', consequence: 'note', acknowledged: false });
    }
    return { issues, warnings: [...new Set(issues.map(issue => issue.message).filter(Boolean))] };
  };
  const history = [];
  if (corrected && manifest?.publicationValidation) history.push({ kind: 'original-publication', label: 'Archived publication before editorial corrections',
    ...projectChecks(manifest.publicationValidation) });
  if (repaired?.originalPublicationValidation) history.push({ kind: 'original-generation', label: 'Original generation before operator repair',
    ...projectChecks(repaired.originalPublicationValidation) });
  const currentChecks = { status: unavailable ? 'unavailable' : checks ? 'checked' : 'not-recorded',
    basis: corrected ? 'corrected-copy' : 'publication',
    ...projectChecks(unavailable ? { ...checks, status: 'unavailable' } : checks, approved) };
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
    currentChecks, history, approval, operationalNotes: notes };
  // Fresh corrected-copy checkedAt timestamps deliberately do not alter this
  // revision. Only meaningful reading, findings, approval or status changes do.
  return { ...presentation, revision: sha256(JSON.stringify({ ...presentation, disposition })) };
}

export function presentationSourceCheckStatus(presentation) {
  return presentation.currentChecks.status !== 'checked' ? 'unavailable'
    : presentation.currentChecks.issues.length ? 'findings' : 'passed-supported-checks';
}

// Read-only replay against the immutable inputs. Never overwrites generation
// findings or treats a correction/disposition as proof that checks passed.
export function readingCopyChecks(original, reviewed, manifest) {
  if (!reviewed?.reviewedContent || reviewed.review?.status !== 'editorially-corrected') return null;
  const identity = { contentSha256: sha256(reviewed.reviewedContent), originalSha256: sha256(original), checkerVersion: 1 };
  if (!manifest?.grounding?.sources || manifest.outputSha256 !== identity.originalSha256) {
    return { ...identity, status: 'unavailable', warnings: ['The corrected reading copy could not be checked against verified captured inputs.'] };
  }
  let checked;
  try { checked = validateBrief(reviewed.reviewedContent, manifest.edition?.date, validationSourceFromManifest(manifest)); }
  catch { return { ...identity, status: 'unavailable', warnings: ['The corrected reading copy could not be checked against its captured inputs.'] }; }
  return { ...identity, inputSha256: sha256(JSON.stringify(manifest)), checkedAt: new Date().toISOString(),
    status: 'checked', valid: checked.valid, warnings: checked.warnings, issues: checked.issues, coverage: checked.coverage };
}

export function readingDisposition(disposition, checks, review, receiptIntegrity, receiptInputSha256) {
  if (disposition?.status === 'superseded') return disposition;
  if (receiptIntegrity === 'invalid') return { ...disposition, status: 'review-required', eligibleForLatest: false,
    editorialReviewStatus: 'review-required', reason: 'The saved input receipt could not be verified against this edition. Restore or inspect the original and receipt before reuse.' };
  // New draft approvals also belong to the captured inputs. A crash before the
  // archive commit must not let an orphan approval attach to a reused filename
  // containing identical prose from a different evidence snapshot.
  if (disposition?.inputSha256 !== undefined
      && (receiptIntegrity !== 'verified' || disposition.inputSha256 !== receiptInputSha256)) {
    return { ...disposition, status: 'review-required', eligibleForLatest: false,
      editorialReviewStatus: 'review-required', reason: 'The saved approval does not match this edition’s verified captured inputs. Review this exact copy and evidence before publication.' };
  }
  // Reclassify retained findings without rerunning historical prose or letting
  // obsolete broad editorial summary flags keep an otherwise useful copy held.
  const decision = publicationDecision(checks);
  // Legacy approvals cover their original edition. An approval of a corrected
  // copy must match that exact copy, not silently transfer to later edits.
  const approvedReading = disposition?.editorialReviewStatus === 'reviewed'
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
    reason: receiptIntegrity === 'invalid' ? 'Saved input manifest could not be verified.' : 'No input manifest was saved for this edition.' };
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

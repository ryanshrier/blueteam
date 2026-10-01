import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGenerationManifest, sha256 } from './generation-manifest.js';
import { briefDisposition, savedBriefReview } from './brief-review.js';
import { validationSourceFromManifest } from './brief-drafts.js';
import { isMaterialReviewIssue, validateBrief } from './validation.js';

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

export function readingDisposition(disposition, checks, review, receiptIntegrity) {
  if (disposition?.status === 'superseded') return disposition;
  if (receiptIntegrity === 'invalid') return { ...disposition, status: 'review-required', eligibleForLatest: false,
    editorialReviewStatus: 'review-required', reason: 'The saved input receipt could not be verified against this edition. Restore or inspect the original and receipt before reuse.' };
  // Older receipts may contain a material issue while their summary flag is
  // false. Reclassify the retained issues without rerunning historical prose.
  const materialReview = checks?.coverage?.materialReviewRequired
    || checks?.issues?.some(isMaterialReviewIssue);
  // Legacy approvals cover their original edition. An approval of a corrected
  // copy must match that exact copy, not silently transfer to later edits.
  const approvedReading = disposition?.editorialReviewStatus === 'reviewed'
    && (!checks?.contentSha256 || (disposition.readingSha256 || disposition.originalSha256) === checks.contentSha256);
  const unresolved = checks?.status === 'unavailable' || checks?.partial || checks?.hardFail || checks?.trustFail
    || checks?.issues?.some(issue => ['trust', 'structure'].includes(issue.severity))
    || (materialReview && !approvedReading);
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
  const disposition = readingDisposition(
    briefDisposition(filename, original, reviewDirectory, checks), checks, reviewed.review, receiptIntegrity,
  );
  return { original, content: reviewed.reviewedContent || original, reviewed, manifest, receipt, readingChecks, disposition };
}

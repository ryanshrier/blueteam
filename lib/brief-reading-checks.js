import { sha256 } from './generation-manifest.js';
import { validationSourceFromManifest } from './brief-drafts.js';
import { validateBrief } from './validation.js';

// Read-only replay against the immutable inputs. Never overwrites generation
// findings or treats a correction/disposition as proof that checks passed.
export function readingCopyChecks(original, reviewed, manifest) {
  if (!reviewed?.reviewedContent || reviewed.review?.status !== 'editorially-corrected') return null;
  const identity = { contentSha256: sha256(reviewed.reviewedContent), originalSha256: sha256(original), checkerVersion: 1 };
  if (!manifest?.grounding?.sources || manifest.outputSha256 !== identity.originalSha256) {
    return { ...identity, status: 'unavailable', warnings: ['The corrected reading copy could not be checked against verified captured inputs.'] };
  }
  const checked = validateBrief(reviewed.reviewedContent, manifest.edition?.date, validationSourceFromManifest(manifest));
  return { ...identity, inputSha256: sha256(JSON.stringify(manifest)), checkedAt: new Date().toISOString(),
    status: 'checked', valid: checked.valid, warnings: checked.warnings, issues: checked.issues, coverage: checked.coverage };
}

export function readingDisposition(disposition, checks, review) {
  if (disposition?.status === 'superseded') return disposition;
  const unresolved = checks?.status === 'unavailable' || checks?.issues?.some(issue => ['trust', 'structure', 'review'].includes(issue.severity));
  if (unresolved || review?.status === 'unavailable') return { ...disposition, status: 'review-required', eligibleForLatest: false,
    editorialReviewStatus: 'review-required', reason: 'The current reading copy has unresolved or unavailable checks. Review its findings before returning it to Latest or Wall.' };
  return disposition;
}

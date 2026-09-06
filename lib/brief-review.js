// Editorial overlays are separate from immutable generated documents/receipts.
// Each exact replacement is bound to the original document digest. A mismatch
// refuses the overlay rather than silently applying a correction to a new text.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const reviewDirectory = fileURLToPath(new URL('../reviews/', import.meta.url));
const validFilename = value => /^brief-\d{4}-\d{2}-\d{2}(?:-\d{1,6})?\.md$/.test(value || '');
export function briefDisposition(filename, original, directory = reviewDirectory, sourceChecks = null) {
  const eligible = sourceChecks?.coverage?.materialReviewRequired
    ? { status: 'review-required', eligibleForLatest: false, editorialReviewStatus: 'review-required', reviewer: 'Bounded automated editorial checks (not human approval)',
      reason: 'Material editorial review findings remain after supported source checks. This edition is retained for review and excluded from default Latest and Wall selection.',
      findings: (sourceChecks.issues || []).filter(issue => issue.severity === 'review').map(issue => ({ code: issue.code, message: issue.message, line: issue.location?.line || 1 })) }
    : { status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'not-reviewed' };
  if (!validFilename(filename)) return eligible;
  const path = join(directory, filename.replace(/\.md$/, '.disposition.json'));
  if (!existsSync(path)) return eligible;
  try {
    const raw = readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw) > 32000) throw new Error('Oversized disposition');
    const value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || value.originalSha256 !== createHash('sha256').update(original).digest('hex')
      || !['review-required', 'superseded', 'eligible'].includes(value.status)
      || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 8000
      || typeof value.reviewer !== 'string' || value.reviewer.length > 200
      || !Number.isFinite(Date.parse(value.reviewedAt))) throw new Error('Invalid disposition');
    if (value.status === 'superseded' && (!validFilename(value.replacementFilename) || value.replacementFilename === filename)) throw new Error('Invalid replacement');
    return { status: value.status, eligibleForLatest: value.status === 'eligible', originalSha256: value.originalSha256,
      reason: value.reason, reviewer: value.reviewer, reviewedAt: value.reviewedAt,
      editorialReviewStatus: value.status === 'eligible' ? 'reviewed' : 'review-required',
      ...(value.status === 'superseded' ? { replacementFilename: value.replacementFilename } : {}),
      ...(Array.isArray(value.findings) ? { findings: value.findings.slice(0, 30).map(item => ({ code: String(item.code || '').slice(0, 100), message: String(item.message || '').slice(0, 1200), line: Number.isSafeInteger(item.line) && item.line > 0 ? item.line : 1 })) } : {}),
    };
  } catch {
    return { status: 'review-required', eligibleForLatest: false, editorialReviewStatus: 'review-required', reason: 'A publication disposition exists but could not be verified against this original edition. Inspect the original and review record before reuse.' };
  }
}

export function saveBriefDisposition(filename, original, input, directory = reviewDirectory) {
  if (!validFilename(filename)) throw new Error('Invalid disposition filename');
  const value = { schemaVersion: 1, originalSha256: createHash('sha256').update(original).digest('hex'),
    status: input.status, reason: input.reason, reviewer: input.reviewer, reviewedAt: input.reviewedAt || new Date().toISOString(),
    ...(input.replacementFilename ? { replacementFilename: input.replacementFilename } : {}),
    ...(input.findings ? { findings: input.findings } : {}),
  };
  if (!['review-required', 'superseded', 'eligible'].includes(value.status) || !value.reason?.trim() || value.reason.length > 8000
    || !value.reviewer?.trim() || value.reviewer.length > 200 || !Number.isFinite(Date.parse(value.reviewedAt))
    || (value.status === 'superseded' && (!validFilename(value.replacementFilename) || value.replacementFilename === filename))) throw new Error('Invalid publication disposition');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename.replace(/\.md$/, '.disposition.json'));
  const temp = `${path}.${process.pid}.tmp`;
  const json = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(json) > 32000) throw new Error('Oversized disposition');
  try { writeFileSync(temp, `${json}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
  return briefDisposition(filename, original, directory);
}

export function applyBriefReview(original, review) {
  if (!review || review.schemaVersion !== 1 || !Array.isArray(review.corrections) || review.corrections.length > 80) throw new Error('Invalid editorial review');
  let evidenceBindings;
  if (review.evidenceBindings !== undefined) {
    if (!Array.isArray(review.evidenceBindings) || review.evidenceBindings.length > 100) throw new Error('Invalid editorial evidence bindings');
    evidenceBindings = review.evidenceBindings.map(item => {
      if (!Number.isSafeInteger(item?.signal) || item.signal < 1 || item.signal > 100
        || !Array.isArray(item.sourceIds) || item.sourceIds.length > 200
        || item.sourceIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,300}$/.test(id))) throw new Error('Invalid editorial evidence bindings');
      return { signal: item.signal, sourceIds: [...new Set(item.sourceIds)] };
    });
  }
  const digest = createHash('sha256').update(original).digest('hex');
  if (review.originalSha256 !== digest) throw new Error('Editorial review does not match the original edition');
  let content = original;
  for (const item of review.corrections) {
    if (!item.original || typeof item.replacement !== 'string' || !item.reason || !item.id || content.split(item.original).length !== 2) throw new Error('Editorial correction target is ambiguous or missing');
    content = content.replace(item.original, () => item.replacement);
  }
  // A display summary is a separate editorial artifact, bound to the complete
  // corrected reading copy. Stale presentation text never changes the reader.
  let presentation;
  if (review.presentation) {
    const value = review.presentation;
    const text = (item, max = 1000) => typeof item === 'string' && item.trim().length > 0 && item.length <= max;
    const reports = list => list === undefined || (Array.isArray(list) && list.length <= 10 && list.every(item => item
      && text(item.url, 2000) && /^https?:\/\//.test(item.url) && Number.isFinite(Date.parse(item.publishedAt)) && text(item.reason)));
    const entries = list => Array.isArray(list) && list.length <= 30 && new Set(list.map(item => item?.index)).size === list.length
      && list.every(item => Number.isSafeInteger(item?.index) && item.index >= 0 && text(item.originalTitle, 500)
        && text(item.title, 200) && text(item.summary) && (item.condition === undefined || text(item.condition)) && reports(item.coveredReports));
    if (value.schemaVersion === 1 && value.contentSha256 === createHash('sha256').update(content).digest('hex')
      && text(value.reviewer, 200) && Number.isFinite(Date.parse(value.reviewedAt))
      && text(value.bluf) && entries(value.judgments) && entries(value.developing)) {
      presentation = { ...value, status: 'reviewed' };
    } else presentation = { status: 'unavailable', message: 'Display review does not match the reading copy; using authored text.' };
  }
  return { reviewedContent: content, review: {
    id: review.id, status: 'editorially-corrected', reviewedAt: review.reviewedAt,
    reviewer: review.reviewer, scope: review.scope, originalSha256: digest,
    ...(evidenceBindings === undefined ? {} : { evidenceBindings }),
    ...(presentation ? { presentation } : {}),
    notes: review.corrections.map(({ id, label, anchor, reason, original, replacement }) => ({ id, label, anchor, reason, original, replacement })),
  } };
}

export function savedBriefReview(filename, original, directory = reviewDirectory) {
  if (!/^brief-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(filename)) return {};
  const path = join(directory, filename.replace(/\.md$/, '.review.json'));
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw) > 256_000) throw new Error('Review exceeds retention limit');
    return applyBriefReview(original, JSON.parse(raw));
  } catch {
    return { review: { status: 'unavailable', message: 'An editorial review exists but could not be verified against this edition. The original text is displayed.' } };
  }
}

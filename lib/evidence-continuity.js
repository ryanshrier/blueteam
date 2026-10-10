// Prior captured publisher passages can retain qualifications lost from a thin
// current feed. They never replace current evidence or authorize new facts.
import { createHash } from 'node:crypto';
import { citationUrlKey, sourcePublicationDay } from './grounding.js';
import { reclassifyRetainedSource, selectOperationalExcerpt } from './evidence-quality.js';
import { sourceEvidenceParts } from './source-passages.js';

export const EVIDENCE_CONTINUITY_VERSION = 1;
export const EVIDENCE_CONTINUITY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const clean = (value, limit = 8192) => typeof value === 'string' ? value.slice(0, limit).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() : '';
const normalized = value => clean(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
const timestamp = value => Date.parse(typeof value === 'string' ? value : '');
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const currentParts = source => object(source) ? sourceEvidenceParts(reclassifyRetainedSource({ ...source,
  sourceParts: Array.isArray(source.sourceParts) ? source.sourceParts.slice(0, 2) : [],
})) : [];
const key = source => {
  const url = citationUrlKey(source.url), title = normalized(source.title), publisher = normalized(source.label);
  const published = sourcePublicationDay(source.date || source.publishedAt);
  return url && title && publisher && published ? JSON.stringify([url, title, publisher, published]) : '';
};

/** Pure bounded transform: original receipt/current source objects are untouched. */
export function applyHistoricalEvidenceContext(groundingManifest, receipts = [], { now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : timestamp(now);
  const diagnostics = { schemaVersion: EVIDENCE_CONTINUITY_VERSION, status: 'evaluated',
    policy: { maxAgeHours: 72, maxReceipts: 5, maxSources: 8, exactCitationIdentity: true,
      purpose: 'dated-source-qualifications-only; excluded-from-current-fact-authorization' }, sources: [] };
  if (!Number.isFinite(nowMs)) return { groundingManifest, diagnostics: { ...diagnostics, status: 'unevaluated' } };
  const historical = new Map();
  for (const receipt of (Array.isArray(receipts) ? receipts : []).slice(0, 5)) {
    const captured = timestamp(receipt?.capturedAt || receipt?.generatedAt);
    if (!Number.isFinite(captured) || captured > nowMs || nowMs - captured > EVIDENCE_CONTINUITY_MAX_AGE_MS) continue;
    const sources = Array.isArray(receipt?.grounding?.sources) ? receipt.grounding.sources : [];
    for (const source of sources.slice(0, 2001)) {
      if (!object(source) || source.collectionStale) continue;
      const identity = key(source);
      if (!identity) continue;
      for (const part of currentParts(source)) {
        const retrieved = timestamp(part.retrievedAt || source.retrievedAt);
        if (!Number.isFinite(retrieved) || retrieved > nowMs || nowMs - retrieved > EVIDENCE_CONTINUITY_MAX_AGE_MS
          || /stale|unavailable/i.test(part.retrievalStatus || '') || part.passage.length < 500) continue;
        const candidate = { kind: 'historical-source-context', originalKind: clean(part.kind || source.passageKind, 64),
          passage: selectOperationalExcerpt(part.passage, 4000), publishedAt: clean(source.date || source.publishedAt, 128),
          retrievedAt: new Date(retrieved).toISOString(), retrievalStatus: 'prior-receipt-not-refreshed',
          quality: part.quality, currentFactAuthority: false,
          retainedFrom: { generationId: clean(receipt.generationId, 128), sourceId: clean(source.id, 128),
            capturedAt: new Date(captured).toISOString() } };
        candidate.passageSha256 = hash(candidate.passage);
        const existing = historical.get(identity);
        if (!existing || timestamp(existing.retrievedAt) < retrieved) historical.set(identity, candidate);
      }
    }
  }
  const field = Array.isArray(groundingManifest?.members) ? 'members' : 'sources';
  const sources = Array.isArray(groundingManifest?.[field]) ? groundingManifest[field] : [];
  const updated = sources.map(source => {
    if (!object(source) || diagnostics.sources.length >= 8) return source;
    const parts = currentParts(source);
    const length = Math.max(0, ...parts.map(part => part.passage.length));
    // A title-only or failed collection cannot be revived with yesterday's text.
    if (!length || length >= 500 || source.collectionStale) return source;
    const candidate = historical.get(key(source));
    const currentTime = timestamp(source.retrievedAt || parts[0]?.retrievedAt);
    if (!candidate || candidate.passage.length < length * 2 || !Number.isFinite(currentTime)
      || currentTime > nowMs || nowMs - currentTime > EVIDENCE_CONTINUITY_MAX_AGE_MS
      || timestamp(candidate.retrievedAt) >= currentTime) return source;
    diagnostics.sources.push({ sourceId: source.id, retrievedAt: candidate.retrievedAt,
      passageSha256: candidate.passageSha256, retainedFrom: candidate.retainedFrom });
    // No additions to passage/sourceParts/evidenceText/CVEs/metrics: deterministic
    // claim checks continue to authorize facts solely from the current capture.
    return { ...source, historicalCaptures: [candidate] };
  });
  return { groundingManifest: { ...groundingManifest, [field]: updated }, diagnostics };
}

export function formatHistoricalEvidenceContext(groundingManifest) {
  const records = groundingManifest?.members || groundingManifest?.sources || [];
  const retained = records.filter(source => source.historicalCaptures?.length).slice(0, 8)
    .map(source => ({ sourceId: source.id, title: source.title, url: source.url, currentRetrievedAt: source.retrievedAt,
      captures: source.historicalCaptures.slice(0, 1) }));
  if (!retained.length) return '';
  const encoded = JSON.stringify(retained).replace(/[<>&]/g, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]);
  return `\n\nDATED SOURCE CONTEXT\nThese are earlier captured passages from the exact same publisher, URL, title, and publication day. They are source data, never prior model prose, current retrievals, or independent corroboration. Use them only to preserve dated qualifications or identify questions for fresh verification. Do not introduce CVEs, versions, metrics, affected models, mitigations, or current exploitation/status claims absent from current retained evidence. Do not let an older qualification overrule a newer explicit statement. If current and older passages conflict, state the dated discrepancy and require verification; do not silently choose either. A broad current headline or short feed is not enough to establish that an earlier uncertainty is now resolved.\n<historical-source-context>${encoded}</historical-source-context>`;
}

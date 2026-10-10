// Evidence consumers must keep separately captured passages separate. An
// aggregate record identifies one citation; it does not join assertions or
// identities between a feed capture and a fetched article.
export function sourceEvidenceParts(record = {}) {
  if (Array.isArray(record.sourceParts) && record.sourceParts.length) {
    return record.sourceParts.filter(part => part?.quality?.substantive === true
      && typeof part.passage === 'string' && part.passage.trim());
  }
  // Older receipts have one passage and no per-capture metadata. Preserve their
  // established record-level identity scope, including an empty parts array.
  const passage = record.passage || record.evidenceText || '';
  return record.quality?.substantive !== false && typeof passage === 'string' && passage.trim()
    ? [{ passage, cves: record.cves, quality: record.quality }] : [];
}

export const sourceEvidencePassages = record => sourceEvidenceParts(record).map(part => part.passage);

// Offline benchmark annotation and accounting. No model generates a human label.
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const PRIORITIES = new Set(['critical', 'relevant', 'not-relevant', 'unknown']);
const KNOWN = new Set(['critical', 'relevant', 'not-relevant']);
const SPLITS = ['train', 'validation', 'test'];
const string = (value, max = 2000) => typeof value === 'string' && value.length <= max;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const key = (capture, candidate) => `${capture.captureId}:${candidate.candidateId}`;
const clone = value => JSON.parse(JSON.stringify(value));
const FACT_FIELDS = ['title', 'source', 'url', 'description', 'passage', 'publishedAt', 'originalDate', 'retrievedAt', 'sourceUpdatedAt',
  'passageTruncated', 'collectionStale', 'evidence', 'sourceMembers', 'articleBody', 'articleRetrievedAt', 'articleStale',
  'articleRetrievalStatus', 'articlePublishedAt', 'cveData', 'cvssSeverityText', 'cvssMetrics', 'cveObservations', 'isKEV', 'kevCVE', 'kevDateAdded', 'kevDueDate', 'kevRecords', 'epss', 'epssRetrievedAt'];
const SOURCE_FIELDS = ['title', 'source', 'url', 'description', 'passage', 'publishedAt', 'originalDate', 'retrievedAt', 'sourceUpdatedAt',
  'passageTruncated', 'collectionStale', 'evidence'];
const pick = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, value[field]]));
function blindEvidence(candidate) {
  const result = pick(candidate.final, FACT_FIELDS);
  // The pipeline's false ranking flag cannot establish current catalog absence.
  if (result.isKEV !== true) result.isKEV = null;
  // Never copy arbitrary nested candidate objects into a blinded review.
  result.sourceMembers = (candidate.final.sourceMembers || []).map(member => pick(member, SOURCE_FIELDS));
  return clone(result);
}
function dataset(captures) {
  if (!Array.isArray(captures) || !captures.length || new Set(captures.map(capture => capture.captureId)).size !== captures.length) fail('A nonempty set of unique complete captures is required');
  const digest = hash(JSON.stringify(captures.map(capture => ({ captureId: capture.captureId, sha256: capture.sha256 })).sort((a, b) => a.captureId.localeCompare(b.captureId))));
  const items = captures.flatMap(capture => capture.candidates.map(candidate => {
    const evidence = blindEvidence(candidate);
    const evidenceSha256 = hash(JSON.stringify(evidence));
    return { itemId: key(capture, candidate), captureId: capture.captureId, observedAt: capture.observedAt, evidenceCutoffAt: capture.completedAt,
      profileId: capture.profileId, evidenceSha256, evidenceRef: `evidence:${evidenceSha256}`, evidence };
  }));
  if (new Set(items.map(item => item.itemId)).size !== items.length) fail('Duplicate candidate identity');
  return { digest, items, byId: new Map(items.map(item => [item.itemId, item])) };
}
const emptyReviewer = () => ({ id: '', name: '', independent: false, reviewedAt: '' });
const emptyLabel = () => ({ priority: null, incidentId: '', rationale: '', evidenceRefs: [] });
function unchangedContext(row, item) {
  return ['captureId', 'observedAt', 'evidenceCutoffAt', 'profileId', 'evidenceSha256', 'evidenceRef'].every(field => row[field] === item[field])
    && hash(JSON.stringify(row.evidence)) === item.evidenceSha256;
}

export function buildRankingReviewExport(captures, { seed = randomUUID() } = {}) {
  const data = dataset(captures);
  return { schemaVersion: 1, kind: 'ranking-review-template', datasetSha256: data.digest,
    instructions: ['Review independently without consulting system ranks or other reviewers.',
      'Use only the retained evidence available at this collection cutoff and the declared profile. Local exposure remains unknown unless evidenced.',
      'critical = a supported issue this team should triage immediately; relevant = useful monitoring/investigation; not-relevant = reviewed and outside scope; unknown = insufficient evidence.',
      'Leave priority null for unjudged items. Unknown and unjudged are never negatives.',
      'Use one stable incidentId across duplicate reports and captures of the same event. Do not use one ID for unrelated stories about the same vendor.',
      'Cite the item evidenceRef in evidenceRefs and explain the label. Reviewer independence is a human attestation, not mechanically verified.',
      'Article/enrichment availability differs by candidate; acquisition was selective. No score, rank, selection, investigation, or later outcome is included.'],
    reviewer: emptyReviewer(),
    profiles: Object.fromEntries(captures.map(capture => [capture.profileId, clone(capture.profile)])),
    items: data.items.sort((a, b) => hash(`${seed}:${a.itemId}`).localeCompare(hash(`${seed}:${b.itemId}`))).map(item => ({ ...item, label: emptyLabel() })),
  };
}
function validateReviewer(value) {
  if (!identifier(value?.id) || !string(value.name, 256) || !value.name.trim() || value.independent !== true
      || !string(value.reviewedAt, 64) || !/^\d{4}-\d{2}-\d{2}T/.test(value.reviewedAt) || !Number.isFinite(Date.parse(value.reviewedAt))) {
    fail('Reviewer identity, independence attestation, and reviewedAt timestamp are required');
  }
  return { id: value.id, name: value.name.trim(), independent: true, reviewedAt: new Date(value.reviewedAt).toISOString() };
}
function validateLabel(value, item) {
  if (!value || (value.priority !== null && !PRIORITIES.has(value.priority)) || !string(value.incidentId, 128)
      || !string(value.rationale, 4000) || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 20
      || value.evidenceRefs.some(ref => ref !== item.evidenceRef)) fail(`Invalid annotation for ${item.itemId}`);
  if (value.priority !== null && (!value.rationale.trim() || !value.evidenceRefs.length)) fail(`Evidence and rationale are required for ${item.itemId}`);
  if (KNOWN.has(value.priority) && !identifier(value.incidentId)) fail(`A stable incidentId is required for ${item.itemId}`);
  if (value.incidentId && !identifier(value.incidentId)) fail(`Invalid incidentId for ${item.itemId}`);
  if (value.priority === null && (value.incidentId || value.rationale || value.evidenceRefs.length)) fail(`An unjudged item must keep its annotation empty: ${item.itemId}`);
  return { priority: value.priority, incidentId: value.incidentId, rationale: value.rationale, evidenceRefs: [...new Set(value.evidenceRefs)] };
}
export function importRankingReview(document, captures) {
  const data = dataset(captures);
  if (document?.schemaVersion !== 1 || !['ranking-review-template', 'ranking-review'].includes(document.kind)
      || document.datasetSha256 !== data.digest) fail('Review belongs to another or changed capture dataset');
  const reviewer = validateReviewer(document.reviewer);
  if (document.kind === 'ranking-review-template') {
    const profiles = Object.fromEntries(captures.map(capture => [capture.profileId, clone(capture.profile)]));
    if (JSON.stringify(document.profiles) !== JSON.stringify(profiles)) fail('Review profile context was changed');
  }
  const rows = document.kind === 'ranking-review' ? document.labels : document.items;
  if (!Array.isArray(rows) || rows.length !== data.items.length || new Set(rows.map(row => row.itemId)).size !== rows.length) fail('Review must contain each candidate exactly once; leave unjudged labels null');
  const labels = rows.map(row => {
    const item = data.byId.get(row.itemId);
    if (!item || row.evidenceSha256 !== item.evidenceSha256 || (document.kind === 'ranking-review-template' && !unchangedContext(row, item))
        || (row.evidence && hash(JSON.stringify(row.evidence)) !== item.evidenceSha256)) fail('Review evidence was changed or references an unknown item');
    return { itemId: row.itemId, evidenceSha256: item.evidenceSha256, label: validateLabel(row.label, item) };
  }).sort((a, b) => a.itemId.localeCompare(b.itemId));
  const normalized = { schemaVersion: 1, kind: 'ranking-review', datasetSha256: data.digest, reviewer, labels };
  const reviewSha256 = hash(JSON.stringify(normalized));
  if (document.kind === 'ranking-review' && document.reviewSha256 !== reviewSha256) fail('Imported review checksum mismatch');
  return { ...normalized, reviewSha256 };
}
function independentReviews(documents, captures) {
  const reviews = documents.map(document => importRankingReview(document, captures));
  if (reviews.length < 2 || new Set(reviews.map(review => review.reviewer.id)).size !== reviews.length
      || new Set(reviews.map(review => review.reviewer.name.toLowerCase())).size !== reviews.length) fail('At least two distinct independently attested reviewers are required');
  return reviews;
}
const labelKey = label => `${label.priority}:${label.incidentId}`;
export function buildRankingAdjudication(captures, documents) {
  const reviews = independentReviews(documents, captures), data = dataset(captures);
  const maps = reviews.map(review => new Map(review.labels.map(row => [row.itemId, row.label])));
  return { schemaVersion: 1, kind: 'ranking-adjudication', datasetSha256: data.digest, adjudicator: emptyReviewer(),
    reviewSha256: reviews.map(review => review.reviewSha256).sort(),
    instructions: ['A third independent reviewer resolves conflicting judgments using retained evidence.',
      'Leave unresolved decisions null. Agreement on unknown remains unknown; missing reviews never become negative labels.'],
    decisions: data.items.flatMap(item => {
      const labels = maps.map(map => map.get(item.itemId));
      if (labels.some(label => label.priority === null) || new Set(labels.map(labelKey)).size === 1) return [];
      return [{ ...item, reviews: reviews.map((review, index) => ({ reviewerId: review.reviewer.id, label: labels[index] })), label: emptyLabel() }];
    }),
  };
}
function resolvedLabels(captures, documents, adjudication) {
  const reviews = independentReviews(documents, captures), data = dataset(captures);
  const maps = reviews.map(review => new Map(review.labels.map(row => [row.itemId, row.label])));
  const expected = buildRankingAdjudication(captures, reviews);
  const decisions = new Map();
  if (adjudication) {
    if (adjudication.schemaVersion !== 1 || adjudication.kind !== 'ranking-adjudication' || adjudication.datasetSha256 !== data.digest
        || JSON.stringify(adjudication.reviewSha256) !== JSON.stringify(expected.reviewSha256)
        || !Array.isArray(adjudication.decisions) || adjudication.decisions.length !== expected.decisions.length
        || new Set(adjudication.decisions.map(row => row.itemId)).size !== expected.decisions.length) fail('Adjudication is stale or does not cover the exact disagreement set');
    const adjudicator = validateReviewer(adjudication.adjudicator);
    if (reviews.some(review => review.reviewer.id === adjudicator.id || review.reviewer.name.toLowerCase() === adjudicator.name.toLowerCase())) fail('Adjudicator must be distinct from the original reviewers');
    const expectedIds = new Set(expected.decisions.map(row => row.itemId));
    for (const row of adjudication.decisions) {
      const item = data.byId.get(row.itemId);
      if (!expectedIds.has(row.itemId) || !unchangedContext(row, item)) fail('Adjudication references changed evidence');
      decisions.set(row.itemId, validateLabel(row.label, item));
    }
  }
  const resolved = new Map();
  for (const item of data.items) {
    const labels = maps.map(map => map.get(item.itemId));
    const allJudged = labels.every(label => label.priority !== null);
    const agreement = allJudged && new Set(labels.map(labelKey)).size === 1;
    const decision = decisions.get(item.itemId);
    resolved.set(item.itemId, { ...(agreement ? labels[0] : decision?.priority ? decision : emptyLabel()),
      basis: agreement ? 'independent-agreement' : decision?.priority ? 'adjudicated' : allJudged ? 'unresolved-disagreement' : 'unjudged' });
  }
  return { resolved, reviewers: reviews.map(review => review.reviewer), disagreementCount: expected.decisions.length };
}

export function buildRankingSplitTemplate(captures) {
  const data = dataset(captures);
  return { schemaVersion: 1, kind: 'ranking-split', datasetSha256: data.digest,
    instructions: ['Assign whole captures to train, validation, or test in strict chronological order.',
      'The same incident or source article must never appear in multiple splits. Choose nonoverlapping windows or remove whole overlapping captures before exporting reviews.',
      'All-test is a pilot report only, not evidence of a tuned model passing a held-out evaluation.'],
    assignments: captures.map(capture => ({ captureId: capture.captureId, observedAt: capture.observedAt, split: null })) };
}
function validateSplit(captures, labels, document) {
  const data = dataset(captures);
  if (document?.schemaVersion !== 1 || document.kind !== 'ranking-split' || document.datasetSha256 !== data.digest
      || !Array.isArray(document.assignments) || document.assignments.length !== captures.length
      || new Set(document.assignments.map(row => row.captureId)).size !== captures.length) fail('Split must assign every captured run exactly once');
  const assignments = new Map(document.assignments.map(row => [row.captureId, row.split]));
  if (captures.some(capture => !SPLITS.includes(assignments.get(capture.captureId)))) fail('Each capture requires train, validation, or test assignment');
  let previousMax = -Infinity;
  for (const split of SPLITS) {
    const times = captures.filter(capture => assignments.get(capture.captureId) === split).map(capture => Date.parse(capture.observedAt));
    if (!times.length) continue;
    if (Math.min(...times) <= previousMax) fail('Temporal leakage: splits must occupy strictly increasing, nonoverlapping time windows');
    previousMax = Math.max(...times);
  }
  const seen = new Map();
  for (const capture of captures) {
    const split = assignments.get(capture.captureId);
    for (const candidate of capture.candidates) {
      const label = labels.get(key(capture, candidate));
      const urls = [candidate.final.url, ...(candidate.final.sourceMembers || []).map(member => member.url)].filter(Boolean);
      const identities = [...urls.map(value => `source:${value}`), ...(label.incidentId ? [`incident:${label.incidentId}`] : [])];
      for (const identity of identities) {
        if (seen.has(identity) && seen.get(identity) !== split) fail('Incident/source leakage: the same retained incident or article crosses split boundaries');
        seen.set(identity, split);
      }
    }
  }
  return assignments;
}
const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
function metrics(captures, labels) {
  let candidates = 0, judged = 0, unknown = 0, unjudged = 0, disagreements = 0;
  let selectedSlots = 0, judgedTop10 = 0, relevantTop10 = 0, duplicateTop10 = 0;
  let criticalIncidents = 0, criticalSelected = 0, criticalTop10 = 0, relevantIncidents = 0, relevantCovered = 0;
  let editoriallyExcluded = 0, enrichmentNotEligible = 0;
  for (const capture of captures) {
    const rows = capture.candidates.map(candidate => ({ candidate, label: labels.get(key(capture, candidate)) }));
    candidates += rows.length;
    judged += rows.filter(row => KNOWN.has(row.label.priority)).length;
    unknown += rows.filter(row => row.label.priority === 'unknown').length;
    unjudged += rows.filter(row => row.label.basis === 'unjudged').length;
    disagreements += rows.filter(row => row.label.basis === 'unresolved-disagreement').length;
    editoriallyExcluded += rows.filter(row => row.candidate.editoriallyExcluded).length;
    enrichmentNotEligible += rows.filter(row => !row.candidate.enrichmentEligible).length;
    const top10 = rows.filter(row => row.candidate.finalSelected && row.candidate.finalRank <= 10);
    const knownTop10 = top10.filter(row => KNOWN.has(row.label.priority));
    selectedSlots += top10.length; judgedTop10 += knownTop10.length;
    relevantTop10 += knownTop10.filter(row => ['critical', 'relevant'].includes(row.label.priority)).length;
    duplicateTop10 += knownTop10.length - new Set(knownTop10.map(row => row.label.incidentId)).size;
    const critical = new Set(rows.filter(row => row.label.priority === 'critical').map(row => row.label.incidentId));
    const relevant = new Set(rows.filter(row => ['critical', 'relevant'].includes(row.label.priority)).map(row => row.label.incidentId));
    const selected = new Set(rows.filter(row => row.candidate.finalSelected && ['critical', 'relevant'].includes(row.label.priority)).map(row => row.label.incidentId));
    const topIds = new Set(knownTop10.filter(row => ['critical', 'relevant'].includes(row.label.priority)).map(row => row.label.incidentId));
    criticalIncidents += critical.size; relevantIncidents += relevant.size;
    criticalSelected += [...critical].filter(id => selected.has(id)).length;
    criticalTop10 += [...critical].filter(id => topIds.has(id)).length;
    relevantCovered += [...relevant].filter(id => topIds.has(id)).length;
  }
  return { runs: captures.length, candidates, judged, unknown, unjudged, unresolvedDisagreements: disagreements,
    annotationCoverage: ratio(judged, candidates), editoriallyExcluded, enrichmentNotEligible,
    top10: { slots: selectedSlots, judgedSlots: judgedTop10, unjudgedOrUnknownSlots: selectedSlots - judgedTop10,
      annotationCoverage: ratio(judgedTop10, selectedSlots), precisionAmongJudged: ratio(relevantTop10, judgedTop10),
      duplicateSlotsAmongJudged: ratio(duplicateTop10, judgedTop10) },
    criticalRecallAmongJudged: ratio(criticalSelected, criticalIncidents),
    criticalRecallAt10AmongJudged: ratio(criticalTop10, criticalIncidents),
    relevantIncidentCoverageAt10AmongJudged: ratio(relevantCovered, relevantIncidents),
  };
}
export function evaluateRankingBenchmark(captures, reviewDocuments, { adjudication = null, split } = {}) {
  const data = dataset(captures);
  const { resolved, reviewers, disagreementCount } = resolvedLabels(captures, reviewDocuments, adjudication);
  const assignments = validateSplit(captures, resolved, split);
  const groups = Object.fromEntries(SPLITS.filter(name => captures.some(capture => assignments.get(capture.captureId) === name))
    .map(name => { const runs = captures.filter(capture => assignments.get(capture.captureId) === name);
      return [name, { ...metrics(runs, resolved), profiles: Object.fromEntries([...new Set(runs.map(capture => capture.profileId))]
        .map(profileId => [profileId, metrics(runs.filter(capture => capture.profileId === profileId), resolved)])) }]; }));
  return { schemaVersion: 1, kind: 'ranking-benchmark-report', datasetSha256: data.digest,
    scope: 'pilot-observational-ranking-evaluation', reviewerIndependence: 'self-attested-not-mechanically-verified',
    reviewers, disagreementCount, groups,
    caveats: ['Unknown, unjudged and unresolved disagreements are excluded from metric denominators and shown as missing coverage.',
      'Incident denominators count incident-run pairs, not globally independent incidents. Repeated windows are correlated.',
      'Recall covers retained collected pools only; upstream fetch/scan omissions and missing captures are not measured.',
      'Post-enrichment evidence is selectively acquired. Ranking and acquisition-budget effects must be interpreted together.',
      'Leakage checks use adjudicated incident IDs and retained article URLs; unresolved identities may conceal related incidents.',
      'No labels were generated by this tool. Pilot results and the authored scoring fixture do not establish production quality.',
      ...(groups.train && groups.test ? [] : ['No train/test separation is represented; do not claim an independently held-out tuning result.'])] };
}

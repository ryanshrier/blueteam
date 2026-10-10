// Optional, private, bounded observations of the complete admitted candidate pool.
// Captures describe one actual collection; they do not manufacture historical runs.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RANKING_CAPTURE_LIMITS = Object.freeze({ maxRuns: 48, maxAgeDays: 14, maxBytes: 64 * 1024 * 1024,
  maxCaptureBytes: 8 * 1024 * 1024, minIntervalMs: 60 * 60 * 1000, maxCandidates: 5000 });
const CAPTURE_NAME = /^ranking-\d{13}-[a-f0-9-]{36}\.json$/;
const ROOT = new URL('../', import.meta.url);
const AXES = ['recency', 'corroboration', 'exploitation', 'severity', 'relevance'];
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const privateFile = path => { if (process.platform !== 'win32') chmodSync(path, 0o600); };
const num = value => Number.isFinite(value) ? value : null;
const numbers = (value, keys) => Object.fromEntries(keys.map(key => [key, num(value?.[key])]));
const timestamp = value => typeof value === 'number' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString()
  : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function text(value, max = 32768) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) fail('Capture field exceeds retention bounds');
  return value.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}
function list(value, mapper = value => text(value, 1024), max = 5000) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) fail('Capture list exceeds retention bounds');
  return value.map(mapper);
}
function url(value) {
  if (!value) return null;
  try {
    const parsed = new URL(text(value, 4096));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = ''; parsed.password = ''; parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|secret|password|credential|signature|api[-_]?key|authorization/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
      else if (/^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.href;
  } catch { return null; }
}
// These allowlists deliberately omit provider settings, webhook destinations,
// arbitrary config keys, environment values and opaque third-party objects.
function watchSnapshot(profile = {}) {
  return { schemaVersion: 1, ...Object.fromEntries(['technologies', 'sectors', 'regions', 'intelligenceQuestions', 'exclusions']
    .map(key => [key, list(profile[key], value => text(value, 1024), 100)])),
  teamProfile: text(profile.teamProfile, 1024), preferredHorizons: list(profile.preferredHorizons, num, 3) };
}
function configurationSnapshot(config = {}, scoring = {}) {
  const analysis = config.analysisSettings || {};
  const domain = scoring.domain || {};
  return {
    scoring: {
      axisWeights: numbers(scoring.axisWeights, AXES), horizonWeights: numbers(scoring.horizonWeights, ['horizon1', 'horizon2', 'horizon3']),
      recencyHalfLifeHours: num(scoring.recencyHalfLifeHours), freshnessHours: num(scoring.freshnessHours),
      alertRules: list(scoring.alertRules, rule => ({ pattern: text(rule.pattern, 2048), boost: num(rule.boost) }), 250),
      domain: { id: text(domain.id, 128),
        urgencyLexicon: Object.fromEntries(['critical', 'elevated', 'horizon1Promote'].map(key => [key, list(domain.urgencyLexicon?.[key], value => text(value, 2048), 250)])),
        exploitation: numbers(domain.exploitation, ['verified', 'critical', 'elevated', 'epss']),
        severity: { dataProperty: text(domain.severity?.dataProperty, 128), pattern: text(domain.severity?.pattern, 2048), max: num(domain.severity?.max),
          bands: numbers(domain.severity?.bands, ['critical', 'high', 'medium', 'low']) } },
    },
    collection: numbers(analysis, ['freshnessHours', 'maxArticleExtractions', 'maxCVEEnrichments', 'maxEPSSLookups']),
    feeds: list(config.trustedFeeds, feed => ({ id: text(feed.id, 128), source: text(feed.source, 512), category: text(feed.category, 128),
      horizon: num(feed.horizon), weight: num(feed.weight) }), 500),
  };
}
function evidenceRef(ref = {}) {
  return { sourceId: text(ref.sourceId, 128), revisionId: text(ref.revisionId, 128), contentHash: text(ref.contentHash, 128),
    publishedAt: text(ref.publishedAt, 128), retrievedAt: text(ref.retrievedAt, 128), lastObservedAt: text(ref.lastObservedAt, 128) };
}
function sourceSnapshot(item = {}) {
  return { title: text(item.title, 4096), source: text(item.source, 512), url: url(item.link || item.canonicalUrl),
    description: text(item.description), passage: text(item.passage), date: text(item.date, 128), publishedAt: text(item.publishedAt || item.date, 128), originalDate: text(item.originalDate, 128),
    retrievedAt: text(item.retrievedAt, 128), sourceUpdatedAt: text(item.sourceUpdatedAt, 128),
    feedPassageField: text(item.feedPassageField, 64),
    revisionAdmission: item.revisionAdmission ? { basis: text(item.revisionAdmission.basis, 128), materiality: text(item.revisionAdmission.materiality, 128),
      updatedAt: text(item.revisionAdmission.updatedAt, 128), previousRevisionId: text(item.revisionAdmission.previousRevisionId, 128) } : null,
    passageTruncated: item.passageTruncated === true, collectionStale: item.collectionStale === true,
    evidence: list(item.evidence, evidenceRef, 500) };
}
function kevRecord(record = {}) {
  return { cve: text(record.cve || record.cve_id, 128), vendor: text(record.vendor, 512), product: text(record.product, 512),
    dateAdded: text(record.dateAdded || record.date_added, 128), dueDate: text(record.dueDate || record.due_date, 128),
    requiredAction: text(record.requiredAction || record.required_action, 8192) };
}
function catalogSnapshot(value) {
  if (!value) return null;
  return { loaded: value.loaded === true, retrievedAt: text(value.retrievedAt, 128), status: text(value.status, 128),
    refreshFailed: value.refreshFailed === true };
}
function headlineSnapshot(item, retainMember = value => value) {
  return { ...sourceSnapshot(item), category: text(item.category, 128),
    sourceMembers: list(item.sourceMembers, member => retainMember(sourceSnapshot(member)), 500),
    eventId: text(item.eventIdentity?.eventId, 128),
    articleBody: text(item.articleBody), articlePublishedAt: text(item.articlePublishedAt, 128), articleRetrievedAt: text(item.articleRetrievedAt, 128), articleStale: item.articleStale === true,
    articleRetrievalStatus: text(item.articleRetrievalStatus, 128),
    cveData: text(item.cveData), cvssSeverityText: text(item.cvssSeverityText, 8192),
    cvssMetrics: list(item.cvssMetrics, metric => ({ cve: text(metric.cve, 128), source: text(metric.source, 128),
      version: text(metric.version, 64), vectorString: text(metric.vectorString, 1024), baseScore: num(metric.baseScore),
      baseSeverity: text(metric.baseSeverity, 64) }), 1000),
    cveObservations: list(item.cveObservations, observation => ({ cve: text(observation.cve, 128), retrievedAt: text(observation.retrievedAt, 128) }), 1000),
    isKEV: typeof item.isKEV === 'boolean' ? item.isKEV : null, kevCVE: text(item.kevCVE, 128), kevDateAdded: text(item.kevDateAdded, 128),
    kevDueDate: text(item.kevDueDate, 128), kevRecords: list(item.kevRecords, kevRecord, 1000),
    epss: num(item.epss), epssRetrievedAt: text(item.epssRetrievedAt, 128),
    horizon: num(item.horizon), originalHorizon: num(item.originalHorizon), urgency: text(item.urgency, 64), weight: num(item.weight),
    corroboration: num(item.corroboration), publishers: list(item.publishers, value => text(value, 512), 500),
    score: num(item.score), scoreComponents: numbers(item.scoreComponents, AXES),
    alertMatched: item.alertMatched === true, alertBoost: num(item.alertBoost),
    regexAssessment: item.regexAssessment ? { schemaVersion: 1, fingerprint: text(item.regexAssessment.fingerprint, 128),
      promote: item.regexAssessment.promote === true, severityMatch: list(item.regexAssessment.severityMatch, value => text(value, 8192), 100),
      urgency: { ...Object.fromEntries(['level', 'reason', 'basis', 'statement', 'source', 'reportedAt', 'exploitationStatus']
        .map(key => [key, text(item.regexAssessment.urgency?.[key], 8192)])),
      evidenceRefs: list(item.regexAssessment.urgency?.evidenceRefs, evidenceRef, 500) } } : null,
  };
}
function implementationSnapshot() {
  const paths = ['lib', 'config/domains'].flatMap(directory => readdirSync(new URL(`${directory}/`, ROOT), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => `${directory}/${entry.name}`));
  paths.push('package-lock.json');
  return Object.fromEntries(paths.sort().map(path => [path, hash(readFileSync(new URL(path, ROOT)))]));
}
function captureEntries(directory) {
  return readdirSync(directory).filter(name => CAPTURE_NAME.test(name)).flatMap(name => {
    const stat = lstatSync(join(directory, name));
    return stat.isFile() ? [{ name, size: stat.size, capturedAt: Number(name.slice(8, 21)) }] : [];
  }).sort((a, b) => b.capturedAt - a.capturedAt || b.name.localeCompare(a.name));
}
function prune(directory, limits, now) {
  let bytes = 0, count = 0;
  for (const entry of captureEntries(directory)) {
    if (entry.capturedAt < now - limits.maxAgeDays * 86400000 || count >= limits.maxRuns || bytes + entry.size > limits.maxBytes) {
      unlinkSync(join(directory, entry.name));
    } else { count++; bytes += entry.size; }
  }
}
export function writePrivateJson(path, value) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
  privateFile(path);
}
export function readRankingCaptures(directory) {
  const entries = captureEntries(directory);
  if (entries.length > RANKING_CAPTURE_LIMITS.maxRuns || entries.reduce((sum, entry) => sum + entry.size, 0) > RANKING_CAPTURE_LIMITS.maxBytes) fail('Capture dataset exceeds review bounds; select a smaller frozen window');
  return entries.map(entry => {
    if (entry.size > RANKING_CAPTURE_LIMITS.maxCaptureBytes) fail('Capture exceeds the read limit');
    const value = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
    const capture = value.capture;
    if (value.schemaVersion !== 1 || value.kind !== 'ranking-capture' || value.sha256 !== hash(JSON.stringify(capture))
      || !capture?.complete || !timestamp(capture.observedAt) || !timestamp(capture.completedAt)
      || !/^[a-f0-9-]{36}$/.test(capture.captureId || '') || capture.profileId !== hash(JSON.stringify(capture.profile))
      || !Array.isArray(capture.observations) || !Array.isArray(capture.candidates)
      || capture.candidates.length > RANKING_CAPTURE_LIMITS.maxCandidates
      || new Set(capture.candidates.map(item => item.candidateId)).size !== capture.candidates.length
      || capture.candidates.some(item => !/^[a-f0-9]{64}$/.test(item.candidateId || '') || !item.baseline || !item.beforeEnrichment || !item.final
        || typeof item.finalSelected !== 'boolean' || !Array.isArray(item.stageReasons)
        || (item.finalSelected ? !Number.isInteger(item.finalRank) || item.finalRank < 1 : item.finalRank !== null))) fail('Invalid or incomplete ranking capture');
    const ranks = capture.candidates.filter(item => item.finalSelected).map(item => item.finalRank).sort((a, b) => a - b);
    if (ranks.some((rank, index) => rank !== index + 1)) fail('Invalid selected ranking');
    return { ...capture, sha256: value.sha256 };
  }).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.captureId.localeCompare(b.captureId));
}

let configured = null;
let status = { enabled: false, state: 'disabled' };
let lastAttemptAt = -Infinity;
export function getRankingBenchmarkStatus() { return clone(status); }
export function configureRankingBenchmark({ directory, ...options } = {}) {
  if (!directory) { configured = null; lastAttemptAt = -Infinity; status = { enabled: false, state: 'disabled' }; return getRankingBenchmarkStatus(); }
  const limits = { ...RANKING_CAPTURE_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] !== undefined) {
      if (!Number.isFinite(options[key]) || options[key] < (key === 'minIntervalMs' ? 0 : 1) || options[key] > limits[key]) fail(`Invalid benchmark limit: ${key}`);
      limits[key] = Math.floor(options[key]);
    }
  }
  const location = resolve(directory);
  configured = { directory: location, limits };
  status = { enabled: true, state: 'ready', limits };
  try {
    mkdirSync(location, { recursive: true, mode: 0o700 });
    if (lstatSync(location).isSymbolicLink() || !lstatSync(location).isDirectory()) fail('Capture directory must be a real directory');
    if (process.platform !== 'win32') chmodSync(location, 0o700);
    // A crash can leave one unfinished private write. Boot-time configuration
    // owns cleanup; never treat that partial file as a completed observation.
    for (const name of readdirSync(location)) {
      if (name.endsWith('.tmp') && CAPTURE_NAME.test(name.slice(0, -4)) && lstatSync(join(location, name)).isFile()) unlinkSync(join(location, name));
    }
    prune(location, limits, Date.now());
    lastAttemptAt = captureEntries(location)[0]?.capturedAt ?? -Infinity;
  } catch { status = { ...status, state: 'unavailable', reason: 'capture-storage-unavailable' }; }
  return getRankingBenchmarkStatus();
}

export function beginRankingBenchmark({ config = {}, watchProfile = {}, scoringConfiguration = {}, observedAt = new Date().toISOString() } = {}) {
  if (!configured) return null;
  const clock = timestamp(observedAt);
  const now = Date.parse(clock || '');
  if (!clock) { status = { ...status, state: 'unavailable', reason: 'invalid-capture-clock' }; return null; }
  if (now - lastAttemptAt < configured.limits.minIntervalMs) {
    if (status.state !== 'unavailable') status = { ...status, state: 'skipped', reason: 'capture-interval' };
    return { collection() {}, beforeEnrichment() {}, abort() {}, complete: () => ({ status: 'skipped', reason: 'capture-interval' }) };
  }
  lastAttemptAt = now;
  const { directory, limits } = configured;
  const captureId = randomUUID();
  let capture, error, phase = 0, retainedBytes = 0;
  const ids = new Map(), rowsById = new Map();
  const failed = reason => { error = reason; status = { ...status, state: 'unavailable', reason, attemptedAt: clock }; };
  const bounded = () => { if (Buffer.byteLength(JSON.stringify(capture)) > limits.maxCaptureBytes - 1024) fail('Capture exceeds byte limit'); };
  const retain = value => {
    retainedBytes += Buffer.byteLength(JSON.stringify(value));
    if (retainedBytes > limits.maxCaptureBytes - 1024) fail('Capture exceeds byte limit');
    return value;
  };
  const retainHeadline = item => {
    const before = retainedBytes;
    const snapshot = headlineSnapshot(item, retain);
    // Members were charged while being materialized to stop a large group
    // early. The enclosing snapshot replaces that temporary member charge.
    retainedBytes = before;
    return retain(snapshot);
  };
  const run = operation => {
    if (error) return;
    try { operation(); bounded(); } catch { failed('capture-incomplete-or-over-limit'); }
  };
  try {
    const profile = watchSnapshot(watchProfile);
    capture = { schemaVersion: 1, captureId, observedAt: clock, complete: false,
      scope: 'all-collected-observations-and-admitted-deduplicated-candidates',
      limitations: ['Upstream fetch/scan/admission limits remain outside this pool.', 'Priority labels are absent until independent human review.',
        'Evidence acquisition is selective; absent enrichment is unknown, not negative.'],
      profile, profileId: hash(JSON.stringify(profile)), configuration: configurationSnapshot(config, scoringConfiguration),
      implementationSha256: implementationSnapshot(), observations: [], candidates: [] };
    retainedBytes = Buffer.byteLength(JSON.stringify(capture));
    status = { ...status, state: 'capturing', attemptedAt: clock, captureId };
  } catch { failed('capture-configuration-unavailable'); }
  return {
    collection({ collected, admitted, candidates }) { run(() => {
      if (phase !== 0 || !Array.isArray(candidates) || candidates.length > limits.maxCandidates) fail('Invalid collection phase');
      const admittedSet = new Set(admitted);
      const collectedSet = new Set(collected);
      if (!Array.isArray(collected) || new Set(candidates).size !== candidates.length || admitted.some(item => !collectedSet.has(item))) fail('Invalid candidate membership');
      capture.observations = list(collected, (item, index) => ({ observationId: hash(`${captureId}:observation:${index}`),
        admitted: admittedSet.has(item), exclusionReason: admittedSet.has(item) ? null : 'editorial-recurring-feature', ...retain(sourceSnapshot(item)) }), limits.maxCandidates);
      capture.candidates = candidates.map((item, index) => {
        const candidateId = hash(`${captureId}:candidate:${index}`);
        ids.set(item, candidateId);
        const row = { candidateId, baseline: retainHeadline(item), beforeEnrichment: null, final: null, stageReasons: [] };
        rowsById.set(candidateId, row);
        return row;
      });
      // Editorial exclusions remain reviewable and part of end-to-end recall.
      for (const observation of capture.observations.filter(item => !item.admitted)) {
        const snapshot = { ...observation, sourceMembers: [] };
        retain(snapshot); retain(snapshot); retain(snapshot);
        capture.candidates.push({ candidateId: observation.observationId, editoriallyExcluded: true,
          baseline: snapshot, beforeEnrichment: snapshot, final: snapshot, initialSelected: false, finalSelected: false,
          enrichmentEligible: false, finalRank: null, stageReasons: ['editorial-recurring-feature'] });
      }
      if (capture.candidates.length > limits.maxCandidates) fail('Too many candidates');
      capture.baselineAt = new Date().toISOString();
      phase = 1;
    }); },
    beforeEnrichment({ candidates, selected, investigations = [], scoringClock, kevRecords, kevCatalogStatus }) { run(() => {
      if (phase !== 1 || candidates.length !== ids.size || candidates.some(item => !ids.has(item))) fail('Candidate pool changed');
      const selectedSet = new Set(selected);
      const investigated = new Map(investigations.map(item => [item.headline, text(item.reason, 256)]));
      for (const item of candidates) {
        const row = rowsById.get(ids.get(item));
        row.beforeEnrichment = retainHeadline(item);
        row.initialSelected = selectedSet.has(item);
        row.stageReasons.push(selectedSet.has(item) ? 'initial-diversity-selection' : 'outside-initial-diversity-selection');
        if (investigated.has(item)) row.stageReasons.push(`investigation:${investigated.get(item)}`);
      }
      capture.initialScoringClock = timestamp(scoringClock);
      capture.beforeEnrichmentAt = new Date().toISOString();
      capture.initialKevRecords = list(kevRecords, kevRecord, 5000);
      capture.initialKevCatalogStatus = catalogSnapshot(kevCatalogStatus);
      phase = 2;
    }); },
    complete({ candidates, selected, enrichmentPool, enrichmentFailures = [], selection = {}, scoringClock, kevRecords, kevCatalogStatus }) {
      run(() => {
        if (phase !== 2 || candidates.length !== ids.size || candidates.some(item => !ids.has(item))
          || selected.some(item => !ids.has(item)) || new Set(selected).size !== selected.length) fail('Candidate pool changed');
        const ranks = new Map(selected.map((item, index) => [item, index + 1]));
        const enriched = new Set(enrichmentPool);
        for (const item of candidates) {
          const row = rowsById.get(ids.get(item));
          row.final = retainHeadline(item); row.finalSelected = ranks.has(item); row.finalRank = ranks.get(item) || null;
          row.enrichmentEligible = enriched.has(item);
          row.stageReasons.push(enriched.has(item) ? 'eligible-for-budgeted-post-enrichment' : 'outside-post-enrichment-pool',
            ranks.has(item) ? 'final-diversity-selection' : 'outside-final-diversity-selection');
        }
        capture.enrichmentFailures = list(enrichmentFailures, value => text(value, 128), 100);
        capture.finalScoringClock = timestamp(scoringClock);
        capture.finalKevRecords = list(kevRecords, kevRecord, 5000);
        capture.finalKevCatalogStatus = catalogSnapshot(kevCatalogStatus);
        capture.selection = { ...numbers(selection, ['candidateCount', 'initialSelectedCount', 'finalSelectedCount', 'excludedCount', 'investigationCount', 'recoveredCount']),
          policy: numbers(selection.policy, ['maxSelected', 'maxInvestigations']) };
        capture.completedAt = new Date().toISOString(); capture.complete = true;
        phase = 3;
      });
      if (!error) {
        const filename = `ranking-${now}-${captureId}.json`;
        const target = join(directory, filename), temp = `${target}.tmp`;
        try {
          const value = { schemaVersion: 1, kind: 'ranking-capture', sha256: hash(JSON.stringify(capture)), capture };
          // Compact storage: the bounded size is the exact on-disk envelope.
          const serialized = JSON.stringify(value) + '\n';
          if (Buffer.byteLength(serialized) > limits.maxCaptureBytes || Buffer.byteLength(serialized) > limits.maxBytes) fail('Capture exceeds byte limit');
          const fd = openSync(temp, 'wx', 0o600);
          try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(temp, target); privateFile(target);
          prune(directory, limits, now);
          status = { enabled: true, state: 'captured', captureId, lastCaptureAt: clock, candidateCount: capture.candidates.length, limits };
        } catch { failed('capture-storage-unavailable'); }
        finally { try { unlinkSync(temp); } catch { /* no temporary file remains on normal completion */ } }
      }
      return error ? { status: 'unavailable', reason: error } : { status: 'captured', captureId, candidateCount: capture.candidates.length };
    },
    abort(reason = 'collection-failed') { failed(text(reason, 128)); },
  };
}

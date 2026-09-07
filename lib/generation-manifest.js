// Versioned local generation receipts. Never serialize an entire config, run,
// SDK client, or settings object: those can contain credentials and disk paths.
import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { selectSourcePassage } from './evidence-quality.js';

export const GENERATION_MANIFEST_VERSION = 1;
export const MAX_GENERATION_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_INPUTS = 200;
const AXES = ['recency', 'corroboration', 'exploitation', 'severity', 'relevance'];
export const sha256 = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = value => Number.isFinite(value) ? value : null;

function text(value, max = 8192) {
  if (typeof value !== 'string') return '';
  if (value.length > max) throw new Error('Generation manifest field exceeds its retention limit');
  // Defense in depth for credential-shaped source text. Prompt hashes still
  // identify the exact provider input when a retained field is redacted.
  return value.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
function list(value, mapper = item => text(item, 512), max = 100) {
  if (!Array.isArray(value)) return [];
  if (value.length > max) throw new Error('Generation manifest list exceeds its retention limit');
  return value.map(mapper);
}
function numbers(value, keys) {
  return Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
}
function sourceUrl(value) {
  try {
    const url = new URL(text(value, 8192));
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    // Signed links and feed query credentials are unnecessary to inspect a
    // retained excerpt. Do not redistribute them in the receipt.
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|credential|signature|api[-_]?key|authorization/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.href;
  } catch { return ''; }
}

const implementation = Object.fromEntries([
  'prompts', 'grounding', 'validation', 'scoring', 'evidence-quality', 'claim-checks',
].map(name => [name, sha256(readFileSync(new URL(`./${name}.js`, import.meta.url), 'utf8'))]));
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function snapshotWatchProfile(value) {
  if (!value) return null;
  const profile = record(value);
  return {
    schemaVersion: 1,
    technologies: list(profile.technologies), sectors: list(profile.sectors),
    regions: list(profile.regions), intelligenceQuestions: list(profile.intelligenceQuestions),
    exclusions: list(profile.exclusions),
    preferredHorizons: list(profile.preferredHorizons, number, 3),
    teamProfile: text(profile.teamProfile, 1024),
  };
}


function evidenceReference(value) {
  const ref = record(value);
  return {
    sourceId: text(ref.sourceId, 128), revisionId: text(ref.revisionId, 128),
    source: text(ref.source, 512), title: text(ref.title), canonicalUrl: sourceUrl(ref.canonicalUrl),
    passageKind: text(ref.passageKind, 64), changed: ref.changed === true,
    publishedAt: text(ref.publishedAt, 128), retrievedAt: text(ref.retrievedAt, 128),
    firstObservedAt: text(ref.firstObservedAt, 128), lastObservedAt: text(ref.lastObservedAt, 128),
  };
}

function snapshotHeadline(h, index) {
  const selected = selectSourcePassage(h);
  const excerpt = text(selected.passage, 32768);
  return {
    index, title: text(h.title), source: text(h.source, 512), url: sourceUrl(h.link),
    publishedAt: text(h.date, 128), horizon: number(h.horizon),
    passage: { kind: selected.kind, text: excerpt || text(h.title), quality: selected.quality },
    ...(selected.excludedArticle ? { excludedArticle: { text: text(selected.excludedArticle.passage, 4000), quality: selected.excludedArticle.quality } } : {}),
    ...(selected.excludedPassage ? { excludedPassage: { text: text(selected.excludedPassage.passage), quality: selected.excludedPassage.quality } } : {}),
    sourceRevisions: list(h.evidence, evidenceReference),
    groupMembers: list(h.sourceMembers, member => ({
      title: text(member.title), source: text(member.source, 512), url: sourceUrl(member.link),
      publishedAt: text(member.date, 128), retrievedAt: text(member.retrievedAt, 128),
      sourceUpdatedAt: text(member.sourceUpdatedAt, 128),
      passage: text(member.passage || member.description || member.title),
      passageTruncated: member.passageTruncated === true,
      sourceRevisions: list(member.evidence, evidenceReference),
    }), 500),
    ...(h.eventIdentity ? { eventIdentity: { eventId: text(h.eventIdentity.eventId, 128), basis: text(h.eventIdentity.basis, 512), publisherCount: number(h.eventIdentity.publisherCount), articleCount: number(h.eventIdentity.articleCount), retainedRecordCount: number(h.eventIdentity.retainedRecordCount), independentObservation: 'unassessed' } } : {}),
    ...(Array.isArray(h.articleIdentities) ? { articleIdentities: list(h.articleIdentities, item => ({ articleId: text(item.articleId, 128), publisherId: text(item.publisherId, 128), canonicalUrl: sourceUrl(item.canonicalUrl), basis: text(item.basis, 512), evidenceRefs: list(item.evidenceRefs, ref => typeof ref === 'string' ? text(ref, 128) : evidenceReference(ref)) }), 500) } : {}),
    revisionStatus: h.evidence?.length ? 'retained-reference' : 'unavailable',
    sources: list(h.sources), corroboration: number(h.corroboration),
    score: number(h.score), scoreComponents: numbers(h.scoreComponents, AXES),
    scoreRationale: text(h.scoreRationale), weight: number(h.weight),
    alertMatched: h.alertMatched === true, alertBoost: number(h.alertBoost),
    enrichment: {
      cveData: text(h.cveData, 32768), cvssSeverityText: text(h.cvssSeverityText, 8192),
      isKEV: typeof h.isKEV === 'boolean' ? h.isKEV : null, kevCVE: text(h.kevCVE, 128), kevDateAdded: text(h.kevDateAdded, 128),
      epss: number(h.epss), urgency: text(h.urgency, 64),
      articleStale: h.articleStale === true,
      mitre: list(h.mitre, tag => typeof tag === 'string' ? text(tag) : { id: text(tag?.id, 128), name: text(tag?.name), tactic: text(tag?.tactic) }),
      actors: list(h.actors, actor => ({ name: text(actor?.name), basis: text(actor?.basis, 128) })),
      vendors: list(h.vendors),
    },
  };
}

/** Called before a paid attempt: bounds failures cannot consume provider spend. */
export function buildGenerationManifest({ run, config, watchProfile, editionContext, groundTruth, groundingManifest, continuityContext, previousBriefs = [] }) {
  const s = config?.analysisSettings || {};
  const manifest = {
    schemaVersion: GENERATION_MANIFEST_VERSION,
    generationId: randomUUID(), capturedAt: new Date().toISOString(),
    application: { name: 'blueteam-news', version: appVersion, implementationSha256: { ...implementation } },
    edition: { date: text(editionContext?.date, 32), timezone: text(editionContext?.timezone, 128), scheduled: editionContext?.scheduled === true },
    collection: {
      collectedAt: text(run?.generatedAt || run?.timestamp, 128),
      watchProfile: snapshotWatchProfile(run?.watchProfile),
      // Old in-memory snapshots have no historical configuration. Say so.
      scoringConfiguration: run?.scoringConfiguration ? sanitizeScoringSnapshot(run.scoringConfiguration) : null,
      configurationStatus: run?.scoringConfiguration ? 'captured-at-collection' : 'unavailable',
      enrichmentFailures: list(run?.stats?.enrichmentFailures),
      evidenceRetentionStatus: run?.stats?.evidenceError ? 'unavailable' : 'not-reported-failed',
    },
    promptWatchProfile: snapshotWatchProfile(watchProfile),
    promptConfiguration: {
      organization: {
        profile: text(config?.organization?.profile, 1024), audience: text(config?.organization?.audience, 1024),
        sector: text(config?.organization?.sector, 4096), regions: list(config?.organization?.regions),
        watchTopics: list(config?.organization?.watchTopics),
      },
      horizons: Object.fromEntries([1, 2, 3].map(horizon => [horizon, {
        name: text(config?.horizons?.[horizon]?.name, 512),
        window: text(config?.horizons?.[horizon]?.window, 1024),
        question: text(config?.horizons?.[horizon]?.question, 2048),
      }])),
      maxSignals: number(s.maxSignals), maxPatterns: number(s.maxPatterns), maxConvergence: number(s.maxConvergence),
    },
    generationSettings: {
      preferredModel: text(s.preferredModel || 'claude-sonnet-5', 128), fallbackModel: text(s.model || 'claude-haiku-4-5', 128),
      maxTokens: number(s.maxTokens || 16000), thinkingEffort: text(s.thinkingEffort || 'low', 32),
      continuityDepth: number(s.continuityDepth ?? 5),
    },
    selectedEvidence: list(run?.headlines, snapshotHeadline, MAX_INPUTS),
    deterministicFacts: text(groundTruth, 65536),
    grounding: {
      cves: list([...(groundingManifest?.cves || [])], item => text(item, 128), 10000),
      urls: list([...(groundingManifest?.urls || [])], sourceUrl, 2001),
      sources: list(groundingManifest?.members, source => ({
        id: text(source.id, 128), index: number(source.index), memberIndex: number(source.memberIndex),
        label: text(source.label, 512), title: text(source.title), url: sourceUrl(source.url),
        publishedAt: text(source.date, 128), evidenceText: text(source.evidenceText, 65536),
        retrievedAt: text(source.retrievedAt, 128), collectionStale: source.collectionStale === true,
        passage: text(source.passage, 65536), passageKind: text(source.passageKind, 64),
        quality: source.quality || null,
        cves: list([...(source.cves || [])], item => text(item, 128), 1000),
        sourceRevisions: list(source.sourceRevisions, evidenceReference),
      }), 2001),
    },
    continuity: {
      kind: 'prior-model-output-topic-labels-only', sha256: sha256(continuityContext),
      editions: list(previousBriefs, brief => ({ filename: validBriefFilename(brief.filename) ? brief.filename : '', contentSha256: sha256(brief.content) }), 10),
    },
    retention: { maxBytes: MAX_GENERATION_MANIFEST_BYTES, policy: 'Saved with the edition until the operator removes both files. Selected excerpts only; no full article cache or provider credentials.', promptRetention: 'SHA-256 of exact provider inputs and implementation files. Prompts are not retained. Rejected final drafts and these captured inputs are separately retained under the draft recovery policy.' },
    providerAttempts: [], validation: [],
  };
  serializeGenerationManifest(manifest);
  return manifest;
}

// The pipeline owns this snapshot, but never trust arbitrary persisted run keys.
function sanitizeScoringSnapshot(s) {
  return {
    schemaVersion: 1, implementationSha256: text(s.implementationSha256, 64),
    axisWeights: numbers(s.axisWeights, AXES), recencyHalfLifeHours: number(s.recencyHalfLifeHours),
    horizonWeights: numbers(s.horizonWeights, ['horizon1', 'horizon2', 'horizon3']), freshnessHours: number(s.freshnessHours),
    alertRules: list(s.alertRules, rule => ({ pattern: text(rule.pattern, 2048), boost: number(rule.boost) }), 250),
    domain: {
      id: text(s.domain?.id, 128),
      urgencyLexicon: Object.fromEntries(['critical', 'elevated', 'horizon1Promote'].map(key => [key, list(s.domain?.urgencyLexicon?.[key], item => text(item, 2048), 250)])),
      exploitation: numbers(s.domain?.exploitation, ['verified', 'critical', 'elevated', 'epss']),
      severity: { dataProperty: text(s.domain?.severity?.dataProperty, 128), pattern: text(s.domain?.severity?.pattern, 2048), max: number(s.domain?.severity?.max), bands: numbers(s.domain?.severity?.bands, ['critical', 'high', 'medium', 'low']) },
    },
  };
}

export function recordProviderAttempt(manifest, params) {
  if (manifest.providerAttempts.length >= 4) throw new Error('Generation manifest attempt limit exceeded');
  const entry = {
    attempt: manifest.providerAttempts.length + 1, model: text(params.model, 128),
    systemPromptSha256: sha256(params.system), messagesSha256: sha256(JSON.stringify(params.messages)),
    maxTokens: number(params.max_tokens), thinkingType: text(params.thinking?.type, 32),
    thinkingEffort: text(params.reasoning?.effort || params.output_config?.effort, 32),
  };
  manifest.providerAttempts.push(entry);
  return entry;
}

export function recordValidation(manifest, draft, result) {
  if (manifest.validation.length >= 8) throw new Error('Generation manifest validation limit exceeded');
  manifest.validation.push({ draftSha256: sha256(draft), valid: result.valid === true, warnings: list(result.warnings, item => text(item, 4096), 100), issues: list(result.issues, issue => ({ code: text(issue.code, 128), severity: text(issue.severity, 32), message: text(issue.message, 4096), ...(issue.location ? { location: { scope: text(issue.location.scope, 32), line: number(issue.location.line), excerpt: text(issue.location.excerpt, 300) } } : {}), ...(issue.sourceIds ? { sourceIds: list(issue.sourceIds, id => text(id, 128)) } : {}) }), 100), coverage: result.coverage || null, editorialReviewStatus: 'not-reviewed' });
}

export function validBriefFilename(filename) {
  return typeof filename === 'string' && /^brief-\d{4}-\d{2}-\d{2}(?:-\d{1,6})?\.md$/.test(filename);
}
export function generationManifestFilename(filename) {
  if (!validBriefFilename(filename)) throw new TypeError('Invalid briefing filename');
  return filename.replace(/\.md$/, '.manifest.json');
}
export function serializeGenerationManifest(manifest) {
  const json = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(json, 'utf8') > MAX_GENERATION_MANIFEST_BYTES) throw new Error('Generation manifest exceeds its retention limit');
  return json;
}
export function generationManifestAvailability(historyDir, filename) {
  const path = join(historyDir, generationManifestFilename(filename));
  const available = existsSync(path);
  return { status: available ? 'available' : 'unavailable', url: available ? `/api/brief/${encodeURIComponent(filename)}/manifest` : null, ...(available ? {} : { reason: 'No input manifest was saved for this edition.' }) };
}
export function readGenerationManifest(historyDir, filename) {
  const path = join(historyDir, generationManifestFilename(filename));
  if (!existsSync(path)) return null;
  if (statSync(path).size > MAX_GENERATION_MANIFEST_BYTES) throw new Error('Generation manifest exceeds its retention limit');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schemaVersion !== GENERATION_MANIFEST_VERSION || manifest.filename !== filename) throw new Error('Invalid generation manifest');
  if (manifest.outputSha256 !== sha256(readFileSync(join(historyDir, filename), 'utf8'))) throw new Error('Generation manifest does not match the saved edition');
  return manifest;
}

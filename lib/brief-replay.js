// Read-only evaluation of retained editions and recoverable drafts. No provider,
// current feed, settings, database initialization, or archive mutation is used.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readGenerationManifest, validBriefFilename, sha256 } from './generation-manifest.js';
import { readBriefDraft, validDraftId, validationSourceFromManifest, validationManifestForDraft } from './brief-drafts.js';
import { validateBrief, publicationDecision } from './validation.js';
import { canonicalActions } from './brief-editorial.js';
import { briefActionRecords } from './brief-composition.js';
import { SECTIONS, section, splitEntries, parseJudgments, judgmentCertainty, rawField, stripMd, sourceCitations } from './brief-schema.js';
import { marked } from 'marked';

const tally = issues => {
  const result = {};
  for (const issue of issues || []) result[issue.code] = (result[issue.code] || 0) + 1;
  return result;
};

function tokenText(tokens) {
  return tokens.map(token => {
    if (['html', 'code', 'space', 'hr'].includes(token.type)) return '';
    if (token.type === 'list') return tokenText(token.items);
    if (token.type === 'table') return tokenText([...token.header, ...token.rows.flat()]);
    return token.tokens ? tokenText(token.tokens) : String(token.text || '');
  }).join(' ');
}
const words = text => String(text).trim().match(/\S+/g)?.length || 0;
const distribution = values => values.reduce((result, value) => {
  const key = value || 'Unspecified';
  result[key] = (result[key] || 0) + 1;
  return result;
}, Object.create(null));

/** Descriptive measurements only. Counts do not establish useful prioritization,
 * source support, or equivalent meaning after editing. Hidden examples are not
 * reader prose; inline technical identifiers and citation labels are counted. */
export function briefReplayDiagnostics(content, capturedActions) {
  const tokens = marked.lexer(String(content || ''), { gfm: true });
  const sections = [];
  let active = { title: 'Document heading', tokens: [] };
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 2) {
      if (active.tokens.length) sections.push(active);
      active = { title: tokenText(token.tokens || [token]), tokens: [] };
    } else active.tokens.push(token);
  }
  if (active.tokens.length) sections.push(active);
  const executive = sections.find(row => /^EXECUTIVE SUMMARY\b/i.test(row.title));
  const summaryItems = (executive?.tokens || []).filter(token => token.type === 'list')
    .flatMap(token => token.items).filter(item => /^(?:Required decisions|Decisions required):\s/i.test(tokenText([item])));
  const executiveDecisionWords = words(tokenText(summaryItems));
  const totalVisibleWords = words(tokenText(tokens));
  const judgments = parseJudgments(content);
  const actionRecords = briefActionRecords(content, capturedActions);
  return {
    wordCounts: {
      totalVisibleWords, executiveDecisionWords,
      // The app presents this row through the compact shared-action view.
      // Report it separately so a copied action list cannot masquerade as
      // shorter underlying analysis, or inflate the body comparison.
      bodyWithoutExecutiveDecisions: totalVisibleWords - executiveDecisionWords,
      sections: sections.map(row => ({ title: row.title, words: words(tokenText(row.tokens)) })),
    },
    confidenceDistribution: distribution(judgments.map(row => judgmentCertainty(row.confidence).value)),
    decisionWindowDistribution: distribution(judgments.map(row => row.decision)),
    // Keep the authored rationale available beside the label distribution.
    // Uniform buckets alone cannot tell an evaluator whether urgency is wrong.
    prioritization: judgments.map((row, index) => ({
      signal: index + 1, title: row.title, confidence: judgmentCertainty(row.confidence),
      decisionWindow: row.decision, assessment: row.assessment,
      initialAction: row.actions[0]?.text || '',
    })),
    appActionRecordCount: actionRecords?.actions.length ?? null,
    appActionRecordsSource: actionRecords?.source || 'unavailable',
    actNowCount: actionRecords ? actionRecords.actions.filter(action => action.actNow).length : null,
  };
}

function expectationText(content, assertion) {
  let value = assertion.section ? section(content, assertion.section) : content;
  if (Number.isInteger(assertion.judgment) && assertion.judgment > 0) {
    value = splitEntries(section(content, SECTIONS.keyJudgments))[assertion.judgment - 1] || '';
  }
  if (assertion.field) value = rawField(value, assertion.field);
  return tokenText(marked.lexer(value, { gfm: true })).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function checkExpectations(content, assertions) {
  if (!Array.isArray(assertions) || assertions.length > 1000) throw new Error('Replay assertions must be a bounded array');
  const ids = new Set();
  return assertions.map(assertion => {
    if (typeof assertion?.id !== 'string' || !assertion.id.trim() || ids.has(assertion.id)
      || (!assertion.contains?.length && !assertion.excludes?.length)
      || ['contains', 'excludes'].some(key => assertion[key] !== undefined && (!Array.isArray(assertion[key])
        || assertion[key].some(text => typeof text !== 'string' || !text.trim())))
      || (assertion.judgment !== undefined && (!Number.isInteger(assertion.judgment) || assertion.judgment < 1 || assertion.judgment > 100))
      || ['section', 'field'].some(key => assertion[key] !== undefined && (typeof assertion[key] !== 'string' || !assertion[key].trim()))) {
      throw new Error('Each replay assertion needs a unique id, valid selector, and nonempty contains/excludes text arrays');
    }
    ids.add(assertion.id);
    const value = expectationText(content, assertion);
    const normalize = text => stripMd(String(text)).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const missing = (assertion.contains || []).filter(text => !value.includes(normalize(text)));
    const forbidden = (assertion.excludes || []).filter(text => value.includes(normalize(text)));
    return { id: assertion.id, passed: !missing.length && !forbidden.length, missing, forbidden };
  });
}

/** Compare an explicitly authored candidate with an immutable captured edition.
 * Authored assertions are review aids, never a general entailment checker or a
 * publication policy. An absent assertion set cannot certify a shorter draft. */
export function compareCapturedBriefs(original, candidate, manifest, { expectations = null } = {}) {
  const originalHash = sha256(original);
  if (manifest.outputSha256 !== originalHash) throw new Error('Captured manifest does not match the baseline copy');
  const baseline = replayCapturedBrief(original, manifest);
  const revised = replayCapturedBrief(candidate, manifest, { capturedValidation: {} });
  const before = briefActionRecords(original)?.actions;
  const after = briefActionRecords(candidate)?.actions;
  const signature = action => JSON.stringify([action.owner, action.response, action.target, action.actNow]);
  const originalActions = new Map((before || []).map(action => [action.id, signature(action)]));
  const candidateActions = new Map((after || []).map(action => [action.id, signature(action)]));
  const changedOrMissingActionIds = [...originalActions].filter(([id, value]) => candidateActions.get(id) !== value).map(([id]) => id);
  const addedActionIds = [...candidateActions.keys()].filter(id => !originalActions.has(id));
  const actionsUnchanged = Boolean(before && after && !changedOrMissingActionIds.length && !addedActionIds.length);
  const assertions = expectations?.assertions || [];
  const baselineAssertions = checkExpectations(original, assertions);
  const candidateAssertions = checkExpectations(candidate, assertions);
  const expectationsBound = expectations?.originalSha256 === originalHash && assertions.length > 0;
  const assertionsPass = expectationsBound && baselineAssertions.every(row => row.passed) && candidateAssertions.every(row => row.passed);
  const factualChecksPass = revised.currentChecks.canPublish && !revised.currentChecks.requiresReview;
  const beforeWords = baseline.diagnostics.wordCounts.bodyWithoutExecutiveDecisions;
  const afterWords = revised.diagnostics.wordCounts.bodyWithoutExecutiveDecisions;
  const citedUrls = text => new Set(sourceCitations(text).map(citation => citation.url).filter(Boolean));
  const candidateUrls = citedUrls(candidate);
  return {
    schemaVersion: 1, mode: 'offline-authored-editorial-comparison',
    originalSha256: originalHash, candidateSha256: sha256(candidate), baseline, candidate: revised,
    comparison: {
      bodyWordsRemoved: beforeWords - afterWords,
      bodyShorter: afterWords < beforeWords,
      bodyReductionPercent: beforeWords ? Math.round((beforeWords - afterWords) * 1000 / beforeWords) / 10 : 0,
      actionsUnchanged, changedOrMissingActionIds, addedActionIds,
      removedCitationUrls: [...citedUrls(original)].filter(url => !candidateUrls.has(url)),
      expectationsBound, baselineAssertions, candidateAssertions, factualChecksPass,
      // Passing means these particular comparisons passed, not that the edit
      // has been semantically proven correct or approved for publication.
      comparisonChecksPassed: factualChecksPass && actionsUnchanged && assertionsPass,
    },
    limits: ['This is an authored offline revision, not a new provider response.',
      'Word counts and label distributions are diagnostics, not quality scores or urgency quotas.',
      'Unchanged complete action records and authored scope assertions supplement, but do not replace, analyst review of source support.',
      'The captured edition and its publication policy are not rewritten; current checks apply only to this comparison.'],
  };
}

export function replayCapturedBrief(content, manifest, { capturedValidation = manifest.publicationValidation } = {}) {
  const checked = validateBrief(content, manifest.edition?.date, validationSourceFromManifest(manifest, content));
  const decision = publicationDecision({ ...checked, partial: capturedValidation?.partial === true });
  const original = [...(manifest.validation || [])].reverse().find(row => row.draftSha256 === sha256(content));
  const sources = manifest.grounding.sources;
  const ids = [...new Set(sources.flatMap(source => source.cves || []))];
  return {
    status: 'replayed', contentSha256: sha256(content),
    currentChecks: { canPublish: decision.canPublish, requiresReview: decision.requiresReview,
      blockerCount: decision.blockers.length, reviewCount: decision.reviewIssues.length, issueCodes: tally(checked.issues),
      capturedPartial: capturedValidation?.partial === true },
    capturedChecks: original ? { valid: original.valid, issueCodes: tally(original.issues) } : null,
    priorityCoverage: checked.priorityCoverage,
    sourceQuality: checked.sourceQuality,
    diagnostics: {
      ...briefReplayDiagnostics(content, manifest.actionRecords),
      judgmentCount: splitEntries(section(content, SECTIONS.keyJudgments)).length,
      structuredActionCount: canonicalActions(content).length,
      capturedSourceCount: sources.length,
      sourceCvesMentioned: ids.filter(id => content.toUpperCase().includes(id.toUpperCase())).length,
      sourceCvesAvailable: ids.length,
      // These are lexical diagnostics, not evidence of semantic correctness.
      actionConditionMarkers: canonicalActions(content).filter(action => /\bif\b|\bwhen\b|\bonly\b|\bconfirm\b/i.test(action.text)).length,
      evidenceRevisionCount: new Set(sources.flatMap(source => (source.sourceRevisions || []).map(ref => ref.revisionId)).filter(Boolean)).size,
    },
    providerAttempts: manifest.providerAttempts?.length ?? null,
    costUsd: Number.isFinite(manifest.costEstimate?.usd) ? manifest.costEstimate.usd : null,
    phaseTimingsMs: manifest.phaseTimingsMs || null,
    selection: manifest.collection?.selection || null,
  };
}

export function replayBriefArchive(historyDir, { limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Replay limit must be 1–500');
  const files = readdirSync(historyDir).filter(validBriefFilename).sort().reverse();
  const editions = files.slice(0, limit).map(filename => {
    try {
      if (statSync(join(historyDir, filename)).size > 500000) throw new Error('Edition exceeds replay size limit');
      const manifest = readGenerationManifest(historyDir, filename);
      if (!manifest) return { filename, status: 'receipt-unavailable' };
      return { filename, ...replayCapturedBrief(readFileSync(join(historyDir, filename), 'utf8'), manifest) };
    } catch (error) { return { filename, status: 'unreplayable', reason: error.message }; }
  });
  const drafts = [];
  const dir = join(historyDir, '.rejected-drafts');
  const draftFiles = existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json') && validDraftId(file.slice(0, -5))).sort() : [];
  for (const filename of draftFiles.slice(0, limit)) {
    const id = filename.slice(0, -5);
    try {
      const artifact = readBriefDraft(historyDir, id);
      if (!artifact) { drafts.push({ id, status: 'outside-retention' }); continue; }
      drafts.push({ id, publication: artifact.publication?.filename || null,
        operatorSaved: Boolean(artifact.operatorSavedAt), revisionCount: artifact.revisions.length,
        revisions: artifact.revisions.map(revision => ({ number: revision.number, ...replayCapturedBrief(revision.content,
          validationManifestForDraft({ ...artifact, revisions: [revision] }), { capturedValidation: revision.validation }) })) });
    } catch (error) { drafts.push({ id, status: 'unreplayable', reason: error.message }); }
  }
  return { schemaVersion: 1, evaluatedAt: new Date().toISOString(), mode: 'offline-retained-evidence',
    summary: { editionsFound: files.length, editionsExamined: editions.length,
      replayed: editions.filter(row => row.status === 'replayed').length,
      receiptUnavailable: editions.filter(row => row.status === 'receipt-unavailable').length,
      unreplayable: editions.filter(row => row.status === 'unreplayable').length,
      currentlyRequireReview: editions.filter(row => row.currentChecks?.requiresReview).length,
      currentlyBlocked: editions.filter(row => row.currentChecks && !row.currentChecks.canPublish).length,
      draftArtifactsFound: draftFiles.length, draftArtifactsExamined: drafts.length,
      retainedDraftsWithOperatorSaves: drafts.filter(row => row.operatorSaved).length },
    limits: ['Historical selected evidence cannot establish recall for candidates not retained.',
      'Action and CVE counts are lexical diagnostics, not scores of usefulness or supported meaning.',
      'Retained drafts are a retention-limited sample; operator saves do not establish the overall manual intervention rate.',
      'Missing timings, costs, and receipts stay unknown; no archive is rewritten.'],
    editions, drafts };
}

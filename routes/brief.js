// BlueTeam.News — briefing generation (SSE) + history + search routes.

import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { getConfig, getHorizonName } from '../lib/config.js';
import { getFreshRun } from '../lib/refresher.js';
import { buildSystemPrompt, buildUserPrompt } from '../lib/prompts.js';
import { buildBriefFactLedger, repairFindingContext } from '../lib/brief-fact-ledger.js';
import {
  saveBrief,
  loadRecentBriefs,
  listBriefEditions,
  extractContinuityContext,
  extractBluf,
  briefDateFromFilename,
  localDateISO,
  scheduledBriefFilename,
  scheduledBriefJobKey,
} from '../lib/history.js';
import { validateBrief, countHorizons, hasHardFail, hasTrustCriticalFailure, captureKevTiming, publicationDecision } from '../lib/validation.js';
import { canonicalizeExecutiveActions, compareEditionInputs } from '../lib/brief-editorial.js';
import { saveBriefDisposition } from '../lib/brief-review.js';
import { briefReadingState, loadBriefReadingState, briefPresentation, presentationSourceCheckStatus } from '../lib/brief-reading-checks.js';
import { listBriefDrafts, readBriefDraft, saveRejectedBrief, revalidateBriefDraft, summarizeBriefDraft, validationSourceFromManifest, validDraftId, draftValidation, recordDraftPublication } from '../lib/brief-drafts.js';
import { createPublicationLookup, verifyPublicationReplay, publishDraftEdition } from '../lib/brief-publication.js';
import { normalizeConvergenceOpening } from '../lib/brief-schema.js';
import { buildGroundingManifest, delinkUnallowlistedMarkdownUrls, visibleHeadlineEvidence } from '../lib/grounding.js';
import {
  parseJudgments, WATCHLIST_MIN_ITEMS, WATCHLIST_MAX_ITEMS,
} from '../lib/brief-schema.js';
import { getEffectiveOrganization, getEffectiveWatchProfile } from '../lib/user-settings.js';
import {
  buildGenerationManifest, readGenerationManifest,
  recordProviderAttempt, recordValidation, sha256, validBriefFilename,
} from '../lib/generation-manifest.js';
import {
  saveBriefMeta, getBriefMeta, indexBrief, searchBriefs,
  countKEVAddedToday, getRecentKEV, getKEVSet, getKEVDueDates,
  completeScheduledBriefJob, getScheduledBriefJob,
} from '../lib/db.js';
import { dispatchBriefWebhook } from '../lib/alerts.js';
import { log } from '../lib/logger.js';
import { recordStorageOutcome } from '../lib/storage-health.js';
import { createGenerationJobs, registerGenerationJobs } from '../lib/generation-jobs.js';
import { localhostBaseUrl, normalizePublicBaseUrl } from '../lib/public-url.js';
import {
  deferBriefGenerationAccounting,
  finalizeBriefGenerationAccounting,
} from '../lib/middleware.js';

// Adaptive thinking lifts synthesis-and-judgment quality, but only some models
// accept it — Haiku 4.5 (the cost fallback) 400s on the param. Gate by model so
// the fallback path stays valid.
// Exported for unit testing: pure/self-contained helpers with no route
// wiring, so the model-fallback trigger, SSE event framing, and redaction rules
// can be pinned directly without booting the full app or an HTTP server.
export function supportsAdaptiveThinking(model) {
  return /opus-4-[678]|sonnet-5|fable-5/.test(model || '');
}

// First-party API list prices per million tokens. Unknown models have no estimate.
function modelPrice(model, inputTokens = 0) {
  const id = String(model || '').toLowerCase();
  if (/^gpt-6\.1-sol(?:$|-)/.test(id)) return inputTokens > 272000
    ? { input: 4, cachedInput: 0.2, cacheWriteInput: 5, output: 15 }
    : { input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10 };
  if (/^gpt-5\.3-codex(?:$|-)/.test(id)) return { input: 1.75, cachedInput: 0.175, output: 14 };
  if (/claude-sonnet-5(?:$|-)/.test(id)) return { input: 2, output: 10 };
  if (/claude-haiku-4-5/.test(id)) return { input: 1, output: 5 };
  if (/claude-opus-4-[5678]/.test(id)) return { input: 5, output: 25 };
  if (/claude-fable-5/.test(id)) return { input: 10, output: 50 };
  return null;
}

export function estimateCostUsd(model, inputTokens, outputTokens, at = new Date(), cachedInputTokens = 0, cacheWriteInputTokens = 0) {
  const price = modelPrice(model, inputTokens);
  if (!price) return null;
  const cached = price.cachedInput == null ? 0 : Math.min(Math.max(0, cachedInputTokens || 0), inputTokens || 0);
  const written = price.cacheWriteInput == null ? 0 : Math.min(Math.max(0, cacheWriteInputTokens || 0), (inputTokens || 0) - cached);
  return ((inputTokens || 0) - cached - written) / 1e6 * price.input + cached / 1e6 * (price.cachedInput || 0)
    + written / 1e6 * (price.cacheWriteInput || 0) + (outputTokens || 0) / 1e6 * price.output;
}

/** Preserve the rates for each paid attempt; fallback models have different prices. */
export function estimateAttemptCosts(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return null;
  const costs = attempts.map(attempt => attempt.costUsd ?? estimateCostUsd(
    attempt.responseModel || attempt.model, attempt.usage?.inputTokens, attempt.usage?.outputTokens,
    undefined, attempt.usage?.cachedInputTokens, attempt.usage?.cacheWriteInputTokens,
  ));
  return costs.some(cost => cost == null) ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

// Archive cards show a readable excerpt, with omission made explicit. Strip
// inline Markdown before shortening so a long citation URL cannot consume it.
function archiveBluf(value) {
  const text = String(value || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= 250) return text;
  const prefix = text.slice(0, 249);
  const boundary = prefix.lastIndexOf(' ');
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

// Apply (or remove) adaptive thinking on a model param set, honoring the
// configured effort. Low is the default; higher effort on a large brief can
// consume the shared output budget before completing the cited document.
export function applyThinking(params, model, effort, client = {}) {
  if (typeof client.configureRequest === 'function') return client.configureRequest(params, { effort });
  if (typeof client.stream === 'function') return;
  if (effort && effort !== 'off' && supportsAdaptiveThinking(model)) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { ...(params.output_config || {}), effort };
  } else {
    // Sonnet 5 thinks adaptively when the field is omitted. "Off" must therefore
    // be explicit; older adaptive models retain their prior omit-to-disable path.
    if (/claude-sonnet-5(?:$|-)/.test(model || '')) params.thinking = { type: 'disabled' };
    else delete params.thinking;
    if (params.output_config) {
      delete params.output_config.effort;
      if (Object.keys(params.output_config).length === 0) delete params.output_config;
    }
  }
}

// These are request facts, not a claim that a remote model used reasoning.
function thinkingConfiguration(params, requestedEffort, client) {
  const explicitEffort = params.reasoning?.effort || params.output_config?.effort
    || (params.thinking?.type === 'disabled' ? 'off' : null);
  return {
    requestedEffort,
    configuredBy: typeof client.configureRequest === 'function' ? 'adapter-hook'
      : typeof client.stream === 'function' ? 'adapter-default' : 'built-in',
    requestEffort: typeof explicitEffort === 'string' ? explicitEffort.slice(0, 32) : null,
  };
}

function reducedRecoveryThinkingEffort(effort) {
  return effort === 'low' || effort === 'off' ? 'off' : 'low';
}

/** Explain how to repair the failed contract, not just repeat its error code. */
export function correctiveGuidance(issues = []) {
  const codes = new Set(issues.map(issue => issue.code));
  const rules = [];
  if (codes.has('CONVERGENCE_EVIDENCE_WEAK')) {
    rules.push('Convergence repair: the **The intersection:** paragraph itself must contain exact bracketed citations for both substantive sources, using their supplied publisher, Published date and URL. Naming publishers in prose or citing them only in another field does not meet this contract. Do not attach citations to a mechanism they do not establish. If two substantive citations cannot support the connection, replace the entries with the plain sentence "No supported intersection is established by the current retained evidence." under CONVERGENCE, with no entry heading or fields.');
  }
  if ([...codes].some(code => /CVSS/.test(code))) {
    rules.push('Score repair: each numeric score needs the exact source citation that supplies that CVE and score in the same judgment\'s What happened field. Write one explicit pair per clause: "CVE-YYYY-NNNN: CVSS v3.1 score N.N" (use only captured values). Do not use an unassigned list of scores or "respectively". An NVD-only score requires the supplied NVD citation; a catalog listing does not supply it. Preserve metric versions and per-record provisional status. Omit any score that the cited passage does not support.');
  }
  if (codes.has('CVE_CITATION_MISMATCH') || codes.has('VERSION_UNSUPPORTED')) {
    rules.push('Evidence repair: a source elsewhere in the input is not automatically cited support for this judgment. Add the exact supplied publisher/date/URL citation for the affected CVE or version to this judgment\'s What happened field. Use only the retained passage and captured lookup facts; a product name or article link alone does not establish an identifier or version. Remove unsupported detail rather than guessing it.');
  }
  if ([...codes].some(code => /KEV_DEADLINE/.test(code))) {
    rules.push('Deadline repair: copy the captured SYSTEM-DERIVED FACTS date for each named CVE exactly. Name the CVE explicitly beside its FCEB remediation date; do not infer a default two-week deadline or substitute a recommended internal target.');
  }
  if (codes.has('JUDGMENT_ACTION_INVALID')) {
    rules.push('Action repair: each recommended action must be a separate Markdown bullet with an owner role, an imperative and its recommended target date. Use the canonical shape "- **Owner role** — verify the applicable control — recommended target Month D, YYYY." Keep applicability conditional where deployment is unknown.');
  }
  return rules.join('\n');
}

/**
 * Deterministic facts computed from the data — handed to the model as ground
 * truth so trend claims ("KEV up since yesterday") are verified rather than
 * confabulated from the continuity context.
 */
// Exported for unit testing: buildGroundTruth is the one place the
// system tells the model "never contradict this" — pinned here against a
// mocked db.js so a KEV-facts wording regression is caught. The underlying
// date-comparison correctness of countKEVAddedSince/getKEVSet/getRecentKEV
// themselves lives in lib/db.js.
export function buildGroundTruth(run) {
  const lines = [];
  try {
    // An empty catalog means KEV hasn't been loaded yet (first run still
    // enriching), not that there are zero entries — say "unavailable" rather
    // than asserting "no new entries", which would be a status-that-lies.
    const catalogLoaded = getKEVSet().size > 0;
    if (!catalogLoaded) {
      lines.push('• CISA KEV catalog: not yet loaded this run — treat KEV status as unknown, do not state a new-entry count.');
    } else {
      // Same-day count: KEV date_added is day-granular, so a "last 24h" window
      // would span up to 48h of calendar dates. countKEVAddedToday matches
      // the number the Wall and /api/landscape already show.
      const kev24 = countKEVAddedToday();
      if (kev24 > 0) {
        let names = '';
        try {
          const recent = getRecentKEV(kev24).map(k => k.cve_id);
          if (recent.length) names = `: ${recent.join(', ')}`;
        } catch { /* names are optional */ }
        lines.push(`• CISA KEV catalog: ${kev24} new ${kev24 === 1 ? 'entry' : 'entries'} added today${names}.`);
      } else {
        lines.push('• CISA KEV catalog: no new entries added today.');
      }

      // The Wire already has authoritative KEV added/due dates, but the brief
      // prompt previously discarded them. Resolve every CVE visible to the model
      // (not only headline.kevCVE) so a source-body CVE such as a Joomla entry
      // cannot acquire a made-up same-shift cutoff. CISA dates are day-granular
      // and BOD remediation dates apply to FCEB agencies; neither property may be
      // silently promoted into this organization's internal clock-time target.
      const visibleCves = new Set();
      for (const headline of (run?.headlines || [])) {
        for (const match of visibleHeadlineEvidence(headline).matchAll(/CVE-\d{4}-\d{3,7}/gi)) {
          visibleCves.add(match[0].toUpperCase());
        }
      }
      const kevTiming = getKEVDueDates([...visibleCves]);
      for (const [cve, timing] of Object.entries(kevTiming).sort(([a], [b]) => a.localeCompare(b))) {
        const added = timing.date_added
          ? `catalog added ${timing.date_added}`
          : 'catalog addition date unavailable';
        lines.push(`• CISA KEV record (date-only; FCEB scope): ${cve} — ${added}; FCEB remediation due ${timing.due_date}. Do not add a clock time or timezone, and do not present the FCEB date as this organization's internal recommended target.`);
      }
    }
  } catch { /* KEV facts optional */ }

  // Failure keys identify separate providers. A missing article body must not
  // turn successfully retained NVD scores or KEV records into a general outage.
  const failed = new Set((run?.stats?.enrichmentFailures || []).map(key => String(key).toLowerCase()));
  if (failed.has('cve') || failed.has('cvss')) {
    lines.push('• Enrichment note — NVD: some current CVE lookups were incomplete. Missing scores and affected-product details remain unconfirmed, never "not severe" or "no vulnerability." Use available cited records and preserve any per-record provisional status; do not label every retained score provisional.');
  }
  if (failed.has('kev')) {
    lines.push('• Enrichment note — KEV: the current catalog refresh was incomplete. Do not infer non-membership from missing data. Any system-verified records shown above retain their captured facts; a refresh failure does not establish a changed catalog status.');
  }
  if (failed.has('epss')) {
    lines.push('• Enrichment note — EPSS: some exploitation-probability lookups were incomplete. Do not substitute an estimate for a missing EPSS value or infer that CVSS or KEV collection failed.');
  }
  if (failed.has('article')) {
    lines.push('• Enrichment note — article retrieval: some current article bodies could not be obtained. Use each source\'s shown passage quality and retained excerpt to determine what it supports. This does not invalidate successful NVD or KEV lookups; mention the retrieval gap only where it limits a specific assessment.');
  }
  const otherFailures = [...failed].filter(key => !['cve', 'cvss', 'kev', 'epss', 'article'].includes(key));
  if (otherFailures.length) {
    lines.push(`• Enrichment note — other incomplete stages: ${otherFailures.join(', ')}. Scope any caveat to those stages and the affected source records; do not infer failures in other providers.`);
  }

  if (lines.length === 0) return '';
  return '\n\nSYSTEM-DERIVED FACTS (computed deterministically from the data — treat as ground truth; ' +
    'use where relevant and never contradict or restate as your own estimate):\n' + lines.join('\n');
}

/**
 * Stream a generation with recovery:
 * buffers chunks (partial briefing always recoverable), applies a hard
 * timeout, and propagates mid-stream errors instead of swallowing them.
 */
export async function streamWithRecovery(client, params, { timeoutMs = 180_000, onChunk, onUsage } = {}) {
  let fullText = '';
  let stream;
  let iterator;
  let iterationComplete = false;
  let timedOut = false;
  let streamError = null;
  let stopReason = null;
  let terminalReceived = false;
  let responseModel = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const abortController = new AbortController();
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  const timeoutMarker = Symbol('generation-timeout');
  let genTimeout;
  const closeIterator = value => {
    // A subprocess adapter may never settle return() while next() is pending.
    // Request cleanup without letting it hold the HTTP request or generation lock.
    Promise.resolve().then(() => typeof value?.return === 'function' ? value.return() : undefined).catch(() => {});
  };
  const abortStream = value => {
    try { value?.controller?.abort(); } catch { /* best effort */ }
  };
  const deadline = new Promise(resolve => {
    genTimeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      abortStream(stream);
      resolve(timeoutMarker);
    }, boundedTimeoutMs);
  });

  try {
    const streamResult = await Promise.race([
      Promise.resolve().then(() => (typeof client.stream === 'function' ? client.stream.bind(client) : client.messages.stream.bind(client.messages))(params, {
        signal: abortController.signal,
        timeout: boundedTimeoutMs,
        maxRetries: 0,
      })).then(opened => {
        if (timedOut) {
          abortStream(opened);
          try { closeIterator(opened?.[Symbol.asyncIterator]?.() || opened?.[Symbol.iterator]?.()); }
          catch { /* late stream setup cannot undo the timeout */ }
        }
        return opened;
      }),
      deadline,
    ]);
    if (streamResult === timeoutMarker) {
      log.warn('stream', `Generation timeout (${boundedTimeoutMs / 1000}s) before the stream opened`);
      return { text: fullText, error: null, timedOut: true, usage, stopReason };
    }
    stream = streamResult;
  } catch (err) {
    clearTimeout(genTimeout);
    return { text: fullText, error: timedOut ? null : err, timedOut, usage };
  }

  try {
    iterator = stream?.[Symbol.asyncIterator]?.() || stream?.[Symbol.iterator]?.();
    if (!iterator || typeof iterator.next !== 'function') throw new Error('Provider returned no iterable response stream.');
    while (true) {
      // Racing every next() also bounds adapters that ignore AbortSignal. Late
      // settlements are observed by Promise.race but cannot append output/usage.
      const next = await Promise.race([Promise.resolve().then(() => iterator.next()), deadline]);
      if (timedOut || next === timeoutMarker) break;
      if (next.done) { iterationComplete = true; break; }
      const event = next.value;
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
        if (onChunk) onChunk(event.delta.text, fullText);
      }
      if (event.type === 'message_start' && typeof event.message?.model === 'string') {
        responseModel = event.message.model.slice(0, 128);
      }
      const reportedUsage = event.type === 'message_start' ? event.message?.usage : event.usage;
      // Either normalized usage event may supply cumulative counts. Omitted or
      // invalid fields must not erase a previous checkpoint; explicit zero is valid.
      for (const [field, value] of Object.entries({
        input_tokens: reportedUsage?.input_tokens, output_tokens: reportedUsage?.output_tokens,
        cached_input_tokens: reportedUsage?.input_tokens_details?.cached_tokens,
        cache_write_input_tokens: reportedUsage?.input_tokens_details?.cache_write_tokens,
        reasoning_tokens: reportedUsage?.output_tokens_details?.reasoning_tokens,
        cost_usd: reportedUsage?.cost_usd,
      })) {
        if (Number.isFinite(value) && value >= 0) usage[field] = value;
      }
      if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason;
      }
      if (event.type === 'message_stop') terminalReceived = true;
      if (onUsage && ((event.type === 'message_start' && event.message?.usage)
        || (event.type === 'message_delta' && event.usage))) onUsage({ ...usage }, responseModel);
      // The normalized terminal event confirms completion. Waiting for another
      // next() would let subprocess cleanup turn a completed answer into a timeout,
      // or append data after the terminal boundary. Validate its reason below.
      if (terminalReceived) break;
    }
    if (!timedOut && (!terminalReceived || !stopReason)) {
      throw Object.assign(new Error('Provider stream ended before verified completion.'), { code: 'E_PROVIDER_INCOMPLETE' });
    }
    if (!timedOut && !['end_turn', 'max_tokens', 'refusal'].includes(stopReason)) {
      throw Object.assign(new Error('Provider returned an unsupported stop reason. The adapter must report end_turn, max_tokens, or refusal.'), { code: 'E_PROVIDER_INCOMPLETE' });
    }
  } catch (err) {
    if (!timedOut) {
      streamError = err;
      abortController.abort();
      abortStream(stream);
      log.warn('stream', `Stream interrupted: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
    }
  } finally {
    clearTimeout(genTimeout);
    if (!iterationComplete) closeIterator(iterator);
    if (timedOut) {
      log.warn('stream', `Generation timeout (${boundedTimeoutMs / 1000}s) — provider completion remains unverified`);
    }
  }

  return { text: fullText, error: streamError, timedOut, usage, stopReason, responseModel, terminalReceived };
}

export function safeErrorMsg(err) {
  // Provider/client errors should never echo credential-shaped material to an
  // SSE client, even if an upstream library includes it in a diagnostic.
  const reason = typeof err?.reason === 'string' ? err.reason.trim() : '';
  const msg = (reason || err?.message || '').trim()
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z\d_.~+/-]+/gi, 'Bearer [REDACTED]');
  if (!msg) return 'Internal server error';
  if (reason) return msg.slice(0, 300);
  if (['E_EVIDENCE', 'E_PROVIDER_INCOMPLETE'].includes(err?.code)) return msg.slice(0, 300);
  if (/API key|not configured|rate limit|overloaded|529|timeout|timed out|model|refus|not found|404|400|401|403|429|5\d\d/i.test(msg)) {
    return msg.slice(0, 300);
  }
  if (err?.status) return `HTTP ${err.status}: ${msg.slice(0, 200)}`;
  // Anything else (a raw fs/db error, say) may embed a local path or other
  // internal detail — keep it in the server log only, never on the wire.
  return 'Generation failed — see server logs';
}

// Parse the persisted warnings column (JSON array) back to a list, defensively. [G]
function parseWarnings(json) {
  if (!json) return [];
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

function editionCost(receipt, meta, at) {
  // Explicit unknown provider accounting is evidence, not permission to infer
  // a new cost from the repaired edition's empty token metadata.
  if (receipt?.costEstimate) return receipt.costEstimate.usd ?? null;
  if (!meta || (meta.input_tokens == null && meta.output_tokens == null)) return null;
  return estimateCostUsd(meta.model_used, meta.input_tokens, meta.output_tokens, at);
}

const originalEditionWarnings = (receipt, meta) => [...new Set([
  ...(receipt?.validation?.warnings || []), ...parseWarnings(meta?.warnings),
])];

const SCHEDULED_TOKEN_HEADER = 'x-blueteam-scheduled-token';

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function parseScheduledJob(req, scheduledJobToken) {
  if (!tokenMatches(req.get(SCHEDULED_TOKEN_HEADER), scheduledJobToken)) return null;
  const source = req.body?.scheduledJob;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw Object.assign(new Error('Scheduled briefing context is missing.'), { code: 'E_SCHEDULE_CONTEXT' });
  }
  const editionDate = typeof source.editionDate === 'string' ? source.editionDate : '';
  const expectedJobKey = scheduledBriefJobKey(editionDate);
  if (source.jobKey !== expectedJobKey) {
    throw Object.assign(new Error('Scheduled briefing job key does not match its edition date.'), { code: 'E_SCHEDULE_CONTEXT' });
  }
  const timezone = typeof source.timezone === 'string' ? source.timezone : '';
  if (!timezone || timezone.length > 100) {
    throw Object.assign(new Error('Scheduled briefing timezone is invalid.'), { code: 'E_SCHEDULE_CONTEXT' });
  }
  if (timezone !== 'local') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw Object.assign(new Error('Scheduled briefing timezone is invalid.'), { code: 'E_SCHEDULE_CONTEXT' });
    }
  }
  return { jobKey: expectedJobKey, editionDate, timezone };
}

function sendCompletedBrief(res, payload) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`data: ${JSON.stringify({ briefComplete: true, ...payload })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function recoverScheduledPublication(historyDir, scheduledJob, reviewDirectory) {
  const filename = scheduledBriefFilename(scheduledJob.editionDate);
  let recorded = null;
  try {
    recorded = getScheduledBriefJob(scheduledJob.jobKey);
  } catch (err) {
    // The deterministic archive remains the primary no-repay marker if SQLite
    // is temporarily unavailable during restart recovery.
    log.warn('brief', `Scheduled job lookup failed; checking its archive directly: ${err.message}`);
  }
  if (recorded && (
    recorded.edition_date !== scheduledJob.editionDate
    || recorded.timezone !== scheduledJob.timezone
    || recorded.filename !== filename
  )) {
    throw Object.assign(
      new Error(`Scheduled briefing job ${scheduledJob.jobKey} is bound to inconsistent publication metadata.`),
      { code: 'E_SCHEDULE_STATE' },
    );
  }

  const target = join(historyDir, filename);
  if (!existsSync(target)) return null;
  const reading = loadBriefReadingState(historyDir, filename, { reviewDirectory });
  const publication = reading.manifest?.publicationValidation;
  if (reading.receipt.integrity !== 'verified' || publication?.partial !== false
    || publication?.hardFail !== false || publication?.trustFail !== false
    || reading.manifest.edition?.date !== scheduledJob.editionDate
    || reading.manifest.edition?.timezone !== scheduledJob.timezone || reading.manifest.edition?.scheduled !== true) {
    throw Object.assign(new Error('The reserved scheduled edition needs publication recovery. Its original has been preserved.'), { code: 'E_SCHEDULE_INTEGRITY' });
  }
  const text = reading.content;
  const completedAt = recorded?.completed_at || statSync(target).mtime.toISOString();
  try {
    completeScheduledBriefJob({
      jobKey: scheduledJob.jobKey,
      editionDate: scheduledJob.editionDate,
      timezone: scheduledJob.timezone,
      filename,
      completedAt,
    });
  } catch (err) {
    log.warn('brief', `Scheduled job completion reconciliation failed: ${err.message}`);
  }
  return { filename, text, completedAt, reading };
}

export function createBriefRouter({
  reviewDir,
  getAnthropic,
  getAiClient = getAnthropic,
  rotateKey,
  historyDir,
  cooldown,
  publicBaseUrl = null,
  localPort = process.env.PORT || 3000,
  scheduledJobToken = '',
  loopback = true,
  trackGeneration = () => () => {},
  onDraftPublished = () => {},
}) {
  const router = Router();
  const outwardBaseUrl = normalizePublicBaseUrl(publicBaseUrl) || localhostBaseUrl(localPort);
  const publications = createPublicationLookup(historyDir);
  const jobs = createGenerationJobs({ recoverPublished: publications.findGeneration });
  registerGenerationJobs(jobs);
  const publicDraft = artifact => artifact ? { ...artifact, publicationDecision: publicationDecision(draftValidation(artifact)) } : null;
  const reconcileDraft = artifact => {
    if (!artifact) return null;
    const found = publications.findDraft(artifact);
    if (!found) return artifact;
    const repaired = found.manifest.repairedDraft;
    const publication = { revision: repaired.revision, contentSha256: repaired.contentSha256, inputSha256: repaired.inputSha256,
      filename: found.filename, publishedAt: found.manifest.generatedAt };
    try { return recordDraftPublication(historyDir, artifact.id, publication) || artifact; }
    catch { return { ...artifact, status: 'published', publication }; }
  };
  const pendingDrafts = () => listBriefDrafts(historyDir).filter(item => !publications.findDraft(item));

  router.get('/brief/status', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!loopback && res.locals.authenticated !== true) return res.status(403).json({ code: 'E_EXPOSED', error: 'Generation status requires a local or authenticated connection.' });
    const status = jobs.status();
    const drafts = pendingDrafts();
    return res.status(status.persistence === 'error' ? 503 : 200).json({ ...status, draftRecovery: { url: '/api/brief/drafts', latest: drafts[0] || null, count: drafts.length, items: drafts } });
  });

  const recoveryAccess = (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!loopback && res.locals.authenticated !== true) return res.status(403).json({ code: 'E_EXPOSED', error: 'Retained drafts require a local or authenticated connection.' });
    next();
  };
  router.get('/brief/drafts', recoveryAccess, (req, res) => {
    try { res.json({ items: pendingDrafts() }); }
    catch { res.status(503).json({ code: 'E_DRAFT_STORAGE', error: 'Retained drafts could not be read.' }); }
  });
  router.get('/brief/drafts/:id', recoveryAccess, (req, res) => {
    if (!validDraftId(req.params.id)) return res.status(400).json({ error: 'Invalid draft identifier' });
    try {
      const artifact = reconcileDraft(readBriefDraft(historyDir, req.params.id));
      return artifact ? res.json(publicDraft(artifact)) : res.status(404).json({ code: 'E_DRAFT_UNAVAILABLE', error: 'Draft unavailable or outside the retention window.' });
    } catch { return res.status(409).json({ code: 'E_DRAFT_INTEGRITY', error: 'The retained draft or input digest could not be verified.' }); }
  });
  router.post('/brief/drafts/:id/revalidate', recoveryAccess, (req, res) => {
    if (!validDraftId(req.params.id)) return res.status(400).json({ error: 'Invalid draft identifier' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || (req.body.content !== undefined && typeof req.body.content !== 'string')
      || (req.body.baseRevision !== undefined && (!Number.isSafeInteger(req.body.baseRevision) || req.body.baseRevision < 1))) return res.status(400).json({ error: 'Invalid repair revision.' });
    try {
      const existing = reconcileDraft(readBriefDraft(historyDir, req.params.id));
      if (existing?.publication) return res.status(409).json({ code: 'E_DRAFT_PUBLISHED', error: 'This draft has already been published. Open the published edition.', artifact: publicDraft(existing) });
      const artifact = revalidateBriefDraft(historyDir, req.params.id, req.body,
        (content, manifest) => validateBrief(content, manifest.edition?.date, validationSourceFromManifest(manifest)));
      return artifact ? res.json(publicDraft(artifact)) : res.status(404).json({ code: 'E_DRAFT_UNAVAILABLE', error: 'Draft unavailable or outside the retention window.' });
    } catch (error) { return res.status(error.code === 'E_DRAFT_CONFLICT' ? 409 : 400).json({ code: error.code || 'E_DRAFT_REVALIDATION', error: safeErrorMsg(error) }); }
  });

  // Real in-flight lock: the cooldown alone is a timestamp gate that
  // only blocks a second POST for 15s, but generation runs up to 180s (360s with
  // model fallback) — a click 16s into a generation started a fully concurrent
  // second one, doubling spend and racing saveBrief's same-day filename counter.
  // This flag is set for the lifetime of a generation and cleared in `finally`,
  // so overlap is impossible regardless of timing; the cooldown separately
  // debounces requests started within 15 seconds, including early failures.
  let generating = false;

  router.post('/brief/drafts/:id/publish', recoveryAccess, (req, res) => {
    if (!validDraftId(req.params.id)) return res.status(400).json({ error: 'Invalid draft identifier' });
    const request = req.body;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || !Number.isSafeInteger(request.baseRevision) || request.baseRevision < 1
      || !/^[a-f\d]{64}$/.test(request.inputSha256 || '')
      || (request.content !== undefined && typeof request.content !== 'string')) return res.status(400).json({ error: 'The draft revision and captured input identity are required.', code: 'E_DRAFT_REQUEST' });
    let artifact;
    let committed = null;
    const warnings = [];
    try {
      artifact = readBriefDraft(historyDir, req.params.id);
      if (!artifact) return res.status(404).json({ error: 'Draft unavailable.', code: 'E_DRAFT_UNAVAILABLE' });
      if (request.inputSha256 !== artifact.manifestSha256) return res.status(409).json({ error: 'The captured inputs changed. Reload the draft.', code: 'E_DRAFT_CONFLICT' });
      const found = publications.findDraft(artifact);
      if (found) {
        committed = { ...found, publication: verifyPublicationReplay(found, artifact, request), replayed: true, scheduled: found.manifest.edition.scheduled };
      } else {
        if (generating) return res.status(409).json({ error: 'Wait for the active generation before publishing this draft.', code: 'E_GENERATION_ACTIVE' });
        let validation;
        artifact = revalidateBriefDraft(historyDir, artifact.id, request, (content, manifest) => {
          validation = validateBrief(content, manifest.edition?.date, validationSourceFromManifest(manifest));
          return validation;
        });
        committed = { ...publishDraftEdition({ historyDir, reviewDir, artifact, validation, request }), replayed: false };
      }
      // The archive is already durable. These recoverable writes must never
      // turn a successful publication into an instruction to regenerate.
      try { artifact = recordDraftPublication(historyDir, artifact.id, committed.publication) || artifact; }
      catch { warnings.push('Published successfully; the draft recovery pointer could not be updated. Retrying Publish will recover the same edition.'); }
      const { filename, manifest, publication } = committed;
      const jobStatus = jobs.status();
      if (jobStatus.jobs.some(job => job.id === manifest.generationId)) {
        try { jobs.finish(manifest.generationId, { status: 'complete', filename, code: 'OPERATOR_REPAIRED' }); }
        catch { warnings.push('Published successfully; generation accounting needs reconciliation. Original provider usage is preserved.'); }
      } else if (jobStatus.persistence === 'error') {
        warnings.push('Published successfully; generation accounting could not be checked. Original provider usage is preserved.');
      }
      const content = readFileSync(join(historyDir, filename), 'utf8');
      if (committed.scheduled) {
        try { completeScheduledBriefJob({ jobKey: scheduledBriefJobKey(manifest.edition.date), editionDate: manifest.edition.date, timezone: manifest.edition.timezone, filename, completedAt: publication.publishedAt }); }
        catch { warnings.push('Published successfully; scheduled-edition accounting needs reconciliation.'); }
      }
      try { onDraftPublished({ editionDate: manifest.edition.date, filename, publishedAt: publication.publishedAt, scheduled: committed.scheduled }); }
      catch { warnings.push('Published successfully; current display or schedule metadata could not be refreshed.'); }
      try { indexBrief(filename, content); }
      catch { warnings.push('Published successfully; search indexing failed during publication. A later reindex can reconcile it.'); }
      try {
        saveBriefMeta({ filename, date: manifest.edition.date, bluf: extractBluf(content), model_used: manifest.modelUsed || null,
          generation_time_ms: 0, headline_count: manifest.selectedEvidence?.length || 0, word_count: content.trim().split(/\s+/).length,
          horizon_counts: countHorizons(content), input_tokens: null, output_tokens: null,
          warnings: manifest.publicationValidation.warnings || [], generated_at: publication.publishedAt });
      } catch { warnings.push('Published successfully; edition metadata could not be saved during publication.'); }
      const reading = loadBriefReadingState(historyDir, filename, { reviewDirectory: reviewDir });
      const presentation = briefPresentation(reading, { operationalNotes: warnings });
      const isCurrent = listBriefEditions(historyDir, { getMeta: getBriefMeta, eligibleOnly: true, limit: 1, reviewDirectory: reviewDir })[0]?.filename === filename;
      // Replayed HTTP requests never repeat external notifications. Delivery is
      // best effort, independent of the archive's successful publication.
      if (!committed.replayed && reading.disposition.eligibleForLatest) {
        const config = getConfig();
        dispatchBriefWebhook({ date: manifest.edition.date, bluf: extractBluf(content),
          judgments: parseJudgments(content).map(j => ({ title: j.title, tier: getHorizonName(config, j.horizon), confidence: j.confidence })),
          link: `${outwardBaseUrl}/briefing/${encodeURIComponent(filename)}`, warnings: manifest.publicationValidation.warnings || [] }, config)
          .catch(error => log.warn('brief', `Published draft notification failed: ${safeErrorMsg(error)}`));
      }
      return res.json({ published: true, filename, publication: { ...publication, eligibleForLatest: reading.disposition.eligibleForLatest },
        isCurrent, replayed: committed.replayed, warnings, presentation, artifact: publicDraft(artifact) });
    } catch (error) {
      if (committed) return res.json({ published: true, filename: committed.filename, publication: committed.publication,
        replayed: committed.replayed, warnings: [...warnings, 'The edition was saved; some publication details could not be refreshed.'], artifact: publicDraft(artifact) });
      if (error.code === 'E_DRAFT_BLOCKED') return res.status(422).json({ error: error.message, code: error.code,
        artifact: publicDraft(artifact), validation: draftValidation(artifact), publicationDecision: error.decision, reviewableIssues: error.decision.reviewIssues });
      return res.status(error.code === 'E_DRAFT_CONFLICT' || error.code === 'E_DRAFT_PUBLISHED' ? 409 : 400)
        .json({ error: safeErrorMsg(error), code: error.code || 'E_DRAFT_PUBLICATION', ...(artifact ? { artifact: publicDraft(artifact) } : {}) });
    }
  });

  // ── POST /brief — generate, streaming via SSE ──
  router.post('/brief', async (req, res) => {
    // Both stacked generation limiters reserve capacity before this route. Hold
    // settlement until the handler really finishes: an SSE close does not stop
    // the paid generation or its publication work.
    deferBriefGenerationAccounting(res);
    try {
    let scheduledJob = null;
    try {
      scheduledJob = parseScheduledJob(req, scheduledJobToken);
    } catch (err) {
      return res.status(400).json({
        error: err.message,
        code: err.code || 'E_SCHEDULE_CONTEXT',
      });
    }
    const editionContext = scheduledJob
      ? { date: scheduledJob.editionDate, timezone: scheduledJob.timezone, scheduled: true }
      : { date: localDateISO(), timezone: 'local', scheduled: false };

    if (scheduledJob) {
      try {
        const recovered = recoverScheduledPublication(historyDir, scheduledJob, reviewDir);
        if (recovered) {
          log.info('brief', `Scheduled briefing ${scheduledJob.jobKey} already published - returning ${recovered.filename} without provider spend`);
          sendCompletedBrief(res, {
            text: recovered.text,
            filename: recovered.filename,
            timestamp: recovered.completedAt,
            partial: false,
            replayed: true,
            jobKey: scheduledJob.jobKey,
            inputManifest: recovered.reading.receipt,
            disposition: recovered.reading.disposition,
            readingChecks: recovered.reading.readingChecks,
            presentation: recovered.reading.presentation,
            sourceCheckStatus: presentationSourceCheckStatus(recovered.reading.presentation),
            editorialReviewStatus: recovered.reading.disposition.editorialReviewStatus,
          });
          return;
        }
        // A retained scheduled draft is work awaiting the operator, not a
        // reason to buy the same day's generation again after a restart.
        const pendingDraft = listBriefDrafts(historyDir).find(item => {
          if (item.editionDate !== scheduledJob.editionDate) return false;
          return readBriefDraft(historyDir, item.id)?.manifest?.edition?.scheduled === true;
        });
        if (pendingDraft) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'private, no-store');
          res.write(`data: ${JSON.stringify({ awaitingReview: true, draftArtifact: pendingDraft, code: 'E_DRAFT_REVIEW', error: 'The scheduled draft is saved and awaits review. No new generation was started.' })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
      } catch (err) {
        log.error('brief', `Scheduled briefing recovery failed: ${err.message}`);
        return res.status(err.code === 'E_SCHEDULE_INTEGRITY' ? 409 : 500).json({
          error: err.code === 'E_SCHEDULE_INTEGRITY' ? 'The saved scheduled edition could not be verified. Inspect its original and input receipt before retrying; no generation was started.' : 'Scheduled briefing recovery failed.',
          code: err.code || 'E_SCHEDULE_STATE',
        });
      }
    }

    let client = getAiClient();
    const provider = client?.provider || 'anthropic';
    if (!client) {
      return res.status(503).json({
        error: 'AI briefing disabled — configure the selected provider and check its status in Settings',
        code: 'E002',
      });
    }
    if (generating) {
      res.setHeader('Retry-After', '15');
      return res.status(429).json({
        error: 'A Briefing is already being generated.',
        code: 'E_GENERATION_ACTIVE',
        retryAfterSeconds: 15,
      });
    }
    if (!cooldown.check('brief', 15000)) {
      const retryAfterSeconds = typeof cooldown.retryAfterSeconds === 'function'
        ? cooldown.retryAfterSeconds('brief', 15000)
        : 15;
      res.setHeader('Retry-After', String(Math.max(1, retryAfterSeconds)));
      return res.status(429).json({
        error: 'A Briefing request was started recently. Wait before starting another.',
        code: 'E_GENERATION_COOLDOWN',
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      });
    }
    generating = true;
    let finishTrackedGeneration = () => {};
    try {
      const finish = trackGeneration();
      if (typeof finish === 'function') finishTrackedGeneration = finish;
    } catch (err) {
      // Lifecycle tracking is a shutdown aid, not permission to fail a request.
      log.warn('brief', `Generation lifecycle tracking failed to start: ${err.message}`);
    }

    req.socket?.setTimeout?.(0);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // The stream contains operator context and the complete generated brief.
    // Forbid browser and intermediary storage rather than merely requiring
    // revalidation of a cached response.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let clientConnected = true;
    // Listen on the RESPONSE, not the request: in modern Node, IncomingMessage
    // emits 'close' as soon as the request MESSAGE completes — for a POST with
    // a body (the UI sends '{}'), that's the instant express.json() finishes
    // reading it, ~1ms in, with the client still fully connected. Guarding
    // send() on req-close silently muted every SSE event of a 150s generation.
    // ServerResponse 'close' fires when the connection actually goes away
    // (client abort), or after our own res.end() — by which point nothing
    // more is written anyway.
    res.on('close', () => { clientConnected = false; });

    const send = (payload) => {
      if (!clientConnected) return;
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { clientConnected = false; }
    };

    const heartbeat = setInterval(() => {
      if (!clientConnected) return;
      try { res.write(': keepalive\n\n'); } catch { clientConnected = false; }
    }, 20000);

    let generationJobId = null;
    let ledgerFinished = false;
    let publishedFilename = null;
    let recoveryManifest = null;
    let recoveryContent = '';
    let recoveryPreviousContent = '';
    const finishJob = outcome => {
      if (!generationJobId || ledgerFinished) return;
      jobs.finish(generationJobId, outcome);
      ledgerFinished = true;
    };

    try {
      const config = getConfig();
      const s = config.analysisSettings || {};
      const genTimeoutMs = (s.generationTimeoutSec ?? 180) * 1000;
      const generationDeadline = Date.now() + genTimeoutMs;
      const withinGenerationDeadline = async (promise, stage) => {
        const remainingMs = generationDeadline - Date.now();
        if (remainingMs <= 0) {
          const err = new Error(`Briefing generation timed out during ${stage}.`);
          err.code = 'E_GENERATION_TIMEOUT';
          throw err;
        }
        let deadlineTimer;
        try {
          return await Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
              deadlineTimer = setTimeout(() => {
                const err = new Error(`Briefing generation timed out during ${stage}.`);
                err.code = 'E_GENERATION_TIMEOUT';
                reject(err);
              }, remainingMs);
            }),
          ]);
        } finally {
          clearTimeout(deadlineTimer);
        }
      };

      // Stage 1 — landscape data (reuses the background run when fresh)
      send({ progress: 'Collecting landscape data...', stage: 'fetching' });
      const evidenceMaxAgeMs = Math.max(
        15 * 60_000,
        (s.refreshMinutes ?? 10) * 3 * 60_000,
      );
      const run = await withinGenerationDeadline(getFreshRun(5 * 60_000, {
        minHeadlines: 5,
        maxAgeMs: evidenceMaxAgeMs,
      }), 'evidence refresh');
      const headlines = run.headlines || [];
      send({ progress: `${headlines.length} scored headlines (${run.stats?.enriched || 0} enriched)`, stage: 'scoring' });

      // Stage 2 — continuity context
      const prev = loadRecentBriefs(historyDir, s.continuityDepth ?? 5, { getMeta: getBriefMeta, reviewDirectory: reviewDir });
      const continuityContext = extractContinuityContext(prev);

      // Stage 3 — generate
      send({ progress: 'Writing briefing...', stage: 'generating' });
      // Layer the operator's Settings > Organization profile overrides (sector,
      // team profile, regions) over config.json's defaults — a scoped copy so
      // the rest of this handler keeps reading the unmodified config.
      const watchProfile = getEffectiveWatchProfile(config);
      const promptConfig = { ...config, organization: getEffectiveOrganization(config), watchProfile };
      const systemPrompt = buildSystemPrompt(promptConfig, editionContext);
      const groundTruth = buildGroundTruth(run);
      const capturedKevSet = new Set(getKEVSet());
      const groundingManifest = buildGroundingManifest({ headlines, extraSourceText: groundTruth, kevSet: capturedKevSet });
      let previousInputs = null;
      try { if (prev[0]?.filename) previousInputs = readGenerationManifest(historyDir, prev[0].filename)?.grounding; } catch { /* older receipts may not exist */ }
      const inputDelta = compareEditionInputs(groundingManifest, previousInputs);
      if (!groundingManifest.members.some(source => source.id !== 'CISA-KEV' && source.quality?.substantive)) {
        const error = new Error('No substantive source passages are available for a new Briefing. The Wire retains headline leads; refresh or inspect the original sources before generating. No provider request was made.');
        error.code = 'E_EVIDENCE_UNUSABLE';
        throw error;
      }
      const capturedKevTiming = captureKevTiming(getKEVDueDates([...groundingManifest.cves]), capturedKevSet);
      const userPrompt = buildUserPrompt({
        headlines,
        continuityContext,
        groundTruth,
        config: promptConfig,
        groundingManifest,
        editionContext,
      }) + `\n\nINPUT CONTINUITY: ${JSON.stringify(inputDelta)}. This compares captured passages, not events. If unchanged, identify an editorial revision; never infer acceleration from repetition.\n\n${buildBriefFactLedger(groundingManifest, capturedKevTiming, capturedKevSet.size > 0)}`;
      const generationManifest = buildGenerationManifest({
        run, config: promptConfig, watchProfile, editionContext,
        groundTruth, groundingManifest, continuityContext, previousBriefs: prev,
      });
      generationManifest.editorialStandard = 2;
      generationManifest.inputDelta = inputDelta;
      generationManifest.verification = { kevCatalogLoaded: capturedKevSet.size > 0, kevCatalogSha256: sha256([...capturedKevSet].sort().join('\n')), selectedKevCves: [...groundingManifest.cves].filter(cve => capturedKevSet.has(cve)).sort(), kevTiming: capturedKevTiming };
      recoveryManifest = generationManifest;
      jobs.start({ id: generationManifest.generationId, editionDate: editionContext.date, scheduledJobKey: scheduledJob?.jobKey });
      generationJobId = generationManifest.generationId;
      send({ generationId: generationJobId, statusUrl: '/api/brief/status' });

      const preferredModel = client.model || s.preferredModel || 'claude-sonnet-5';
      const fallbackModel = client.fallbackModel || (typeof client.stream === 'function' ? preferredModel : s.model || 'claude-haiku-4-5');
      Object.assign(generationManifest.generationSettings, { provider, preferredModel, fallbackModel });
      let modelUsed = preferredModel;
      // One wall-clock budget covers stream setup, key rotation, model
      // fallback, and corrective validation retries. Each SDK call also gets
      // an AbortSignal and maxRetries:0 inside streamWithRecovery.
      const genStart = performance.now();
      let chunkSeq = 0;

      const modelParams = {
        model: preferredModel,
        max_tokens: s.maxTokens || 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      };
      const thinkingEffort = s.thinkingEffort || 'low';
      let requestedThinkingEffort = thinkingEffort;
      applyThinking(modelParams, preferredModel, thinkingEffort, client);
      generationManifest.generationSettings.thinkingEffort = modelParams.reasoning?.effort || thinkingEffort;
      generationManifest.generationSettings.thinkingConfiguration = thinkingConfiguration(modelParams, thinkingEffort, client);

      const onChunk = (chunk) => { recoveryContent += chunk; send({ text: chunk, seq: chunkSeq++ }); };
      let providerAttemptCount = 0;
      const runProviderAttempt = async client => {
        if (recoveryContent) recoveryPreviousContent = recoveryContent;
        recoveryContent = '';
        providerAttemptCount++;
        const attempt = recordProviderAttempt(generationManifest, modelParams);
        attempt.provider = provider;
        attempt.thinkingConfiguration = thinkingConfiguration(modelParams, requestedThinkingEffort, client);
        attempt.pricing = { asOf: '2026-09-05', perMillionTokens: modelPrice(attempt.model) };
        jobs.startAttempt(generationJobId, attempt);
        res.locals.briefGenerationAttempted = true;
        const outcome = await streamWithRecovery(client, modelParams, {
          timeoutMs: Math.max(1, generationDeadline - Date.now()),
          onChunk,
          onUsage: (usage, responseModel) => jobs.usage(generationJobId, attempt.attempt, {
            inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, responseModel,
            costUsd: usage.cost_usd ?? estimateCostUsd(responseModel || attempt.model, usage.input_tokens, usage.output_tokens, undefined, usage.cached_input_tokens, usage.cache_write_input_tokens),
          }),
        });
        attempt.stopReason = outcome.stopReason || null;
        attempt.responseModel = outcome.responseModel || null;
        attempt.timedOut = outcome.timedOut;
        attempt.failed = Boolean(outcome.error);
        if (outcome.error) attempt.failureReason = safeErrorMsg(outcome.error);
        attempt.usage = { inputTokens: outcome.usage?.input_tokens || 0, outputTokens: outcome.usage?.output_tokens || 0 };
        if (outcome.usage?.cached_input_tokens !== undefined) attempt.usage.cachedInputTokens = outcome.usage.cached_input_tokens;
        if (outcome.usage?.cache_write_input_tokens !== undefined) attempt.usage.cacheWriteInputTokens = outcome.usage.cache_write_input_tokens;
        if (outcome.usage?.reasoning_tokens !== undefined) attempt.usage.reasoningTokens = outcome.usage.reasoning_tokens;
        const reportedCost = outcome.usage?.cost_usd;
        attempt.pricing = reportedCost !== undefined ? { currency: 'USD', basis: 'Provider-reported cost' }
          : { asOf: '2026-10-09', currency: 'USD', perMillionTokens: modelPrice(attempt.responseModel || attempt.model, attempt.usage.inputTokens), basis: 'Standard API list-rate estimate', ...client.pricing };
        attempt.costUsd = reportedCost ?? estimateCostUsd(attempt.responseModel || attempt.model, attempt.usage.inputTokens, attempt.usage.outputTokens, undefined, attempt.usage.cachedInputTokens, attempt.usage.cacheWriteInputTokens);
        jobs.usage(generationJobId, attempt.attempt, { ...attempt.usage, responseModel: attempt.responseModel, costUsd: attempt.costUsd });
        jobs.finishAttempt(generationJobId, attempt.attempt, { stopReason: attempt.stopReason, failed: attempt.failed, timedOut: attempt.timedOut });
        return outcome;
      };

      // From here on the request may incur provider cost. Rate limiters inspect
      // this marker when the route finalizes so aborting the SSE connection
      // cannot refund a generation that continues in the background and saves.
      let result = await runProviderAttempt(client);
      if (result.stopReason === 'refusal') {
        throw new Error('The model refused this briefing request. Review the source mix and retry.');
      }
      // Usage from the first attempt, preserved across a fallback retry (below) so
      // tokens spent on a discarded attempt aren't silently dropped from the
      // reported/billed total — this is mostly theoretical for the current
      // fallback trigger (401/403/404/529 almost always error before
      // message_start, so attempt 1's usage is 0/0), but a mid-stream 529 after
      // partial output would otherwise lose real spend from the total.
      // Running total of usage from any prior discarded attempts, carried across
      // each retry below so a fallback's accumulation never drops an intermediate
      // attempt's spend (re-snapshotted after the rotation retry).
      let firstAttemptUsage = { ...result.usage };

      // Secondary-key rotation on an auth rejection. A 401/403 is a credential
      // problem, not a model problem, so swapping the key and retrying the SAME
      // model is the correct first response — and this is the path a streamed
      // generation (messages.stream) actually takes. Ordered before model
      // fallback: if the primary key is dead, a different model on the same dead
      // key won't help. rotateKey() returns the secondary-key client, or null
      // when none is configured / it was already rotated (so this never loops).
      if (result.error && (result.error.status === 401 || result.error.status === 403)
          && (typeof client.rotateKey === 'function' || (typeof client.stream !== 'function' && typeof rotateKey === 'function'))) {
        const rotated = typeof client.rotateKey === 'function' ? client.rotateKey() : rotateKey(provider);
        if (rotated) {
          log.warn('brief', `${modelUsed} auth rejected — retrying with secondary API key`);
          client = rotated;
          send({ reset: true, progress: 'Retrying with the secondary API key...', stage: 'generating' });
          result = await runProviderAttempt(client);
          if (result.stopReason === 'refusal') {
            throw new Error('The model refused this briefing request. Review the source mix and retry.');
          }
          result.usage = {
            input_tokens: firstAttemptUsage.input_tokens + result.usage.input_tokens,
            output_tokens: firstAttemptUsage.output_tokens + result.usage.output_tokens,
          };
          // Fold this attempt into the running prior-total so a subsequent model
          // fallback accumulates on top of it rather than re-adding attempt 1.
          firstAttemptUsage = { ...result.usage };
        }
      }

      // Model fallback on immediate availability failures (a still-erroring key
      // after rotation falls through to here and swaps the model, as before)
      if (result.error && preferredModel !== fallbackModel) {
        const status = result.error.status;
        if (status === 401 || status === 403 || status === 404 || status === 529) {
          log.warn('brief', `${preferredModel} unavailable (${result.error.message}) — falling back to ${fallbackModel}`);
          modelUsed = fallbackModel;
          modelParams.model = fallbackModel;
          applyThinking(modelParams, fallbackModel, thinkingEffort, client);
          send({ reset: true, text: `*[Generated with ${fallbackModel} — preferred model unavailable]*\n\n` });
          result = await runProviderAttempt(client);
          if (result.stopReason === 'refusal') {
            throw new Error('The model refused this briefing request. Review the source mix and retry.');
          }
          result.usage = {
            input_tokens: firstAttemptUsage.input_tokens + result.usage.input_tokens,
            output_tokens: firstAttemptUsage.output_tokens + result.usage.output_tokens,
          };
        }
      }

      // Empty or degenerate output is normally a terminal provider failure.
      // `max_tokens` is the exception: adaptive reasoning can consume the
      // budget before much visible text is emitted, and the bounded lower-
      // effort recovery below exists specifically to repair that outcome.
      if (result.text.length < 100 && result.stopReason !== 'max_tokens') {
        const err = result.error || new Error(
          result.timedOut
            ? 'Generation timed out before the model produced content.'
            : `Model returned no content (${modelUsed}).`
        );
        if (result.error?.status) err.status = result.error.status;
        throw err;
      }

      let fullBrief = normalizeConvergenceOpening(result.text);
      const elapsed = ((performance.now() - genStart) / 1000).toFixed(1);
      let wordCount = fullBrief.trim().split(/\s+/).length;

      // Stage 4 — validate, with one automatic corrective retry. Unresolved
      // structural or factual trust failures remain recoverable drafts and are
      // never published as completed Briefings.
      const genDate = editionContext.date;
      const validationSource = { groundingManifest, kevSet: capturedKevSet, kevTiming: capturedKevTiming, publication: true, editorialStandard: 2, inputDelta };
      generationManifest.verification = {
        kevCatalogLoaded: validationSource.kevSet.size > 0,
        kevCatalogSha256: sha256([...validationSource.kevSet].sort().join('\n')),
        selectedKevCves: [...groundingManifest.cves].filter(cve => validationSource.kevSet.has(cve)).sort(),
        kevTiming: capturedKevTiming,
      };
      const audit = draft => {
        fullBrief = canonicalizeExecutiveActions(draft);
        const checked = validateBrief(fullBrief, genDate, validationSource);
        recordValidation(generationManifest, fullBrief, checked);
        return checked;
      };
      let validation = audit(fullBrief);
      let warnings = validation.valid ? [] : [...validation.warnings];
      // hasHardFail is exported by lib/validation.js — the same module that
      // produces the warning strings — so this can never drift out of sync with
      // a rewording the way a local string-matching regex could.
      let hardFail = hasHardFail(validation.issues);
      let trustFail = hasTrustCriticalFailure(validation.issues);
      let correctiveRetryAttempted = false;
      let correctiveRetryFailure = null;

      // Resolve a link-only failure without paying for another model call.
      // Citation prose stays intact; only an unsupported live href is removed.
      let delinkedBrief = delinkUnallowlistedMarkdownUrls(fullBrief, groundingManifest);
      if (delinkedBrief !== fullBrief) {
        fullBrief = delinkedBrief;
        wordCount = fullBrief.trim().split(/\s+/).length;
        validation = audit(fullBrief);
        warnings = validation.valid ? [] : [...validation.warnings];
        hardFail = hasHardFail(validation.issues);
        trustFail = hasTrustCriticalFailure(validation.issues);
      }

      const stoppedAtOutputLimit = result.stopReason === 'max_tokens';
      // Token-limit recovery shares the existing single corrective-retry slot.
      // If key rotation or model fallback already consumed a second provider
      // call, never turn a max_tokens result into a third call.
      const outputLimitRetryAvailable = !stoppedAtOutputLimit || providerAttemptCount < 2;
      if ((hardFail || trustFail || stoppedAtOutputLimit)
          && outputLimitRetryAvailable && !result.error && !result.timedOut) {
        correctiveRetryAttempted = true;
        const correctiveWarnings = validation.issues.filter(issue => (
          hasHardFail([issue]) || hasTrustCriticalFailure([issue]) || issue.severity === 'review'
        )).map(issue => issue.message);
        if (stoppedAtOutputLimit) {
          const recoveryEffort = reducedRecoveryThinkingEffort(thinkingEffort);
          requestedThinkingEffort = recoveryEffort;
          applyThinking(modelParams, modelUsed, recoveryEffort, client);
          log.warn('brief', `Output-token recovery retry (${thinkingEffort} → ${recoveryEffort} thinking)`);
          send({ reset: true, progress: 'Retrying — requesting a shorter draft to complete every section...', stage: 'generating' });
          const failedChecks = correctiveWarnings.length
            ? ` It also failed these checks: ${correctiveWarnings.join('; ')}.`
            : '';
          // Do not resend the 16k-token partial draft: the original current-source
          // prompt plus precise failures is sufficient and leaves more context for
          // a concise, complete replacement.
          modelParams.messages = [{
            role: 'user',
            content: `${userPrompt}\n\nRECOVERY INSTRUCTION: The previous attempt exhausted the configured output-token limit and was discarded.${failedChecks} Regenerate the full brief from the top in the exact same format, but be concise enough to finish every required section, including ${WATCHLIST_MIN_ITEMS}–${WATCHLIST_MAX_ITEMS} complete Watchlist bullets. Use only CVEs and URLs in the current-source input; a source marked URL unavailable must have a plain [Source Name, Date] citation with no link. Never contradict verified KEV status.`,
          }];
        } else {
          log.warn('brief', `Corrective validation retry (${correctiveWarnings.join('; ')})`);
          send({ reset: true, progress: 'Retrying — correcting source verification or required structure...', stage: 'generating' });
          modelParams.messages = [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: fullBrief },
            { role: 'user', content: `Your previous draft failed these checks: ${correctiveWarnings.join('; ')}.\nLocated findings (including editorial findings): ${JSON.stringify(repairFindingContext(validation.issues))}\n${correctiveGuidance(validation.issues)}\n${buildBriefFactLedger(groundingManifest, capturedKevTiming, capturedKevSet.size > 0)}\nRepair the identified claims while preserving supported content, complete paired actions, citations and qualifications. Do not introduce new metrics or deadlines elsewhere while repairing a citation. Return the complete brief in the same format. Use only CVEs and URLs in the current-source input; a source marked URL unavailable must have a plain [Source Name, Date] citation with no link. Never contradict verified KEV status.` },
          ];
        }
        const retryResult = await runProviderAttempt(client);
        if (retryResult.error) correctiveRetryFailure = safeErrorMsg(retryResult.error);
        else if (retryResult.timedOut) correctiveRetryFailure = 'Generation timed out.';
        retryResult.usage = {
          input_tokens: result.usage.input_tokens + retryResult.usage.input_tokens,
          output_tokens: result.usage.output_tokens + retryResult.usage.output_tokens,
        };
        // The retry is billable even when it fails and we retain the original
        // draft, so always carry its usage into the final metadata/cost.
        result.usage = retryResult.usage;
        // Only adopt the retry if it actually produced usable content — a
        // degenerate/errored retry keeps the original (already-valid-enough)
        // draft rather than replacing it with nothing.
        if (!retryResult.error && !retryResult.timedOut && retryResult.stopReason !== 'refusal' && retryResult.text.length >= 100) {
          result = retryResult;
          fullBrief = normalizeConvergenceOpening(result.text);
          wordCount = fullBrief.trim().split(/\s+/).length;
          validation = audit(fullBrief);
          warnings = validation.valid ? [] : [...validation.warnings];
          hardFail = hasHardFail(validation.issues);
          trustFail = hasTrustCriticalFailure(validation.issues);
        }
      }

      // An unsupported URL can be made publication-safe without changing the
      // factual prose: preserve `[Source, Date]`, remove only its live href, and
      // re-audit. CVE/KEV contradictions cannot be repaired mechanically.
      delinkedBrief = delinkUnallowlistedMarkdownUrls(fullBrief, groundingManifest);
      if (delinkedBrief !== fullBrief) {
        fullBrief = delinkedBrief;
        wordCount = fullBrief.trim().split(/\s+/).length;
        validation = audit(fullBrief);
        warnings = validation.valid ? [] : [...validation.warnings];
        hardFail = hasHardFail(validation.issues);
        trustFail = hasTrustCriticalFailure(validation.issues);
      }

      // A brief is partial when the generation timed out, a mid-stream error
      // interrupted it, OR the provider stopped at the configured output-token
      // ceiling. `max_tokens` is a normal SDK stop reason rather than an error,
      // but publishing it as complete can leave the final Watchlist (or any
      // other trailing section) cut off mid-sentence.
      const outputLimitReached = result.stopReason === 'max_tokens';
      const isPartial = result.timedOut || !!result.error || outputLimitReached;
      if (result.error) {
        warnings.push(`Generation was interrupted mid-stream: ${safeErrorMsg(result.error)}`);
      }
      if (correctiveRetryFailure) warnings.push(`Corrective retry failed: ${correctiveRetryFailure}`);
      if (outputLimitReached) {
        warnings.push('Generation reached the configured output-token limit before completion');
      }
      if (warnings.length) {
        log.warn('brief', `Validation warnings: ${warnings.join('; ')}`);
      }

      // Publication is all-or-nothing. A partial stream or a structurally
      // invalid draft is returned to the operator for recovery, but is never
      // archived, indexed, sent to a webhook, or announced as a successful
      // scheduled edition.
      generationManifest.generatedAt = new Date().toISOString();
      generationManifest.modelUsed = modelUsed;
      generationManifest.responseModel = result.responseModel || null;
      generationManifest.judgmentEvidence = validation.judgmentEvidence;
      generationManifest.publicationValidation = { valid: validation.valid, warnings: [...warnings], issues: validation.issues, hardFail, trustFail, partial: isPartial, coverage: validation.coverage, sourceCheckStatus: hardFail || trustFail ? 'findings' : 'passed-supported-checks', editorialReviewStatus: 'not-reviewed' };
      generationManifest.costEstimate = { usd: estimateAttemptCosts(generationManifest.providerAttempts), currency: 'USD', asOf: '2026-09-05', basis: 'Sum of per-attempt reported costs or API list-rate estimates' };
      const publishDecision = publicationDecision({ ...validation, partial: isPartial });
      if (!publishDecision.canPublish) {
        const blocking = validation.issues.filter(issue => (
          hasHardFail([issue]) || hasTrustCriticalFailure([issue])
        )).map(issue => issue.message);
        const costUsd = estimateAttemptCosts(generationManifest.providerAttempts);
        const retryState = correctiveRetryAttempted
          ? 'after one corrective retry'
          : 'and a corrective retry could not be completed';
        let code = 'E_VALIDATION';
        let message = `Draft was not published because required validation still failed ${retryState}: ${blocking.join('; ')}.`;
        let recoveryAdvice = 'Correct the source input or draft structure before requesting another generation.';
        if (trustFail) {
          code = 'E006';
          message = `Draft was not published because source verification still failed ${retryState}: ${blocking.join('; ')}.`;
          recoveryAdvice = 'Refresh the landscape data or correct the source input before requesting another generation.';
        } else if (isPartial) {
          code = 'E_PARTIAL_GENERATION';
          message = outputLimitReached
            ? 'Draft was not published because generation reached the configured output-token limit before completing the Briefing.'
            : result.timedOut
              ? 'Draft was not published because generation exceeded the end-to-end timeout.'
              : `Draft was not published because the provider stream was interrupted: ${safeErrorMsg(result.error)}`;
          recoveryAdvice = outputLimitReached ? 'Raise analysisSettings.maxTokens in config.json or reduce the Briefing scope before requesting another generation.' : 'Check provider status before requesting another generation.';
        } else if (publishDecision.requiresReview && !publishDecision.blockers.length) {
          code = 'E_DRAFT_REVIEW';
          message = 'The draft is saved for review of a proposed security control change. Review the exact action before publishing.';
        }
        if (result.error && trustFail) message += ` Provider failure: ${safeErrorMsg(result.error)}`;
        if (correctiveRetryFailure) message += ` Corrective retry failed: ${correctiveRetryFailure}`;
        let draftArtifact = null;
        try {
          const artifact = saveRejectedBrief(historyDir, { id: generationManifest.generationId, content: fullBrief, manifest: generationManifest, validation: { ...validation, partial: isPartial, hardFail, trustFail }, code });
          draftArtifact = summarizeBriefDraft(artifact);
          recordStorageOutcome('rejected-draft');
          message += ' Open the saved draft, correct the findings, then Publish briefing; no new model call is needed.';
        } catch (error) {
          recordStorageOutcome('rejected-draft', error);
          message += ` Draft recovery could not be saved; copy the visible draft before leaving this view. ${recoveryAdvice}`;
        }
        log.error('brief', message);
        finishJob({ status: 'failed', code });
        send({
          error: message,
          code,
          draft: fullBrief,
          model: modelUsed,
          tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
          costUsd,
          validation: { warnings, hardFail, trustFail, issues: validation.issues, coverage: validation.coverage },
          draftArtifact,
          awaitingReview: Boolean(draftArtifact),
          sourceCheckStatus: 'findings', editorialReviewStatus: 'not-reviewed',
        });
        if (clientConnected) {
          try { res.end(); } catch { /* client gone */ }
        }
        return;
      }

      const generatedAt = new Date().toISOString();
      generationManifest.generatedAt = generatedAt;
      generationManifest.modelUsed = modelUsed;
      generationManifest.responseModel = result.responseModel || null;
      generationManifest.judgmentEvidence = validation.judgmentEvidence;
      generationManifest.publicationValidation = { ...generationManifest.publicationValidation, valid: validation.valid, warnings: [...warnings], issues: validation.issues, hardFail, trustFail, partial: isPartial };
      generationManifest.costEstimate = { usd: estimateAttemptCosts(generationManifest.providerAttempts), currency: 'USD', asOf: '2026-09-05', basis: 'Sum of per-attempt reported costs or API list-rate estimates' };
      let filename;
      try {
        filename = saveBrief(historyDir, fullBrief, {
          date: genDate,
          scheduled: Boolean(scheduledJob),
          manifest: generationManifest,
        });
        recordStorageOutcome('brief-publication');
        publishedFilename = filename;
      } catch (error) {
        recordStorageOutcome('brief-publication', error);
        throw error;
      }
      try { finishJob({ status: 'complete', filename }); }
      catch { warnings.push('Briefing was saved, but generation accounting could not be updated; the verified archive will reconcile its status.'); }
      if (scheduledJob) {
        try {
          completeScheduledBriefJob({
            jobKey: scheduledJob.jobKey,
            editionDate: scheduledJob.editionDate,
            timezone: scheduledJob.timezone,
            filename,
            completedAt: generatedAt,
          });
        } catch (jobErr) {
          // The atomically published -00 archive remains the durable replay
          // marker. A restart reconstructs this row before any provider call.
          log.warn('brief', `Scheduled job completion marker failed (archive is durable): ${jobErr.message}`);
        }
      }
      // Index synchronously (better-sqlite3 is synchronous and fast): the brief is
      // searchable the instant we tell the client it's done, and an index failure
      // surfaces in this brief's warnings instead of vanishing into a log line.
      try {
        indexBrief(filename, fullBrief);
      } catch (dbErr) {
        log.warn('brief', `Search indexing error (non-blocking): ${dbErr.message}`);
        warnings.push('Search index failed during publication. A later reindex can reconcile it.');
      }
      try {
        saveBriefMeta({
          filename,
          date: genDate,
          bluf: extractBluf(fullBrief),
          model_used: modelUsed,
          generation_time_ms: Math.round(performance.now() - genStart),
          headline_count: headlines.length,
          word_count: wordCount,
          horizon_counts: countHorizons(fullBrief),
          input_tokens: result.usage?.input_tokens || null,
          output_tokens: result.usage?.output_tokens || null,
          warnings,   // persist the generation-time warning set so it re-surfaces on load [G]
          generated_at: generatedAt,
        });
      } catch (dbErr) {
        log.warn('brief', `Edition metadata write error (non-blocking): ${dbErr.message}`);
        warnings.push('Edition metadata could not be saved during publication. The verified archive remains readable.');
      }

      // Push the finished brief (BLUF + key judgments + link) to the configured
      // webhook when webhook.events is 'brief'/'both'. Self-gating and best-effort:
      // never awaited, never throws, never delays the client's completion event.
      // The link must be absolute — safeSlackLink() rejects anything new URL()
      // can't parse, which silently drops a bare relative path.
      const publishedReading = briefReadingState(filename, fullBrief, { ...generationManifest, filename, outputSha256: sha256(fullBrief) }, { reviewDirectory: reviewDir });
      const presentation = briefPresentation(publishedReading, { legacyWarnings: warnings });
      const judgments = parseJudgments(publishedReading.content).map(j => ({
        title: j.title, tier: getHorizonName(config, j.horizon), confidence: j.confidence,
      }));
      if (publishedReading.disposition.eligibleForLatest) dispatchBriefWebhook(
        {
          date: genDate,
          bluf: extractBluf(publishedReading.content),
          judgments,
          link: `${outwardBaseUrl}/briefing/${encodeURIComponent(filename)}`,
          warnings: [...warnings],
        },
        config,
      ).catch(err => log.warn('brief', `Brief webhook dispatch failed (non-blocking): ${err.message}`));

      // Estimated cost — clearly labeled "est." wherever a client surfaces it;
      // null when the model isn't in the price map rather than a misleading $0.
      const costUsd = estimateAttemptCosts(generationManifest.providerAttempts);

      log.info('brief', `Complete — ${fullBrief.length} chars, ${wordCount} words, ${elapsed}s, model: ${modelUsed}${isPartial ? ' (partial)' : ''}${costUsd != null ? ` (est. $${costUsd.toFixed(3)})` : ''}`);

      // Explicit success signal for the short-window and daily generation
      // limiters. HTTP status cannot distinguish SSE success from failure.
      res.locals.briefGenerationSucceeded = true;
      send({
        briefComplete: true, text: fullBrief, filename,
        timestamp: generatedAt, partial: isPartial,
        model: modelUsed,
        ...(scheduledJob ? { jobKey: scheduledJob.jobKey } : {}),
        tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
        costUsd,
        validation: { warnings, hardFail, trustFail, issues: validation.issues, coverage: validation.coverage },
        inputManifest: { status: 'available', url: `/api/brief/${encodeURIComponent(filename)}/manifest`, verification: generationManifest.verification, costEstimate: generationManifest.costEstimate },
        disposition: publishedReading.disposition, presentation, sourceCheckStatus: presentationSourceCheckStatus(presentation), editorialReviewStatus: publishedReading.disposition.editorialReviewStatus,
      });
      if (clientConnected) {
        try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
      }
    } catch (err) {
      let recoveredDraft = null;
      const retained = recoveryContent || recoveryPreviousContent;
      if (!publishedFilename && recoveryManifest && retained) {
        try {
          if (!readBriefDraft(historyDir, recoveryManifest.generationId)) {
            const checked = validateBrief(retained, recoveryManifest.edition?.date, validationSourceFromManifest(recoveryManifest));
            const failure = { code: 'GENERATION_INTERRUPTED', severity: 'structure', message: 'Generation did not complete. Review the retained content before repair.', location: { scope: 'document', line: 1, excerpt: '' } };
            checked.valid = false; checked.issues.push(failure); checked.warnings.push(failure.message);
            recoveryManifest.costEstimate = { usd: estimateAttemptCosts(recoveryManifest.providerAttempts), currency: 'USD' };
            recoveredDraft = summarizeBriefDraft(saveRejectedBrief(historyDir, { id: recoveryManifest.generationId, content: retained, manifest: recoveryManifest, validation: checked, code: err?.code || 'E_GENERATION_FAILED' }));
          }
        } catch (storageError) { recordStorageOutcome('rejected-draft', storageError); }
      }
      try { finishJob({ status: publishedFilename ? 'complete' : 'failed', filename: publishedFilename, code: err?.code || 'E_GENERATION_FAILED' }); }
      catch (ledgerError) { err = ledgerError; }
      log.error('brief', `Generation error: ${err.message}`);
      send({
        error: `${safeErrorMsg(err)}${recoveredDraft ? ' Open the saved draft, correct the findings, then Publish briefing; no new model call is needed.' : ''}`,
          ...(recoveredDraft ? { draft: retained, draftArtifact: recoveredDraft, awaitingReview: true, sourceCheckStatus: 'findings', editorialReviewStatus: 'not-reviewed' } : {}),
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.details ? { details: err.details } : {}),
      });
      if (clientConnected) {
        try { res.end(); } catch { /* client gone */ }
      }
    } finally {
      clearInterval(heartbeat);
      generating = false;
      if (generationJobId) jobs.release(generationJobId);
      try { finishTrackedGeneration(); } catch { /* shutdown tracking is best effort */ }
    }
    } finally {
      finalizeBriefGenerationAccounting(res);
    }
  });

  // ── GET /briefs — history list ──
  router.get('/briefs', (req, res) => {
    try {
      const paginated = req.query.page !== undefined;
      const requestedPage = Number(req.query.page || 1);
      const requestedSize = Number(req.query.pageSize || 12);
      if (paginated && (!Number.isSafeInteger(requestedPage) || requestedPage < 1
        || !Number.isSafeInteger(requestedSize) || requestedSize < 1 || requestedSize > 50)) {
        return res.status(400).json({ error: 'Invalid archive page.' });
      }
      const all = listBriefEditions(historyDir, { getMeta: getBriefMeta, limit: paginated ? Infinity : 30, reviewDirectory: reviewDir });
      const total = all.length;
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / requestedSize)));
      const briefs = paginated ? all.slice((page - 1) * requestedSize, page * requestedSize) : all;
      const results = briefs.map(({ filename: f, date, generatedAt, meta, disposition, reading }) => {
        // Preserve captured per-attempt costs; legacy receipts use the model-rate estimate.
        const { receipt, reviewed, content: readingCopy } = reading;
        const presentation = briefPresentation(reading, { legacyWarnings: parseWarnings(meta?.warnings) });
        const pricingDate = date ? new Date(`${date}T12:00:00Z`) : new Date();
        // Archive descriptions must match the verified reading copy. Original
        // metadata and the full-text search index remain immutable provenance.
        const reviewStatus = reviewed.review?.status || null;
        if (meta && meta.bluf != null && meta.word_count != null) {
          return {
            filename: f, date, disposition, presentation,
            bluf: archiveBluf(reviewed.reviewedContent ? extractBluf(readingCopy) : meta.bluf),
            wordCount: reviewed.reviewedContent ? readingCopy.trim().split(/\s+/).length : meta.word_count,
            reviewStatus,
            model: meta.model_used || null,
            costUsd: editionCost(receipt, meta, pricingDate),
            warnings: originalEditionWarnings(receipt, meta),
            generatedAt,
            inputManifest: receipt,
          };
        }
        return { filename: f, date, disposition, presentation, bluf: archiveBluf(extractBluf(readingCopy)), wordCount: readingCopy.trim().split(/\s+/).length, reviewStatus, model: meta?.model_used || null, costUsd: editionCost(receipt, meta, pricingDate), warnings: originalEditionWarnings(receipt, meta), generatedAt, inputManifest: receipt };
      });
      res.json(paginated ? { items: results, total, page, pageSize: requestedSize } : results);
    } catch {
      if (req.query.page !== undefined) res.status(503).json({ error: 'Archive unavailable.' });
      else res.json([]);
    }
  });

  // Local profile and retained passages share the Settings trust boundary.
  router.get('/brief/:filename/manifest', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!loopback && res.locals.authenticated !== true) {
      return res.status(403).json({ error: 'Input manifests require a local or authenticated connection.', code: 'E_EXPOSED' });
    }
    const filename = req.params.filename;
    if (!validBriefFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (!existsSync(join(historyDir, filename))) return res.status(404).json({ error: 'Briefing not found' });
    try {
      const manifest = readGenerationManifest(historyDir, filename);
      if (!manifest) return res.status(404).json({ error: 'No input manifest was saved for this edition.', code: 'E_MANIFEST_UNAVAILABLE' });
      return res.json(manifest);
    } catch {
      return res.status(500).json({ error: 'Input manifest could not be verified.', code: 'E_MANIFEST_INVALID' });
    }
  });

  // ── GET /brief/:filename ──
  router.get('/brief/:filename', (req, res) => {
    const filename = req.params.filename;
    // Pin the real brief shape (brief-YYYY-MM-DD[-NN].md); the tight pattern makes
    // traversal impossible, and the resolve() confinement is belt-and-suspenders.
    if (!validBriefFilename(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = join(historyDir, filename);
    if (!resolve(filepath).startsWith(resolve(historyDir) + sep)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    if (!existsSync(filepath)) {
      return res.status(404).json({ error: 'Briefing not found' });
    }
    try {
      const reading = loadBriefReadingState(historyDir, filename, { reviewDirectory: reviewDir });
      const { original: content, reviewed, receipt, readingChecks, disposition } = reading;
      let meta = null;
      const operationalNotes = [];
      try { meta = getBriefMeta(filename); }
      catch { operationalNotes.push({ code: 'EDITION_METADATA_UNAVAILABLE', message: 'Edition metadata is unavailable; the verified archive remains readable.' }); }
      const generatedAt = meta?.generated_at || reading.manifest?.generatedAt || statSync(filepath).mtime.toISOString();
      const presentation = briefPresentation(reading, { legacyWarnings: parseWarnings(meta?.warnings), operationalNotes });
      const editionDate = briefDateFromFilename(filename);
      const pricingDate = editionDate ? new Date(`${editionDate}T12:00:00Z`) : new Date();
      res.json({
        filename,
        content,
        ...reviewed,
        readingChecks,
        disposition,
        presentation,
        sourceCheckStatus: presentationSourceCheckStatus(presentation),
        editorialReviewStatus: disposition.editorialReviewStatus,
        generatedAt,
        inputManifest: receipt,
        meta: meta ? {
          ...meta,
          estimated_cost_usd: editionCost(receipt, meta, pricingDate),
          warnings: originalEditionWarnings(receipt, meta),
        } : receipt.validation ? { estimated_cost_usd: editionCost(receipt, meta, pricingDate), warnings: originalEditionWarnings(receipt, meta) } : null,
      });
    } catch {
      res.status(500).json({ error: 'Failed to read briefing' });
    }
  });

  router.post('/brief/:filename/disposition', recoveryAccess, (req, res) => {
    const filename = req.params.filename;
    if (!validBriefFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (!existsSync(join(historyDir, filename))) return res.status(404).json({ error: 'Briefing not found' });
    if (req.body?.status === 'superseded' && (!validBriefFilename(req.body.replacementFilename) || !existsSync(join(historyDir, req.body.replacementFilename)))) return res.status(400).json({ error: 'Replacement briefing not found' });
    try {
      const reading = loadBriefReadingState(historyDir, filename, { reviewDirectory: reviewDir });
      saveBriefDisposition(filename, reading.original, req.body || {}, reviewDir, { readingContent: reading.content });
      return res.json({ disposition: loadBriefReadingState(historyDir, filename, { reviewDirectory: reviewDir }).disposition });
    }
    catch { return res.status(400).json({ error: 'A valid disposition, reviewer and reason are required.' }); }
  });

  // ── GET /search?q= ── (FTS5 full-text over all briefings)
  router.get('/search', (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.length < 2) {
      return res.status(400).json({ error: 'Query too short', code: 'E005' });
    }
    if (q.length > 200) {
      return res.status(400).json({ error: 'Query too long', code: 'E005' });
    }
    try {
      // Tokenize and double-quote each term rather than passing raw text to MATCH.
      // FTS5 parses a bare hyphen as a column filter ("CVE-2026-1234" throws "no
      // such column: 2026") and bare AND/OR/NOT/NEAR as query operators — both
      // previously threw, and the catch below swallowed the error into an empty
      // result, silently lying about the archive for the single most natural
      // analyst query (a CVE ID). A quoted string token is matched literally,
      // hyphens and all, and neutralizes the boolean/proximity operators.
      const terms = q.split(/\s+/).filter(Boolean).map(t => '"' + t.replace(/"/g, '') + '"');
      if (!terms.length) return res.json([]);
      const matches = searchBriefs(terms.join(' '), 20, { sort: req.query.sort === 'newest' ? 'newest' : 'relevance' });
      res.json(matches.map(item => {
        if (!validBriefFilename(item.filename) || !existsSync(join(historyDir, item.filename))) return item;
        const { reviewed, disposition, presentation } = loadBriefReadingState(historyDir, item.filename, { reviewDirectory: reviewDir });
        return { ...item, disposition, presentation, ...(reviewed.review ? { reviewStatus: reviewed.review.status, snippetVersion: 'original-generated-edition' } : {}) };
      }));
    } catch (err) {
      log.warn('search', `FTS5 error: ${err.message}`);
      res.status(503).json({ error: 'Archive search is temporarily unavailable. Your query was not evaluated.', code: 'E_SEARCH_UNAVAILABLE' });
    }
  });

  return router;
}

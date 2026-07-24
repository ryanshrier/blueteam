// BlueTeam.News — briefing generation (SSE) + history + search routes.

import { Router } from 'express';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { getConfig, getHorizonName } from '../lib/config.js';
import { getFreshRun } from '../lib/refresher.js';
import { buildSystemPrompt, buildUserPrompt } from '../lib/prompts.js';
import { saveBrief, loadRecentBriefs, extractContinuityContext, extractBluf, briefDateFromFilename, localDateISO } from '../lib/history.js';
import { validateBrief, countHorizons, hasHardFail, hasTrustCriticalFailure } from '../lib/validation.js';
import { buildGroundingManifest, delinkUnallowlistedMarkdownUrls, visibleHeadlineEvidence } from '../lib/grounding.js';
import { parseJudgments } from '../lib/brief-schema.js';
import { getEffectiveOrganization } from '../lib/user-settings.js';
import {
  saveBriefMeta, getBriefMeta, indexBrief, searchBriefs,
  countKEVAddedToday, getRecentKEV, getKEVSet, getKEVDueDates,
} from '../lib/db.js';
import { dispatchBriefWebhook } from '../lib/alerts.js';
import { log } from '../lib/logger.js';
import { localhostBaseUrl, normalizePublicBaseUrl } from '../lib/public-url.js';

// Adaptive thinking lifts synthesis-and-judgment quality, but only some models
// accept it — Haiku 4.5 (the cost fallback) 400s on the param. Gate by model so
// the fallback path stays valid.
// Exported for unit testing: pure/self-contained helpers with no route
// wiring, so the model-fallback trigger, SSE event framing, and redaction rules
// can be pinned directly without booting the full app or an HTTP server.
export function supportsAdaptiveThinking(model) {
  return /opus-4-[678]|sonnet-5|fable-5/.test(model || '');
}

// First-party Claude API list pricing per million tokens. Sonnet 5's launch
// pricing is temporary, so date-gate it instead of baking a soon-wrong estimate
// into every archived brief. Unknown IDs return null rather than pretending $0.
function modelPrice(model, at = new Date()) {
  const id = String(model || '').toLowerCase();
  if (/claude-sonnet-5(?:$|-)/.test(id)) {
    return at.getTime() < Date.UTC(2026, 8, 1) // introductory pricing through Aug 31, 2026
      ? { input: 2, output: 10 }
      : { input: 3, output: 15 };
  }
  if (/claude-haiku-4-5/.test(id)) return { input: 1, output: 5 };
  if (/claude-opus-4-[5678]/.test(id)) return { input: 5, output: 25 };
  if (/claude-fable-5/.test(id)) return { input: 10, output: 50 };
  return null;
}

export function estimateCostUsd(model, inputTokens, outputTokens, at = new Date()) {
  const price = modelPrice(model, at);
  if (!price) return null;
  return (inputTokens || 0) / 1e6 * price.input + (outputTokens || 0) / 1e6 * price.output;
}

// Apply (or remove) adaptive thinking on a model param set, honoring the
// configured effort. Medium is the default balance; high effort on a large brief
// can think past the generation timeout before emitting text.
export function applyThinking(params, model, effort) {
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

  // If enrichment failed this run, tell the model to hedge rather than read an
  // absent CVSS/affected-product/KEV signal as "not severe".
  const failed = run?.stats?.enrichmentFailures || [];
  if (failed.length) {
    lines.push(`• Enrichment note: ${failed.join(' and ')} enrichment was unavailable this run — CVSS scores, affected-product detail, and KEV membership may be incomplete. Treat missing enrichment as unconfirmed, never as "not severe" or "no vulnerability."`);
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
export async function streamWithRecovery(anthropic, params, { timeoutMs = 180_000, onChunk } = {}) {
  let fullText = '';
  let stream;
  let timedOut = false;
  let streamError = null;
  let stopReason = null;
  const usage = { input_tokens: 0, output_tokens: 0 };

  try {
    stream = await anthropic.messages.stream(params);
  } catch (err) {
    return { text: fullText, error: err, timedOut: false, usage };
  }

  const genTimeout = setTimeout(() => {
    timedOut = true;
    log.warn('stream', `Generation timeout (${timeoutMs / 1000}s) — saving partial briefing`);
    try { stream.controller?.abort(); } catch { /* best effort */ }
  }, timeoutMs);

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
        if (onChunk) onChunk(event.delta.text, fullText);
      }
      if (event.type === 'message_start' && event.message?.usage) {
        usage.input_tokens = event.message.usage.input_tokens || 0;
        usage.output_tokens = event.message.usage.output_tokens || 0;
      }
      if (event.type === 'message_delta' && event.usage?.output_tokens) {
        usage.output_tokens = event.usage.output_tokens;
      }
      if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason;
      }
    }
  } catch (err) {
    if (!timedOut) {
      streamError = err;
      log.warn('stream', `Stream interrupted: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
    }
  } finally {
    clearTimeout(genTimeout);
  }

  return { text: fullText, error: streamError, timedOut, usage, stopReason };
}

export function safeErrorMsg(err) {
  // Provider/client errors should never echo credential-shaped material to an
  // SSE client, even if an upstream library includes it in a diagnostic.
  const msg = (err?.message || '').trim()
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
  if (!msg) return 'Internal server error';
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

export function createBriefRouter({ getAnthropic, rotateKey, historyDir, cooldown, publicBaseUrl = null, localPort = process.env.PORT || 3000 }) {
  const router = Router();
  const outwardBaseUrl = normalizePublicBaseUrl(publicBaseUrl) || localhostBaseUrl(localPort);

  // Real in-flight lock: the cooldown alone is a timestamp gate that
  // only blocks a second POST for 15s, but generation runs up to 180s (360s with
  // model fallback) — a click 16s into a generation started a fully concurrent
  // second one, doubling spend and racing saveBrief's same-day filename counter.
  // This flag is set for the lifetime of a generation and cleared in `finally`,
  // so overlap is impossible regardless of timing; the cooldown remains as a
  // post-completion debounce against rapid re-clicks once generation finishes.
  let generating = false;

  // ── POST /brief — generate, streaming via SSE ──
  router.post('/brief', async (req, res) => {
    let anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({
        error: 'AI briefing disabled — set ANTHROPIC_API_KEY to enable generation',
        code: 'E002',
      });
    }
    if (generating) {
      return res.status(429).json({ error: 'Briefing generation in progress — please wait', code: 'E001' });
    }
    if (!cooldown.check('brief', 15000)) {
      return res.status(429).json({ error: 'Briefing generation in progress — please wait', code: 'E001' });
    }
    generating = true;

    const config = getConfig();
    const s = config.analysisSettings || {};

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

    try {
      // Stage 1 — landscape data (reuses the background run when fresh)
      send({ progress: 'Collecting landscape data...', stage: 'fetching' });
      const run = await getFreshRun(5 * 60_000);
      const headlines = run.headlines || [];
      send({ progress: `${headlines.length} scored headlines (${run.stats?.enriched || 0} enriched)`, stage: 'scoring' });

      // Stage 2 — continuity context
      const prev = loadRecentBriefs(historyDir, s.continuityDepth ?? 5);
      const continuityContext = extractContinuityContext(prev);

      // Stage 3 — generate
      send({ progress: 'Writing briefing...', stage: 'generating' });
      // Layer the operator's Settings > Organization profile overrides (sector,
      // team profile, regions) over config.json's defaults — a scoped copy so
      // the rest of this handler keeps reading the unmodified config.
      const promptConfig = { ...config, organization: getEffectiveOrganization(config) };
      const systemPrompt = buildSystemPrompt(promptConfig);
      const groundTruth = buildGroundTruth(run);
      const groundingManifest = buildGroundingManifest({ headlines, extraSourceText: groundTruth });
      const userPrompt = buildUserPrompt({
        headlines, continuityContext, groundTruth, config: promptConfig, groundingManifest,
      });

      const preferredModel = s.preferredModel || 'claude-sonnet-5';
      const fallbackModel = s.model || 'claude-haiku-4-5';
      let modelUsed = preferredModel;
      const genTimeoutMs = (s.generationTimeoutSec ?? 180) * 1000;
      const genStart = performance.now();
      let chunkSeq = 0;

      const modelParams = {
        model: preferredModel,
        max_tokens: s.maxTokens || 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      };
      const thinkingEffort = s.thinkingEffort || 'medium';
      applyThinking(modelParams, preferredModel, thinkingEffort);

      const onChunk = (chunk) => send({ text: chunk, seq: chunkSeq++ });

      // From here on the request may incur provider cost. Rate limiters inspect
      // this marker on response finish/close so aborting the SSE connection
      // cannot refund a generation that continues in the background and saves.
      res.locals.briefGenerationAttempted = true;
      let result = await streamWithRecovery(anthropic, modelParams, { timeoutMs: genTimeoutMs, onChunk });
      if (result.stopReason === 'refusal') {
        throw new Error('Claude refused this briefing request. Review the source mix and retry.');
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
      if (result.error && (result.error.status === 401 || result.error.status === 403) && typeof rotateKey === 'function') {
        const rotated = rotateKey();
        if (rotated) {
          log.warn('brief', `${modelUsed} auth rejected — retrying with secondary API key`);
          anthropic = rotated;
          result = await streamWithRecovery(anthropic, modelParams, { timeoutMs: genTimeoutMs, onChunk });
          if (result.stopReason === 'refusal') {
            throw new Error('Claude refused this briefing request. Review the source mix and retry.');
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
          applyThinking(modelParams, fallbackModel, thinkingEffort);
          send({ text: `*[Generated with ${fallbackModel} — preferred model unavailable]*\n\n` });
          result = await streamWithRecovery(anthropic, modelParams, { timeoutMs: genTimeoutMs, onChunk });
          if (result.stopReason === 'refusal') {
            throw new Error('Claude refused this briefing request. Review the source mix and retry.');
          }
          result.usage = {
            input_tokens: firstAttemptUsage.input_tokens + result.usage.input_tokens,
            output_tokens: firstAttemptUsage.output_tokens + result.usage.output_tokens,
          };
        }
      }

      // Empty or degenerate output is a failure regardless of error state
      if (result.text.length < 100) {
        const err = result.error || new Error(
          result.timedOut
            ? 'Generation timed out before the model produced content.'
            : `Model returned no content (${modelUsed}).`
        );
        if (result.error?.status) err.status = result.error.status;
        throw err;
      }

      let fullBrief = result.text;
      const elapsed = ((performance.now() - genStart) / 1000).toFixed(1);
      let wordCount = fullBrief.trim().split(/\s+/).length;

      // Stage 4 — validate, with one automatic corrective retry. Structural
      // hard-fails preserve their existing warn/save behavior after the retry;
      // factual grounding failures do not publish if they remain unresolved.
      const genDate = localDateISO();
      const validationSource = { groundingManifest, kevSet: getKEVSet() };
      const audit = draft => validateBrief(draft, genDate, validationSource);
      let validation = audit(fullBrief);
      let warnings = validation.valid ? [] : [...validation.warnings];
      // hasHardFail is exported by lib/validation.js — the same module that
      // produces the warning strings — so this can never drift out of sync with
      // a rewording the way a local string-matching regex could.
      let hardFail = hasHardFail(warnings);
      let trustFail = hasTrustCriticalFailure(warnings);
      let correctiveRetryAttempted = false;

      // Resolve a link-only failure without paying for another model call.
      // Citation prose stays intact; only an unsupported live href is removed.
      let delinkedBrief = delinkUnallowlistedMarkdownUrls(fullBrief, groundingManifest);
      if (delinkedBrief !== fullBrief) {
        fullBrief = delinkedBrief;
        wordCount = fullBrief.trim().split(/\s+/).length;
        validation = audit(fullBrief);
        warnings = validation.valid ? [] : [...validation.warnings];
        hardFail = hasHardFail(warnings);
        trustFail = hasTrustCriticalFailure(warnings);
      }

      if ((hardFail || trustFail) && !result.error && !result.timedOut) {
        correctiveRetryAttempted = true;
        const correctiveWarnings = warnings.filter(warning => (
          hasHardFail([warning]) || hasTrustCriticalFailure([warning])
        ));
        log.warn('brief', `Corrective validation retry (${correctiveWarnings.join('; ')})`);
        send({ progress: 'Retrying — correcting source verification or required structure...', stage: 'generating' });
        modelParams.messages = [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: fullBrief },
          { role: 'user', content: `Your previous draft failed these checks: ${correctiveWarnings.join('; ')}. Regenerate the full brief from the top in the exact same format. Use only CVEs and URLs in the current-source input; a source marked URL unavailable must have a plain [Source Name, Date] citation with no link. Never contradict verified KEV status.` },
        ];
        const retryResult = await streamWithRecovery(anthropic, modelParams, { timeoutMs: genTimeoutMs, onChunk });
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
          fullBrief = result.text;
          wordCount = fullBrief.trim().split(/\s+/).length;
          validation = audit(fullBrief);
          warnings = validation.valid ? [] : [...validation.warnings];
          hardFail = hasHardFail(warnings);
          trustFail = hasTrustCriticalFailure(warnings);
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
        hardFail = hasHardFail(warnings);
        trustFail = hasTrustCriticalFailure(warnings);
      }

      // A brief is partial when the generation timed out OR a mid-stream error
      // (network reset, mid-stream overloaded) truncated it after content had
      // already streamed — that error is captured in result.error but previously
      // only the timeout path ever set the partial flag, so a cut-off brief was
      // saved, announced as complete, and promoted to the Wall with no marker.
      const isPartial = result.timedOut || !!result.error;
      if (result.error) {
        warnings.push(`Generation was interrupted mid-stream: ${safeErrorMsg(result.error)}`);
      }
      if (warnings.length) {
        log.warn('brief', `Validation warnings: ${warnings.join('; ')}`);
      }

      if (trustFail) {
        const blocking = warnings.filter(warning => hasTrustCriticalFailure([warning]));
        const costUsd = estimateCostUsd(modelUsed, result.usage?.input_tokens, result.usage?.output_tokens);
        const retryState = correctiveRetryAttempted
          ? 'after one corrective retry'
          : 'and a corrective retry could not be completed';
        const message = `Draft was not published because source verification still failed ${retryState}: ${blocking.join('; ')}. Refresh the landscape data or correct the source input, then generate again.`;
        log.error('brief', message);
        send({
          error: message,
          code: 'E006',
          draft: fullBrief,
          model: modelUsed,
          tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
          costUsd,
          validation: { warnings, hardFail, trustFail: true },
        });
        if (clientConnected) {
          try { res.end(); } catch { /* client gone */ }
        }
        return;
      }

      const filename = saveBrief(historyDir, fullBrief);
      const generatedAt = new Date().toISOString();
      // Index synchronously (better-sqlite3 is synchronous and fast): the brief is
      // searchable the instant we tell the client it's done, and an index failure
      // surfaces in this brief's warnings instead of vanishing into a log line.
      try {
        indexBrief(filename, fullBrief);
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
        log.warn('brief', `DB write error (non-blocking): ${dbErr.message}`);
        warnings.push('Search index failed — this brief will not appear in search until the next reindex.');
      }

      // Push the finished brief (BLUF + key judgments + link) to the configured
      // webhook when webhook.events is 'brief'/'both'. Self-gating and best-effort:
      // never awaited, never throws, never delays the client's completion event.
      // The link must be absolute — safeSlackLink() rejects anything new URL()
      // can't parse, which silently drops a bare relative path.
      const judgments = parseJudgments(fullBrief).map(j => ({
        title: j.title, tier: getHorizonName(config, j.horizon), confidence: j.confidence,
      }));
      dispatchBriefWebhook(
        { date: genDate, bluf: extractBluf(fullBrief), judgments, link: `${outwardBaseUrl}/briefing/${encodeURIComponent(filename)}` },
        config,
      ).catch(err => log.warn('brief', `Brief webhook dispatch failed (non-blocking): ${err.message}`));

      // Estimated cost — clearly labeled "est." wherever a client surfaces it;
      // null when the model isn't in the price map rather than a misleading $0.
      const costUsd = estimateCostUsd(modelUsed, result.usage?.input_tokens, result.usage?.output_tokens);

      log.info('brief', `Complete — ${fullBrief.length} chars, ${wordCount} words, ${elapsed}s, model: ${modelUsed}${isPartial ? ' (partial)' : ''}${costUsd != null ? ` (est. $${costUsd.toFixed(3)})` : ''}`);

      // Explicit success signal for the short-window and daily generation
      // limiters. HTTP status cannot distinguish SSE success from failure.
      res.locals.briefGenerationSucceeded = true;
      send({
        briefComplete: true, text: fullBrief, filename,
        timestamp: generatedAt, partial: isPartial,
        model: modelUsed,
        tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
        costUsd,
        validation: warnings.length ? { warnings, hardFail } : null,
      });
      if (clientConnected) {
        try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
      }
    } catch (err) {
      log.error('brief', `Generation error: ${err.message}`);
      send({ error: safeErrorMsg(err) });
      if (clientConnected) {
        try { res.end(); } catch { /* client gone */ }
      }
    } finally {
      clearInterval(heartbeat);
      generating = false;
    }
  });

  // ── GET /briefs — history list ──
  router.get('/briefs', (req, res) => {
    try {
      const briefs = readdirSync(historyDir)
        .filter(f => f.startsWith('brief-') && f.endsWith('.md'))
        .sort().reverse().slice(0, 30);

      const results = briefs.map(f => {
        const date = briefDateFromFilename(f);
        const meta = getBriefMeta(f);
        const generatedAt = meta?.generated_at || statSync(join(historyDir, f)).mtime.toISOString();
        // Estimate an archived run at the price in effect on its edition date so
        // Sonnet 5's introductory pricing does not make old costs drift over time.
        const pricingDate = date ? new Date(`${date}T12:00:00Z`) : new Date();
        // Trust the stored meta — bluf + word_count are persisted at generation — and
        // skip the disk read entirely (the common path). Only fall back to reading the
        // file for a legacy brief that predates the meta table. [F]
        if (meta && meta.bluf != null && meta.word_count != null) {
          return {
            filename: f, date, bluf: (meta.bluf || '').slice(0, 250), wordCount: meta.word_count,
            model: meta.model_used || null,
            costUsd: estimateCostUsd(meta.model_used, meta.input_tokens, meta.output_tokens, pricingDate),
            warnings: parseWarnings(meta.warnings),
            generatedAt,
          };
        }
        const content = readFileSync(join(historyDir, f), 'utf-8');
        return { filename: f, date, bluf: extractBluf(content).slice(0, 250), wordCount: content.trim().split(/\s+/).length, model: meta?.model_used || null, warnings: [], generatedAt };
      });
      res.json(results);
    } catch {
      res.json([]);
    }
  });

  // ── GET /brief/:filename ──
  router.get('/brief/:filename', (req, res) => {
    const filename = req.params.filename;
    // Pin the real brief shape (brief-YYYY-MM-DD[-NN].md); the tight pattern makes
    // traversal impossible, and the resolve() confinement is belt-and-suspenders.
    if (!/^brief-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(filename)) {
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
      const content = readFileSync(filepath, 'utf-8');
      const meta = getBriefMeta(filename);
      const generatedAt = meta?.generated_at || statSync(filepath).mtime.toISOString();
      const editionDate = briefDateFromFilename(filename);
      const pricingDate = editionDate ? new Date(`${editionDate}T12:00:00Z`) : new Date();
      res.json({
        filename,
        content,
        generatedAt,
        meta: meta ? {
          ...meta,
          estimated_cost_usd: estimateCostUsd(meta.model_used, meta.input_tokens, meta.output_tokens, pricingDate),
          warnings: parseWarnings(meta.warnings),
        } : null,
      });
    } catch {
      res.status(500).json({ error: 'Failed to read briefing' });
    }
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
      res.json(searchBriefs(terms.join(' '), 20));
    } catch (err) {
      log.warn('search', `FTS5 error: ${err.message}`);
      res.json([]);
    }
  });

  return router;
}

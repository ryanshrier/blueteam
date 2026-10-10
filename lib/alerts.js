// BlueTeam.News — outbound alert + brief delivery.
//
// alertRules boost a headline's score and set `alertMatched`; dispatchAlerts
// is what actually gets the zero-day / your-stack-vendor signal out of the
// box. After each pipeline run the refresher hands us the scored headlines;
// we POST the matched ones to the operator-configured webhook.
//
// dispatchBriefWebhook does the same for the finished daily brief's BLUF +
// key judgments — the artifact leadership actually reads, pushed to the same
// channel. `webhook.events` ('alerts' | 'brief' | 'both') chooses
// which of the two fire; the caller in routes/brief.js invokes
// dispatchBriefWebhook once a brief completes.
//
// Discipline (shared by both dispatch functions):
//   • DISABLED by default — fires only when analysisSettings.webhook.url is set.
//   • SSRF-guarded — every POST goes through safeFetch (the url is operator-
//     supplied but still untrusted; a webhook into an internal service is the
//     exact vector safeFetch closes).
//   • Deduped per destination and material event. Briefing notifications bind
//     to their immutable edition/reading-copy identity.
//   • Persisted before sending, with bounded retries and visible failures.
//     Delivery remains independent of refresh/publication success.

import { PUBLIC_APP_NAME } from './identity.js';
import { createHash } from 'node:crypto';

import { safeFetch, readCapped } from './net.js';
import { titleKey } from './db.js';
import { log } from './logger.js';
import { assessUrgency, headlineCves } from './intelligence-context.js';
import { webhookDestinationKey, knownWebhookEventKeys, enqueueWebhookBatches, drainWebhookOutbox,
  getWebhookDeliveryStatus } from './alert-delivery.js';
export { getWebhookDeliveryStatus } from './alert-delivery.js';

const POST_TIMEOUT_MS = 8000;
const MAX_BRIEF_WARNINGS = 20;
const MAX_BRIEF_WARNING_CHARS = 500;
const MAX_SLACK_SECTION_CHARS = 2900;
const MAX_SLACK_MESSAGE_CHARS = 12000;
const MAX_SLACK_CONTENT_BLOCKS = 40;
// Delivery and its sent-key update must be one serialized operation. Pipeline
// runs can finish while a prior webhook is still draining; without this queue,
// both dispatches can read the same old key set and post the same alert twice.
let alertDispatchTail = Promise.resolve();
let deliveryTimer = null;
let briefDeliveryValidator;
let deliveryConfigProvider;
const eventHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const federalDueDatePassed = headline => Boolean(headline.kevOverdue || headline.kevRecords?.some(record => record.overdue));

// Recency and score fluctuate every refresh. Escalation identity includes
// concrete threat state instead, so a KEV/deadline/CVE change can alert again
// without repeatedly notifying on routine score decay.
export function alertEventKey(headline, destination) {
  const urgency = assessUrgency(headline, undefined, { preparedOnly: true });
  const severity = Number.isFinite(headline.cvssScore)
    ? headline.cvssScore >= 9 ? 'critical' : headline.cvssScore >= 7 ? 'high' : headline.cvssScore >= 4 ? 'medium' : 'low'
    : null;
  return eventHash([destination, titleKey(headline.title),
    Boolean(headline.isKEV), federalDueDatePassed(headline),
    [...new Set([...headlineCves(headline), headline.kevCVE, ...(headline.kevRecords || []).map(record => record.cve)]
      .filter(value => typeof value === 'string'))].sort(),
    (headline.kevRecords || []).map(record => [record.cve || null, record.dueDate || null, Boolean(record.overdue)])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    urgency.exploitationStatus, urgency.level, severity]);
}

function serializedDelivery(work) {
  const pending = alertDispatchTail.then(work);
  alertDispatchTail = pending.catch(() => {});
  return pending;
}

function drain(config, options = {}) {
  // A completed pipeline can carry an older config snapshot while waiting for
  // another send. Resolve the current destination/events when the queue runs.
  const currentConfig = typeof deliveryConfigProvider === 'function' ? deliveryConfigProvider() : config;
  return drainWebhookOutbox(currentConfig, postWebhook, { validateBriefDelivery: briefDeliveryValidator, ...options });
}

export function retryWebhookDeliveries(config) {
  return serializedDelivery(() => drain(config)).catch(error => {
    log.warn('alerts', `Webhook retry unavailable: ${error.message}`);
  });
}

export function startWebhookDeliverySchedule({ getConfig, validateBriefDelivery } = {}) {
  stopWebhookDeliverySchedule();
  briefDeliveryValidator = validateBriefDelivery;
  deliveryConfigProvider = getConfig;
  if (typeof getConfig !== 'function') return;
  const retry = () => {
    try { return retryWebhookDeliveries(getConfig()); }
    catch (error) { log.warn('alerts', `Webhook retry configuration unavailable: ${error.message}`); }
  };
  deliveryTimer = setInterval(retry, 60_000);
  deliveryTimer.unref?.();
  retry();
}

export function stopWebhookDeliverySchedule() {
  if (deliveryTimer) clearInterval(deliveryTimer);
  deliveryTimer = null;
}

export async function waitForWebhookDeliveryIdle() {
  let pending;
  do { pending = alertDispatchTail; await pending; } while (pending !== alertDispatchTail);
}

function chipFor(h) {
  const bits = [];
  if (h.isKEV) bits.push(h.kevCVE ? `KEV ${h.kevCVE}` : 'KEV');
  if (federalDueDatePassed(h)) bits.push('FEDERAL DUE DATE PASSED');
  bits.push(`H${h.horizon}`);
  if (h.source) bits.push(h.source);
  return bits.join(' · ');
}

// Slack mrkdwn escaping (per Slack's own spec: escape &, <, > — in THAT order,
// so the &amp; produced for a literal '&' doesn't get re-escaped by the '<'/'>'
// passes). Feed title/link text is untrusted; without this a title or link
// containing '|' or '>' breaks out of the `<url|text>` link syntax and injects
// arbitrary mrkdwn (forged formatting, deceptive links) into the operator's
// channel.
function escapeMrkdwn(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Only build a Slack link token for a link that's actually safe to embed in
// `<url|text>` syntax: http(s) scheme only (matches safeFetch's own scheme
// gate) and free of the '|'/'<'/'>' characters that would let it escape the
// link token even after escaping the surrounding text.
function safeSlackLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  if (/[|<>]/.test(link)) return '';
  return ` <${link}|link>`;
}

function buildSlackBatches(items) {
  const batches = [];
  let blocks = [];
  let keys = [];
  let chars = 0;
  const flush = () => {
    if (!blocks.length) return;
    const heading = `${PUBLIC_APP_NAME} — new alerts`;
    batches.push({
      keys,
      body: {
        text: `:rotating_light: ${heading}\n${blocks.map(block => block.text.text).join('\n')}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*` } }, ...blocks],
      },
    });
    blocks = []; keys = []; chars = 0;
  };
  for (const item of items) {
    const line = `• *${escapeMrkdwn(item.title)}* — ${escapeMrkdwn(chipFor(item))}${safeSlackLink(item.link)}`;
    // Ordinary alerts stay intact. An oversized item uses plain text chunks,
    // so a split cannot corrupt a Slack link or escape sequence. Its dedup key
    // is attached only after every chunk, including any prior message, succeeds.
    const sections = line.length <= MAX_SLACK_SECTION_CHARS
      ? [{ type: 'mrkdwn', text: line }]
      : (() => {
        const characters = Array.from(`• ${item.title} — ${chipFor(item)}${item.link ? ` ${item.link}` : ''}`);
        const chunks = [];
        let text = '';
        for (const character of characters) {
          if (text.length + character.length > MAX_SLACK_SECTION_CHARS) {
            chunks.push({ type: 'plain_text', text }); text = '';
          }
          text += character;
        }
        if (text) chunks.push({ type: 'plain_text', text });
        return chunks;
      })();
    for (const section of sections) {
      if (chars + section.text.length > MAX_SLACK_MESSAGE_CHARS || blocks.length >= MAX_SLACK_CONTENT_BLOCKS) flush();
      const previous = blocks.at(-1)?.text;
      if (previous?.type === section.type && previous.text.length + 1 + section.text.length <= MAX_SLACK_SECTION_CHARS) {
        previous.text += `\n${section.text}`;
        chars += 1;
      } else {
        blocks.push({ type: 'section', text: { ...section } });
      }
      chars += section.text.length;
    }
    keys.push(item.deliveryKey);
  }
  flush();
  return batches;
}

function buildJsonBody(items) {
  return {
    source: 'blueteam',
    generatedAt: new Date().toISOString(),
    count: items.length,
    items: items.map(h => ({
      title: h.title,
      link: h.link || null,
      source: h.source || null,
      horizon: h.horizon,
      score: Math.round((h.score || 0) * 10) / 10,
      isKEV: Boolean(h.isKEV),
      kevCVE: h.kevCVE || null,
      kevOverdue: federalDueDatePassed(h),
      kevDeadlineScope: 'US federal civilian agencies',
      kevDeadlines: (h.kevRecords || []).map(record => ({ cve: record.cve, dueDate: record.dueDate || null, overdue: Boolean(record.overdue) })),
    })),
  };
}

// Shared POST-and-drain, used by both dispatchAlerts and dispatchBriefWebhook.
// SSRF-guarded (safeFetch), timeout-bounded, and drains a small capped amount
// of the response body rather than leaving the stream unconsumed.
// Returns the Response so callers can inspect res.ok. A network failure throws
// so the durable outbox can distinguish safe retries from ambiguous delivery.
async function postWebhook(url, body, deliveryId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': deliveryId },
      body,
    }, { allowRedirects: false });
    // Keep the same deadline alive through the response drain. Clearing it as
    // soon as headers arrived let a webhook trickle its body forever and hang
    // alert/brief dispatch despite the documented 8-second bound.
    try {
      await readCapped(res, 64_000);
    } catch {
      try { await res.body?.cancel?.(); } catch { /* already closed/aborted */ }
    }
    // Belt-and-suspenders for non-2xx responses: custom/mocked transports may
    // report a completed drain without actually consuming the underlying body.
    // Cancellation after a real completed drain is a harmless no-op.
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* already drained/locked */ }
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

function summarizeBriefWarnings(value) {
  const source = Array.isArray(value)
    ? value.map(warning => String(warning || '').trim()).filter(Boolean)
    : [];
  const warnings = source
    .slice(0, MAX_BRIEF_WARNINGS)
    .map(warning => warning.slice(0, MAX_BRIEF_WARNING_CHARS));
  return {
    count: source.length,
    truncated: source.length > warnings.length
      || source.some(warning => warning.length > MAX_BRIEF_WARNING_CHARS),
    warnings,
  };
}

// Slack/JSON body for the finished brief's BLUF + key judgments. Kept
// deliberately compact — this is a "here's today's brief" ping, not the full
// text; the deep link is where the reader goes for the rest.
function buildBriefSlackBody({ date, bluf, judgments, link, warnings }) {
  const lines = (judgments || []).map(j => `• *${escapeMrkdwn(j.title)}* — ${escapeMrkdwn(j.tier || '')}${j.confidence ? ` (${escapeMrkdwn(j.confidence)})` : ''}`);
  const linkToken = safeSlackLink(link);
  const warningSummary = summarizeBriefWarnings(warnings);
  const warningLines = warningSummary.warnings.map(warning => `• ${escapeMrkdwn(warning)}`);
  const warningHeading = warningSummary.count
    ? `:warning: ${warningSummary.count} validation warning${warningSummary.count === 1 ? '' : 's'}${warningSummary.truncated ? ' (truncated)' : ''}`
    : '';
  const warningText = warningHeading
    ? `${warningHeading}${warningLines.length ? `\n${warningLines.join('\n')}` : ''}`
    : '';
  const text = `:newspaper: ${PUBLIC_APP_NAME} Brief — ${date}\n${bluf ? escapeMrkdwn(bluf) + '\n' : ''}${lines.join('\n')}${warningText ? `\n${warningText}` : ''}${linkToken}`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${PUBLIC_APP_NAME} Brief — ${date}*` } },
      ...(bluf ? [{ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(bluf).slice(0, 2900) } }] : []),
      ...(lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } }] : []),
      ...(warningText ? [{ type: 'section', text: { type: 'mrkdwn', text: warningText.slice(0, 2900) } }] : []),
      ...(linkToken ? [{ type: 'section', text: { type: 'mrkdwn', text: `<${link}|Open the full brief>` } }] : []),
    ],
  };
}

function buildBriefJsonBody({ date, bluf, judgments, link, warnings }) {
  const warningSummary = summarizeBriefWarnings(warnings);
  return {
    source: 'blueteam',
    type: 'brief',
    date,
    bluf: bluf || null,
    judgments: (judgments || []).map(j => ({ title: j.title, tier: j.tier || null, confidence: j.confidence || null })),
    link: link || null,
    validation: {
      warningCount: warningSummary.count,
      warnings: warningSummary.warnings,
      truncated: warningSummary.truncated,
    },
  };
}

/**
 * Dispatch a finished brief's BLUF + key judgments to the configured webhook.
 * No-op when disabled or when webhook.events is 'alerts' only. Best-effort:
 * catches and logs everything; never throws. Exact edition deliveries are
 * deduped and retain their payload in the durable outbox when retryable.
 *
 * `brief` shape:
 * { date, bluf, judgments: [{ title, tier, confidence }], link, warnings: [] }
 */
async function dispatchBriefWebhookOnce(brief, config) {
  const webhook = config?.analysisSettings?.webhook;
  const url = (webhook?.url || '').trim();
  if (!url) return; // disabled — the default
  const events = webhook.events || 'alerts';
  if (events !== 'brief' && events !== 'both') return;

  try {
    const format = webhook.format === 'json' ? 'json' : 'slack';
    const body = format === 'slack' ? buildBriefSlackBody(brief) : buildBriefJsonBody(brief);
    const destination = webhookDestinationKey(url);
    const key = eventHash([destination, 'brief', brief.deliveryIdentity || body]);
    if (!knownWebhookEventKeys().has(key)) {
      enqueueWebhookBatches({ destination, kind: 'brief', batches: [{ body, keys: [key] }],
        eventKeys: [key], deliveryIdentity: brief.deliveryIdentity || null });
    }
    await drain(config, { allowNewBriefKeys: [key] });
    log.info('alerts', `Brief webhook delivery checked (${format}; ${getWebhookDeliveryStatus().status})`);
  } catch (err) {
    log.warn('alerts', `Brief dispatch failed (non-blocking): ${err.message}`);
  }
}

export function dispatchBriefWebhook(brief, config) {
  return serializedDelivery(() => dispatchBriefWebhookOnce(brief, config));
}

/**
 * Dispatch matching alerts to the configured webhook. No-op when disabled or
 * when webhook.events is 'brief' only. Best-effort: catches and logs
 * everything; never throws.
 */
async function dispatchAlertsOnce(headlines, config) {
  const webhook = config?.analysisSettings?.webhook;
  const url = (webhook?.url || '').trim();
  if (!url) return; // disabled — the default
  const events = webhook.events || 'alerts';
  if (events !== 'alerts' && events !== 'both') return;

  try {
    const matched = (headlines || []).filter(h => h && h.alertMatched && h.title);
    if (matched.length === 0) return;

    const destination = webhookDestinationKey(url);
    const events = matched.map(item => ({ title: titleKey(item.title), key: alertEventKey(item, destination) }));
    const sentSet = knownWebhookEventKeys(events);
    const fresh = [];
    const freshKeys = [];
    for (const h of matched) {
      const key = alertEventKey(h, destination);
      if (!key || sentSet.has(key)) continue;
      sentSet.add(key); // guard against intra-run duplicates too
      fresh.push({ ...h, deliveryKey: key });
      freshKeys.push(key);
    }
    if (fresh.length === 0) { await drain(config); return; }

    const format = webhook.format === 'json' ? 'json' : 'slack';
    const batches = format === 'slack'
      ? buildSlackBatches(fresh)
      : [{ body: buildJsonBody(fresh), keys: freshKeys }];
    enqueueWebhookBatches({ destination, kind: 'alerts', batches, eventKeys: freshKeys });
    await drain(config);
    log.info('alerts', `Queued ${fresh.length} alert(s) for webhook delivery (${format}; ${getWebhookDeliveryStatus().status})`);
  } catch (err) {
    log.warn('alerts', `Dispatch failed (non-blocking): ${err.message}`);
  }
}

export function dispatchAlerts(headlines, config) {
  return serializedDelivery(() => dispatchAlertsOnce(headlines, config));
}

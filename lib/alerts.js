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
//   • Deduped (alerts only) — each story fires at most once. Sent title-keys
//     persist in the meta table so a restart or the next run doesn't re-alert
//     the same item. The brief has no dedup table — one brief per day, and
//     re-sending on a manual regenerate is an acceptable/expected repeat.
//   • Best-effort — never throws into the caller; a failed POST is logged
//     and the run/request still succeeds.

import { PUBLIC_APP_NAME } from './identity.js';

import { safeFetch, readCapped } from './net.js';
import { getMeta, setMeta, titleKey } from './db.js';
import { log } from './logger.js';

const META_KEY = 'alert_sent_keys';
// Cap the persisted set so it can't grow without bound; the archive prunes at
// 14 days, so a few hundred keys covers the dedup window with headroom.
const MAX_SENT_KEYS = 500;
const POST_TIMEOUT_MS = 8000;
// Delivery and its sent-key update must be one serialized operation. Pipeline
// runs can finish while a prior webhook is still draining; without this queue,
// both dispatches can read the same old key set and post the same alert twice.
let alertDispatchTail = Promise.resolve();

function loadSentKeys() {
  try {
    const raw = getMeta(META_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(k => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function persistSentKeys(keys) {
  // Keep the most recent MAX_SENT_KEYS (new keys are appended, so slice the tail).
  const capped = keys.slice(-MAX_SENT_KEYS);
  try { setMeta(META_KEY, JSON.stringify(capped)); } catch (e) {
    log.warn('alerts', `Could not persist sent keys: ${e.message}`);
  }
}

function chipFor(h) {
  const bits = [];
  if (h.isKEV) bits.push(h.kevCVE ? `KEV ${h.kevCVE}` : 'KEV');
  if (h.kevOverdue) bits.push('OVERDUE');
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

function buildSlackBody(items) {
  const lines = items.map(h => {
    const meta = chipFor(h);
    const link = safeSlackLink(h.link);
    return `• *${escapeMrkdwn(h.title)}* — ${escapeMrkdwn(meta)}${link}`;
  });
  const text = `:rotating_light: ${PUBLIC_APP_NAME} — ${items.length} new alert${items.length === 1 ? '' : 's'}\n${lines.join('\n')}`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${PUBLIC_APP_NAME} — ${items.length} new alert${items.length === 1 ? '' : 's'}*`,
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } },
    ],
  };
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
      kevOverdue: Boolean(h.kevOverdue),
    })),
  };
}

// Shared POST-and-drain, used by both dispatchAlerts and dispatchBriefWebhook.
// SSRF-guarded (safeFetch), timeout-bounded, and drains a small capped amount
// of the response body rather than leaving the stream unconsumed.
// Returns the Response so callers can inspect res.ok; never throws — a
// network failure surfaces as a thrown error the caller wraps in its own
// try/catch (both callers are best-effort by contract).
async function postWebhook(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Keep the same deadline alive through the response drain. Clearing it as
    // soon as headers arrived let a webhook trickle its body forever and hang
    // alert/brief dispatch despite the documented 8-second bound.
    try { await readCapped(res, 64_000); } catch { /* ignore — status already read */ }
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Slack/JSON body for the finished brief's BLUF + key judgments. Kept
// deliberately compact — this is a "here's today's brief" ping, not the full
// text; the deep link is where the reader goes for the rest.
function buildBriefSlackBody({ date, bluf, judgments, link }) {
  const lines = (judgments || []).map(j => `• *${escapeMrkdwn(j.title)}* — ${escapeMrkdwn(j.tier || '')}${j.confidence ? ` (${escapeMrkdwn(j.confidence)})` : ''}`);
  const linkToken = safeSlackLink(link);
  const text = `:newspaper: ${PUBLIC_APP_NAME} Brief — ${date}\n${bluf ? escapeMrkdwn(bluf) + '\n' : ''}${lines.join('\n')}${linkToken}`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${PUBLIC_APP_NAME} Brief — ${date}*` } },
      ...(bluf ? [{ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(bluf).slice(0, 2900) } }] : []),
      ...(lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } }] : []),
      ...(linkToken ? [{ type: 'section', text: { type: 'mrkdwn', text: `<${link}|Open the full brief>` } }] : []),
    ],
  };
}

function buildBriefJsonBody({ date, bluf, judgments, link }) {
  return {
    source: 'blueteam',
    type: 'brief',
    date,
    bluf: bluf || null,
    judgments: (judgments || []).map(j => ({ title: j.title, tier: j.tier || null, confidence: j.confidence || null })),
    link: link || null,
  };
}

/**
 * Dispatch a finished brief's BLUF + key judgments to the configured webhook.
 * No-op when disabled or when webhook.events is 'alerts' only. Best-effort:
 * catches and logs everything; never throws. Not deduped (one brief per day)
 * and unrelated to the alert title-key dedup table.
 *
 * `brief` shape: { date, bluf, judgments: [{ title, tier, confidence }], link }
 */
export async function dispatchBriefWebhook(brief, config) {
  const webhook = config?.analysisSettings?.webhook;
  const url = (webhook?.url || '').trim();
  if (!url) return; // disabled — the default
  const events = webhook.events || 'alerts';
  if (events !== 'brief' && events !== 'both') return;

  try {
    const format = webhook.format === 'json' ? 'json' : 'slack';
    const body = format === 'slack' ? buildBriefSlackBody(brief) : buildBriefJsonBody(brief);
    const res = await postWebhook(url, body);
    if (!res.ok) {
      log.warn('alerts', `Brief webhook POST returned HTTP ${res.status}`);
      return;
    }
    log.info('alerts', `Dispatched brief to webhook (${format})`);
  } catch (err) {
    log.warn('alerts', `Brief dispatch failed (non-blocking): ${err.message}`);
  }
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

    const sent = loadSentKeys();
    const sentSet = new Set(sent);
    const fresh = [];
    const freshKeys = [];
    for (const h of matched) {
      const key = titleKey(h.title);
      if (!key || sentSet.has(key)) continue;
      sentSet.add(key); // guard against intra-run duplicates too
      fresh.push(h);
      freshKeys.push(key);
    }
    if (fresh.length === 0) return;

    const format = webhook.format === 'json' ? 'json' : 'slack';
    const body = format === 'slack' ? buildSlackBody(fresh) : buildJsonBody(fresh);
    const res = await postWebhook(url, body);

    if (!res.ok) {
      log.warn('alerts', `Webhook POST returned HTTP ${res.status} — not marking ${fresh.length} item(s) sent`);
      return; // leave keys unpersisted so a transient failure retries next run
    }

    // Only record as sent on a confirmed delivery.
    persistSentKeys([...sent, ...freshKeys]);
    log.info('alerts', `Dispatched ${fresh.length} alert(s) to webhook (${format})`);
  } catch (err) {
    log.warn('alerts', `Dispatch failed (non-blocking): ${err.message}`);
  }
}

export function dispatchAlerts(headlines, config) {
  const dispatch = alertDispatchTail.then(() => dispatchAlertsOnce(headlines, config));
  // Keep the queue usable even if a future refactor lets an unexpected error
  // escape dispatchAlertsOnce's best-effort boundary.
  alertDispatchTail = dispatch.catch(() => {});
  return dispatch;
}

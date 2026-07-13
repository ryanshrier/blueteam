// BlueTeam.News — feed aggregation (RSS + Atom + news search) and the full
// intelligence pipeline: fetch → dedup → classify → score → diversify → enrich.
//
// Resilience features: per-feed circuit breakers, conditional GET caching,
// bounded concurrency, TF-IDF deduplication with distinct-publisher tracking.

import { XMLParser } from 'fast-xml-parser';
import { log } from './logger.js';
import {
  scoreHeadline, applyAlertRules, getEffectiveAlertRules, classifyUrgency,
  applyHorizonOverrides, enforceDiversity, writeScoringDebugLog,
} from './scoring.js';
import { getFeedCache, setFeedCache, logFeedHealth } from './db.js';
import { safeFetch, readCapped } from './net.js';
import { getDomainPack, getEnrichers } from './domain.js';
import { outboundUserAgent } from './identity.js';

// Identify the product honestly to feed operators. Some providers apply broad
// bot rules to non-browser clients, but impersonating a browser makes a security
// tool harder to trust and gives operators no useful provenance in their logs.
// Conditional GET, bounded concurrency, Retry-After handling, and serve-last-good
// keep this reader polite; an operator can supply a contact-bearing identity when
// their environment requires one.
export const feedUserAgent = outboundUserAgent;

export const FEED_STATUS = Object.freeze({
  OK: 'ok',
  OK_CACHED: 'ok (cached)',
  OK_STALE: 'ok (stale)',
  EMPTY: 'empty',
  CIRCUIT_OPEN: 'circuit-open',
  RATE_LIMITED: 'rate-limited',
  PARSE_ERROR: 'parse-error',
  FAILED: 'failed',
});

export const REACHABLE_FEED_STATUSES = Object.freeze([
  FEED_STATUS.OK,
  FEED_STATUS.OK_CACHED,
  FEED_STATUS.OK_STALE,
  FEED_STATUS.EMPTY,
]);

export const FRESH_FEED_STATUSES = Object.freeze([
  FEED_STATUS.OK,
  FEED_STATUS.OK_CACHED,
]);

export function httpFeedStatus(status) {
  return `http-${status}`;
}

// Outbound per-request timeout. 12s (was 5s) so slow government and policy
// feeds — CISA, gov-CERTs, Blogger-hosted research — clear before aborting.
const FETCH_TIMEOUT_MS = 12_000;

// Default per-feed body cap. Buffering whole feeds up to 16MB then
// parsing them synchronously (fast-xml-parser) can block the event loop for
// hundreds of ms per large feed, and with concurrency 8 the transient buffer
// footprint could reach well over 100MB — a real stall/OOM risk on a small
// deployment. Most feeds are a few hundred KB; only a couple of known
// full-content Blogger/WordPress feeds legitimately need the old 16MB
// ceiling, so they keep it via FEED_BODY_CAP_OVERRIDES and everything else
// gets the much smaller default.
const DEFAULT_FEED_BODY_CAP = 4_000_000;
const FEED_BODY_CAP_OVERRIDES = [
  // [hostname substring, cap in bytes]
  ['projectzero.google', 16_000_000], // Project Zero — ~13MB full-content feed (host is projectzero.google, not the old blogspot domain)
];

function feedBodyCap(feedUrl) {
  try {
    const host = new URL(feedUrl).hostname.toLowerCase();
    const hit = FEED_BODY_CAP_OVERRIDES.find(([needle]) => host.includes(needle));
    if (hit) return hit[1];
  } catch { /* fall through to default */ }
  return DEFAULT_FEED_BODY_CAP;
}

// Serve-last-good window: on a fetch failure we fall back to the cached items
// if they're no older than this, so a transient block never empties the wall.
const STALE_MAX_MS = 48 * 60 * 60 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'entry'].includes(name),
  // Entity processing disabled — several large feeds exceed the parser's
  // entity limit, and we strip HTML from descriptions anyway.
  processEntities: false,
  trimValues: true,
});

// Entity decoding lives here because the XML parser runs with
// processEntities disabled (several large feeds exceed its entity limit).
// Feeds ship descriptions like "&lt;p&gt;CISA has added..." — decode twice
// (handles &amp;lt; chains), then strip the now-real tags.
const NAMED_ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
  '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&rdquo;': '\u201d', '&ldquo;': '\u201c', '&amp;': '&',
};

function decodeEntities(str) {
  return String(str).replace(/&(?:amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo|#\d+|#x[0-9a-f]+);/gi, (m) => {
    const lower = m.toLowerCase();
    if (lower.startsWith('&#x')) {
      const code = parseInt(lower.slice(3, -1), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    if (lower.startsWith('&#')) {
      const code = parseInt(lower.slice(2, -1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[lower] ?? m;
  });
}

export function stripHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return decodeEntities(decodeEntities(str))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'object' && node['#text']) return String(node['#text']).trim();
  return String(node).trim();
}

// Resolve a possibly-relative link against the feed's own URL and drop
// anything that isn't http(s) after resolution. An Atom `<link href="/2026/06/
// post.html">` (relative href — some self-hosted Atom feeds and CMSes emit
// these) would otherwise pass through untouched: it renders as a Wire anchor
// that navigates INSIDE the BlueTeam.News app instead of to the publisher, makes
// `new URL()` throw inside extractArticleBody (silently failing extraction),
// and yields an empty publisherKey (the source count falls back to source name).
// `baseUrl` is optional so this stays reusable for callers with no feed
// context (e.g. Google News search results, which are already absolute).
function resolveLink(rawLink, baseUrl) {
  if (!rawLink) return '';
  try {
    const resolved = baseUrl ? new URL(rawLink, baseUrl).href : new URL(rawLink).href;
    return /^https?:$/.test(new URL(resolved).protocol) ? resolved : '';
  } catch {
    return '';
  }
}

function extractLink(item, baseUrl) {
  let raw = '';
  if (item.link && typeof item.link === 'string') raw = item.link.trim();
  else if (item.link && typeof item.link === 'object') {
    if (item.link['@_href']) raw = item.link['@_href'].trim();
    else if (Array.isArray(item.link)) {
      const alt = item.link.find(l => l['@_rel'] === 'alternate' || !l['@_rel']);
      if (alt?.['@_href']) raw = alt['@_href'].trim();
    }
  }
  if (!raw) {
    if (item.guid && typeof item.guid === 'string' && item.guid.startsWith('http')) raw = item.guid;
    else if (item.guid?.['#text'] && item.guid['#text'].startsWith('http')) raw = item.guid['#text'];
  }
  return resolveLink(raw, baseUrl);
}

// ── Google News redirect resolution ──
// News-sweep items carry opaque news.google.com/rss/articles/CBM… links that
// resolve to a Google interstitial, not the publisher. Decode the canonical
// publisher URL when we can do so confidently; otherwise drop the link so the
// brief cites [Source, Date] plain rather than an opaque redirect. We never
// fabricate a URL and never throw — a bad decode just yields "".
function isGoogleNewsLink(url) {
  return /^https?:\/\/news\.google\.com\//i.test(url || '');
}

// Some Google News article IDs base64-decode to a payload that embeds the
// publisher URL as a length-prefixed string (older "CBM…" format). Newer IDs
// are opaque protobuf with no embeddable URL — those stay undecodable and we
// drop the link rather than guess.
function decodeGoogleArticleId(id) {
  try {
    const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    const raw = buf.toString('latin1');
    const m = raw.match(/https?:\/\/[^\s\u0000-\u001f"'<>]+/);
    if (!m) return '';
    // Trailing bytes of the protobuf can bleed into the match; cut at the first
    // control/garbage byte and require a sane publisher host (never google.com).
    const candidate = m[0];
    if (isGoogleNewsLink(candidate)) return '';
    try {
      const u = new URL(candidate);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
      return u.href;
    } catch {
      return '';
    }
  } catch {
    return '';
  }
}

// Resolve a Google News link to the primary publisher. Strategy, in order:
//   1. a publisher href embedded in the item description's <a href>
//   2. a publisher URL decodable from the /articles/<id> path
// If neither is confident, return "" (drop the link).
export function resolveGoogleNewsLink(link, rawDescription = '') {
  if (!isGoogleNewsLink(link)) return link;
  try {
    // 1. description anchor (older feeds embed the real article link here)
    if (rawDescription) {
      const hrefs = String(rawDescription).match(/href="(https?:\/\/[^"]+)"/gi) || [];
      for (const h of hrefs) {
        const u = h.slice(6, -1);
        if (!isGoogleNewsLink(u)) {
          try { return new URL(u).href; } catch { /* try next */ }
        }
      }
    }
    // 2. decode the article id from the path
    const m = link.match(/\/rss\/articles\/([^?/]+)/) || link.match(/\/articles\/([^?/]+)/);
    if (m) {
      const decoded = decodeGoogleArticleId(m[1]);
      if (decoded) return decoded;
    }
  } catch { /* fall through to drop */ }
  return ''; // not confidently decodable — drop rather than cite a redirect
}

function isFresh(dateStr, maxAgeMs) {
  if (!dateStr) return true;
  const parsed = Date.parse(dateStr);
  if (isNaN(parsed)) return true;
  const delta = Date.now() - parsed;
  // Drop implausibly future-dated items (>1h ahead = feed clock skew or a
  // float-to-top trick). The scoring recency clamp neutralizes borderline skew;
  // this keeps the absurd out of the freshness window entirely.
  if (delta < -3600_000) return false;
  return delta < maxAgeMs;
}

// ── TF-IDF cosine similarity deduplication ──
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'has', 'have',
  'not', 'but', 'its', 'can', 'will', 'new', 'says', 'could', 'may', 'also', 'been',
  'more', 'than', 'all', 'into', 'over', 'after', 'how', 'what', 'who', 'why',
]);

function tokenize(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function buildIDF(documents) {
  const df = {};
  const N = documents.length;
  for (const doc of documents) {
    for (const term of new Set(doc)) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const idf = {};
  for (const [term, count] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (count + 1)) + 1; // smoothed
  }
  return idf;
}

function tfidfVector(tokens, idf) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const vec = {};
  for (const [term, count] of Object.entries(tf)) {
    vec[term] = count * (idf[term] || 1);
  }
  return vec;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (const key of new Set([...Object.keys(vecA), ...Object.keys(vecB)])) {
    const a = vecA[key] || 0;
    const b = vecB[key] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// CVE IDs cited in a title, uppercased for case-insensitive set comparison.
// Same pattern used elsewhere (enrichment.js) for CVE extraction.
const CVE_ID_PATTERN = /CVE-\d{4}-\d{4,7}/gi;
function extractCveIds(title) {
  return new Set((title || '').match(CVE_ID_PATTERN)?.map(id => id.toUpperCase()) || []);
}

// Vendor-advisory titles are templated ('Fortinet patches CVE-2026-1111
// exploited in the wild' vs '...CVE-2026-2222...'): 6 of 7 tokens identical, so
// cosine similarity alone can clear the merge threshold for two headlines about
// DISTINCT vulnerabilities. Refuse the merge when both titles cite CVE IDs and
// those sets are disjoint — same-CVE citations (or one/both sides uncited) are
// unaffected and merge as before.
function citesConflictingCves(titleA, titleB) {
  const a = extractCveIds(titleA);
  const b = extractCveIds(titleB);
  if (a.size === 0 || b.size === 0) return false;
  for (const id of a) if (b.has(id)) return false; // any shared CVE — not a conflict
  return true; // both cite CVEs, and none overlap
}

// ── Publisher identity (cross-source reporting count) ──
// The count must avoid obvious duplicate distribution without claiming editorial
// independence: the same story echoed by one publisher across its own RSS feed
// and a Google-News result is ONE source identity, not two. Counting feed copies
// inflates the score's cross-source axis. We key each headline to its publisher:
// the registrable domain of the resolved article link (the canonical identity,
// after Google-News redirects are resolved upstream), falling back to a normalized
// source name when no link
// survived, then to a title slug so genuinely distinct unknown-origin items aren't
// collapsed into one phantom publisher. Distinct keys — not raw merge count — set
// the legacy `corroboration` field used by the scoring and API schemas.
//
// Limitation: wire-service reprints (Reuters/AP) land on different domains and so
// still count as distinct source identities even when they share an upstream
// origin; provenance analysis is outside this redirect-based de-duplication.
// Common multi-part public suffixes — where the registrable domain is the last
// THREE labels, not two. Not the full Public Suffix List (thousands of entries +
// a dependency we don't want); this covers the suffixes real news publishers use.
// An unlisted one degrades to last-2 labels: at worst two regional publishers
// share a key and the source count nudges up by one — never a crash, never silent
// data loss.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'co.jp', 'or.jp', 'ne.jp',
  'com.au', 'net.au', 'org.au', 'gov.au', 'co.nz', 'co.in', 'co.za', 'co.il',
  'co.kr', 'co.th', 'co.id', 'co.ke', 'com.br', 'gov.br', 'com.cn', 'net.cn',
  'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.mx', 'com.ar', 'com.tr',
  'com.ua', 'com.ng', 'com.pk', 'com.bd', 'com.eg', 'com.sa', 'com.pe', 'com.co',
]);

// Any Google host (google.com or a regional google.co.uk / news.google.* variant)
// means a Google-News redirect never resolved to a publisher — no identity to key on.
function isGoogleHost(host) {
  return /(^|\.)google\.[a-z.]+$/.test(host);
}

function registrableDomain(url) {
  if (!url) return '';
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';   // only real article links carry publisher identity
    host = u.hostname.toLowerCase();
  } catch { return ''; }
  if (!host || isGoogleHost(host)) return '';
  // Splitting on the dot and taking the registrable suffix strips ALL leading
  // subdomains (www / m / app / news / amp) to one publisher key automatically.
  host = host.replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

function normalizeSourceName(s) {
  const k = (s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  // Generic aggregator labels carry no publisher identity — defer to the domain.
  return (!k || ['newssearch', 'googlenews', 'news', 'rss', 'unknown'].includes(k)) ? '' : k;
}

/** A headline's publisher identity for source counting (domain, then name, then title). */
export function publisherKey(h) {
  return registrableDomain(h?.link)
    || normalizeSourceName(h?.source)
    // Last resort (no link, generic/empty source): a long title slug so distinct
    // unknown-origin items don't collide into one phantom publisher.
    || 'untitled:' + (h?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 80);
}

// ── Clustering strategy: greedy single-pass (kept, deliberately) ──
// This is a greedy, order-dependent clusterer: each headline is compared only to
// already-kept survivors and merges into the FIRST match ≥ threshold (the
// `break`). Because similarity is non-transitive (a "bridge" headline B can be
// similar to both A and D while A≁D), input order changes which items merge and
// therefore the distinct-publisher source count. The order-dependence is
// real and is pinned by a regression test in test/feeds.test.js.
//
// We evaluated two order-independent alternatives empirically before keeping
// greedy (harness: greedy vs union-find vs complete-linkage over the real
// pre-dedup corpus — RSS feed_cache + live search — swept across thresholds):
//
//   • At the operating threshold (0.5, set in runIntelligencePipeline) — and all
//     the way down to 0.40 — greedy, union-find, and complete-linkage produced
//     BYTE-IDENTICAL clusters on real data (≈150 headlines → ≈149 clusters,
//     largest cluster size 2, zero chains). At 0.5 there is nothing to fix: the
//     near-duplicate graph is so sparse that no chaining or order-sensitivity can
//     manifest, and the merges that do happen are clean pairwise matches.
//
//   • Union-find (build the similarity graph, union every pair ≥ threshold, take
//     connected components) is order-independent but introduces SINGLE-LINKAGE
//     CHAINING — strictly worse than greedy when it triggers. It only triggers
//     below ~0.35 in real data, but when it does it is severe: at thr 0.30 it
//     fused four unrelated stories into one cluster ("Beyond IOCs: AI-enabled
//     threat intelligence" + "Early Edition: June 29" share 0.000 direct
//     similarity yet land together via generic tokens); at thr 0.20 it collapsed
//     13 distinct headlines into a single bloated cluster. That would over-count
//     cross-source credit on a phantom merged story — the opposite of what dedup
//     is for.
//     So union-find is neutral at 0.5 and a latent footgun the moment the
//     threshold is lowered. We do NOT adopt it.
//
//   • Complete-linkage (merge clusters only if EVERY cross pair ≥ threshold) is
//     the one safe order-independent option — it held the largest cluster at 2–3
//     across the whole sweep, never chaining. But it buys nothing over greedy at
//     0.5 and costs an O(n³)-ish agglomerative pass. If the threshold is ever
//     lowered to catch more paraphrases, switch to COMPLETE-LINKAGE, not
//     union-find.
//
// Decision: keep greedy. It is deterministic IN PRACTICE because the pipeline's
// input order is stable (RSS feeds in config order, then search — see
// runIntelligencePipeline), and at the operating threshold it is empirically
// identical to both alternatives on real data.

/**
 * Deduplicate near-identical headlines. A survivor's `corroboration` is the count
 * of DISTINCT PUBLISHER IDENTITIES behind it (see publisherKey), not the number of
 * feed copies. It is cross-source reporting, not proof of editorial independence;
 * wire-service reprints can still share an origin. `sources` keeps the feed labels
 * for display and cross-checking.
 */
export function deduplicateWithCorroboration(headlines, threshold = 0.55) {
  if (headlines.length === 0) return [];

  const allTokens = headlines.map(h => tokenize(h.title));
  const idf = buildIDF(allTokens);

  const kept = [];
  const keptVecs = [];

  for (let i = 0; i < headlines.length; i++) {
    const h = headlines[i];
    // Track which source labels report a story, not just how many. A bare
    // "×3 sources" can't be cross-checked; the names can. Seed from the
    // survivor's own source on first sight.
    if (!h.sources) h.sources = h.source ? [h.source] : [];
    // Distinct publisher identities (not feed copies) drive the stored count —
    // see publisherKey.
    if (!h.publishers) h.publishers = [publisherKey(h)];
    h.corroboration = h.publishers.length;
    const vec = tfidfVector(allTokens[i], idf);
    let dupIdx = -1;

    for (let j = 0; j < keptVecs.length; j++) {
      if (cosineSimilarity(vec, keptVecs[j]) >= threshold) {
        // Templated vendor-advisory titles can clear the cosine threshold
        // while naming two DISTINCT CVEs; refuse the merge in that case so the
        // second vulnerability isn't hidden from the run.
        if (citesConflictingCves(h.title, kept[j].title)) continue;
        dupIdx = j;
        break;
      }
    }

    if (dupIdx >= 0) {
      const survivor = kept[dupIdx];
      // Merge publisher identities; `corroboration` stores the distinct-publisher count,
      // so a publisher echoing itself across feeds does NOT raise it.
      for (const pk of h.publishers) {
        if (!survivor.publishers.includes(pk)) survivor.publishers.push(pk);
      }
      survivor.corroboration = survivor.publishers.length;
      if (h.source && !survivor.sources.includes(h.source)) survivor.sources.push(h.source);
      if (h.link && !survivor.link) survivor.link = h.link;
      if (h.description && h.description.length > (survivor.description?.length || 0)) {
        survivor.description = h.description;
      }
      // A survivor with no parseable date (dateUnknown) should adopt a
      // merged duplicate's real date rather than stay pinned at the recency
      // prior: cross-reported stories are exactly the ones that most need an
      // accurate freshness score, and the system already knows the date from
      // another publisher reporting the same story.
      if (survivor.dateUnknown && h.date && !Number.isNaN(Date.parse(h.date))) {
        survivor.date = h.date;
        survivor.dateUnknown = false;
      }
    } else {
      kept.push(h);
      keptVecs.push(vec);
    }
  }
  return kept;
}

// ── Feed health + circuit breaker ──
let feedHealth = {};
let searchHealth = { queries: 0, results: 0, failures: 0 };

const feedCircuitBreaker = {};
const CB_FAILURE_THRESHOLD = 5;
const CB_COOLDOWN_MS = 15 * 60 * 1000;

function cbRecord(source, success) {
  if (!feedCircuitBreaker[source]) feedCircuitBreaker[source] = { failures: 0, trippedAt: 0 };
  const cb = feedCircuitBreaker[source];
  if (success) {
    cb.failures = 0;
    cb.trippedAt = 0;
  } else {
    cb.failures++;
    if (cb.failures >= CB_FAILURE_THRESHOLD) {
      cb.trippedAt = Date.now();
      log.warn('circuit-breaker', `${source}: tripped after ${cb.failures} consecutive failures — cooling down`);
    }
  }
}

function cbIsOpen(source) {
  const cb = feedCircuitBreaker[source];
  if (!cb || cb.failures < CB_FAILURE_THRESHOLD) return false;
  if (Date.now() - cb.trippedAt > CB_COOLDOWN_MS) {
    cb.failures = CB_FAILURE_THRESHOLD - 1; // allow one retry
    return false;
  }
  return true;
}

// ── Rate-limit cooldown (429 Retry-After) ──
// When a host returns 429, respect its requested cooldown (or a 60s floor)
// before touching it again; until then we serve the last good items.
const retryAfterUntil = {};

// Ceiling on the honored cooldown. parseRetryAfter accepts arbitrary
// seconds or an HTTP date arbitrarily far in the future; without a cap, a
// misconfigured or hostile feed server can silence a feed for the life of the
// process (health stuck at 'rate-limited', serve-last-good expiring after 48h
// with no recovery until restart). Feed input must not make unbounded
// scheduling decisions.
const RETRY_AFTER_MAX_MS = 6 * 3600_000;

// Exported (pure, no side effects) so it can be unit-tested directly.
export function parseRetryAfter(headerVal) {
  if (!headerVal) return 0;
  const secs = Number(headerVal);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(headerVal);
  return Number.isNaN(when) ? 0 : Math.max(0, when - Date.now());
}

// ── Serve-last-good ──
// cached_at is stored by SQLite as UTC "YYYY-MM-DD HH:MM:SS" (no zone marker).
function staleAgeMs(cached) {
  if (!cached?.cached_at) return Infinity;
  const t = Date.parse(cached.cached_at.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

function serveStale(feed, cached, results, health) {
  if (!cached?.items_json || staleAgeMs(cached) > STALE_MAX_MS) return false;
  try {
    const items = JSON.parse(cached.items_json);
    if (!Array.isArray(items) || items.length === 0) return false;
    // Re-stamp config-derived routing from the CURRENT feed config: cached items
    // may predate a config change (e.g. a tier/horizon reassignment); the body is
    // unchanged but the routing may have moved.
    for (const item of items) { item.horizon = feed.horizon || 2; item.weight = feed.weight ?? 1.0; results.push(item); }
    health[feed.source] = FEED_STATUS.OK_STALE;
    return true;
  } catch {
    return false;
  }
}

async function pooledMap(items, fn, concurrency = 8) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function getFeedHealth() {
  // Return copies — the live objects are swapped wholesale mid-pipeline, and
  // callers (the wall, /health) read continuously; never hand out a reference
  // into pipeline state.
  return { feeds: { ...feedHealth }, search: { ...searchHealth } };
}

/** Fetch all configured RSS/Atom feeds with freshness windows per horizon. */
export async function fetchNewsContext(feeds, config = {}) {
  const results = [];
  // Accumulate into a local map and publish atomically at the end, so a request
  // landing mid-refresh sees the previous complete map, not a half-filled one.
  const health = {};
  const baseFreshnessHours = config?.analysisSettings?.freshnessHours || 48;

  // Weekend-aware freshness: many sources don't publish on weekends, so a
  // strict window would empty Horizon 1 by Sunday.
  const dayOfWeek = new Date().getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isMonday = dayOfWeek === 1;
  const weekendBoost = isWeekend ? 48 : isMonday ? 24 : 0;

  const freshnessByHorizon = {
    // +48h headroom so burst publishers (CISA, gov-CERTs, Talos) that post
    // Thursday and go quiet over the weekend still read as fresh on Monday.
    // T2 (Operational) takes the broader 144h window so the merged quarter→18mo
    // content (old emerging tier) doesn't age out before the brief runs.
    1: (baseFreshnessHours + weekendBoost + 48) * 3600_000,
    2: Math.max(baseFreshnessHours, 144 + weekendBoost) * 3600_000,
    3: Math.max(baseFreshnessHours, 192 + weekendBoost) * 3600_000,
  };

  await pooledMap(feeds, async (feed) => {
    if (cbIsOpen(feed.source)) {
      health[feed.source] = FEED_STATUS.CIRCUIT_OPEN;
      // Log every TERMINAL status, not just the success path, so
      // feed_health_log can actually answer "which feed has been flaky" instead
      // of omitting exactly the failures it exists to record.
      try { logFeedHealth(feed.source, health[feed.source], 0); } catch { /* non-critical */ }
      return;
    }
    const cached = getFeedCache(feed.url);

    // Server-directed cooldown still in effect (429 Retry-After) — don't touch
    // the host; show its last good items instead.
    if (retryAfterUntil[feed.source] && Date.now() < retryAfterUntil[feed.source]) {
      if (!serveStale(feed, cached, results, health)) health[feed.source] = FEED_STATUS.RATE_LIMITED;
      try { logFeedHealth(feed.source, health[feed.source], 0); } catch { /* non-critical */ }
      return;
    }

    try {
      const headers = { 'User-Agent': feedUserAgent() };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      if (cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;

      // The abort timer stays live through the body read below (readCapped
      // has no deadline of its own): a host that returns headers then stalls or
      // drips the body would otherwise hang this worker forever, wedging the
      // whole pipeline (Promise.all in fetchNewsContext never resolves). Clearing
      // only happens once BOTH the header exchange and the body are done.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await safeFetch(feed.url, { signal: ctrl.signal, headers });
      } catch (fetchErr) {
        clearTimeout(t);
        throw fetchErr;
      }

      // 304 Not Modified — reuse cached items
      if (res.status === 304 && cached?.items_json) {
        clearTimeout(t);
        try {
          const reloaded = JSON.parse(cached.items_json);
          if (!Array.isArray(reloaded)) throw new Error('cached feed items are not an array');
          // A 304 only confirms the BODY is unchanged, not that the items are
          // still fresh; freshness was last evaluated at original cache time, which
          // can be arbitrarily far in the past for a dormant or dead-but-304ing
          // feed. Re-apply the same freshness window here (dateUnknown items still
          // pass through, matching the live-fetch path above).
          const maxAge = freshnessByHorizon[feed.horizon] || freshnessByHorizon[2];
          const fresh = reloaded.filter(item => item.dateUnknown || isFresh(item.date, maxAge));
          // Re-stamp config-derived routing (see serveStale): a 304 means the body
          // is identical, but a tier/horizon reassignment in config must still apply.
          for (const item of fresh) {
            item.horizon = feed.horizon || 2;
            item.weight = feed.weight ?? 1.0;
            results.push(item);
          }
          // The server just confirmed the cached content is still current;
          // bump cached_at so the serve-last-good window (staleAgeMs) measures from
          // now, not from whenever this feed last returned a fresh 200. Reuse the
          // existing etag/last-modified so the conditional-GET headers stay valid.
          if (fresh.length > 0) {
            try { setFeedCache(feed.url, cached.etag || '', cached.last_modified || '', reloaded); } catch { /* non-critical */ }
          }
          health[feed.source] = fresh.length > 0 ? FEED_STATUS.OK_CACHED : FEED_STATUS.EMPTY;
          cbRecord(feed.source, true);
          try { logFeedHealth(feed.source, health[feed.source], fresh.length); } catch { /* non-critical */ }
        } catch (cacheErr) {
          // The origin answered, but the local cached representation is
          // unusable. Invalidate its validators so the next run performs an
          // unconditional GET instead of receiving this same unhealable 304
          // forever. Do not publish a fresh/healthy status for zero data now.
          try { setFeedCache(feed.url, '', '', []); } catch { /* non-critical */ }
          health[feed.source] = FEED_STATUS.PARSE_ERROR;
          cbRecord(feed.source, false);
          log.warn('rss', `${feed.source}: cached feed parse error — ${cacheErr.message}`);
          try { logFeedHealth(feed.source, health[feed.source], 0); } catch { /* non-critical */ }
        }
        return;
      }

      if (!res.ok) {
        clearTimeout(t);
        try { await res.body?.cancel?.(); } catch { /* discard error response */ }
        if (res.status === 429) {
          retryAfterUntil[feed.source] = Date.now() +
            Math.min(Math.max(parseRetryAfter(res.headers.get('retry-after')), 60_000), RETRY_AFTER_MAX_MS);
        }
        cbRecord(feed.source, false);
        log.warn('rss', `${feed.source}: HTTP ${res.status}`);
        if (!serveStale(feed, cached, results, health)) health[feed.source] = httpFeedStatus(res.status);
        try { logFeedHealth(feed.source, health[feed.source], 0); } catch { /* non-critical */ }
        return;
      }

      // Most feeds are a few hundred KB; only known full-content
      // outliers such as Project Zero get the larger 16MB ceiling, via
      // feedBodyCap. trustedFeeds is operator-curated, so the cap guards against
      // a runaway feed, not arbitrary input.
      let xml;
      try {
        xml = await readCapped(res, feedBodyCap(feed.url));
      } finally {
        // The deadline now covers the body read; only clear once it's done
        // (success or failure), never before.
        clearTimeout(t);
      }
      const resEtag = res.headers.get('etag') || '';
      const resLastMod = res.headers.get('last-modified') || '';

      let parsed;
      try {
        parsed = parser.parse(xml);
      } catch (parseErr) {
        cbRecord(feed.source, false);
        log.warn('rss', `${feed.source}: XML parse error — ${parseErr.message}`);
        if (!serveStale(feed, cached, results, health)) health[feed.source] = FEED_STATUS.PARSE_ERROR;
        try { logFeedHealth(feed.source, health[feed.source], 0); } catch { /* non-critical */ }
        return;
      }

      const channel = parsed?.rss?.channel;
      const atomFeed = parsed?.feed;
      const items = (channel?.item || atomFeed?.entry || []);

      let count = 0;
      const feedItems = [];
      for (const item of items) {
        if (count >= 5) break;   // cap per feed AFTER freshness, so fresh items aren't lost behind stale ones at the top
        const title = stripHtml(textOf(item.title));
        if (!title) continue;

        let desc = stripHtml(textOf(item.description || item.summary || ''));
        if (desc.length > 300) desc = desc.slice(0, 300) + '...';

        // Prefer Atom's <published> (original publication date) over
        // <updated> (bumped on ANY edit, including a trivial typo fix). Reading
        // <updated> first let a months-old post re-enter the freshness window and
        // score as breaking on a cosmetic edit. <updated> stays as the last-resort
        // fallback for feeds that only ever emit it.
        const date = textOf(item.pubDate || item.published || item.updated || '');
        if (!isFresh(date, freshnessByHorizon[feed.horizon] || freshnessByHorizon[2])) continue;

        // Undated / unparseable-date items are still admitted (isFresh lets them
        // through), but tag them so downstream surfaces can say "date unknown"
        // rather than silently presenting unknown recency as in-window.
        const dateUnknown = !date || Number.isNaN(Date.parse(date));

        const rec = {
          title,
          description: desc,
          link: extractLink(item, feed.url),
          source: feed.source,
          category: feed.category || 'general',
          horizon: feed.horizon || 2,
          weight: feed.weight ?? 1.0,
          deepExtract: feed.deepExtract || false,
          date,
          dateUnknown,
          corroboration: 1,
        };
        results.push(rec);
        feedItems.push(rec);
        count++;
      }

      health[feed.source] = count > 0 ? FEED_STATUS.OK : FEED_STATUS.EMPTY;
      cbRecord(feed.source, true);
      try { logFeedHealth(feed.source, health[feed.source], count); } catch { /* non-critical */ }

      // Cache on every success that yielded items (regardless of ETag/Last-
      // Modified presence) so serve-last-good has something to fall back on the
      // next time this host blocks or times out. Don't overwrite with an empty
      // set — a quiet run must not erase the last good items.
      if (count > 0) {
        try { setFeedCache(feed.url, resEtag, resLastMod, feedItems); } catch { /* non-critical */ }
      }
    } catch (err) {
      cbRecord(feed.source, false);
      log.warn('rss', `${feed.source} failed: ${err.message}`);
      if (!serveStale(feed, cached, results, health)) health[feed.source] = FEED_STATUS.FAILED;
      try { logFeedHealth(feed.source, health[feed.source], 0); } catch { /* non-critical */ }
    }
  }, 8);

  feedHealth = health; // atomic publish
  const ok = Object.values(health).filter(v => FRESH_FEED_STATUSES.includes(v)).length;
  log.info('rss', `${ok}/${Object.keys(health).length} feeds active`);
  return results;
}

// ── News search sweep (Google News RSS) ──
function buildSearchQueries(config) {
  // Kept lean: Google News throttles aggressively, and this sweep is a
  // secondary discovery channel on top of the ~49 trusted feeds. The
  // pressing-angle queries come from the active Domain Pack, not a hardcoded
  // cyber list — a new edition declares its own — plus a few org watch-topics.
  const queries = (getDomainPack().feeds?.searchQueries || []).map(q => ({ ...q }));

  // Organization-specific watch topics from config (optional)
  const topics = config.organization?.watchTopics || [];
  for (const topic of topics.slice(0, 3)) {
    queries.push({ q: `${topic} security`, horizon: 2 });
  }
  return queries;
}

async function fetchSearchBatch(queries, stats) {
  const results = [];
  for (const { q, horizon } of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-US&gl=US&ceid=US:en`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      // Keep the deadline live through the body read (readCapped has no
      // deadline of its own); clearing early would let a stalled body hang this
      // query forever. See the matching fix in fetchNewsContext above.
      let xml;
      try {
        const res = await safeFetch(url, { signal: ctrl.signal, headers: { 'User-Agent': feedUserAgent() } });
        xml = await readCapped(res, 4_000_000);
      } finally {
        clearTimeout(t);
      }

      let parsed;
      try { parsed = parser.parse(xml); } catch { stats.failures++; continue; }

      const items = (parsed?.rss?.channel?.item || []).slice(0, 3);
      if (items.length === 0) { stats.failures++; continue; }

      for (const item of items) {
        const title = stripHtml(textOf(item.title));
        if (!title) continue;
        const date = textOf(item.pubDate || '');
        // Resolve the Google News redirect to the primary publisher (using
        // the raw description, which still carries the publisher <a href>), or
        // drop the link so the citation reads [Source, Date] plain.
        const link = resolveGoogleNewsLink(
          extractLink(item),
          textOf(item.description || item.summary || ''),
        );
        results.push({
          title,
          description: '',
          link,
          source: stripHtml(textOf(item.source?.['#text'] || item.source || 'News Search')),
          category: 'search',
          horizon,
          weight: 0.7, // search results carry lower authority
          deepExtract: false,
          date,
          dateUnknown: !date || Number.isNaN(Date.parse(date)),
          corroboration: 1,
        });
      }
    } catch (err) {
      stats.failures++;
      log.warn('search', `"${q}" failed: ${err.message}`);
    }
  }
  return results;
}

export async function fetchSearchResults(config) {
  const queries = buildSearchQueries(config);
  const stats = { queries: queries.length, results: 0, failures: 0 };

  const results = [];
  for (let i = 0; i < queries.length; i += 5) {
    const batch = await fetchSearchBatch(queries.slice(i, i + 5), stats);
    results.push(...batch);
    // Wider, jittered gap between batches so we don't burst Google News into a
    // 429 — this is a best-effort secondary source, so patience costs nothing.
    if (i + 5 < queries.length) await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
  }

  stats.results = results.length;
  searchHealth = stats; // atomic publish
  log.info('search', `${results.length} headlines from ${queries.length} queries (${stats.failures} failed)`);
  return results;
}

// Run the active pack's enrichers for one stage, in declared order, over the
// given headlines. Each enricher MUTATES in place and must not throw fatally — a
// failure is caught + logged, and (when it carries a failureKey) recorded so the
// brief can hedge. `limitKey`/`limitDefault` resolve a per-enricher budget from
// analysisSettings.
export async function runEnricherStage(stage, headlines, s, failures) {
  for (const e of getEnrichers().filter(x => x.stage === stage)) {
    try {
      const limit = e.limitKey ? (s[e.limitKey] ?? e.limitDefault) : undefined;
      await e.fn(headlines, limit);
    } catch (err) {
      if (e.failureKey) failures.push(e.failureKey);
      log.warn('pipeline', `${e.name} enrichment failed: ${err.message}`);
    }
  }
}

/**
 * Full intelligence pipeline. Returns scored, diversified, enriched headlines.
 */
export async function runIntelligencePipeline(config) {
  const startTime = performance.now();
  // Feeds come from the active edition's pack when it declares them; cyber leaves
  // them in config.trustedFeeds (deployment config), so it's unchanged.
  const packFeeds = getDomainPack().feeds?.sources;
  const feeds = (packFeeds?.length ? packFeeds : config.trustedFeeds) || [];
  const s = config.analysisSettings || {};

  // 1. Fetch RSS + search in parallel
  const [rssHeadlines, searchHeadlines] = await Promise.all([
    fetchNewsContext(feeds, config),
    fetchSearchResults(config),
  ]);

  // 2. Merge + dedup with distinct-publisher counting
  const deduped = deduplicateWithCorroboration([...rssHeadlines, ...searchHeadlines], 0.5);

  // 3. Classify urgency
  for (const h of deduped) h.urgency = classifyUrgency(h);

  // 4. Alert rules — config rules PLUS the operator's watch-terms as escaped
  //    literals (see getEffectiveAlertRules); applyAlertRules ReDoS-filters both.
  applyAlertRules(deduped, getEffectiveAlertRules(config));

  // 5. Horizon overrides (promote operationally urgent items to H1)
  applyHorizonOverrides(deduped);

  // 6. Local, ranking-relevant enrichment BEFORE scoring. KEV membership is a
  //    Set lookup and entity/MITRE tags are regex matches (no per-headline
  //    network), so they run on the FULL set while they can still affect
  //    selection. Otherwise a sub-cut headline citing a known-exploited CVE is
  //    dropped before it ever earns its KEV boost — in exactly the busy cycle
  //    when surfacing it matters most.
  // Track enrichment failures so the briefing can hedge rather than
  // present absent KEV/CVE context as authoritative ("no CVSS" ≠ "not severe").
  const enrichmentFailures = [];
  await runEnricherStage('pre', deduped, s, enrichmentFailures);

  // 7. Score (KEV / urgency / tags now known, so they shape selection)
  for (const h of deduped) scoreHeadline(h, config);

  // 8. Diversity enforcement
  const diverse = enforceDiversity(deduped, null, 50, config);

  // 9. Expensive network enrichment — additive, never blocking, survivors only
  await runEnricherStage('post', diverse, s, enrichmentFailures);

  // 10. Re-score the survivors now that CVE/CVSS enrichment has landed, so the
  //     severity axis folds into the final order (enrichCVEs runs after the
  //     selection score, so CVSS was unknown at step 7 for most headlines), then
  //     order by the refreshed score.
  for (const h of diverse) scoreHeadline(h, config);
  diverse.sort((a, b) => (b.score || 0) - (a.score || 0));

  // 11. Debug log
  if (s.debugScoring) {
    const dataDir = new URL('../data', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    writeScoringDebugLog(diverse, dataDir);
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  log.info('pipeline', `${diverse.length} headlines (${rssHeadlines.length} RSS + ${searchHeadlines.length} search → ${deduped.length} deduped) in ${elapsed}s`);

  return {
    headlines: diverse,
    stats: {
      rss: rssHeadlines.length,
      search: searchHeadlines.length,
      deduped: deduped.length,
      diverse: diverse.length,
      enriched: diverse.filter(h => h.cveData || h.articleBody).length,
      enrichmentFailures,
    },
  };
}

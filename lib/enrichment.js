// BlueTeam.News — enrichment pipeline.
// CISA KEV membership, NVD CVE detail, article body extraction, and
// threat-actor / region tagging for the wall display.
// Contract: enrichment ADDS context but never BLOCKS the pipeline.

import { log } from './logger.js';
import { getKEVSet, bulkInsertKEV, getKEVAge, getKEVDatesAdded } from './db.js';
import { safeFetch, readCapped } from './net.js';
import { outboundUserAgent } from './identity.js';
import { getDomainPack } from './domain.js';
import { escapeRegExp } from './regex-util.js';
import * as htmlparser2 from 'htmlparser2';

// ── Entity taxonomy — read from the ACTIVE Domain Pack, never welded here ──
// The cyber pack supplies threat actors (with attribution → region) and the
// load-bearing vendors; a new edition supplies its own. The MATCHING logic below
// is engine code and rebuilds when the active edition changes (see entityMatchers).

// ── Shared word-boundary entity matcher ──
// Substring matching (text.includes) is case-sensitive and unanchored: it
// misses "lockbit" in a lowercased headline and false-positives common-word
// vendors ("Progress", "Elastic", "Apple", "Oracle", "Docker") inside ordinary
// prose. Precompile one \bname\b regex per term (escaped, case-insensitive) and
// share it across tagEntities, buildActorLeaderboard, and buildVendorExposure
// so all three agree on what "mentions X" means.

// \b is a word boundary on [A-Za-z0-9_]. It works for names ending in word
// chars; terms like "LAPSUS$" or "F5" end on a non-word/word edge that \b still
// anchors correctly on the leading side. Trailing boundary is relaxed to a
// lookahead for non-word-or-end so "$"-suffixed names still match.
function compileEntityRegex(name) {
  return new RegExp(`\\b${escapeRegExp(name)}(?![\\w])`, 'i');
}

// A HANDFUL of actor entries name an interim-designator FAMILY, not a single
// group — Microsoft's "Storm-####" and Mandiant's "UNC#####" — that dominate
// early reporting before a cluster earns a tracked name. Those
// entries carry a literal `\d` in their `name`, which is otherwise always a
// plain string escaped via escapeRegExp before compiling (so an ordinary actor
// name like "F5" or "LAPSUS$" is matched LITERALLY, never as a pattern). Detect
// the family convention by the literal backslash-d and compile it as a regex
// source instead of escaping it — this is the ONLY place a pack's actor `name`
// is treated as anything but inert data.
const PATTERN_ACTOR_SHAPE = /\\d/;
function compileEntityMatcher(name) {
  return PATTERN_ACTOR_SHAPE.test(name)
    ? new RegExp(`\\b${name}(?![\\w])`, 'i')
    : compileEntityRegex(name);
}

// Entity matchers are rebuilt when the active edition changes (keyed on pack.id),
// so a pack swap re-tags against the NEW edition's actors/vendors rather than a
// stale snapshot of whichever pack loaded first. Memoized within an edition, so
// the per-headline hot path never recompiles.
let _matchersCache = { id: null, actors: [], vendors: [] };
function entityMatchers() {
  const pack = getDomainPack();
  if (_matchersCache.id !== pack.id) {
    _matchersCache = {
      id: pack.id,
      actors: (pack.entities?.actors || []).map(actor => ({
        name: actor.name,
        region: actor.region,
        patterns: [actor.name, ...(actor.aliases || [])].map(compileEntityMatcher),
      })),
      vendors: (pack.entities?.vendors || []).map(name => ({ name, pattern: compileEntityRegex(name) })),
    };
  }
  return _matchersCache;
}

// ── Provenance guard: negation / contrast ──
// A name match is a HEURISTIC inference, and the worst failure is attributing an
// attack to an actor a report explicitly RULED OUT ("not linked to Lazarus",
// "unlike APT28"). When a negation/contrast cue sits in the few words immediately
// before a mention, suppress the tag rather than assert a false attribution. This
// is deliberately conservative — it biases toward NOT making a claim.
const NEGATION_WINDOW = 28;
const NEGATION_CUES = /\b(not|never|unlike|unrelated|besides|except|despite|denie[sd]|rule[ds]?\s*out|falsely|wrongly|no\s+link|other\s+than)\b|n['’]t\b/i;

function isNegatedAt(text, index) {
  if (index < 0) return false;
  return NEGATION_CUES.test(text.slice(Math.max(0, index - NEGATION_WINDOW), index));
}

// First match index of a (non-global) pattern in text, or -1. Non-global regexes
// don't carry lastIndex state, so the compiled matchers are safe to reuse.
function firstIndex(text, pattern) {
  const m = pattern.exec(text);
  return m ? m.index : -1;
}

/**
 * Threat actors inferred from a headline, each carrying its provenance: `basis`
 * is 'title' when the actor is named in the headline itself (the story is about
 * it) or 'mention' when it only appears in the body (a weaker, passing reference).
 * Negated/contrastive mentions are dropped (see isNegatedAt). Heuristic by
 * nature — the UI hedges every tag; this just makes the strength explicit.
 */
export function matchActors(title, body = '') {
  const out = [];
  for (const m of entityMatchers().actors) {
    const tIdx = m.patterns.map(p => firstIndex(title, p)).filter(i => i >= 0).sort((a, b) => a - b)[0];
    if (tIdx != null && !isNegatedAt(title, tIdx)) { out.push({ name: m.name, region: m.region, basis: 'title' }); continue; }
    const bIdx = body ? m.patterns.map(p => firstIndex(body, p)).filter(i => i >= 0).sort((a, b) => a - b)[0] : undefined;
    if (bIdx != null && !isNegatedAt(body, bIdx)) out.push({ name: m.name, region: m.region, basis: 'mention' });
  }
  return out;
}

/** Known vendors named in `text` (word-boundary, case-insensitive), negation-guarded. */
export function matchVendors(text) {
  const out = [];
  for (const m of entityMatchers().vendors) {
    const idx = firstIndex(text, m.pattern);
    if (idx >= 0 && !isNegatedAt(text, idx)) out.push(m.name);
  }
  return out;
}

// ── DOM-based article extraction (htmlparser2) ──
const SKIP_TAGS = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe', 'svg', 'form']);
const CONTENT_SELECTORS = ['article', 'main'];
const CONTENT_CLASS_PATTERNS = /article[_-]?body|entry[_-]?content|post[_-]?content|story[_-]?body|field--body|post-body|article-content|story-content/i;
const BOILERPLATE_PATTERN = /^(subscribe|sign up|cookie|copyright|share this|related|advertisement|follow us|terms of|read more|click here|learn more|see also|you may also|about the author|published|tags:|filed under)/i;

function domExtract(html) {
  const dom = htmlparser2.parseDocument(html);

  function getText(node) {
    if (node.type === 'text') return node.data || '';
    if (node.type === 'tag' && SKIP_TAGS.has(node.name)) return '';
    if (!node.children) return '';
    return node.children.map(getText).join(' ');
  }

  function findAll(root, predicate) {
    const results = [];
    const queue = root.children ? [...root.children] : [];
    // Index cursor keeps traversal O(n). Array#shift moved every remaining
    // element on every node, making attacker-controlled 2 MB HTML quadratic.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      if (node.type === 'tag' && predicate(node)) results.push(node);
      if (node.children) queue.push(...node.children);
    }
    return results;
  }

  // Strategy 1: <article> or <main>
  for (const selector of CONTENT_SELECTORS) {
    const matches = findAll(dom, n => n.name === selector);
    if (matches.length > 0) {
      const best = matches.reduce((a, b) => getText(a).length > getText(b).length ? a : b);
      const text = getText(best).replace(/\s+/g, ' ').trim();
      if (text.length > 100) return text;
    }
  }

  // Strategy 2: content-indicating class names
  const classMatches = findAll(dom, n => CONTENT_CLASS_PATTERNS.test(n.attribs?.class || ''));
  if (classMatches.length > 0) {
    const best = classMatches.reduce((a, b) => getText(a).length > getText(b).length ? a : b);
    const text = getText(best).replace(/\s+/g, ' ').trim();
    if (text.length > 100) return text;
  }

  // Strategy 3: substantial non-boilerplate paragraphs
  const paragraphs = findAll(dom, n => n.name === 'p')
    .map(p => getText(p).replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 40 && !BOILERPLATE_PATTERN.test(t));
  return paragraphs.join(' ');
}

export async function extractArticleBody(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': outboundUserAgent(), 'Accept': 'text/html' },
    });
    if (!res.ok) return null;
    const html = await readCapped(res, 2_000_000);
    let body = domExtract(html);
    if (!body || body.length < 50) return null;
    return body.replace(/\s+/g, ' ').trim().slice(0, 2000);
  } catch (err) {
    log.warn('enrichment', `Article extraction failed for ${url}: ${err.message}`);
    return null;
  } finally {
    // Cover both headers and the capped body drain; a trickling page must not
    // hang the post-enrichment stage after returning headers quickly.
    clearTimeout(timer);
  }
}

// ── CISA KEV catalog ──
let kevSet = null;
let kevRefreshInFlight = null;
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const KEV_REFRESH_HOURS = 12;

async function performKEVRefresh() {
  try {
    const age = getKEVAge();
    if (age < KEV_REFRESH_HOURS && kevSet) return kevSet;

    const res = await safeFetch(KEV_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(await readCapped(res, 32_000_000)); // KEV catalog is multi-MB — cap, never read unbounded
    const vulns = data?.vulnerabilities || [];
    if (vulns.length === 0) throw new Error('Empty KEV response');

    bulkInsertKEV(vulns);
    kevSet = new Set(vulns.map(v => v.cveID));
    log.info('enrichment', `KEV catalog refreshed: ${kevSet.size} entries`);
    return kevSet;
  } catch (err) {
    log.warn('enrichment', `KEV refresh failed: ${err.message}`);
    if (!kevSet) kevSet = getKEVSet(); // fall back to SQLite cache
    return kevSet;
  }
}

export async function refreshKEV() {
  // Boot refresh and the startup pipeline can arrive concurrently while the
  // in-memory set is still empty. Share one catalog download/parse/DB insert.
  if (!kevRefreshInFlight) {
    kevRefreshInFlight = performKEVRefresh().finally(() => {
      kevRefreshInFlight = null;
    });
  }
  return kevRefreshInFlight;
}

/**
 * Tag headlines referencing CVEs in the CISA Known Exploited
 * Vulnerabilities catalog — the single most actionable signal for defenders.
 */
export async function enrichKEV(headlines) {
  const kev = await refreshKEV();
  if (!kev || kev.size === 0) return;

  let hits = 0;
  const cvePattern = /CVE-\d{4}-\d{4,7}/gi;
  for (const h of headlines) {
    const text = `${h.title} ${h.description || ''}`;
    for (const m of text.matchAll(cvePattern)) {
      const cve = m[0].toUpperCase();
      if (kev.has(cve)) {
        h.isKEV = true;
        h.kevCVE = cve;
        hits++;
        break;
      }
    }
  }
  if (hits > 0) {
    // Stamp date_added (pre-score) so scoring can age the exploitation credit of
    // long-settled catalog entries. Best-effort: a lookup miss leaves the
    // field unset and kevRecencyFactor falls back to full credit.
    try {
      const matched = headlines.filter(h => h.kevCVE);
      const dates = getKEVDatesAdded(matched.map(h => h.kevCVE));
      for (const h of matched) if (dates[h.kevCVE]) h.kevDateAdded = dates[h.kevCVE];
    } catch { /* non-critical */ }
    log.info('enrichment', `KEV matches: ${hits} headlines reference known-exploited CVEs`);
  }
}

// ── NVD CVE detail ──
// Enrich up to PER_HEADLINE_CVES distinct CVEs per headline so multi-CVE
// advisories (vendor round-ups) don't show detail for only the first — the
// unenriched ones may be the more severe. Bounded by the global maxLookups
// budget across all headlines so NVD isn't hammered.
const PER_HEADLINE_CVES = 3;

// NVD's unauthenticated rate limit is 5 requests / rolling 30s (50/30s with an
// API key). An optional NVD_API_KEY env var raises the ceiling and is sent as
// the `apiKey` header NVD documents; with no key, pace calls conservatively
// (~6.5s apart covers 5/30s with margin) so a ~8-lookup run doesn't get
// throttled partway through. This also serves the caching goal below: a
// request that never fires because the cache already had the CVE costs
// nothing against the pace budget, so caching and pacing compound.
function nvdApiKey() {
  // Read lazily: server.js calls dotenv.config() after static dependencies have
  // evaluated, so a module-level snapshot silently ignored keys stored in .env.
  return process.env.NVD_API_KEY || '';
}

function nvdPaceMs() {
  return nvdApiKey() ? 700 : 6500; // 50/30s vs 5/30s, with margin
}

// Process-lifetime CVE cache (cve_id → {data, cachedAt}). NVD re-analysis is
// slow, so a CVE's detail is stable for many refreshes — the same ~8 top-scored
// headlines otherwise get re-fetched every ~10-minute pipeline run.
// A persistent SQLite-backed cache (cve_cache, mirroring kev_cache/feed_cache)
// would survive restarts and is the better home for this, but that table lives
// in a different module — this in-memory cache still eliminates the
// intra-process re-fetch storm and is a strict improvement, just not
// persisted across restarts. TTL matches the KEV catalog's own cadence.
const CVE_CACHE_TTL_MS = 24 * 3600_000;
const cveCache = new Map();

function getCachedCVE(cveId) {
  const entry = cveCache.get(cveId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CVE_CACHE_TTL_MS) {
    cveCache.delete(cveId);
    return undefined;
  }
  return entry.data;
}

function setCachedCVE(cveId, data) {
  cveCache.set(cveId, { data, cachedAt: Date.now() });
}

// A dedicated sentinel (distinct from `null`, which still means "NVD has
// nothing for this CVE") so enrichCVEs can tell a THROTTLED lookup apart from
// an ordinary miss and record it in enrichmentFailures instead of letting it
// vanish silently — the exact "absent context presented as
// authoritative" failure the enrichmentFailures mechanism exists to prevent.
const CVE_THROTTLED = Symbol('cve-throttled');

export async function enrichCVEs(headlines, maxLookups = 8) {
  const cvePattern = /CVE-\d{4}-\d{4,7}/gi;
  let attempts = 0;
  let enriched = 0;
  let throttled = false;
  let lastFetchAt = 0;

  for (const h of headlines) {
    const text = `${h.title} ${h.description || ''}`;
    const cves = [...new Set([...text.matchAll(cvePattern)].map(m => m[0].toUpperCase()))]
      .slice(0, PER_HEADLINE_CVES);
    if (cves.length === 0) continue;

    const entries = [];
    for (const cve of cves) {
      try {
        let data = getCachedCVE(cve);
        if (data === undefined) {
          // This is a live-request budget: misses, errors, and throttles consume
          // it just like successes. Cached entries remain free.
          // Once NVD throttles, do not spend the rest of the run hammering the
          // same limit; cached entries later in the input may still be applied.
          if (throttled || attempts >= maxLookups) continue;
          attempts++;
          // Space live NVD calls so a cache-full run costs nothing against the
          // pace budget and a cache-miss run never bursts past NVD's window.
          const waitMs = nvdPaceMs() - (Date.now() - lastFetchAt);
          if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
          lastFetchAt = Date.now();
          data = await fetchCVEData(cve);
          if (data === CVE_THROTTLED) {
            throttled = true;
            data = null;
          } else {
            setCachedCVE(cve, data); // cache misses too — avoids re-hammering a CVE NVD has nothing for
          }
        }
        if (data) {
          entries.push(data);
          enriched++;
        }
      } catch (err) {
        log.warn('enrichment', `CVE lookup failed for ${cve}: ${err.message}`);
      }
    }
    if (entries.length > 0) {
      // Keep cveData a single string for the existing surfaces; cveDetails
      // carries the per-CVE list for callers that want to render multiple chips.
      h.cveData = entries.map(e => e.text).join(' · ');
      h.cveDetails = entries.map(e => e.text);
      // The severity axis (config/domains/cyber.js scoring.severity) reads a
      // DEDICATED string field, not cveData: cveData joins multiple CVEs and
      // labels the version BEFORE the score ("CVSS 4.0 9.3"), both of which
      // corrupt a naive "CVSS\s+([\d.]+)" re-parse (the version digit gets
      // captured as the score). cvssSeverityText carries only the
      // MAX numeric score across this headline's CVEs (a multi-CVE roundup
      // scores on its worst entry, not its first) with no version label in
      // front of the number, plus the matching severity band word for the
      // parser's band-fallback. h.cvssScore is the same max, as a plain number,
      // for any caller that wants it without a regex re-parse.
      const maxEntry = entries.reduce((a, b) => (b.score ?? -1) > (a.score ?? -1) ? b : a);
      if (maxEntry.score != null) {
        h.cvssScore = maxEntry.score;
        h.cvssSeverityText = `CVSS ${maxEntry.score}${maxEntry.severity ? ` (${maxEntry.severity})` : ''}`;
      }
    }
  }
  if (enriched > 0) log.info('enrichment', `Enriched ${enriched} CVE lookups with NVD data`);
  // runEnricherStage (lib/feeds.js) only records a failureKey when the
  // enricher THROWS — there's no separate failures channel passed into fn.
  // Throwing here (after already mutating whatever headlines DID succeed, so
  // no partial work is lost — enrichment never blocks the pipeline) is how a
  // throttled run surfaces into enrichmentFailures instead of vanishing
  // silently, per the cyber enrichers manifest's `failureKey: 'CVE'`.
  if (throttled) throw new Error('NVD rate-limited one or more CVE lookups');
}

async function fetchCVEData(cveId) {
  try {
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId}`;
    // An optional NVD_API_KEY (see .env.example) raises the rate limit from 5/30s to 50/30s;
    // sent via the `apiKey` header NVD's API documents. Absent, requests are
    // still made (NVD's unauthenticated tier), just paced more conservatively
    // (see NVD_PACE_MS above).
    const key = nvdApiKey();
    const headers = key ? { apiKey: key } : undefined;
    const res = await safeFetch(url, { headers, signal: AbortSignal.timeout(3000) });
    // 403/429 is NVD's throttle response, not "this CVE has no data" — the two
    // must not collapse to the same `null`, or a throttled run
    // silently reads as a clean "nothing enriched" every time.
    if (res.status === 403 || res.status === 429) return CVE_THROTTLED;
    if (!res.ok) return null;

    const data = JSON.parse(await readCapped(res, 4_000_000));
    const vuln = data?.vulnerabilities?.[0]?.cve;
    if (!vuln) return null;

    // Cover the full CVSS lineage in preference order: v3.1 (most common today),
    // then v3.0, then v4.0 (newer), then v2 (legacy). A CVE carrying only v2 or
    // only v4.0 is still scored — rendering "N/A" would read as "not severe."
    // Label the version when it isn't the default v3.1 so the analyst knows the
    // basis — AFTER the score, as a trailing parenthetical ("CVSS 9.3 (v4.0)"),
    // never between "CVSS" and the number: a version label sitting there
    // ("CVSS 4.0 9.3") gets captured BY THE SEVERITY AXIS'S OWN REGEX as if
    // "4.0" were the score — silently mis-ranking every v4-only
    // or v2-only CVE ~50-75% low and rendering a wrong number in the evidence
    // ledger. The version digit must never be adjacent to the score digit.
    const cvssSources = [
      { versionLabel: '', metric: vuln.metrics?.cvssMetricV31?.[0] },
      { versionLabel: '', metric: vuln.metrics?.cvssMetricV30?.[0] },
      { versionLabel: 'v4.0', metric: vuln.metrics?.cvssMetricV40?.[0] },
      { versionLabel: 'v2.0', metric: vuln.metrics?.cvssMetricV2?.[0] },
    ];
    const scored = cvssSources.find(s => s.metric?.cvssData?.baseScore != null);
    const cvss = scored?.metric?.cvssData?.baseScore;
    // v2 carries severity in the metric envelope (baseSeverity), not cvssData.
    const severity = scored?.metric?.cvssData?.baseSeverity || scored?.metric?.baseSeverity;
    const versionLabel = scored?.versionLabel || '';

    const configs = vuln.configurations?.[0]?.nodes?.[0]?.cpeMatch || [];
    // CPE criteria are colon-delimited; fields 3-4 are vendor + product as terse
    // lowercase tokens ("paloalto pan-os"). Clean them so they read like products.
    const products = [...new Set(
      configs
        .slice(0, 3)
        .map(c => cleanCpeProduct(c.criteria))
        .filter(Boolean)
    )];

    const refs = vuln.references || [];
    const exploitRef = refs.some(r => r.tags?.includes('Exploit'));

    // Honor NVD's vulnStatus. A "Rejected" / "Awaiting Analysis" / "Undergoing
    // Analysis" CVE has no final score; presenting its (missing or provisional)
    // score as a verified fact is a status-honesty failure. Suppress the score
    // for rejected CVEs and mark unanalyzed ones provisional.
    const status = vuln.vulnStatus || '';
    const isRejected = /reject/i.test(status);
    const isProvisional = /await|undergoing|received/i.test(status);

    let scoreText;
    if (isRejected) {
      scoreText = `${cveId}: rejected by NVD (no score)`;
    } else if (cvss != null) {
      // Version label trails the score (never sits between "CVSS" and the
      // number — see the versionLabel comment above).
      scoreText = `${cveId}: CVSS ${cvss}${severity ? ` (${severity})` : ''}${versionLabel ? ` (${versionLabel})` : ''}` +
        (isProvisional ? ' (provisional)' : '');
    } else {
      scoreText = `${cveId}: CVSS N/A` + (isProvisional ? ' (provisional)' : '');
    }

    const parts = [scoreText];
    if (!isRejected && products.length > 0) parts.push(`Affects: ${products.join(', ')}`);
    if (!isRejected && exploitRef) parts.push('exploit references exist');
    // Returned as {text, score, severity} rather than a bare string so the
    // caller (enrichCVEs) can compute a max-across-CVEs numeric severity
    // without re-parsing this display text.
    return {
      text: parts.join(' — '),
      score: (!isRejected && cvss != null) ? cvss : null,
      severity: (!isRejected && severity) ? severity : null,
    };
  } catch {
    return null;
  }
}

/**
 * Turn a CPE 2.3 criteria string into a readable product label.
 * "cpe:2.3:a:paloaltonetworks:pan-os:*:*…" → "Paloaltonetworks PAN-OS".
 * The vendor field is a single concatenated token (no reliable word breaks), so
 * we title-case it; the product field splits on hyphen/underscore and upper-
 * cases short all-letter codes (pan-os → PAN-OS) so it reads as a product, not a
 * raw CPE fragment.
 */
function cleanCpeProduct(criteria) {
  if (!criteria) return '';
  const [vendor, product] = criteria.split(':').slice(3, 5);
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const vendorText = vendor && vendor !== '*' ? titleCase(vendor) : '';
  const productText = product && product !== '*'
    ? product
        .split(/[-_]/)
        .map(part => (part.length <= 3 && /^[a-z]+$/.test(part))
          ? part.toUpperCase()
          : titleCase(part))
        .join('-')
    : '';
  return [vendorText, productText].filter(Boolean).join(' ').trim();
}

// ── FIRST EPSS (Exploit Prediction Scoring System) ──
// The exploitation axis today is binary-verified (KEV) or keyword-heuristic
// (urgency lexicon); severity is a static CVSS number. Neither answers "how
// LIKELY is this specific CVE to be exploited" — the gap between "on the KEV
// catalog" and "a regex saw the word zero-day". EPSS is FIRST.org's
// daily-updated, keyless probability-of-exploitation-in-30-days model, queried
// here per-CVE (batched into one call) rather than the full daily bulk CSV —
// this pipeline enriches at most PER_HEADLINE_CVES × maxLookups CVEs per run,
// so a targeted batch call is far cheaper than fetching/parsing the whole
// catalog and adds no CSV-parsing dependency.
const EPSS_URL = 'https://api.first.org/data/v1/epss';
const EPSS_CACHE_TTL_MS = 24 * 3600_000; // FIRST republishes EPSS once daily
const epssCache = new Map(); // cve_id → { score, cachedAt }

function getCachedEPSS(cveId) {
  const entry = epssCache.get(cveId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > EPSS_CACHE_TTL_MS) {
    epssCache.delete(cveId);
    return undefined;
  }
  return entry.score;
}

/**
 * Tag headlines' cveDetails with an EPSS exploitation-probability score
 * (0–1). Runs AFTER enrichCVEs (post-stage; see cyber-enrichers.js) since it
 * reuses the CVE ids enrichCVEs already extracted rather than re-scanning
 * title/description. Sets h.epss (0–1) as the MAX across the headline's CVEs,
 * mirroring h.cvssScore's max-across-CVEs convention, and
 * h.epssCVE naming which CVE it came from for the evidence-ledger citation.
 * Labeled distinctly from KEV in the caller's rationale text ("FIRST EPSS
 * (model estimate)") so a probability estimate is never mistaken for KEV's
 * verified-exploitation fact — the same verified-vs-heuristic honesty the KEV
 * path already models.
 */
export async function enrichEPSS(headlines, maxLookups = 20) {
  const targets = headlines.filter(h => h.cveDetails?.length || /CVE-\d{4}-\d{4,7}/i.test(`${h.title} ${h.description || ''}`));
  if (targets.length === 0) return;

  const cvePattern = /CVE-\d{4}-\d{4,7}/gi;
  const idsByHeadline = new Map();
  const allIds = new Set();
  for (const h of targets) {
    const text = `${h.title} ${h.description || ''}`;
    const ids = [...new Set([...text.matchAll(cvePattern)].map(m => m[0].toUpperCase()))].slice(0, PER_HEADLINE_CVES);
    if (ids.length === 0) continue;
    idsByHeadline.set(h, ids);
    for (const id of ids) allIds.add(id);
  }
  if (allIds.size === 0) return;

  const uncached = [...allIds].filter(id => getCachedEPSS(id) === undefined).slice(0, maxLookups);
  if (uncached.length > 0) {
    try {
      const url = `${EPSS_URL}?cve=${uncached.join(',')}`;
      const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(await readCapped(res, 2_000_000));
      const now = Date.now();
      for (const row of body?.data || []) {
        const score = parseFloat(row.epss);
        if (row.cve && Number.isFinite(score)) epssCache.set(row.cve.toUpperCase(), { score, cachedAt: now });
      }
    } catch (err) {
      log.warn('enrichment', `EPSS lookup failed: ${err.message}`);
      // Additive-only signal — a failed EPSS fetch degrades gracefully (no
      // h.epss set) rather than blocking the pipeline; not pushed through
      // enrichmentFailures since the exploitation axis has KEV + urgency as
      // its other, unaffected inputs and EPSS is a supplementary refinement.
      return;
    }
  }

  let tagged = 0;
  for (const [h, ids] of idsByHeadline) {
    let best = null;
    let bestCVE = null;
    for (const id of ids) {
      const score = getCachedEPSS(id);
      if (score != null && (best === null || score > best)) { best = score; bestCVE = id; }
    }
    if (best !== null) {
      h.epss = best;
      h.epssCVE = bestCVE;
      tagged++;
    }
  }
  if (tagged > 0) log.info('enrichment', `EPSS: ${tagged} headlines scored (FIRST model estimate)`);
}

/** Deep-extract article bodies for top headlines flagged for extraction. */
export async function enrichArticleBodies(headlines, maxExtractions = 10) {
  const candidates = headlines
    .filter(h => h.link && (h.deepExtract || h.horizon === 1))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, maxExtractions);
  if (candidates.length === 0) return;

  const results = await Promise.allSettled(
    candidates.map(async (h) => {
      const body = await extractArticleBody(h.link);
      if (body && body.length > 50) {
        h.articleBody = body;
        return true;
      }
      return false;
    })
  );

  const extracted = results.filter(r => r.status === 'fulfilled' && r.value).length;
  if (extracted > 0) log.info('enrichment', `Extracted ${extracted}/${candidates.length} article bodies`);
}

// ── IOC extraction (domains, IPs, hashes) ──
// The pipeline's only machine-readable indicator today is the CVE id; a story
// about a phishing or malware campaign yields no domains/IPs a SOC can drop
// onto a blocklist — the classic "news desk" vs "intel desk" gap.
// Runs on h.articleBody, which enrichArticleBodies (the 'article' enricher)
// already fetched for the same top-scored headlines, so this adds no new
// network calls. News-text IOC extraction is inherently noisy (a defanged IP
// in a "how to defend" explainer isn't necessarily THIS story's indicator), so
// every result is tagged heuristic and capped — an unverified extraction aid,
// never presented as a confirmed indicator feed.
const IOC_MAX_PER_TYPE = 10;

// Defanged forms are the norm in threat-intel writing (hxxp://, 1.2.3[.]4,
// example[.]com) specifically so the text itself doesn't render as a live
// link/IOC — match both the defanged and live forms.
const IOC_PATTERNS = {
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  domain: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\[?\.\]?){1,}(?:[a-z]{2,24})\b/gi,
  md5: /\b[a-f0-9]{32}\b/gi,
  sha1: /\b[a-f0-9]{40}\b/gi,
  sha256: /\b[a-f0-9]{64}\b/gi,
};
// Domain suffixes that are overwhelmingly noise in news prose (file extensions,
// version-looking tokens) rather than an actor's infrastructure — filtered out
// of the domain match set rather than added to the pattern (keeps the pattern
// itself simple and auditable).
const DOMAIN_NOISE_SUFFIX = /\.(?:js|json|png|jpg|jpeg|gif|svg|css|html?|pdf|zip|exe|dll|md|txt)$/i;

function undefang(s) {
  return s.replace(/hxxp/gi, 'http').replace(/\[\.\]/g, '.').replace(/\[dot\]/gi, '.');
}

function extractIOCs(text) {
  if (!text) return null;
  // Defang before matching so "example[.]com" and "1[.]2[.]3[.]4" are found by
  // the plain-dotted patterns above, rather than needing a second bracket-aware
  // pattern per indicator type.
  const clean = undefang(text);

  const domains = [...new Set((clean.match(IOC_PATTERNS.domain) || [])
    .map(d => d.toLowerCase())
    .filter(d => d.includes('.') && !DOMAIN_NOISE_SUFFIX.test(d)))]
    .slice(0, IOC_MAX_PER_TYPE);
  const ips = [...new Set(clean.match(IOC_PATTERNS.ipv4) || [])]
    .filter(ip => ip.split('.').every(octet => Number(octet) <= 255))
    .slice(0, IOC_MAX_PER_TYPE);
  // Longest hash length first so a SHA-256 string isn't also double-counted as
  // containing a shorter MD5/SHA-1 substring match.
  const sha256 = [...new Set(clean.match(IOC_PATTERNS.sha256) || [])].slice(0, IOC_MAX_PER_TYPE);
  const consumed = new Set(sha256);
  const sha1 = [...new Set((clean.match(IOC_PATTERNS.sha1) || []).filter(h => !consumed.has(h)))].slice(0, IOC_MAX_PER_TYPE);
  for (const h of sha1) consumed.add(h);
  const md5 = [...new Set((clean.match(IOC_PATTERNS.md5) || []).filter(h => !consumed.has(h)))].slice(0, IOC_MAX_PER_TYPE);

  const hashes = [...sha256, ...sha1, ...md5];
  if (domains.length === 0 && ips.length === 0 && hashes.length === 0) return null;
  return { domains, ips, hashes };
}

/**
 * Extract heuristic IOCs (domains, IPs, file hashes) from deep-extracted
 * article bodies. Opt-in per the honesty posture: only runs on headlines that
 * already carry h.articleBody (the 'article' enricher's output), and tags
 * every result h.iocs.heuristic = true so the Wire/CSV surfaces can label it
 * "unverified extraction" rather than a confirmed indicator feed.
 */
export function enrichIOCs(headlines) {
  let tagged = 0;
  for (const h of headlines) {
    if (!h.articleBody) continue;
    const iocs = extractIOCs(h.articleBody);
    if (iocs) {
      h.iocs = { ...iocs, heuristic: true };
      tagged++;
    }
  }
  if (tagged > 0) log.info('enrichment', `IOC extraction: ${tagged} headlines yielded heuristic indicators`);
}

/**
 * Tag headlines with threat actors / vendors / regions mentioned.
 * Powers the wall's actor leaderboard and region activity panels.
 */
export function tagEntities(headlines) {
  for (const h of headlines) {
    // Actor attribution reads title and body separately so the tag can record
    // WHERE it was found (headline vs passing mention) — see matchActors.
    const actors = matchActors(h.title || '', h.description || '');
    if (actors.length > 0) h.actors = actors;

    const vendors = matchVendors(`${h.title} ${h.description || ''}`);
    if (vendors.length > 0) h.vendors = vendors.slice(0, 4);
  }
}

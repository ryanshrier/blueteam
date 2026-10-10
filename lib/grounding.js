// BlueTeam.News — one grounding contract shared by prompt construction,
// post-generation validation, and the deterministic citation fallback.

import { marked } from 'marked';
import { parseDocument } from 'htmlparser2';
import { selectSourcePassage, classifySourceEvidence } from './evidence-quality.js';
import { expandCveShorthand } from './cve-identities.js';
import { nvdApplicabilityEvidence } from './nvd-applicability.js';
import { normalizeFeedTimestamp } from './intelligence-context.js';

const CVE_RE = /CVE-\d{4}-\d{3,7}/gi;
export const CISA_KEV_CATALOG_URL = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';

function asText(value) {
  return typeof value === 'string' ? value : '';
}

// Citation dates identify the publisher's calendar day. Converting an RFC RSS
// timestamp to UTC can silently move it to a different day than an equivalent
// ISO timestamp, so preserve the explicit date in both common feed formats.
export function sourcePublicationDay(value) {
  const raw = asText(value).trim();
  if (!raw) return '';
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(raw);
  const rfc = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:$|\s)/i.exec(raw);
  let year; let month; let day;
  if (iso) [year, month, day] = iso.slice(1, 4).map(Number);
  else if (rfc) {
    year = Number(rfc[3]); month = months.indexOf(rfc[2].slice(0, 3).toLowerCase()) + 1; day = Number(rfc[1]);
  } else {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
  }
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return year >= 1000 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
}

/**
 * Remove Markdown delimiters whose rendered text is visually contiguous.
 * `stripMd` already handles asterisks/backticks; this covers valid GFM
 * underscore emphasis/strong and strikethrough without treating intraword
 * `K__E__V` as emphasis when Marked itself leaves those underscores visible.
 */
export function normalizeRenderedMarkdownDelimiters(value) {
  return asText(value)
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
    .replace(/(^|[^A-Za-z0-9_])__(?=\S)([^_\n]*?\S)__(?![A-Za-z0-9_])/g, '$1$2')
    .replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9_])/g, '$1$2');
}

/** Visible source text; enrichments are separate authorities when attributing a passage. */
export function visibleHeadlineEvidence(headline = {}, { includeEnrichment = true } = {}) {
  const selected = selectSourcePassage(headline);
  return [
    asText(headline.title),
    includeEnrichment ? asText(headline.cveData) : '',
    ...(selected.sourceParts?.length ? selected.sourceParts.map(part => part.passage) : [selected.passage]),
    includeEnrichment && headline.isKEV ? asText(headline.kevCVE) : '',
  ].filter(Boolean).join(' ');
}

/** Accept absolute HTTP(S) URLs without credentials or hidden controls. */
export function safeSourceUrl(value) {
  // Check before trimming: URL() silently discards tabs/newlines and can hide
  // malformed source metadata. Encoded CR/LF and NUL are unsafe at URL sinks too.
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return '';
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw) || raw.includes('\\')) return '';
  try {
    const parsed = new URL(raw);
    return !parsed.username && !parsed.password
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? raw : '';
  } catch {
    return '';
  }
}

/** Full citation identity, distinct from the lossy grouping key below.
 * Markdown hrefs become HTML attributes, which decode entities exactly once.
 * Captured source URLs are raw URLs, so never decode their query values. */
export function citationUrlKey(value, { rendered = false } = {}) {
  if (typeof value !== 'string') return '';
  const decoded = rendered
    ? parseDocument(`<a href="${value.replace(/"/g, '&quot;')}"></a>`).children[0]?.attribs?.href
    : value;
  const url = safeSourceUrl(decoded);
  return url ? new URL(url).href : '';
}

/** Lossy publisher grouping only; never authorize a generated citation with it. */
export function sourceUrlKey(value) {
  try {
    // URLs are HTML-escaped inside the prompt's <source> fence. Treat a model's
    // faithful `&amp;` copy as the same URL as the raw feed delimiter.
    const parsed = new URL(String(value).replace(/&amp;/gi, '&'));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    // Fragments never identify a different server resource. Remove only known
    // analytics parameters; preserve meaningful query values (`?id=123`) so one
    // query-selected article cannot bless another (`?id=999`).
    for (const key of [...new Set(parsed.searchParams.keys())]) {
      if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    const query = parsed.searchParams.toString();
    return `${parsed.origin}${path}${query ? `?${query}` : ''}`;
  } catch {
    return '';
  }
}

// Apply a transform only to prose/Markdown, preserving inline and fenced code
// byte-for-byte. URLs and anchor-looking examples inside code are not citations.
function transformOutsideCode(value, transform) {
  const code = /```[\s\S]*?```|~~~[\s\S]*?~~~|(`+)(?!`)([^\n]*?)\1(?!`)/g;
  let output = '';
  let cursor = 0;
  for (const match of value.matchAll(code)) {
    output += transform(value.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }
  return output + transform(value.slice(cursor));
}

// Use the same parser/options as the browser renderer. Regexes that only look
// for `http(s)://` miss GFM's implicit `www.`, email, and `ftp://` links as
// well as CommonMark's arbitrary-scheme autolinks and reference links.
function renderedLinkTokens(value) {
  const links = [];
  try {
    const tokens = marked.lexer(asText(value), { gfm: true, breaks: true });
    marked.walkTokens(tokens, token => {
      if (token.type === 'link' && typeof token.href === 'string') links.push(token);
    });
  } catch {
    // A malformed model response must not make validation itself fail. Marked
    // is deliberately permissive, so this is only a last-resort guard.
  }
  return links;
}

function neutralizedLinkText(token) {
  const raw = asText(token?.raw);
  // Preserve authored link labels. Escaping both brackets prevents a matching
  // reference definition elsewhere from turning the label back into a link.
  if (raw.startsWith('[')) {
    const label = asText(token?.text).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    // The established inline-citation fallback is exact bracketed prose. It is
    // safe in the normal case; if a hostile matching reference definition also
    // exists, the authoritative re-audit below detects that newly rendered link
    // and forces retry/block.
    if (raw.includes('](')) return `[${label}]`;
    return `\\[${label}\\]`;
  }
  return '[source link unavailable]';
}

function neutralizeRenderedLinks(value, manifest) {
  const unsafe = renderedLinkTokens(value)
    .filter(token => !isAllowedSourceUrl(token.href, manifest))
    .filter(token => token.raw)
    .sort((a, b) => b.raw.length - a.raw.length);

  let output = value;
  const seen = new Set();
  for (const token of unsafe) {
    if (seen.has(token.raw)) continue;
    seen.add(token.raw);
    // The lexer resolves reference definitions across the whole document. Do
    // the literal rewrite only in prose so an identical example inside code is
    // untouched. Exotic link labels that themselves span code may remain; the
    // authoritative post-sanitize lexer audit then forces retry/block.
    output = transformOutsideCode(output, segment => (
      segment.split(token.raw).join(neutralizedLinkText(token))
    ));
  }
  return output;
}

/**
 * Build the allowlist for one generation. `sources[index]` corresponds to
 * `headlines[index]`, so prompting and validation cannot disagree about which
 * URL or CVE the model was actually shown.
 */
export function selectGroundingMembers(headline) {
  const originals = Array.isArray(headline.sourceMembers) ? headline.sourceMembers : [];
  const secondaries = originals.filter(member => (
    sourceUrlKey(member.link) !== sourceUrlKey(headline.link)
    || member.source !== headline.source
    || (!member.link && member.title !== headline.title)
  )).sort((a, b) => Number(a.collectionStale === true) - Number(b.collectionStale === true)
    || (Date.parse(b.retrievedAt || '') || 0) - (Date.parse(a.retrievedAt || '') || 0));
  const seen = new Set();
  const unique = secondaries.filter(member => {
    const identity = JSON.stringify({
      source: asText(member.source).trim().replace(/\s+/g, ' '), url: sourceUrlKey(member.link),
      date: member.dateUnknown ? '' : sourcePublicationDay(member.date), title: asText(member.title),
      passage: asText(member.passage || member.description),
      revisions: (member.evidence || []).map(ref => `${ref.sourceId || ''}:${ref.revisionId || ''}`).sort(),
    });
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return [headline, ...unique.slice(0, 4)];
}

export function buildGroundingManifest({ headlines = [], extraSourceText = '', kevSet = null, kevCatalogStatus = null } = {}) {
  const sourceList = Array.isArray(headlines) ? headlines : [];
  const cves = new Set();
  const urls = new Set();
  const urlKeys = new Set();

  const members = [];
  const nvdRecords = new Map();
  const sources = sourceList.map((headline, index) => {
    // Grouping is a selection aid. Every passage retains its original source
    // identity; a secondary report never inherits the primary's authority.
    const selected = selectGroundingMembers(headline);
    const groupSources = selected.map((member, memberIndex) => {
      // Enrichment belongs to the selected group; copied secondary passages
      // carry only their own body/description and original source metadata.
      const passage = memberIndex === 0 ? member : {
        ...member, description: member.passage || member.description,
      };
      const selectedPassage = selectSourcePassage(passage);
      const sourceParts = (selectedPassage.sourceParts || []).map(part => ({ ...part,
        cves: [...new Set([...expandCveShorthand([part.kind === 'feed-excerpt' ? asText(member.title) : '', part.passage].join(' ')).matchAll(CVE_RE)].map(match => match[0].toUpperCase()))],
      }));
      const capturedText = sourceParts.length > 1
        ? sourceParts.map(part => `[${part.kind} capture]\n${part.passage}`).join('\n\n')
        : selectedPassage.passage;
      const evidenceText = [asText(member.title), capturedText].filter(Boolean).join(' ');
      // Capture metadata is provenance, never additional claim evidence.
      const factualText = [asText(member.title), ...sourceParts.map(part => part.passage)].join(' ');
      const sourceCves = new Set([...expandCveShorthand(factualText).matchAll(CVE_RE)].map(match => match[0].toUpperCase()));
      const url = safeSourceUrl(member.link);
      const source = Object.freeze({
        id: `S${index + 1}.${memberIndex + 1}`, index, memberIndex,
        label: asText(member.source).trim() || 'Unnamed source',
        title: asText(member.title), date: member.dateUnknown ? ''
          : member.originalDate && normalizeFeedTimestamp(member.originalDate)
            && normalizeFeedTimestamp(member.originalDate) === normalizeFeedTimestamp(member.date)
            ? asText(member.originalDate) : asText(member.date),
        retrievedAt: asText(selectedPassage.retrievedAt), collectionStale: member.collectionStale === true,
        url, cves: sourceCves, evidenceText,
        passage: selectedPassage.passage, passageKind: selectedPassage.kind, quality: selectedPassage.quality,
        sourceParts,
        ...(selectedPassage.excludedArticle ? { excludedArticle: selectedPassage.excludedArticle } : {}),
        ...(selectedPassage.excludedPassage ? { excludedPassage: selectedPassage.excludedPassage } : {}),
        sourceRevisions: selectedPassage.sourceRevisions || [],
      });
      for (const cve of sourceCves) cves.add(cve);
      if (url) { urls.add(url); urlKeys.add(sourceUrlKey(url)); }
      members.push(source);
      return source;
    });
    // NVD is a different publisher. Its looked-up score/products must never
    // become evidence attributed to the feed whose CVE triggered the lookup.
    const details = Array.isArray(headline.cveDetails) && headline.cveDetails.length
      ? headline.cveDetails.filter(value => typeof value === 'string')
      : asText(headline.cveData).split(/\s*[·\n]\s*(?=CVE-\d{4}-\d{3,7}\s*:)/i);
    const nvdSources = [];
    for (const detail of details) {
      const match = /^\s*(CVE-\d{4}-\d{3,7})\s*:\s*\S/i.exec(detail);
      if (!match) continue;
      const cve = match[1].toUpperCase();
      const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve}`;
      let record = nvdRecords.get(cve);
      const observed = (headline.cveObservations || []).filter(value => value?.cve === cve)
        .map(value => Date.parse(value.retrievedAt)).filter(Number.isFinite).map(value => new Date(value).toISOString());
      if (!record) {
        record = { id: `NVD-${cve}`, index: null, memberIndex: null, label: 'NVD',
          title: `NVD lookup: ${cve}`, date: '', retrievedAt: '', url,
          cves: new Set([cve]), evidenceText: detail.trim(), passage: detail.trim(), sourceRevisions: [],
          cvssMetrics: [],
        };
        nvdRecords.set(cve, record);
      } else if (!record.evidenceText.split('\n').includes(detail.trim())) {
        // Preserve any conflicting retained lookup passages instead of choosing
        // a score silently. They share one underlying per-CVE NVD identity.
        record.evidenceText += `\n${detail.trim()}`;
        record.passage = record.evidenceText;
      }
      record.observationTimes = [...new Set([...(record.observationTimes || []), ...observed])].sort();
      // One timestamp cannot describe distinct observations. Keep each capture
      // time without borrowing the newest clock for older/conflicting evidence.
      record.retrievedAt = record.observationTimes.length === 1 ? record.observationTimes[0] : '';
      for (const metric of headline.cvssMetrics || []) {
        if (metric.cve !== cve) continue;
        const captured = { cve, score: metric.score, version: metric.version, source: metric.source, type: metric.type,
          status: metric.status, provisional: metric.provisional === true, selected: metric.selected === true };
        if (!record.cvssMetrics.some(existing => JSON.stringify(existing) === JSON.stringify(captured))) record.cvssMetrics.push(captured);
      }
      const applicability = (headline.cveConfigurations || []).find(value => value.cve === cve);
      if (/reject/i.test(applicability?.status || '') || /rejected by NVD/i.test(detail)) {
        record.applicabilityRejected = true;
        record.applicabilityComplete = false;
        record.applicabilityPassage = `A captured NVD record for ${cve} is rejected. Do not use retained applicability conditions as current affected-version or fixed-release evidence.`;
        delete record.configurations;
      } else if (applicability && !record.applicabilityRejected) {
        const captured = nvdApplicabilityEvidence(cve, applicability.configurations);
        record.configurationCaptures ||= [];
        if (!record.configurationCaptures.some(previous => JSON.stringify(previous.configurations) === JSON.stringify(captured.configurations))) {
          record.configurationCaptures.push({ configurations: captured.configurations, passage: captured.passage, complete: captured.complete });
        }
        if (record.configurationCaptures.length === 1) {
          record.configurations = captured.configurations;
          record.applicabilityPassage = captured.passage;
          record.applicabilityComplete = captured.complete;
        } else {
          // Different captures are not one NVD condition tree. Preserve them
          // for inspection without silently unioning their applicability.
          record.applicabilityComplete = false;
          record.applicabilityPassage = `Conflicting captured NVD applicability configurations for ${cve}. The separate condition sets are retained for inspection; no combined affected-version claim is supported. Do not infer affected versions or fixed releases from these conflicting snapshots.`;
        }
      }
      if (!nvdSources.includes(record)) nvdSources.push(record);
      cves.add(cve); urls.add(url); urlKeys.add(sourceUrlKey(url));
    }
    // Keep legacy/global identifier grounding intact without assigning the
    // enrichment's assertions to a publisher passage.
    for (const match of expandCveShorthand(visibleHeadlineEvidence(headline)).matchAll(CVE_RE)) cves.add(match[0].toUpperCase());
    return Object.freeze({ ...groupSources[0], members: Object.freeze(groupSources), nvdSources: Object.freeze(nvdSources) });
  });
  for (const record of nvdRecords.values()) {
    record.passageKind = 'structured-cve-record';
    record.quality = classifySourceEvidence(record);
    members.push(Object.freeze(record));
  }

  // This deterministic URL is displayed beside every system-verified KEV hit,
  // so it belongs in the same allowlist as feed-provided current-source links.
  if (sourceList.some(headline => headline?.isKEV)) {
    urls.add(CISA_KEV_CATALOG_URL);
    urlKeys.add(sourceUrlKey(CISA_KEV_CATALOG_URL));
  }

  if (typeof extraSourceText === 'string') {
    for (const match of expandCveShorthand(extraSourceText).matchAll(CVE_RE)) {
      cves.add(match[0].toUpperCase());
    }
  }

  const verified = kevSet instanceof Set ? [...cves].filter(cve => kevSet.has(cve))
    : sourceList.filter(headline => headline?.isKEV).map(headline => headline.kevCVE).filter(Boolean);
  if (verified.length) {
    urls.add(CISA_KEV_CATALOG_URL);
    urlKeys.add(sourceUrlKey(CISA_KEV_CATALOG_URL));
    members.push(Object.freeze({ id: 'CISA-KEV', index: null, memberIndex: null,
      label: 'CISA KEV catalog', title: 'System-verified CISA KEV membership', date: '',
      retrievedAt: kevCatalogStatus?.retrievedAt || '',
      url: CISA_KEV_CATALOG_URL, cves: new Set(verified),
      passageKind: 'catalog-membership-only', quality: Object.freeze({ status: 'substantive', substantive: true, reasons: Object.freeze(['verified-catalog-membership-only']) }),
      evidenceText: verified.map(cve => `${cve} is in CISA KEV.`).join(' '), sourceRevisions: [],
    }));
  }

  return Object.freeze({ sources: Object.freeze(sources), members: Object.freeze(members), cves, urls, urlKeys,
    ...(kevCatalogStatus ? { kevCatalogStatus } : {}) });
}

/** Authorize only complete captured destinations, including query and fragment. */
export function isAllowedSourceUrl(value, manifest) {
  const key = citationUrlKey(value, { rendered: true });
  if (!key || !manifest?.urls) return false;
  return [...manifest.urls].some(url => citationUrlKey(url) === key);
}

/** Return every unique rendered link destination that is outside the allowlist. */
export function findUnallowlistedMarkdownUrls(text, manifest) {
  // Raw anchors are audited separately and stripped before URL extraction so a
  // quoted href cannot masquerade as a grounded Markdown link. Marked itself
  // excludes inline/fenced code from link tokenization.
  const urls = renderedLinkTokens(stripRawHtmlAnchors(text)).map(token => token.href);
  return [...new Set(urls)].filter(url => !isAllowedSourceUrl(url, manifest));
}

/**
 * Preserve citation text but remove the live href for unsupported URLs.
 * `[Vendor, July 7](invented-url)` becomes `[Vendor, July 7]`.
 */
export function delinkUnallowlistedMarkdownUrls(text, manifest) {
  const anchorSafe = stripRawHtmlAnchors(text);
  return neutralizeRenderedLinks(anchorSafe, manifest);
}

/** Raw HTML anchors bypass Markdown-link parsing; disallow them at generation. */
export function containsRawHtmlAnchor(text) {
  let found = false;
  transformOutsideCode(asText(text), (segment) => {
    if (/<\/?a\b/i.test(segment)) found = true;
    return segment;
  });
  return found;
}

/** Remove raw anchor tags conservatively while preserving all visible label text. */
export function stripRawHtmlAnchors(text) {
  return transformOutsideCode(asText(text), segment => segment
    .replace(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '')
    .replace(/<\/a\s*>/gi, ''));
}

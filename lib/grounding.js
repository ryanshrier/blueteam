// BlueTeam.News — one grounding contract shared by prompt construction,
// post-generation validation, and the deterministic citation fallback.

import { marked } from 'marked';

const CVE_RE = /CVE-\d{4}-\d{3,7}/gi;
export const CISA_KEV_CATALOG_URL = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';

function asText(value) {
  return typeof value === 'string' ? value : '';
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

/** The exact evidence text from a headline that buildUserPrompt exposes. */
export function visibleHeadlineEvidence(headline = {}) {
  return [
    asText(headline.title),
    asText(headline.cveData),
    headline.articleBody
      ? asText(headline.articleBody).slice(0, 800)
      : asText(headline.description),
    headline.isKEV ? asText(headline.kevCVE) : '',
  ].filter(Boolean).join(' ');
}

/** Accept only absolute HTTP(S) source URLs; return the original trimmed URL. */
export function safeSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const raw = value.trim();
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : '';
  } catch {
    return '';
  }
}

function sourceUrlKey(value) {
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
export function buildGroundingManifest({ headlines = [], extraSourceText = '' } = {}) {
  const sourceList = Array.isArray(headlines) ? headlines : [];
  const cves = new Set();
  const urls = new Set();
  const urlKeys = new Set();

  const sources = sourceList.map((headline, index) => {
    const evidenceText = visibleHeadlineEvidence(headline);
    const sourceCves = new Set(
      [...evidenceText.matchAll(CVE_RE)].map(match => match[0].toUpperCase())
    );
    for (const cve of sourceCves) cves.add(cve);

    const url = safeSourceUrl(headline?.link);
    if (url) {
      urls.add(url);
      const key = sourceUrlKey(url);
      if (key) urlKeys.add(key);
    }

    return Object.freeze({ index, url, cves: sourceCves, evidenceText });
  });

  // This deterministic URL is displayed beside every system-verified KEV hit,
  // so it belongs in the same allowlist as feed-provided current-source links.
  if (sourceList.some(headline => headline?.isKEV)) {
    urls.add(CISA_KEV_CATALOG_URL);
    urlKeys.add(sourceUrlKey(CISA_KEV_CATALOG_URL));
  }

  if (typeof extraSourceText === 'string') {
    for (const match of extraSourceText.matchAll(CVE_RE)) {
      cves.add(match[0].toUpperCase());
    }
  }

  return Object.freeze({ sources: Object.freeze(sources), cves, urls, urlKeys });
}

/** Query strings/fragments may differ; the exact origin + path must match. */
export function isAllowedSourceUrl(value, manifest) {
  const url = safeSourceUrl(value);
  if (!url || !manifest) return false;
  if (manifest.urls?.has(url)) return true;
  const key = sourceUrlKey(url);
  return Boolean(key && manifest.urlKeys?.has(key));
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

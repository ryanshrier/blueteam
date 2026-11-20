// Citations are authored as retained source IDs; display labels and destinations
// belong to the app. This accepts ordinary Markdown as well, without rebuilding
// the document or changing the claims around a citation.
import { marked } from 'marked';
import { citationUrlKey, safeSourceUrl, sourcePublicationDay, restoreGroundingCitationUrls } from './grounding.js';
import { escapeRegExp } from './regex-util.js';

const SOURCE_ID = /^(?:S\d+\.\d+|NVD-CVE-\d{4}-\d{3,7}|CISA-KEV)$/i;
const SOURCE_START = /^(?:S\d+(?:\.\d+)?(?![.\w])|NVD-CVE-\d{4}-\d+\b|CISA-KEV\b)/i;
const PROTECTED = new Set(['code', 'codespan', 'html', 'image', 'link']);

export function protectedSpans(text) {
  const literals = new Map();
  const htmlTags = new Map();
  const lexer = new marked.Lexer({ gfm: true });
  // Reference definitions disappear from the final token list. Capture them
  // while lexing, including multiline titles, so they remain byte-for-byte.
  const originalDef = lexer.tokenizer.def;
  lexer.tokenizer.def = function (source) {
    const token = originalDef.call(this, source);
    if (token?.raw) literals.set(token.raw, token);
    return token;
  };
  const tokens = lexer.lex(text);
  marked.walkTokens(tokens, token => {
    if (PROTECTED.has(token.type) && token.raw) literals.set(token.raw, token);
    if (token.type === 'html') {
      const tag = /^<(\/)?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>$/i.exec(token.raw || '');
      if (tag && !/\/$/.test(token.raw.slice(0, -1))
        && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag[2])) {
        htmlTags.set(token.raw, { name: tag[2].toLowerCase(), closing: Boolean(tag[1]) });
      }
    }
  });
  const spans = [];
  const tags = [];
  for (const [raw, token] of literals) {
    // Marked normalizes line endings. Match both forms without normalizing the
    // authored document, which also keeps offsets meaningful in findings.
    // Blockquotes and lists remove their container prefixes from child tokens.
    // Restore those possible prefixes when locating a protected child span.
    const pattern = escapeRegExp(raw).replace(/\r?\n/g, '\\r?\\n[ \\t]*(?:>[ \\t]*)*');
    for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
      spans.push([match.index, match.index + match[0].length, token]);
      if (htmlTags.has(raw)) tags.push({ ...htmlTags.get(raw), start: match.index, end: match.index + match[0].length });
    }
  }
  // Marked represents inline HTML as separate opening/closing tag tokens.
  // Content inside those elements can be hidden by attributes or styling and
  // must not become a new visible source citation through normalization.
  const open = [];
  for (const tag of tags.filter(tag => !spans.some(([start, end]) => start <= tag.start && end >= tag.end
    && (start < tag.start || end > tag.end))).sort((a, b) => a.start - b.start)) {
    if (!tag.closing) { open.push(tag); continue; }
    const index = open.findLastIndex(value => value.name === tag.name);
    if (index < 0) continue;
    spans.push([open[index].start, tag.end]);
    open.splice(index);
  }
  for (const tag of open) spans.push([tag.start, text.length]);
  return spans;
}

function displayLabel(record) {
  const value = record.id?.toUpperCase() === 'CISA-KEV' ? 'CISA KEV catalog'
    : `${String(record.label || '').trim()}, ${sourcePublicationDay(record.date) || 'date unavailable'}`;
  // A publisher name is text, never Markdown or an HTML entity supplied by a
  // feed. Escape before inserting it into a label (including GFM table cells).
  return value.replace(/&/g, '&amp;').replace(/[\\`*_[\]<>~|]/g, char => `&#${char.charCodeAt(0)};`)
    .replace(/[\r\n]+/g, ' ');
}

function destination(record) {
  // Preserve raw query/fragment identity. Escape Markdown punctuation and HTML
  // entities, not URL components: percent-encoding can change the destination.
  const escaped = record.url.replace(/&/g, '&amp;').replace(/[\\()<>"']/g, '\\$&');
  return /\s/.test(record.url) ? `<${escaped}>` : escaped;
}

// Exact rendered source identities for presentation only. Semantic links with
// other labels are never removed, even when they share a citation destination.
export function capturedCitationTokens(grounding = {}) {
  const records = grounding.members || grounding.sources || [];
  return [...new Set(records.filter(record => record?.label && (!record.url || safeSourceUrl(record.url)))
    .map(record => record.url ? `[${displayLabel(record)}](${destination(record)})` : `[${displayLabel(record)}]`))];
}

function hasDistinctDisplayIdentity(record, records) {
  const key = citationUrlKey(record.url);
  const name = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const sameDestination = records.filter(candidate => citationUrlKey(candidate.url) === key);
  if (key && sameDestination.length === 1) return true;
  // The persisted Markdown is also consumed by older readers. Do not erase an
  // ID distinction that publisher/date + complete URL cannot represent.
  return sameDestination.filter(candidate => name(candidate.label) === name(record.label)
    && sourcePublicationDay(candidate.date) === sourcePublicationDay(record.date)).length === 1;
}

// Marked interprets a provider's "[^1]: [S1.1]" as a link to the literal
// relative path "[S1.1]". Translate source-only reference definitions only
// when every use is a plain marker and its destination identifies one record.
// The number itself never identifies a source. Notes containing prose stay authored.
function normalizeCapturedLinks(text, records, byId, spans) {
  const changes = [];
  const aliases = new Map();
  const outer = new Map();
  let covered = -1;
  for (const [start, end, token] of [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    if (start < covered) { covered = Math.max(end, covered); continue; }
    outer.set(start, { end, token });
    covered = end;
  }
  const defined = new Set([...outer.values()].filter(span => span.token?.type === 'def').map(span => span.token.tag.toUpperCase()));
  const byUrl = new Map();
  for (const record of records) {
    const key = citationUrlKey(record.url);
    if (!key) continue;
    if (byUrl.has(key)) byUrl.set(key, null); else byUrl.set(key, record);
  }
  const resolve = destination => {
    const id = /^\[([^\]]+)\]$/.exec(destination)?.[1]?.toUpperCase();
    if (id && SOURCE_ID.test(id)) return byId.get(id)?.length === 1 ? byId.get(id)[0] : null;
    return byUrl.get(citationUrlKey(destination, { rendered: true }));
  };
  const usable = record => typeof record?.id === 'string' && SOURCE_ID.test(record.id) && byId.get(record.id.toUpperCase())?.length === 1
    && !defined.has(record.id.toUpperCase()) && typeof record.label === 'string' && record.label.trim() && (!record.url || safeSourceUrl(record.url))
    && hasDistinctDisplayIdentity(record, records);
  for (const [start, { end, token }] of outer) {
    if (!token || !['link', 'def'].includes(token.type)) continue;
    if (text[start - 1] === '\\') continue;
    if (token.type === 'def' && /^\^?\d+$/.test(token.tag)) {
      const record = resolve(token.href);
      if (!usable(record) || token.title || !/^\[\^?\d+\]:[ \t]+\S+[ \t]*[\r\n]*$/.test(token.raw)) continue;
      // Only a top-level, single definition is safe to consume.
      if (start && text[start - 1] !== '\n') continue;
      if (/^\r?\n[ \t]+\S/.test(text.slice(start + token.raw.trimEnd().length))) continue;
      if (aliases.has(token.tag)) aliases.set(token.tag, null);
      else aliases.set(token.tag, { start, end: start + token.raw.trimEnd().length, record, uses: [] });
    } else if (token.type === 'link' && !token.title && SOURCE_ID.test(token.text) && token.raw.startsWith(`[${token.text}](`)) {
      const id = token.text.toUpperCase(), record = byId.get(id)?.[0];
      if (usable(record) && record.url
        && citationUrlKey(token.href, { rendered: true }) === citationUrlKey(record.url)) changes.push({ start, end, to: `[${id}]` });
    }
  }
  // Leave mixed-use definitions in place, including named references and
  // images that depend on the same number. Inspect literal examples conservatively.
  if (aliases.size) for (const match of text.matchAll(/\[(\^?\d+)\]/g)) {
    const alias = aliases.get(match[1]);
    if (!alias || match.index === alias.start) continue;
    const start = match.index, end = start + match[0].length;
    const span = outer.get(start);
    if (span?.end !== end || span.token?.type !== 'link' || span.token.raw !== match[0] || text[start - 1] === '\\') aliases.set(match[1], null);
    else {
      const id = `[${alias.record.id}]`;
      // Numeric footnotes are commonly attached before or after a period.
      // Keep the period with its sentence so the reading projections can
      // move the resulting bibliography to Sources without clipping prose.
      if (start && /\S/.test(text[start - 1]) && /^[.!?](?:\s|$)/.test(text.slice(end, end + 2))) {
        alias.uses.push({ start, end: end + 1, to: text[end] + ' ' + id });
      } else alias.uses.push({ start, end, to: (start && /[.!?]/.test(text[start - 1]) ? ' ' : '') + id });
    }
  }
  for (const alias of aliases.values()) {
    if (!alias?.uses.length) continue;
    for (const use of alias.uses) changes.push(use);
    changes.push({ start: alias.start, end: alias.end, to: '' });
  }
  if (!changes.length) return text;
  let pos = 0;
  const result = [];
  for (const { start, end, to } of changes.sort((a, b) => a.start - b.start)) {
    result.push(text.slice(pos, start), to);
    pos = end;
  }
  return result.join('') + text.slice(pos);
}

/** Expand visible [S1.1], [NVD-CVE-...], and [CISA-KEV] references from one
 * captured manifest. Lists and casing/spacing differences are tolerated. No
 * publisher-name or URL guessing occurs; unresolved references remain visible
 * and carry blocking findings. Existing links, code, HTML, images and escaped
 * examples stay unchanged, and calling this again is a no-op. */
export function renderBriefCitations(value, grounding = {}) {
  let text = String(value || '');
  grounding = restoreGroundingCitationUrls(grounding, text);
  const records = grounding.members || grounding.sources || [];
  const byId = new Map();
  for (const record of records) {
    const id = String(record?.id || '').trim().toUpperCase();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(record);
  }
  let spans = protectedSpans(text);
  if (/^\[\^?\d+\]:|\[(?:S\d+\.\d+|NVD-CVE-[\d-]+|CISA-KEV)\]\(/im.test(text)) {
    const normalized = normalizeCapturedLinks(text, records, byId, spans);
    if (normalized !== text) { text = normalized; spans = protectedSpans(text); }
  }
  const issues = [];
  const references = [];
  const content = text.replace(/\[([^\[\]\r\n]+)\]/g, (raw, inner, offset) => {
    if (text[offset - 1] === '!' || /(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(0, offset))
      || spans.some(([start, end]) => offset < end && offset + raw.length > start)) return raw;
    const body = inner.trim().replace(/^sources?\s*:\s*/i, '');
    if (!SOURCE_START.test(body)) return raw;
    // A provider may group IDs with spaces or "and" despite the prompt's
    // one-ID-per-bracket form. Accept those separators only: every resulting
    // token must still resolve to a complete, unique captured source below.
    const ids = body.split(/\s*(?:[,;]\s*(?:and\b\s*)?|\band\b|&)\s*|\s+/i).map(id => id.toUpperCase());
    const uniqueIds = [...new Set(ids)];
    const matched = uniqueIds.map(id => byId.get(id) || []);
    const valid = uniqueIds.every((id, index) => SOURCE_ID.test(id) && matched[index].length === 1
      && String(matched[index][0].label || '').trim()
      && (!matched[index][0].url || safeSourceUrl(matched[index][0].url))
      && hasDistinctDisplayIdentity(matched[index][0], records));
    if (!valid) {
      issues.push({ code: 'CITATION_REFERENCE_INVALID', severity: 'trust',
        message: `Source reference ${raw} does not identify a unique, usable captured source. Use a source ID supplied with this edition.`,
        sourceIds: uniqueIds.filter(id => SOURCE_ID.test(id)),
        location: { scope: 'paragraph', line: text.slice(0, offset).split('\n').length, excerpt: raw },
      });
      return raw;
    }
    const selected = matched.map(matches => matches[0]);
    references.push({ sourceIds: selected.map(record => record.id), raw,
      line: text.slice(0, offset).split('\n').length });
    return selected.map(record => record.url
      ? `[${displayLabel(record)}](${destination(record)})` : `[${displayLabel(record)}]`).join(' ');
  });
  return { content, issues, references };
}

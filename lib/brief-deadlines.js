// Federal catalog dates come from the captured facts, never a model's date
// arithmetic. This is an additive composition pass: authored claims remain
// intact so a conflicting date, scope or invented precision is still checked.
import { marked } from 'marked';
import { CISA_KEV_CATALOG_URL, sourcePublicationDay } from './grounding.js';
import { expandCveShorthand } from './cve-identities.js';

const LABEL = 'Federal remediation';
const SCOPE = 'Captured CISA KEV dates apply only to Federal Civilian Executive Branch (FCEB) agencies. Internal recommended targets are separate.';
const ids = value => [...new Set([...expandCveShorthand(value).matchAll(/\bCVE-\d{4}-\d{3,7}\b/gi)].map(match => match[0].toUpperCase()))];
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && sourcePublicationDay(value) === value;

/** Exact captured identities and dates only. A timing record alone does not
 * establish catalog membership, and an invalid/missing date stays unknown. */
export function capturedFederalDeadlines(grounding = {}, kevTiming = {}) {
  const records = grounding?.members || grounding?.sources || [];
  const verified = new Set(records.filter(record => record.id === 'CISA-KEV')
    .flatMap(record => [...(record.cves || [])]).filter(id => typeof id === 'string').map(id => id.toUpperCase()));
  return [...verified].sort().flatMap(cve => {
    if (!/^CVE-\d{4}-\d{3,7}$/.test(cve)) return [];
    const record = kevTiming?.[cve];
    const dueDate = record?.dueDate ?? record?.due_date;
    if (!validDay(dueDate)) return [];
    return [{ cve, dueDate, scope: 'FCEB', precision: 'day', sourceId: 'CISA-KEV', sourceUrl: CISA_KEV_CATALOG_URL }];
  });
}

// Read visible prose identities, not destinations, image alt text, hidden
// metadata, code examples or quoted copies of another report. Top-level Marked
// headings also prevent a fenced/commented KEY JUDGMENTS from being composed.
function visibleText(token, state = { html: [] }) {
  if (!token || ['code', 'image', 'blockquote'].includes(token.type)) return '';
  if (token.type === 'html') {
    // Inline HTML tags and their contents are separate Marked tokens. A hidden
    // span must not turn its enclosed identity into a visible catalog fact.
    // Share the stack across paragraphs so an unmatched opener remains opaque.
    const raw = String(token.raw || '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    for (const tag of raw.matchAll(/<(\/)?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      const name = tag[2].toLowerCase();
      if (/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) continue;
      if (!tag[1]) state.html.push(name);
      else {
        const index = state.html.lastIndexOf(name);
        if (index >= 0) state.html.splice(index);
      }
    }
    return '';
  }
  // Inline formatting around a complete identity is ordinary provider prose.
  // Commands and examples remain excluded even if they happen to name a CVE.
  if (token.type === 'codespan') return !state.html.length && /^CVE-\d{4}-\d{3,7}(?:\s*(?:,|;|and|&)\s*CVE-\d{4}-\d{3,7})*$/i.test(token.text.trim()) ? token.text : '';
  const children = tokens => tokens.map(child => visibleText(child, state)).join(' ');
  if (token.type === 'list') return token.items.map(item => children(item.tokens || [])).join(' ');
  if (token.type === 'table') return [...token.header, ...token.rows.flat()].map(cell => children(cell.tokens || [])).join(' ');
  return token.tokens ? children(token.tokens) : state.html.length ? '' : token.text || '';
}

function locatedTokens(document) {
  let cursor = 0;
  return marked.lexer(document).map(token => {
    const start = document.indexOf(token.raw, cursor);
    if (start < 0) return null;
    cursor = start + token.raw.length;
    return { token, start, end: cursor };
  }).filter(Boolean);
}

const factLine = fact => `- ${fact.cve}: FCEB remediation due ${fact.dueDate}. [CISA KEV catalog](${fact.sourceUrl})`;

/** Add deterministic federal-date context to the judgments that name its CVEs.
 * Repeated composition is idempotent. Existing Federal remediation text is
 * preserved, including forged labels or conflicting claims, rather than being
 * trusted as an instruction to overwrite or suppress evidence. */
export function renderBriefDeadlines(markdown, { grounding = {}, kevTiming = {} } = {}) {
  const original = String(markdown || '');
  const document = original.replace(/\r\n/g, '\n');
  const facts = capturedFederalDeadlines(grounding, kevTiming);
  if (!facts.length) return { content: original, deadlines: [] };
  const tokens = locatedTokens(document);
  const visibility = { html: [] }, visible = new Map();
  for (const { token, start } of tokens) visible.set(start, visibleText(token, visibility));
  const sections = tokens.filter(({ token }) => token.type === 'heading' && token.depth === 2 && /^KEY JUDGMENTS(?:\s|$)/i.test(token.text));
  if (sections.length !== 1) return { content: original, deadlines: [] };
  const section = sections[0];
  const end = tokens.find(({ token, start }) => start > section.start && token.type === 'heading' && token.depth <= 2)?.start ?? document.length;
  const entries = tokens.filter(({ token, start }) => start > section.start && start < end && token.type === 'heading' && token.depth === 3);
  const edits = [], deadlines = [];
  entries.forEach((entry, index) => {
    const boundary = entries[index + 1]?.start ?? end;
    const body = tokens.filter(({ start }) => start >= entry.start && start < boundary);
    const mentioned = new Set(ids(body.map(({ start }) => visible.get(start)).join(' ')));
    const selected = facts.filter(fact => mentioned.has(fact.cve));
    if (!selected.length) return;
    deadlines.push(...selected.map(fact => ({ judgmentIndex: index + 1, ...fact })));
    const field = body.find(({ token }) => token.type === 'paragraph' && new RegExp(`^\\*\\*${LABEL}:\\*\\*`, 'i').test(token.raw));
    const fieldEnd = field ? body.find(({ token, start }) => start > field.start && (token.type === 'hr'
      || (token.type === 'paragraph' && /^\*\*[^*\n]+:\*\*/.test(token.raw))))?.start ?? boundary : null;
    const fieldText = field ? document.slice(field.start, fieldEnd) : '';
    // Only exact rendered rows count as already present. A marker/label, the
    // same date in a code block, or a different date never suppresses the fact.
    const fieldRows = field ? body.filter(({ start, token }) => start >= field.start && start < fieldEnd && token.type === 'list')
      .flatMap(({ token }) => token.items.filter(item => !item.tokens?.some(child => ['code', 'html'].includes(child.type))).map(item => `- ${item.text.trim()}`)) : [];
    const missing = selected.filter(fact => !fieldRows.includes(factLine(fact)));
    if (!missing.length) return;
    const insertAt = field ? fieldEnd : body.find(({ token }) => token.type === 'paragraph' && /^\*\*Recommended actions:\*\*/i.test(token.raw))?.start
      ?? body.find(({ token }) => token.type === 'hr')?.start ?? boundary;
    const scope = fieldText.includes(SCOPE) ? '' : `${SCOPE}\n\n`;
    const addition = `${field ? '' : `**${LABEL}:** `}${scope}${missing.map(factLine).join('\n')}`;
    const before = document.slice(0, insertAt);
    edits.push({ at: insertAt, text: `${before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'}${addition}\n\n` });
  });
  if (!edits.length) return { content: original, deadlines };
  let content = document;
  for (const edit of edits.sort((a, b) => b.at - a.at)) content = content.slice(0, edit.at) + edit.text + content.slice(edit.at);
  if (original.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
  return { content, deadlines };
}

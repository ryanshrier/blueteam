// BlueTeam.News — printable "newspaper" export of a briefing.
//
// The on-screen brief is a dark-mode digital memo (cards, tier rules, a
// confidence gauge). A printout of that wastes ink and reads like a web page,
// not a paper. This module instead opens a self-contained, SAME-ORIGIN
// edition: it CLONES the already-rendered, already-DOMPurify-sanitized
// #briefContent and reskins its stable semantic classes (.bluf,
// .brief-judgment-card.h{1,2,3}, .the-line, .c-action, .brief-judgment-meta,
// .brief-sources-appendix) for warm paper — a centred nameplate, a folio rule,
// a readable single-column body, tier tags, pull quotes, and a source appendix.
//
// Why a separate document and not an `@media print` rule on the app:
//   • full control over the layout without fighting the dark theme, the sticky
//     header, the TOC, or the toolbar bleeding into the page;
//   • the result is also a readable artifact on screen — the operator can read
//     the briefing, then Ctrl-P / Save-as-PDF it cleanly;
//   • fonts load from the same self-hosted /fonts.css (no CDN, air-gap-safe).
//
// Content is trusted-sanitized (it is the live brief HTML). Only the small
// dynamic strings we compose (date, filename, model) are escaped, defensively.

import { escapeHtml } from '../core/sanitize.js';
import { executiveSummaryModel } from '../wall/wall-format.js';

// Transient nodes the live brief may carry that have no place in the artifact.
// .brief-judgment-link is in-app Wire navigation — a dead anchor on paper, so strip it.
// .brief-validation-warning (the on-screen banner) is stripped too — it doesn't fit the
// broadsheet's visual language — but its content is NOT dropped: it renders as a
// compact "Generation notes" line into the colophon so a flagged brief never prints as
// a clean, authoritative paper with its known defects silently erased.
const STRIP_SELECTOR = '.streaming-cursor, .brief-validation-warning, .gen-progress, .error-message, .briefing-status, .brief-judgment-link, .bjm-revises';

// The model normally emits one labeled field per paragraph, but Markdown's
// `breaks:true` mode can pack adjacent fields into one <p> separated by <br>s.
// Keep this allowlist narrow so an intentional prose line-break is never turned
// into a new paragraph just because it happens to start with bold text.
const JUDGMENT_FIELD_LABELS = new Set([
  'assessment', 'what happened', 'defender impact', 'relevance',
  'recommended actions', 'the line', 'confidence', 'decision window',
  'revises if', 'increases if', 'decreases if', 'act now',
]);
const PAGINATION_FIELD_LABELS = new Set([
  ...JUDGMENT_FIELD_LABELS,
  'trajectory', 'watch criteria', 'the intersection', 'the cascade', 'the move',
]);
const ATOMIC_FIELD_MAX_CHARS = 720;

function leadingHtmlFieldLabel(html) {
  const match = String(html || '').match(/^\s*<strong\b[^>]*>\s*([^<]+?)\s*<\/strong>\s*:?[\t ]*/i);
  return match ? match[1].trim().replace(/:$/, '').toLowerCase() : '';
}

export function isAssessmentFieldHtml(html) {
  return leadingHtmlFieldLabel(html) === 'assessment';
}

export function stripAssessmentLabelHtml(html) {
  return String(html || '').replace(
    /^\s*<strong\b[^>]*>\s*assessment\s*:?\s*<\/strong>\s*:?\s*/i,
    ''
  );
}

export function shouldKeepFieldParagraphTogether(html, textLength) {
  const length = Number(textLength);
  return PAGINATION_FIELD_LABELS.has(leadingHtmlFieldLabel(html))
    && Number.isFinite(length)
    && length > 0
    && length <= ATOMIC_FIELD_MAX_CHARS;
}

/**
 * Split a Markdown-packed judgment paragraph into field-sized HTML fragments.
 * Unlabelled continuation lines stay attached to the preceding field.
 * Exported for a DOM-free regression test; browser callers use the DOM wrapper
 * below so inline citation markup is preserved exactly.
 */
export function splitPackedJudgmentFieldHtml(html) {
  const source = String(html || '');
  const parts = source.split(/<br\s*\/?>/i);
  if (parts.length < 2) return [source];

  const recognized = parts.filter(part => JUDGMENT_FIELD_LABELS.has(leadingHtmlFieldLabel(part))).length;
  if (recognized < 2) return [source];

  const groups = [];
  for (const part of parts) {
    if (JUDGMENT_FIELD_LABELS.has(leadingHtmlFieldLabel(part)) || groups.length === 0) {
      groups.push(part);
    } else {
      groups[groups.length - 1] += `<br>${part}`;
    }
  }
  return groups.filter(part => part.trim());
}

function normalizePackedJudgmentFields(root) {
  root.querySelectorAll('.brief-judgment-card').forEach(card => {
    [...card.children].filter(el => el.tagName === 'P').forEach(p => {
      const fields = splitPackedJudgmentFieldHtml(p.innerHTML);
      if (fields.length < 2) return;
      for (const html of fields) {
        const field = p.cloneNode(false);
        field.innerHTML = html;
        p.before(field);
      }
      p.remove();
    });
  });
}

// Chromium may still fragment a heading even when break-after:avoid is set.
// Give each non-lead story a small, genuinely atomic opening (headline,
// metadata, and Assessment) while leaving the rest of the card pageable.
function preparePrintPagination(root) {
  root.querySelectorAll('.brief-judgment-card:not(.np-lead)').forEach(card => {
    const children = [...card.children];
    const heading = children.find(el => el.tagName === 'H3');
    if (!heading || heading.closest('.np-judgment-opening')) return;
    const meta = children.find(el => el.classList.contains('brief-judgment-meta'));
    const assessment = children.find(el => el.tagName === 'P' && isAssessmentFieldHtml(el.innerHTML));
    const opening = root.ownerDocument.createElement('div');
    opening.className = 'np-judgment-opening';
    card.insertBefore(opening, heading);
    opening.append(heading);
    if (meta) opening.append(meta);
    if (assessment) opening.append(assessment);
  });

  // Short labeled fields are the natural pagination unit. Keeping these intact
  // prevents a one-line continuation on the next page; the length ceiling lets
  // an unusually long model paragraph flow instead of creating a giant gap.
  root.querySelectorAll('p').forEach(p => {
    if (shouldKeepFieldParagraphTogether(p.innerHTML, p.textContent.trim().length)) {
      p.classList.add('np-field-unit');
    }
  });
}

// CVEs are frequently (but not invariably) emitted as Markdown code. Protect
// plain-text CVE IDs too, so neither a narrow preview nor a PDF can split an
// identifier across lines and change what an operator reads.
function protectUnbreakableTokens(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest('code, .np-nowrap, script, style')) nodes.push(node);
  }
  for (const textNode of nodes) {
    const text = textNode.nodeValue || '';
    const pattern = /CVE-\d{4}-\d{4,7}/gi;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = root.ownerDocument.createDocumentFragment();
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
      const span = root.ownerDocument.createElement('span');
      span.className = 'np-nowrap';
      span.textContent = match[0];
      fragment.append(span);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    textNode.replaceWith(fragment);
  }
}

/**
 * Open a printable newspaper rendering of the currently-displayed brief.
 * @param {HTMLElement} contentEl  the live #briefContent node (post styling)
 * @param {string|null} filename   e.g. "brief-2026-06-29-01.md" (date + name)
 * @param {string}      metaText   the brief meta line (for model provenance)
 * @param {string|null} generatedAt machine-readable generation timestamp, when known
 * @param {number|string|null} readMins app-computed reading time; preferred over recounting the clone
 * @param {string[]}    warnings   persisted validation warnings, if any
 */
export function exportBriefNewspaper({
  contentEl,
  filename = null,
  metaText = '',
  model = '',
  generatedAt = null,
  readMins = null,
  warnings = [],
}) {
  const clone = contentEl.cloneNode(true);
  clone.querySelectorAll(STRIP_SELECTOR).forEach(el => el.remove());

  // Normalize the generated field structure before promoting the lead. Without
  // this pass, a packed Assessment/What happened/Impact paragraph is mistaken
  // for one giant centered standfirst.
  normalizePackedJudgmentFields(clone);

  // Turn the three generated prose bullets into a compact decision brief. The
  // same pure model powers the Wall, so both surfaces agree on owners, actions,
  // and whether one shared due date can be printed once.
  structureExecutiveSummary(clone);

  // The brief opens with `# {pack title}` + a dateline `### {pack subtitle} · DATE · WEEKDAY`.
  // The nameplate is built from those fields, so a non-cyber edition prints its own
  // masthead. A narrow legacy alias brings archived "Blue Team" editions forward to
  // the current BlueTeam.News identity without changing any other pack title.
  const h1 = clone.querySelector('h1');
  const plateTitle = canonicalPlateTitle(h1?.textContent);
  const datelineEl = h1 && h1.nextElementSibling?.tagName === 'H3' ? h1.nextElementSibling : null;
  const datelineText = datelineEl?.textContent || '';
  const plateSubtitle = (datelineText.split('·')[0] || '').trim() || 'Threat Landscape';
  datelineEl?.remove();
  h1?.remove();

  // Lead story — a front page leads with ONE dominant story, not a uniform
  // run of equal judgments. The model already orders signals by operational
  // priority, so promote the first to a spanning hero: a big centred headline +
  // deck (its Assessment), with the rest of the story flowing beneath it.
  promoteLead(clone);
  preparePrintPagination(clone);

  const { longDate, dateSlug } = resolveDate(datelineText, filename);
  const resolvedReadMins = resolveReadMins(readMins, metaText, clone.textContent || '');
  const freshness = formatGeneratedFreshness(generatedAt, metaText, longDate);
  // Model provenance is passed explicitly from state; the meta-line regex is only a
  // defensive fallback for when the caller didn't supply it (it breaks if the string
  // format ever changes).
  const resolvedModel = model || (metaText.match(/claude-[\w.-]+/i) || [])[0] || '';

  protectUnbreakableTokens(clone);

  const html = buildDocument({
    bodyHtml: clone.innerHTML,
    plateTitle,
    plateSubtitle,
    longDate,
    readMins: resolvedReadMins,
    freshness,
    model: resolvedModel,
    warningCount: Array.isArray(warnings) ? warnings.length : 0,
  });

  // Render the broadsheet in an in-app overlay (an isolated, same-origin iframe),
  // NOT a popup window. Popups are routinely blocked, which dropped the export to
  // a raw-HTML download — the failure the operator actually hit. The iframe
  // sandboxes the paper CSS from the app; the controls live OUTSIDE it so the
  // printed page is clean; Print prints the iframe document directly (its own
  // @media print rules apply), reliable in every browser with no popup permission.
  // A true modal dialog (not a div with role=toolbar): aria-modal, a labelled title,
  // focus moved in on open + trapped, and returned to the Export button on close.
  const returnFocusTo = document.activeElement;
  const titleSlug = plateTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'briefing';
  const overlay = document.createElement('div');
  overlay.className = 'np-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'npOvTitle');
  overlay.innerHTML = `
    <div class="np-overlay-bar">
      <span class="np-overlay-title" id="npOvTitle">${escapeHtml(plateTitle)} edition — ${escapeHtml(longDate)}</span>
      <div class="np-overlay-actions">
        <button type="button" class="np-ov-btn np-ov-print primary" aria-label="Print this edition or save it as a PDF" aria-busy="true" disabled>Print / PDF</button>
        <button type="button" class="np-ov-link np-ov-download">Download HTML</button>
        <button type="button" class="np-ov-btn np-ov-close" aria-label="Close export">Close</button>
      </div>
    </div>
    <iframe class="np-frame" title="${escapeHtml(plateTitle)} printable edition"></iframe>`;
  document.body.appendChild(overlay);

  const frame = overlay.querySelector('.np-frame');
  const printBtn = overlay.querySelector('.np-ov-print');

  // Printing before srcdoc and its self-hosted fonts are ready produces a
  // partially styled first page in some browsers. Keep the action unavailable
  // until both the iframe load event and document.fonts.ready have settled.
  const printReady = gatePrintUntilReady(frame, printBtn);
  const doPrint = async () => {
    if (printBtn.disabled) return;
    await printReady;
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch { window.print(); }   // fallback: app @media print hides all but the overlay
  };

  // Export opens a readable preview first. Printing is a separate explicit action:
  // immediately throwing an OS print dialog made the edition feel like a side
  // effect instead of an artifact the reader could inspect.
  frame.srcdoc = html;   // same-origin; /fonts.css and the paper CSS resolve inside it

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') {   // trap Tab within the dialog's own controls
      const f = [...overlay.querySelectorAll('button:not(:disabled)')];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || !overlay.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !overlay.contains(a))) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.np-ov-close').addEventListener('click', close);
  overlay.querySelector('.np-ov-download').addEventListener('click', () => downloadHtml(html, `${titleSlug}-${dateSlug}.html`));
  printBtn.addEventListener('click', doPrint);
  // Print is disabled until the iframe/fonts settle, so focus the first usable
  // control now; the primary action joins the tab order as soon as it is ready.
  overlay.querySelector('.np-ov-download').focus();
}

// ── helpers ──

export async function waitForPrintableFrame(frame) {
  try {
    const d = frame?.contentDocument || frame?.contentWindow?.document;
    if (d?.fonts?.ready) await d.fonts.ready;
  } catch {
    // Access can fail in older/sandboxed browsers. The load event still proves
    // srcdoc is present, so allow the operator to print with fallback fonts.
  }
}

export function gatePrintUntilReady(frame, button, maxWaitMs = 8_000) {
  button.disabled = true;
  button.setAttribute?.('aria-busy', 'true');
  return new Promise(resolve => {
    let settled = false;
    let timeoutId;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      button.disabled = false;
      button.removeAttribute?.('aria-busy');
      resolve();
    };

    // A stalled iframe or font request must not strand the primary export
    // action forever. Prefer the finished fonts, then fall back to the browser's
    // available faces after a bounded wait.
    timeoutId = setTimeout(finish, Math.max(0, Number(maxWaitMs) || 0));
    frame.addEventListener('load', async () => {
      try {
        await waitForPrintableFrame(frame);
      } finally {
        finish();
      }
    }, { once: true });
  });
}

function readingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function resolveReadMins(preferred, metaText, text) {
  const explicit = typeof preferred === 'string'
    ? (preferred.match(/\d{1,3}/) || [])[0]
    : preferred;
  const explicitNumber = Number(explicit);
  if (Number.isFinite(explicitNumber) && explicitNumber > 0) return Math.round(explicitNumber);
  const metaNumber = Number((String(metaText || '').match(/\b(\d{1,3})\s+min(?:ute)?s?\s+read\b/i) || [])[1]);
  if (Number.isFinite(metaNumber) && metaNumber > 0) return Math.round(metaNumber);
  return readingTime(text);
}

function formatGeneratedFreshness(generatedAt, metaText, longDate) {
  const metaLead = String(metaText || '').split('·')[0].trim();
  const source = generatedAt || (/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(metaLead) ? metaLead : '');
  if (source) {
    const generated = source instanceof Date ? source : new Date(source);
    if (!Number.isNaN(generated.getTime())) {
      const time = generated.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
      });
      return `Generated ${time}`;
    }
  }
  return `As of ${longDate}`;
}

function canonicalPlateTitle(value) {
  const title = String(value || '').trim();
  if (/^blue\s*team(?:\.news)?\.?$/i.test(title)) return 'BlueTeam.News';
  return title || 'Briefing';
}

function wordmarkHtml(title) {
  const dot = title.lastIndexOf('.');
  if (dot > 0 && dot < title.length - 1) {
    return `${escapeHtml(title.slice(0, dot))}<span class="np-dot">${escapeHtml(title.slice(dot))}</span>`;
  }
  return escapeHtml(title);
}

function formatModelLabel(model) {
  const raw = String(model || '');
  const m = raw.match(/claude-(sonnet|haiku|opus|fable|mythos)-(\d+)(?:-(\d+))?/i);
  if (!m) return raw;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// Lead story — restructure the first judgment card into a spanning headline
// + deck and a body that flows beneath. The card is a direct child of .np-body,
// so .np-lead can column-span:all cleanly; its head carries the h3 (+ chip), the
// confidence/window byline, and the Assessment as the deck, and its body keeps
// the rest of the story. Pure DOM shuffle of trusted, already-sanitized nodes.
function promoteLead(root) {
  const card = root.querySelector('.brief-judgment-card');
  if (!card) return;
  card.classList.add('np-lead');
  const head = document.createElement('div'); head.className = 'np-lead-head';
  const body = document.createElement('div'); body.className = 'np-lead-body';
  // Assessment is the standfirst. Never fall back to "the first paragraph":
  // older/packed briefs can put several labeled fields there, which centers an
  // entire story and recreates the malformed edition this transform prevents.
  const assessment = [...card.children].find(el =>
    el.tagName === 'P' && isAssessmentFieldHtml(el.innerHTML)
  );
  const children = [...card.children];
  const heading = children.find(el => el.tagName === 'H3');
  const meta = children.find(el => el.classList.contains('brief-judgment-meta'));
  if (heading) head.appendChild(heading);
  if (assessment) {
    assessment.innerHTML = stripAssessmentLabelHtml(assessment.innerHTML);
    assessment.classList.add('np-lead-deck');
    head.appendChild(assessment);
  }
  if (meta) head.appendChild(meta);
  for (const el of children) {
    if (el !== heading && el !== assessment && el !== meta) body.appendChild(el);
  }
  card.replaceChildren(head, body);
}

function structureExecutiveSummary(root) {
  const heading = [...root.querySelectorAll('h2')]
    .find(el => /^\s*EXECUTIVE SUMMARY\b/i.test(el.textContent || ''));
  const list = heading?.nextElementSibling;
  if (!heading || !list || !/^(?:UL|OL)$/.test(list.tagName)) return;

  const items = [...list.children].filter(el => el.tagName === 'LI').map(li => {
    const lead = li.querySelector('strong')?.textContent || '';
    const copy = li.cloneNode(true);
    copy.querySelector('strong')?.remove();
    return { lead, tail: (copy.textContent || '').replace(/^\s*:\s*/, '').trim() };
  });
  const model = executiveSummaryModel(items);
  const facts = [model.threat, model.exposure, ...model.context].filter(Boolean).slice(0, 3);
  if (!facts.length && !model.decisions.length) return;

  heading.textContent = 'EXECUTIVE SUMMARY \u2014 SHIFT DECISIONS';
  const panel = root.ownerDocument.createElement('section');
  panel.className = 'np-exec-panel';

  if (facts.length) {
    const factGrid = root.ownerDocument.createElement('div');
    factGrid.className = 'np-exec-facts';
    facts.forEach((fact, index) => {
      const row = root.ownerDocument.createElement('div');
      row.className = `np-exec-fact${index === 0 ? ' is-primary' : ''}`;
      const eyebrow = root.ownerDocument.createElement('span');
      eyebrow.className = 'np-exec-fact-label';
      eyebrow.textContent = `${String(index + 1).padStart(2, '0')}  ${fact.label}`;
      const text = root.ownerDocument.createElement('p');
      text.textContent = fact.text;
      row.append(eyebrow, text);
      factGrid.appendChild(row);
    });
    panel.appendChild(factGrid);
  }

  if (model.decisions.length) {
    const queue = root.ownerDocument.createElement('div');
    queue.className = 'np-exec-queue';
    const queueHead = root.ownerDocument.createElement('div');
    queueHead.className = 'np-exec-queue-head';
    const queueLabel = root.ownerDocument.createElement('span');
    queueLabel.textContent = 'Decision queue';
    queueHead.appendChild(queueLabel);
    if (model.commonDeadline) {
      const due = root.ownerDocument.createElement('span');
      due.className = 'np-exec-common-due';
      due.textContent = `Due ${model.commonDeadline}`;
      queueHead.appendChild(due);
    }
    queue.appendChild(queueHead);
    const actions = root.ownerDocument.createElement('ol');
    actions.className = 'np-exec-actions';
    model.decisions.slice(0, 4).forEach((decision, index) => {
      const item = root.ownerDocument.createElement('li');
      const number = root.ownerDocument.createElement('span');
      number.className = 'np-exec-action-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const task = root.ownerDocument.createElement('div');
      task.className = 'np-exec-action-task';
      const owner = root.ownerDocument.createElement('strong');
      owner.textContent = decision.owner;
      const action = root.ownerDocument.createElement('p');
      action.textContent = decision.action;
      task.append(owner, action);
      item.append(number, task);
      if (decision.deadline && !model.commonDeadline) {
        const due = root.ownerDocument.createElement('span');
        due.className = 'np-exec-action-due';
        due.textContent = decision.deadline;
        item.appendChild(due);
      }
      actions.appendChild(item);
    });
    queue.appendChild(actions);
    panel.appendChild(queue);
  }

  list.replaceWith(panel);
}

// Long-form date for the folio + a yyyy-mm-dd slug for the download filename.
// Prefer the brief's own dateline (carries the weekday the model wrote); fall
// back to the filename's date; finally to whatever the dateline said verbatim.
function resolveDate(datelineText, filename) {
  const iso = (datelineText.match(/\d{4}-\d{2}-\d{2}/) || [])[0]
    || (filename?.match(/\d{4}-\d{2}-\d{2}/) || [])[0]
    || '';
  if (iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d); // local — no TZ shift on a date-only value
    if (!Number.isNaN(dt.getTime())) {
      return {
        longDate: dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        dateSlug: iso,
      };
    }
  }
  const fallback = datelineText.replace(/^[^·]*·\s*/, '').trim() || 'Threat Landscape Briefing';
  return { longDate: fallback, dateSlug: 'briefing' };
}

function downloadHtml(html, name) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// The whole self-contained broadsheet document. Inline CSS so it prints with
// nothing missing; /fonts.css linked same-origin for the same typefaces the
// app uses (Newsreader serif · JetBrains Mono).
function buildDocument({ bodyHtml, plateTitle, plateSubtitle, longDate, readMins, freshness, model, warningCount = 0 }) {
  const modelNote = model ? ` Model: ${escapeHtml(formatModelLabel(model))}.` : '';
  const validationNote = warningCount > 0
    ? `<span class="np-validation-note"> Generation notes: ${warningCount} automated ${warningCount === 1 ? 'check needs' : 'checks need'} review in the live briefing.</span>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(plateTitle)} edition — ${escapeHtml(longDate)}</title>
<link rel="stylesheet" href="/fonts.css">
<style>
${NEWSPAPER_CSS}
</style>
</head>
<body>
  <div class="paper">
    <div class="np-handling">Internal · For situational awareness · Verify before acting</div>
    <header class="np-masthead">
      <div class="np-plate">
        <div class="np-ear np-ear-left">${escapeHtml(plateSubtitle)}</div>
        <h1 class="np-wordmark">${wordmarkHtml(plateTitle)}</h1>
        <div class="np-ear np-ear-right">${readMins} min read</div>
      </div>
      <div class="np-folio">
        <span class="np-folio-date">${escapeHtml(longDate)}</span>
        <span class="np-folio-end">${escapeHtml(freshness)} · AI-assisted</span>
      </div>
    </header>

    <div class="np-body brief-content">
      ${bodyHtml}
    </div>

    <footer class="np-colophon">
      ${escapeHtml(plateTitle)} · AI-assisted synthesis from sourced signals.${modelNote}
      Verify every CVE ID, vendor name, date, and link before acting.
      ${validationNote}
    </footer>
    <div class="np-handling np-handling-foot">Internal · For situational awareness · Verify before acting</div>
  </div>
</body>
</html>`;
}

// Paper skin. Every visual is defined from scratch (the app's stylesheet is not
// loaded here), reskinning the brief's semantic classes for a warm edition.
export const NEWSPAPER_CSS = `
:root{
  --paper:#f6f3ea; --paper-edge:#e7e1d2; --desk:#d7d2c5;
  --ink:#1a1714; --ink-2:#3a352e; --ink-3:#5e574c; --ink-faint:#6f675a;   /* faint ink darkened to ~5:1 on paper — clears WCAG AA for the 9-10px colophon/byline */
  --rule:#1a1714; --hair:rgba(26,23,20,.18); --hair-2:rgba(26,23,20,.34);
  --accent:#1d4ed8;
  --t1:#b3261e; --t2:#9a5b09; --t3:#553c9a;   /* Tactical · Operational · Strategic — t3 muted from a digital purple toward a printer's indigo */
}
*{box-sizing:border-box;}
html,body{margin:0;}
body{
  background:var(--desk);
  color:var(--ink);
  font-family:'Newsreader',Georgia,'Times New Roman',serif;
  font-optical-sizing:auto;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
  padding:30px 16px 64px;
}

/* The sheet */
.paper{
  max-width:1060px; margin:0 auto; background:var(--paper);
  border:1px solid var(--paper-edge);
  box-shadow:0 10px 44px rgba(0,0,0,.28);
  padding:46px 56px 52px;
}

/* Handling caveat — defense-doc convention: the same banner top and bottom,
   so a loose page is never read as cleared-for-distribution, and the AI-synthesized
   "verify before acting" posture rides on the artifact itself, not just the screen. */
.np-handling{
  margin:0 0 14px; padding:0 0 7px; text-align:center;
  border-bottom:1px solid var(--rule);
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9px; font-weight:700; letter-spacing:.22em; text-transform:uppercase; color:var(--ink-2);
}
.np-handling-foot{ margin:18px 0 0; padding:7px 0 0; border-bottom:none; border-top:1px solid var(--rule); }

/* ── Masthead ── */
.np-masthead{ margin-bottom:22px; }
.np-plate{
  display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:20px;
  border-top:3px solid var(--rule); border-bottom:1px solid var(--rule);
  padding:12px 0 8px;
}
.np-ear{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px; line-height:1.55; letter-spacing:.2em; text-transform:uppercase;
  color:var(--ink-3);
}
.np-ear-left{ text-align:left; } .np-ear-right{ text-align:right; }
.np-wordmark{
  margin:0; font-weight:800; letter-spacing:-.015em; line-height:.92;
  font-size:clamp(38px,7vw,80px); white-space:nowrap; text-align:center;
}
.np-dot{ color:var(--accent); }
.np-folio{
  display:flex; justify-content:space-between; align-items:baseline; gap:14px; flex-wrap:wrap;
  border-top:1px solid var(--rule); border-bottom:3px double var(--rule);
  padding:6px 1px; margin-top:5px;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3);
}
.np-folio-date{ color:var(--ink); font-weight:600; letter-spacing:.1em; }
.np-folio-end{ text-align:right; }

/* ── Body ──
   One readable column at a comfortable measure in both preview and print. This
   is the canonical edition layout, so Save as PDF cannot silently recompose it. */
.np-body{
  max-width:74ch; margin:0 auto;
  font-size:16px; line-height:1.65; text-align:left; hyphens:none;
  -webkit-hyphens:none;
  orphans:2; widows:2;   /* never strand a single line at a column foot/head */
}
.np-body > *{ break-inside:avoid-column; }   /* default; relaxed for tall blocks below */
.np-body p{ margin:0 0 10px; }
.np-body strong{ font-weight:700; color:var(--ink); }
.np-body em{ font-style:italic; }
.np-body a{ color:var(--ink); text-decoration:none; border-bottom:1px solid var(--hair-2); }
.np-body code{
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:.86em;
  background:rgba(26,23,20,.06); padding:1px 4px; border-radius:3px;
  white-space:nowrap; word-break:keep-all; overflow-wrap:normal; hyphens:none;
}
.np-body .np-nowrap{ white-space:nowrap; word-break:keep-all; overflow-wrap:normal; hyphens:none; }
.np-body hr{ display:none; }   /* sections are delimited by banners / story rules */
.np-body ul, .np-body ol{ margin:0 0 11px; padding-left:1.3em; }
.np-body li{ margin:0 0 6px; break-inside:avoid; }

/* Lead (BLUF) — a full-width centred standfirst under the nameplate */
.np-body .bluf{
  column-span:all; margin:2px 0 20px; padding:0 0 18px;
  border-bottom:2px solid var(--rule); text-align:center;
}
.np-body .bluf::before{
  content:'Bottom Line Up Front'; display:block;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10.5px; font-weight:700; letter-spacing:.26em; text-transform:uppercase;
  color:var(--accent); margin-bottom:11px;
}
.np-body .bluf p{
  margin:0 auto; max-width:46ch; text-align:center; hyphens:none;
  font-size:clamp(19px,2.1vw,25px); line-height:1.36; font-weight:500; color:var(--ink);
}

/* Section banners — centred label between rules (h2 carries an id + sometimes
   .brief-exec-heading / .brief-sources-heading; styled uniformly here) */
.np-body h2{
  column-span:all; margin:24px 0 14px; padding:6px 0; text-align:center;
  border-top:1px solid var(--rule); border-bottom:1px solid var(--rule);
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:12px; font-weight:700; letter-spacing:.24em; text-transform:uppercase; color:var(--ink);
  break-after:avoid-page; page-break-after:avoid;   /* a banner never lands alone at the foot of a page */
}
/* Executive Summary restates the BLUF — keep it a quiet sub-banner on paper too, so
   the read flows BLUF → Key Judgments without a redundant equal-weight stop. */
.np-body h2.brief-exec-heading{
  border-top:none; border-bottom:1px solid var(--hair);
  font-size:10.5px; color:var(--ink-3); padding:2px 0 5px; margin-top:16px;
}

/* Executive decision brief — facts establish the situation once, then a clean
   owner queue answers who moves next. Shared deadlines print at queue level. */
.np-exec-panel{ column-span:all; margin:0 0 24px; break-inside:avoid; }
.np-exec-facts{ display:grid; grid-template-columns:1fr 1fr; border-bottom:1px solid var(--rule); }
.np-exec-fact{ padding:12px 14px 13px 0; }
.np-exec-fact + .np-exec-fact{ border-left:1px solid var(--hair); padding-left:14px; }
.np-exec-fact-label,
.np-exec-queue-head,
.np-exec-common-due,
.np-exec-action-index,
.np-exec-action-due{
  font-family:'JetBrains Mono',ui-monospace,monospace; text-transform:uppercase;
  font-size:9px; font-weight:700; letter-spacing:.16em; color:var(--ink-3);
}
.np-exec-fact-label{ display:block; margin-bottom:5px; color:var(--accent); }
.np-exec-fact p{ margin:0; font-size:14px; line-height:1.46; color:var(--ink-2); }
.np-exec-queue{ padding-top:11px; }
.np-exec-queue-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:2px; color:var(--ink); }
.np-exec-common-due{ color:var(--accent); letter-spacing:.1em; }
.np-exec-actions{ list-style:none; margin:0 !important; padding:0 !important; }
.np-exec-actions > li{
  display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:10px; align-items:start;
  margin:0 !important; padding:8px 0; border-top:1px solid var(--hair);
}
.np-exec-action-index{ padding-top:2px; color:var(--accent); }
.np-exec-action-task strong{ display:block; margin-bottom:1px; font-size:13.5px; }
.np-exec-action-task p{ margin:0; font-size:13.5px; line-height:1.4; color:var(--ink-2); }
.np-exec-action-due{ max-width:17ch; padding-top:2px; text-align:right; color:var(--ink-2); letter-spacing:.06em; }

/* Story (Key Judgment / Convergence card) — a clean editorial block separated
   by a horizontal hairline. The tier chip already carries the classification;
   a second solid/dashed/dotted rail was noisy and looked unfinished. */
.np-body .brief-judgment-card{
  break-inside:avoid; margin:0 0 18px; padding:0 0 16px;
  border-top:none; border-bottom:1px solid var(--hair);
}
.np-body .np-judgment-opening{ border-top:1px solid var(--hair); padding:14px 0 0; }
.np-body .brief-judgment-card > h3:first-child,
.np-body .np-judgment-opening > h3:first-child{ margin-top:0; }
.np-body h3{
  font-weight:760; font-size:18.5px; line-height:1.2; margin:18px 0 7px;
  text-align:left; hyphens:none; break-after:avoid;
}

/* ── Lead story ── the page's dominant judgment. Its head is a prominent
   centred block while every field after Assessment returns to left-aligned prose. */
.np-body .brief-judgment-card.np-lead{
  column-span:all; break-inside:auto;
  border-top:none; border-bottom:2px solid var(--rule);
  margin:0 0 24px; padding:0 0 20px;
}
.np-lead-head{ text-align:center; margin:0 0 14px; }
.np-lead-body{ text-align:left; }
.np-lead-head::before{
  content:'Lead Judgment'; display:block;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px; font-weight:700; letter-spacing:.24em; text-transform:uppercase;
  color:var(--accent); margin-bottom:9px;
}
.np-lead-head > h3{
  font-size:clamp(27px,3.4vw,40px); line-height:1.07; margin:0 0 10px;
  text-align:center; hyphens:none; break-after:avoid;
}
.np-lead-head .brief-judgment-meta{ text-align:center; margin:12px 0 0; }
.np-lead-deck{
  max-width:56ch; margin:6px auto 0;
  font-size:18px; line-height:1.45; color:var(--ink-2); text-align:center;
}
.np-lead-deck strong{ color:var(--ink); }
/* Quiet verifier host trailing a rich citation in the appendix. */
.np-body .brief-cite-host{ color:var(--ink-faint); }

/* Tier tag (was the inline .c-chip) */
.np-body .c-chip{
  display:inline-block; vertical-align:2px; margin-right:7px;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9px; font-weight:700; letter-spacing:.14em; text-transform:uppercase;
  padding:1px 5px; border:1px solid currentColor; border-radius:2px;
}
.np-body .c-chip.h1{ color:var(--t1); }
.np-body .c-chip.h2{ color:var(--t2); }
.np-body .c-chip.h3{ color:var(--t3); }

/* Judgment meta — confidence + decision window as a quiet byline line.
   Drop the on-screen gradient gauge; paper carries it as text. */
.np-body .brief-judgment-meta{
  display:block; break-inside:avoid; margin:0 0 9px;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3);
}
.np-body .bjm-confidence::before{ content:none; }
.np-body .bjm-confidence{ margin-right:12px; }
.np-body .bjm-window::before{ content:'· '; }
.np-body .bjm-window[data-edition-date]::after{
  content:' · as of ' attr(data-edition-date); color:var(--ink-faint);
}
/* "The line" — serif pull-quote carried by type, not another left rail. */
.np-body .the-line{
  break-inside:avoid; position:relative; margin:15px 0; padding:6px 0 6px 22px;
  font-style:italic; font-weight:600; font-size:16px; line-height:1.42;
  color:var(--ink); text-align:left; hyphens:none;
}
.np-body .the-line::before{
  content:'“'; position:absolute; left:0; top:0;
  font-style:normal; font-weight:700; font-size:1.5em; line-height:1; color:var(--accent);
}

/* Action directive ("Act now") — the closing climax, set as a compact top-ruled
   note rather than a third left-highlight treatment. */
.np-body .c-action{
  break-inside:avoid; margin:14px 0 4px; padding:9px 0 0;
  border-top:2px solid var(--accent); background:none;
}
.np-body .c-action-label{
  display:block; margin-bottom:4px;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9.5px; font-weight:700; letter-spacing:.18em; text-transform:uppercase; color:var(--accent);
}
.np-body .c-action-text{ font-weight:600; color:var(--ink); }

/* Numbered inline citations + the sources column */
.np-body .brief-cite{
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:.62em;
  vertical-align:super; color:var(--accent); margin-left:1px;
}
.np-body .brief-cite a.brief-cite-link{
  color:var(--accent); border-bottom:none; text-decoration:none; padding:0 1px;
}
.np-body .brief-sources-appendix{
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10.5px; line-height:1.5;
  padding-left:2.2em;
}
.np-body .brief-sources-appendix li{ color:var(--ink-2); }
.np-body .brief-sources-heading + .brief-sources-appendix{ break-before:avoid-page; page-break-before:avoid; }
.np-body .brief-sources-appendix a{ border-bottom:none; overflow-wrap:anywhere; word-break:normal; }

/* Closing-thought blockquote */
.np-body blockquote{
  break-inside:avoid; margin:8px 0; padding:6px 0 6px 16px;
  border-left:2px solid var(--hair-2);
  font-style:italic; font-size:15px; line-height:1.42; color:var(--ink-2);
}

/* Tables (rare, but the contract allows them) */
.np-body table{ width:100%; border-collapse:collapse; margin:10px 0; font-size:12px; }
.np-body th, .np-body td{ text-align:left; padding:5px 8px; border-bottom:1px solid var(--hair); }
.np-body th{
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:9.5px;
  letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3);
}

/* Colophon */
.np-colophon{
  margin-top:26px; padding-top:13px; border-top:3px double var(--rule);
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9.5px; letter-spacing:.06em; line-height:1.8; text-transform:uppercase;
  color:var(--ink-faint); text-align:center;
}
.np-validation-note{ color:var(--t2); font-weight:700; text-transform:none; letter-spacing:.02em; }
/* ── Print ── */
@page{ size:letter portrait; margin:14mm; background:#f6f3ea; }
@media print{
  html,body{ background:var(--paper); }
  body{ padding:0; }
  /* Print is the same warm, single-column edition as the preview. Only the
     simulated desk/sheet chrome is removed; @page supplies recurring margins. */
  .paper{ max-width:none; margin:0; padding:0; border:none; box-shadow:none; background:var(--paper); }
  .no-print{ display:none !important; }
  /* Long stories and the Sources list may cross pages instead of leaving a
     mostly empty predecessor. Keep only local reading units together. */
  .np-body .brief-judgment-card, .np-body .brief-sources-appendix{ break-inside:auto; page-break-inside:auto; }
  .np-body h2, .np-body h3, .np-body .brief-judgment-meta{
    break-after:avoid-page; page-break-after:avoid;
  }
  .np-body h3, .np-body .np-judgment-opening, .np-body p.np-field-unit{
    break-inside:avoid-page; page-break-inside:avoid;
  }
  .np-body h2 + *, .np-body .brief-sources-heading + .brief-sources-appendix{
    break-before:avoid-page; page-break-before:avoid;
  }
  .np-lead-head, .np-body .bluf,
  .np-body .brief-judgment-meta, .np-body .c-action, .np-body .the-line,
  .np-body blockquote, .np-body table, .np-body tr, .np-body li{
    break-inside:avoid-page; page-break-inside:avoid;
  }
  .np-body p{ orphans:4; widows:4; }
  a[href]{ color:var(--ink) !important; border-bottom:none !important; }
}

/* Narrow screens — this artifact is read on screen before it's printed; drop
   the masthead ears (they crowd a phone), stack the plate, and tighten the sheet. */
@media (max-width:760px){
  body{ padding:8px 6px 28px; }
  .paper{ padding:18px 16px 24px; }
  .np-handling{ margin-bottom:9px; padding-bottom:4px; font-size:8px; letter-spacing:.16em; }
  .np-masthead{ margin-bottom:15px; }
  .np-ear{ display:none; }
  .np-plate{ grid-template-columns:1fr; gap:3px; padding:8px 0 5px; }
  .np-folio{ margin-top:3px; padding:4px 1px; font-size:9px; letter-spacing:.08em; }
  .np-wordmark{ font-size:clamp(29px,10vw,47px); }
  .np-body .bluf{ margin-bottom:14px; padding-bottom:12px; }
  .np-body .bluf::before{ margin-bottom:7px; }
  .np-body .bluf p{ font-size:clamp(18px,5.5vw,22px); }
  .np-body h2{ margin:18px 0 11px; }
  .np-exec-facts{ grid-template-columns:1fr; }
  .np-exec-fact + .np-exec-fact{ border-left:0; border-top:1px solid var(--hair); padding-left:0; }
  .np-exec-actions > li{ grid-template-columns:24px minmax(0,1fr); }
  .np-exec-action-due{ grid-column:2; max-width:none; padding-top:0; text-align:left; }
  .np-body .brief-judgment-card.np-lead{ margin-bottom:18px; padding-bottom:15px; }
  .np-lead-head{ margin-bottom:10px; }
  .np-lead-head > h3{ font-size:clamp(22px,6.6vw,31px); }
  .np-lead-deck{ font-size:16.5px; }
}

@media (prefers-reduced-motion: reduce){ *{ animation:none !important; } }
`;

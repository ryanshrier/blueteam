// BlueTeam.News — editorial Print Edition of the saved briefing.
// Clone the already-rendered, DOMPurify-sanitized #briefContent into a separate
// same-origin reading document. The white publication uses the product wordmark,
// serif assessments, sans-serif navigation and metadata, complete action rows,
// and a readable source appendix. The historical export names remain compatible.
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
import { formatEditionIdentity, formatEventTime } from '../core/brief-date.js';
import { structureExecutiveSummary } from './brief-executive.js';
import {
  normalizePackedBriefFields,
  splitPackedBriefFieldHtml,
} from './brief-renderer.js';

// Keep srcdoc same-origin so self-hosted fonts, readiness checks, and the bounded
// iframe print fallback continue to work. allow-modals is required for print();
// citation anchors are app-created HTTP(S) links with rel=noopener, so permit
// their explicit new-tab navigation to escape the non-scripted preview sandbox.
// Deliberately omit allow-scripts so a future sanitizer regression cannot turn
// briefing content into executable code inside the preview.
export const PRINT_IFRAME_SANDBOX = 'allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox';
export const PRINT_DOCUMENT_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "script-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

// Transient nodes the live brief may carry that have no place in the artifact.
// .brief-judgment-link is in-app Wire navigation — a dead anchor on paper, so strip it.
// .brief-validation-warning is rebuilt below as a static Edition notes block,
// including the complete warning text rather than a count-only live-app reference.
const STRIP_SELECTOR = '.streaming-cursor, .brief-validation-warning, .gen-progress, .error-message, .briefing-status, .brief-judgment-tools, .brief-copy-decision, .brief-judgment-link, .bjm-revises, [data-reader-metadata]';

// Field labels eligible for short-block pagination after shared normalization.
const PAGINATION_FIELD_LABELS = new Set([
  'assessment', 'what happened', 'defender impact', 'impact', 'relevance',
  'recommended actions', 'the line', 'confidence', 'likelihood', 'decision window',
  'revises if', 'increases if', 'decreases if', 'act now',
  'trajectory', 'watch criteria', 'the intersection', 'the cascade', 'the move',
]);
// Only genuinely short fields stay atomic. The former 720-character ceiling
// made ten-line evidence paragraphs indivisible and left large holes on paper.
const ATOMIC_FIELD_MAX_CHARS = 280;
const ATOMIC_LIST_MAX_ITEMS = 3;
const ATOMIC_LIST_MAX_CHARS = 640;

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

export function shouldKeepShortListTogether(itemCount, textLength) {
  const count = Number(itemCount);
  const length = Number(textLength);
  return Number.isInteger(count)
    && count > 0
    && count <= ATOMIC_LIST_MAX_ITEMS
    && Number.isFinite(length)
    && length > 0
    && length <= ATOMIC_LIST_MAX_CHARS;
}

// Persisted warnings are the authoritative generation-time audit, but legacy or
// manually edited archive files can acquire a client-derived structural warning
// when rendered. Merge both sources before the live banner is stripped from the
// clone so the Edition cannot print cleaner than the Briefing shown on screen.
export function collectEditionWarnings(contentEl, persisted = []) {
  const values = Array.isArray(persisted) ? [...persisted] : [];
  if (contentEl?.querySelectorAll) {
    contentEl.querySelectorAll('.brief-validation-warning li').forEach(li => {
      values.push(li.textContent || '');
    });
  }

  const warnings = [];
  const seen = new Set();
  for (const value of values) {
    const warning = String(value || '').trim();
    if (!warning || seen.has(warning)) continue;
    seen.add(warning);
    warnings.push(warning);
  }
  return warnings;
}

// Operate only on the export clone. The reader groups corrections in its top
// review disclosure; print keeps that complete audit trail after the
// intelligence and source appendix. Legacy per-section notes work as well.
export function extractPrintReviewNotes(root) {
  return [...root.querySelectorAll('.brief-review-note')].map(note => {
    // The live summary is only a repeated disclosure/count label. Every
    // correction ID, explanation and source link remains in the full content.
    note.querySelector('summary')?.remove();
    const html = note.innerHTML;
    note.remove();
    return `<div class="np-review-correction-group">${html}</div>`;
  }).join('\n');
}

// Keep the former public helper name for compatibility; screen and export now
// use the same section-agnostic normalizer from brief-renderer.js.
export const splitPackedJudgmentFieldHtml = splitPackedBriefFieldHtml;

// Chromium may still fragment a heading even when break-after:avoid is set.
// Give each non-lead story a small, genuinely atomic opening (headline,
// metadata, and Assessment) while leaving the rest of the card pageable.
function preparePrintPagination(root) {
  // The reader puts actions first. On paper the executive heading and its
  // parallel context form one opening, followed by the pageable action queue.
  // A wrapper lets the print engine keep that opening together reliably.
  root.querySelectorAll('.np-exec-panel').forEach(panel => {
    const heading = panel.previousElementSibling;
    const facts = panel.querySelector('.np-exec-facts');
    if (heading?.tagName !== 'H2' || !facts) return;
    const opening = root.ownerDocument.createElement('div');
    opening.className = 'np-exec-opening';
    opening.append(heading, facts);
    panel.prepend(opening);
  });
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

    // Mark a short bold label immediately introducing a list (most often
    // "Recommended actions:") for the bounded grouping pass below.
    const next = p.nextElementSibling;
    const onlyChild = p.children.length === 1 ? p.firstElementChild : null;
    if (
      next?.matches('ul, ol')
      && onlyChild?.tagName === 'STRONG'
      && p.textContent.trim().length <= 80
    ) {
      p.classList.add('np-list-intro');
    }
  });

  // The prompt caps Recommended actions at three bullets. Keep a genuinely
  // short label/list group atomic so neither a heading nor a lone bullet is
  // stranded across a page turn. Unusually long lists remain pageable.
  root.querySelectorAll('p.np-list-intro').forEach(intro => {
    const list = intro.nextElementSibling;
    if (
      !list?.matches('ul, ol')
      || !shouldKeepShortListTogether(list.children.length, list.textContent.trim().length)
    ) return;
    const group = root.ownerDocument.createElement('div');
    group.className = 'np-short-list-group';
    intro.before(group);
    group.append(intro, list);
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
 * @param {HTMLElement} opener     control that opened the edition, if known
 * @returns {Function} idempotent disposer; pass { restoreFocus: false } when navigating away
 */
export function exportBriefNewspaper({
  contentEl,
  filename = null,
  metaText = '',
  model = '',
  generatedAt = null,
  readMins = null,
  warnings = [],
  opener = null,
  review = null,
}) {
  const editionWarnings = collectEditionWarnings(contentEl, warnings);
  const clone = contentEl.cloneNode(true);
  // Extract nested correction groups before removing their reader disclosure.
  const reviewNotesHtml = extractPrintReviewNotes(clone);
  clone.querySelectorAll(STRIP_SELECTOR).forEach(el => el.remove());
  clone.querySelectorAll('[data-review-original], .brief-review-summary, .brief-priority-index').forEach(el => el.remove());
  // Reader disclosures simplify scanning. The print artifact always includes
  // every authored supporting paragraph, independent of disclosure state.
  expandReaderDisclosures(clone);

  // Re-run the shared normalization defensively before promoting the lead.
  // Completed screen briefs already crossed this pass, while legacy/direct
  // export callers may still provide packed fields.
  normalizePackedBriefFields(clone);

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

  const { longDate } = resolveDate(datelineText, filename);
  const resolvedReadMins = resolveReadMins(readMins, metaText, clone.textContent || '');
  const freshness = formatGeneratedFreshness(generatedAt, metaText, longDate);
  // Model provenance is passed explicitly from state; the meta-line regex is only a
  // defensive fallback for when the caller didn't supply it (it breaks if the string
  // format ever changes).
  const resolvedModel = model || (metaText.match(/claude-[\w.-]+/i) || [])[0] || '';

  protectUnbreakableTokens(clone);
  clone.querySelectorAll('.brief-cite').forEach(cite => cite.removeAttribute('data-label-retained'));
  clone.querySelectorAll('.brief-cite-back, .brief-material-unknown').forEach(node => node.remove());
  // Long authored units must be able to cross a page. Short callouts retain the
  // existing keep-together treatment; no text is shortened to fit the paper.
  clone.querySelectorAll('.bluf, .np-lead-head, .c-action, .the-line, .np-exec-actions > li').forEach(el => {
    if ((el.textContent || '').length > 700) el.classList.add('np-flow-long');
  });
  clone.querySelectorAll('.brief-sources-appendix a.source-link').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href) || link.textContent.trim() === href) return;
    const url = clone.ownerDocument.createElement('span');
    url.className = 'np-source-url';
    url.textContent = href;
    link.parentElement.appendChild(url);
  });

  const html = buildDocument({
    bodyHtml: clone.innerHTML,
    plateTitle,
    plateSubtitle,
    longDate,
    readMins: resolvedReadMins,
    freshness,
    model: resolvedModel,
    warnings: editionWarnings,
    filename,
    editionUrl: filename ? `${location.origin}/briefing/${encodeURIComponent(filename)}` : '',
    review,
    reviewNotesHtml,
  });

  // Render the edition in an in-app preview (an isolated, same-origin iframe).
  // The iframe sandboxes the paper CSS from the app; the controls live outside it.
  // An explicit Print/PDF click opens a top-level document synchronously, which is
  // the reliable browser print target. The iframe remains a readable preview and
  // a bounded fallback when popup policy refuses the top-level document.
  // A true modal dialog (not a div with role=toolbar): aria-modal, a labelled title,
  // focus moved in on open + trapped, and returned to the Export button on close.
  // Safari pointer activation does not necessarily focus the clicked button.
  // Prefer the explicit invoking control over the previously focused document.
  const returnFocusTo = opener || document.activeElement;
  const overlay = document.createElement('dialog');
  overlay.className = 'np-overlay';
  // Redundant on browsers with native dialog semantics, but valuable to older
  // fallback implementations and to app code that detects modal ownership via
  // an explicit ARIA contract.
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'npOvTitle');
  overlay.innerHTML = `
    <div class="np-overlay-bar">
       <span class="np-overlay-title" id="npOvTitle">${escapeHtml(plateTitle)} print edition — ${escapeHtml(longDate)}</span>
      <div class="np-overlay-actions">
        <button type="button" class="np-ov-btn np-ov-print primary" aria-label="Print this edition or save it as a PDF" aria-busy="true" disabled>Preparing edition…</button>
        <button type="button" class="np-ov-btn np-ov-close" aria-label="Close print edition">Close</button>
      </div>
       <p class="np-overlay-status" role="status" hidden></p>
       <p class="np-overlay-reading-note">Continuous reading preview. Print / Save PDF shows page breaks and paper options.</p>
    </div>
     <iframe class="np-frame" sandbox="${PRINT_IFRAME_SANDBOX}" title="${escapeHtml(plateTitle)} continuous reading preview"></iframe>`;
  document.body.appendChild(overlay);
  // Native modal semantics make the app behind the preview inert and allow
  // keyboard focus to enter the iframe; the former hand-rolled button-only trap
  // made every citation in the preview unreachable.
  if (typeof overlay.showModal === 'function') overlay.showModal();
  else overlay.setAttribute('open', '');

  const frame = overlay.querySelector('.np-frame');
  const printBtn = overlay.querySelector('.np-ov-print');
  const readiness = new AbortController();
  let active = true;

  // Printing before srcdoc and its self-hosted fonts are ready produces a
  // partially styled first page in some browsers. Keep the action unavailable
  // until both the iframe load event and document.fonts.ready have settled.
  const printReady = gatePrintUntilReady(frame, printBtn, 8_000, readiness.signal);
  const doPrint = async () => {
    if (!active) return;
    // Open the top-level print document synchronously from the click gesture,
    // then wait for its own fonts. This avoids browsers printing a blank iframe
    // or the parent app when frame printing fails.
    const opened = await printTopLevelDocument(html);
    if (opened || !active) return;

    // Popup policies can still refuse a new top-level document. The already
    // loaded preview remains a bounded fallback; never print the parent shell.
    await printReady;
    if (!active) return;
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      const status = overlay.querySelector('.np-overlay-status');
      status.hidden = false;
      status.textContent = 'Printing could not start. Allow pop-ups for this site, then try Print / Save PDF again.';
    }
  };

  // Export opens a readable preview first. Printing is a separate explicit action:
  // immediately throwing an OS print dialog made the edition feel like a side
  // effect instead of an artifact the reader could inspect.
  frame.srcdoc = html;   // same-origin; /fonts.css and the paper CSS resolve inside it

  let unbindPrintShortcut = () => {};
  const close = ({ restoreFocus = true } = {}) => {
    if (!active) return;
    active = false;
    readiness.abort();
    unbindPrintShortcut();
    unbindPrintShortcut = () => {};
    if (overlay.open && typeof overlay.close === 'function') overlay.close();
    overlay.remove();
    if (restoreFocus && returnFocusTo?.isConnected !== false && typeof returnFocusTo?.focus === 'function') {
      returnFocusTo.focus({ preventScroll: true });
    }
  };

  // Ctrl/Cmd+P from the parent dialog must not print the fixed-height iframe
  // shell. Send it through the same top-level document path as the visible
  // Print / Save PDF action. A shortcut pressed inside the iframe remains owned by that
  // document and prints the white Edition directly.
  unbindPrintShortcut = bindEditionPrintShortcut(document, overlay, doPrint);
  overlay.querySelector('.np-ov-close').addEventListener('click', close);
  overlay.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  overlay.addEventListener('close', () => close());
  printBtn.addEventListener('click', doPrint);
  // Print is disabled until the iframe/fonts settle, so focus the usable Close
  // control now; the primary action joins the tab order as soon as it is ready.
  overlay.querySelector('.np-ov-close').focus();
  return close;
}

export function expandReaderDisclosures(root) {
  root.querySelectorAll('.brief-judgment-support, .brief-confidence-detail').forEach(details => {
    details.querySelector(':scope > summary')?.remove();
    details.replaceWith(...details.childNodes);
  });
}

// ── helpers ──

/**
 * Print from a real top-level document created synchronously by the user's
 * Print / Save PDF click. Top-level printing is substantially more reliable than
 * asking a browser to print a sandboxed iframe, especially on Safari.
 * `openWindow` is injectable for the DOM-free unit test.
 */
export async function printTopLevelDocument(html, openWindow = null, maxFontWaitMs = 4_000) {
  let target;
  try {
    const opener = openWindow || (() => window.open('', '_blank'));
    target = opener();
    if (!target?.document) return false;

    target.document.open();
    target.document.write(String(html || ''));
    target.document.close();

    const fontsReady = target.document.fonts?.ready;
    if (fontsReady) {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve();
        };
        const timeoutId = setTimeout(finish, Math.max(0, Number(maxFontWaitMs) || 0));
        Promise.resolve(fontsReady).then(finish, finish);
      });
    }
    target.focus?.();
    if (typeof target.print !== 'function') {
      target.close?.();
      return false;
    }
    target.addEventListener?.('afterprint', () => target.close?.(), { once: true });
    target.print();
    return true;
  } catch {
    try { target?.close?.(); } catch { /* non-critical cleanup */ }
    return false;
  }
}

export async function waitForPrintableFrame(frame) {
  try {
    const d = frame?.contentDocument || frame?.contentWindow?.document;
    if (d?.fonts?.ready) await d.fonts.ready;
  } catch {
    // Access can fail in older/sandboxed browsers. The load event still proves
    // srcdoc is present, so allow the operator to print with fallback fonts.
  }
}

export function gatePrintUntilReady(frame, button, maxWaitMs = 8_000, signal = null) {
  button.disabled = true;
  button.textContent = 'Preparing edition…';
  button.setAttribute?.('aria-busy', 'true');
  return new Promise(resolve => {
    let settled = false;
    let timeoutId;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      frame.removeEventListener?.('load', onLoad);
      signal?.removeEventListener('abort', onAbort);
      if (!cancelled) {
        button.disabled = false;
        button.textContent = 'Print / Save PDF';
        button.removeAttribute?.('aria-busy');
      }
      resolve();
    };
    const onAbort = () => finish(true);
    const onLoad = async () => {
      try {
        await waitForPrintableFrame(frame);
      } finally {
        finish();
      }
    };
    if (signal?.aborted) { finish(true); return; }

    // A stalled iframe or font request must not strand the primary export
    // action forever. Prefer the finished fonts, then fall back to the browser's
    // available faces after a bounded wait.
    timeoutId = setTimeout(finish, Math.max(0, Number(maxWaitMs) || 0));
    frame.addEventListener('load', onLoad, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Route the browser's ordinary Print shortcut through the Edition's reliable
 * top-level print path while its dialog is open. Closing the dialog removes the
 * listener and restores normal parent-document printing.
 */
export function bindEditionPrintShortcut(doc, dialog, printEdition) {
  if (!doc?.addEventListener || !dialog || typeof printEdition !== 'function') {
    return () => {};
  }

  const onKeydown = event => {
    const printChord = (event?.ctrlKey || event?.metaKey)
      && !event?.altKey
      && !event?.shiftKey
      && String(event?.key || '').toLowerCase() === 'p';
    if (!dialog.open || event?.defaultPrevented || !printChord) return;
    event.preventDefault?.();
    if (event?.repeat) return;
    void printEdition();
  };

  doc.addEventListener('keydown', onKeydown);
  return () => doc.removeEventListener?.('keydown', onKeydown);
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

export function formatGeneratedFreshness(generatedAt, metaText, longDate) {
  const metaLead = String(metaText || '').split('·')[0].trim();
  const source = generatedAt || (/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(metaLead) ? metaLead : '');
  if (source) {
    const generated = source instanceof Date ? source : new Date(source);
    if (!Number.isNaN(generated.getTime())) {
      const time = generated.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'UTC',
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
  // Classification and confidence are a byline for the judgment, so they must
  // precede the Assessment deck rather than appearing as an afterthought below it.
  if (meta) head.appendChild(meta);
  if (assessment) {
    assessment.innerHTML = stripAssessmentLabelHtml(assessment.innerHTML);
    assessment.classList.add('np-lead-deck');
    head.appendChild(assessment);
  }
  for (const el of children) {
    if (el !== heading && el !== assessment && el !== meta) body.appendChild(el);
  }
  card.replaceChildren(head, body);
}

// Long-form date for the folio.
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
      };
    }
  }
  const fallback = datelineText.replace(/^[^·]*·\s*/, '').trim() || 'Threat Landscape Briefing';
  return { longDate: fallback };
}

// The standalone same-origin print document. Presentation CSS is inline;
// /fonts.css supplies the same self-hosted faces as the app.
export function buildDocument({
  bodyHtml,
  plateTitle,
  plateSubtitle,
  longDate,
  readMins,
  freshness,
  model,
  warnings = [],
  warningCount = 0,
  filename = null,
  editionUrl = '',
  review = null,
  reviewNotesHtml = '',
}) {
  const identity = formatEditionIdentity(filename) || longDate;
  let safeEditionUrl = '';
  try { const url = new URL(editionUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) safeEditionUrl = url.href; } catch { /* unsaved edition */ }
  const modelNote = model ? ` Model: ${escapeHtml(formatModelLabel(model))}.` : '';
  const safeWarnings = Array.isArray(warnings)
    ? warnings.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const resolvedWarningCount = safeWarnings.length || Math.max(0, Number(warningCount) || 0);
  const corrected = review?.status === 'editorially-corrected';
  const validationBlock = safeWarnings.length
    ? `<aside class="np-validation" id="npPublicationNotes" aria-labelledby="npValidationTitle">
        <strong id="npValidationTitle">Original publication notes${corrected ? ' (before later correction)' : ' — review before distribution'}</strong>
        <p>These records describe the original publication. Notes prefixed QA review are later editorial annotations; their original author/time were not recorded.${corrected ? ' They precede the correction shown in this reading copy and are preserved as history.' : ''}</p>
        <ul>${safeWarnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
      </aside>`
    : '';
  const validationNote = resolvedWarningCount > 0
    ? `<span class="np-validation-note"> Original publication notes: ${resolvedWarningCount} ${resolvedWarningCount === 1 ? 'note' : 'notes'} retained${safeWarnings.length ? ' in the appendix' : ' in the live briefing'}.</span>`
    : '';
  const provenance = corrected || resolvedWarningCount > 0
    ? `<p class="np-reading-provenance">${corrected ? `Editorially corrected · Reviewed ${escapeHtml(formatEventTime(review.reviewedAt))} · <a href="#npEditorialReview">Review provenance</a>` : 'Publication notes require review before distribution'}${resolvedWarningCount > 0 ? ` · ${resolvedWarningCount} original publication ${resolvedWarningCount === 1 ? 'note' : 'notes'}${safeWarnings.length ? ' · <a href="#npPublicationNotes">Notes at end</a>' : ' in live briefing'}` : ''}</p>`
    : '';
  const reviewBlock = corrected
    ? `<aside class="np-validation" id="npEditorialReview"><strong>Editorial review provenance</strong><p>${escapeHtml(review.reviewer)} · ${escapeHtml(formatEventTime(review.reviewedAt))}. ${escapeHtml(review.scope)}</p>${review.originalSha256 ? `<p>Original edition SHA-256: <code>${escapeHtml(review.originalSha256)}</code></p>` : ''}</aside>`
    : '';
  const correctionBlock = reviewNotesHtml
    ? `<aside class="np-validation np-editorial-corrections" id="npEditorialCorrections" aria-labelledby="npEditorialCorrectionsTitle" style="break-inside:auto;page-break-inside:auto"><strong id="npEditorialCorrectionsTitle">Editorial corrections appendix</strong><p>Complete correction notes for this reading copy. The original generated edition and its captured inputs are preserved; these annotations are separate from its original source checks.</p>${reviewNotesHtml}</aside>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${PRINT_DOCUMENT_CSP}">
<title>${escapeHtml(plateTitle)} print edition — ${escapeHtml(identity)}</title>
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
        <span class="np-folio-date">${escapeHtml(identity)}</span>
        <span class="np-folio-end">${escapeHtml(freshness)} · AI-generated</span>
      </div>
    </header>

    ${provenance}

    <div class="np-body brief-content">
      ${bodyHtml}
    </div>

    ${validationBlock}
    ${reviewBlock}
    ${correctionBlock}

    <footer class="np-colophon">
      ${escapeHtml(plateTitle)} · AI-generated synthesis from sourced signals.${modelNote}
      Verify every CVE ID, vendor name, date, and link before acting.
      ${validationNote}
      ${safeEditionUrl ? `<p>Permanent edition: <a href="${escapeHtml(safeEditionUrl)}">${escapeHtml(identity)}</a><br>${escapeHtml(safeEditionUrl)} · ${escapeHtml(freshness)}</p>` : ''}
    </footer>
    <div class="np-handling np-handling-foot">Internal · For situational awareness · Verify before acting</div>
  </div>
</body>
</html>`;
}

// Paper skin. Every visual is defined from scratch (the app's stylesheet is not
// loaded here), reskinning the brief's semantic classes for a white edition.
export const NEWSPAPER_CSS = `
:root{
  --paper:#fff; --paper-edge:#d4d6d8; --desk:#e7e8e8;
  --ink:#222428; --ink-2:#353940; --ink-3:#555b63; --ink-faint:#60666e;
  --rule:#222428; --hair:#d4d6d8; --hair-2:#969ba2;
  --accent:#1d4ed8; --t1:#555b63; --t2:#555b63; --t3:#555b63;
  --sans:Inter,Arial,sans-serif;
  --serif:Newsreader,Georgia,'Times New Roman',serif;
  --mono:'JetBrains Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;}
body{
  background:var(--desk); color:var(--ink); font-family:var(--serif);
  font-optical-sizing:auto; -webkit-print-color-adjust:economy; print-color-adjust:economy;
  padding:32px 20px 64px;
}
.paper{
  max-width:960px; margin:0 auto; background:var(--paper);
  border:1px solid var(--paper-edge); box-shadow:0 4px 24px rgba(20,24,28,.1);
  padding:36px 52px 44px;
}
/* A quiet handling line, followed by the product identity and publication title. */
.np-handling{ margin:0 0 20px; font:10px/1.5 var(--sans); color:var(--ink-3); }
.np-handling-foot{ margin:16px 0 0; }
.np-masthead{ margin-bottom:24px; }
.np-plate{ display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:14px 24px; padding:0 0 16px; }
.np-wordmark{ grid-row:1; grid-column:1; margin:0; font:750 17px/1.2 var(--sans); letter-spacing:.055em; text-transform:uppercase; overflow-wrap:anywhere; }
.np-dot{ color:var(--ink); }
.np-ear-left{ grid-row:2; grid-column:1 / -1; font:550 32px/1.15 var(--serif); letter-spacing:-.02em; color:var(--ink); }
.np-ear-right{ grid-row:1; grid-column:2; font:12px/1.5 var(--sans); color:var(--ink-3); text-align:right; white-space:nowrap; }
.np-folio{ display:flex; justify-content:space-between; align-items:baseline; gap:6px 24px; flex-wrap:wrap; border-top:2px solid var(--rule); padding-top:9px; font:12px/1.5 var(--sans); color:var(--ink-3); }
.np-folio-date{ color:var(--ink); font-weight:600; }
.np-folio-end{ text-align:right; }
.np-reading-provenance{ font:12px/1.55 var(--sans); color:var(--ink-3); margin:0 0 20px; padding-left:12px; border-left:2px solid var(--hair-2); }
.np-reading-provenance a{ color:var(--accent); text-underline-offset:3px; }
/* Appendix is ordinary reading, with technical identifiers in monospace. */
.np-validation{ margin:24px 0; padding:14px 0 0; border-top:1px solid var(--hair-2); break-inside:avoid-page; font:13px/1.6 var(--sans); color:var(--ink-2); }
.np-validation > strong{ display:block; margin-bottom:8px; font-size:14px; font-weight:650; color:var(--ink); }
.np-validation ul{ margin:8px 0; padding-left:1.35em; }
.np-validation li{ margin:5px 0; }
.np-validation, .np-validation code{ min-width:0; overflow-wrap:anywhere; word-break:normal; white-space:normal; }
.np-validation code{ font:11px/1.65 var(--mono); }
.np-review-correction-group{ padding-top:8px; }
.np-body{ max-width:72ch; margin:0 auto; font-size:17px; line-height:1.55; text-align:left; hyphens:none; -webkit-hyphens:none; orphans:2; widows:2; }
.np-body p{ margin:0 0 11px; }
.np-body strong{ font-weight:650; color:var(--ink); }
.np-body em{ font-style:italic; }
.np-body a{ color:var(--ink); text-decoration:underline; text-decoration-color:var(--hair-2); text-underline-offset:3px; }
.np-body code{ font-family:var(--mono); font-size:.86em; white-space:normal; word-break:normal; overflow-wrap:anywhere; hyphens:none; }
.np-body .np-nowrap{ display:inline-block; max-width:100%; vertical-align:baseline; white-space:normal; word-break:normal; overflow-wrap:anywhere; hyphens:none; }
.np-body hr{ display:none; }
.np-body ul, .np-body ol{ margin:0 0 12px; padding-left:1.3em; }
.np-body li{ margin:0 0 6px; }
/* An opening assessment has presence without filling the whole first page. */
.np-body .bluf{ margin:0 0 24px; padding:0 0 20px; border-bottom:1px solid var(--hair); text-align:left; }
.np-body .bluf::before{ content:'Bottom line up front'; display:block; font:650 12px/1.4 var(--sans); color:var(--ink-3); margin-bottom:10px; }
.np-body .bluf p{ margin:0; max-width:none; text-align:left; font-size:23px; line-height:1.4; font-weight:450; color:var(--ink); }
.np-body .bluf.np-flow-long p{ font-size:19px; line-height:1.5; }
.np-body h2{ margin:28px 0 15px; padding:10px 0 0; text-align:left; border-top:1px solid var(--hair-2); font:650 13px/1.45 var(--sans); letter-spacing:.04em; color:var(--ink); break-after:avoid-page; page-break-after:avoid; }
.np-body h2.brief-exec-heading{ margin-top:20px; border-top:0; padding-top:0; }
/* Complete context and an owner/action queue; only compact units stay atomic. */
.np-exec-panel{ margin:0 0 24px; break-inside:auto; }
.np-exec-facts{ display:grid; grid-template-columns:1fr 1fr; gap:20px; padding-bottom:16px; border-bottom:1px solid var(--hair); }
.np-exec-fact{ min-width:0; }
.np-exec-fact:last-child:nth-child(odd){ grid-column:1 / -1; }
.np-exec-fact-label{ display:block; margin-bottom:5px; font:650 12px/1.45 var(--sans); color:var(--ink-3); }
.np-exec-fact p{ margin:0; font-size:15px; line-height:1.5; color:var(--ink-2); }
.np-exec-queue{ padding-top:12px; }
.np-exec-queue-head{ display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px 20px; margin-bottom:4px; font:650 12px/1.5 var(--sans); color:var(--ink); }
.np-exec-common-due{ color:var(--ink-3); font-weight:400; }
.np-exec-actions{ list-style:none; margin:0 !important; padding:0 !important; }
.np-exec-actions > li{ display:grid; grid-template-columns:24px minmax(0,1fr) minmax(112px,22%); gap:12px; align-items:start; margin:0 !important; padding:12px 0; border-top:1px solid var(--hair); }
.np-exec-action-index{ font:12px/1.5 var(--mono); color:var(--ink-3); padding-top:2px; }
.np-exec-action-task{ min-width:0; }
.np-exec-action-task strong{ display:block; margin-bottom:4px; font:650 15px/1.4 var(--sans); }
.np-exec-action-task p{ margin:0; font-size:16px; line-height:1.45; color:var(--ink-2); }
.np-exec-owner{ display:block; margin-top:6px; font:12px/1.5 var(--sans); color:var(--ink-3); }
.np-exec-action-due{ font:12px/1.5 var(--sans); color:var(--ink-2); }
.np-exec-due-label{ display:block; color:var(--ink-3); font-size:11px; margin-bottom:3px; }
.np-exec-action-task:last-child{ grid-column:2 / -1; }
.np-body .brief-judgment-card{ margin:0 0 20px; padding:0 0 16px; border-bottom:1px solid var(--hair); }
.np-body .np-judgment-opening{ border-top:0; padding:4px 0 0; }
.np-body .brief-judgment-card > h3:first-child, .np-body .np-judgment-opening > h3:first-child{ margin-top:0; }
.np-body h3{ font:650 21px/1.25 var(--sans); margin:20px 0 9px; text-align:left; hyphens:none; break-after:avoid; }
.np-body .brief-judgment-card.np-lead{ break-inside:auto; margin:0 0 24px; padding:0 0 20px; }
.np-lead-head{ text-align:left; margin:0 0 16px; }
.np-lead-body{ text-align:left; }
.np-lead-head > h3{ font:550 30px/1.15 var(--serif); letter-spacing:-.015em; margin:0 0 12px; text-align:left; break-after:avoid; }
.np-lead-head .brief-judgment-meta{ margin:0 0 12px; }
.np-body .np-lead-deck{ max-width:66ch; margin:0; font-size:19px; line-height:1.5; color:var(--ink-2); text-align:left; }
/* Tiers are classifications, so the label carries their identity. */
.np-body .c-chip{ display:inline-block; margin-right:10px; font:650 11px/1.5 var(--sans); color:var(--ink-3); text-transform:uppercase; letter-spacing:.03em; }
.np-body .brief-judgment-meta{ display:block; break-inside:avoid; margin:0 0 12px; font:12px/1.55 var(--sans); color:var(--ink-3); }
.np-body .bjm-confidence::before{ content:none; }
.np-body .bjm-confidence{ margin-right:12px; }
.np-body .bjm-window::before{ content:'· '; }
.np-body .bjm-window-label{ font-weight:600; }
.np-body .bjm-window-label::after{ content:' · '; }
.np-body .bjm-window[data-edition-date]::after{ content:' · as of ' attr(data-edition-date); color:var(--ink-faint); }
.np-body .the-line{ break-inside:avoid; margin:16px 0; padding:0; font-style:italic; font-weight:500; font-size:17px; line-height:1.5; color:var(--ink); text-align:left; }
.np-body .the-line::before{ content:none; }
.np-body .c-action{ display:block; break-inside:avoid; margin:18px 0 14px; padding:0 0 0 14px; border-left:2px solid var(--rule); background:none; }
.np-body .c-action-label{ display:block; margin-bottom:6px; font:650 12px/1.5 var(--sans); color:var(--ink); }
.np-body .c-action-text{ display:block; width:100%; font-weight:500; color:var(--ink); }
.np-body .brief-action-target{ display:block; margin-top:6px; font:12px/1.5 var(--sans); color:var(--ink-3); }
.np-body .c-action-text .brief-action-owner{ display:block; margin-bottom:4px; font:650 13px/1.5 var(--sans); }
.np-body .brief-cite{ font-family:var(--mono); font-size:.72em; vertical-align:super; color:var(--accent); margin-left:1px; }
.np-body .brief-cite a.brief-cite-link{ color:var(--accent); border-bottom:none; text-decoration:none; padding:0 1px; }
.np-body .brief-cite-host{ color:var(--ink-faint); }
.np-body .brief-cite[data-label-retained="true"]{ display:none; }
.np-body .brief-source-detail{ display:block; font:12px/1.5 var(--sans); color:var(--ink-3); margin:4px 0 10px; }
.np-body .brief-sources-appendix{ font:13px/1.6 var(--sans); padding-left:2em; }
.np-body .brief-sources-appendix li{ color:var(--ink-2); padding:5px 0; }
.np-body .brief-sources-heading + .brief-sources-appendix{ break-before:avoid-page; page-break-before:avoid; }
.np-body .brief-sources-appendix a{ border-bottom:none; overflow-wrap:anywhere; word-break:normal; }
.np-source-url{ display:block; overflow-wrap:anywhere; color:var(--ink-3); font:11px/1.55 var(--mono); margin:4px 0 8px; }
.np-body blockquote{ break-inside:avoid; margin:12px 0; padding:0 0 0 14px; border-left:2px solid var(--hair-2); font-style:italic; font-size:16px; line-height:1.5; color:var(--ink-2); }
.np-body table{ width:100%; table-layout:fixed; border-collapse:collapse; margin:12px 0; font:13px/1.5 var(--sans); }
.np-body th, .np-body td{ text-align:left; padding:7px 8px; border-bottom:1px solid var(--hair); overflow-wrap:anywhere; }
.np-body th{ font-size:11px; font-weight:600; color:var(--ink-3); }
.np-colophon{ margin-top:28px; padding-top:14px; border-top:1px solid var(--hair-2); font:12px/1.65 var(--sans); color:var(--ink-3); overflow-wrap:anywhere; text-align:left; }
.np-colophon p{ margin:8px 0; }
.np-colophon a{ color:var(--ink); text-underline-offset:3px; }
.np-validation-note{ font-weight:600; }
/* The page margin carries small running folios. Content provides a fallback
   for engines that do not support CSS margin boxes. */
@page{
  size:auto;
  margin:14mm;
  @bottom-left{ content:'BlueTeam.News · Print edition'; font-family:Inter,Arial,sans-serif; font-size:8pt; color:#555b63; }
  @bottom-right{ content:'Page ' counter(page) ' of ' counter(pages); font-family:Inter,Arial,sans-serif; font-size:8pt; color:#555b63; }
}
@media print{
  html,body{ background:#fff; }
  body{ padding:0; }
  .paper{ max-width:none; margin:0; padding:0; border:none; box-shadow:none; background:#fff; }
  .np-body{ max-width:none; font-size:11pt; line-height:1.5; orphans:2; widows:2; }
  .np-wordmark{ font-size:12pt; }
  .np-ear-left{ font-size:24pt; }
  .np-ear-right, .np-folio{ font-size:9pt; }
  .np-handling{ font-size:8pt; margin-bottom:14px; }
  .np-masthead{ margin-bottom:18px; }
  .np-body .bluf p{ font-size:15pt; line-height:1.4; }
  .np-body .bluf.np-flow-long p{ font-size:12pt; line-height:1.5; }
  .np-body h2{ font-size:10pt; }
  .np-body h3{ font-size:14pt; }
  .np-lead-head > h3{ font-size:21pt; }
  .np-body .np-lead-deck{ font-size:12pt; }
  .np-body .brief-sources-appendix{ font-size:9.5pt; }
  .np-colophon, .np-reading-provenance{ font-size:9pt; }
  .np-validation{ font-size:9.5pt; }
  .np-validation > strong{ font-size:10pt; }
  .np-exec-queue-head{ break-after:avoid-page; page-break-after:avoid; }
  .np-exec-actions{ break-before:avoid-page; page-break-before:avoid; }
  /* Block flow keeps a complete action and its owner together reliably when
     Chromium paginates a list; the screen grid remains unchanged. */
  .np-exec-actions > li{ display:block; position:relative; padding-left:32px; padding-right:152px; }
  .np-exec-action-index{ position:absolute; left:0; top:12px; }
  .np-exec-action-due{ position:absolute; right:0; top:12px; width:132px; }
  .np-exec-owner{ break-before:avoid-page; page-break-before:avoid; }
  .no-print{ display:none !important; }
  .np-body .brief-judgment-card, .np-body .brief-sources-appendix, .np-body li{ break-inside:auto; page-break-inside:auto; }
  .np-body .brief-sources-appendix li{ break-inside:avoid-page; page-break-inside:avoid; }
  .np-body .the-line, .np-colophon, .np-handling-foot{ break-before:avoid-page; page-break-before:avoid; }
  .np-colophon{ break-inside:avoid-page; page-break-inside:avoid; }
  .np-body h2, .np-body h3, .np-body .brief-judgment-meta{ break-after:avoid-page; page-break-after:avoid; }
  .np-body h3, .np-body .np-judgment-opening, .np-body p.np-field-unit{
    break-inside:avoid-page; page-break-inside:avoid;
  }
  .np-body p.np-list-intro{ break-after:avoid-page; page-break-after:avoid; }
  .np-body p.np-list-intro + ul, .np-body p.np-list-intro + ol{ break-before:avoid-page; page-break-before:avoid; }
  .np-body .np-short-list-group{ break-inside:avoid-page; page-break-inside:avoid; }
  .np-body h2 + *, .np-body .brief-sources-heading + .brief-sources-appendix{ break-before:avoid-page; page-break-before:avoid; }
  .np-lead-head, .np-body .bluf, .np-exec-facts, .np-body .brief-judgment-meta,
  .np-body .c-action, .np-body .the-line, .np-body blockquote, .np-body tr, .np-exec-actions > li{ break-inside:avoid-page; page-break-inside:avoid; }
  .np-body p{ orphans:2; widows:2; }
  .np-body .np-flow-long{ break-inside:auto; page-break-inside:auto; }
  .np-body .np-exec-opening, .np-body .np-exec-facts{ break-inside:avoid-page; page-break-inside:avoid; }
  .np-body .brief-exec-heading{ break-after:avoid-page; page-break-after:avoid; }
  a[href]{ color:var(--ink) !important; border-bottom:none !important; }
}
/* Preview keeps the publication title and metadata available on phones. */
@media screen and (max-width:760px){
  body{ padding:8px 6px 24px; }
  .paper{ padding:20px 18px 28px; }
  .np-handling{ font-size:10px; margin-bottom:16px; }
  .np-masthead{ margin-bottom:20px; }
  .np-plate{ gap:12px; }
  .np-wordmark{ font-size:14px; }
  .np-ear-right{ font-size:11px; }
  .np-ear-left{ font-size:26px; }
  .np-folio{ font-size:11px; }
  .np-folio-end{ text-align:left; }
  .np-body{ font-size:17px; }
  .np-body .bluf p{ font-size:21px; }
  .np-body .bluf.np-flow-long p{ font-size:18px; }
  .np-exec-facts{ grid-template-columns:1fr; gap:14px; }
  .np-exec-actions > li{ grid-template-columns:22px minmax(0,1fr); }
  .np-exec-action-due{ grid-column:2; padding-top:0; }
  .np-body h2{ margin-top:22px; }
  .np-body h3{ font-size:20px; }
  .np-lead-head > h3{ font-size:27px; }
  .np-body .np-lead-deck{ font-size:18px; }
}
@media (prefers-reduced-motion: reduce){ *{ animation:none !important; } }
`;

// BlueTeam.News — semantic post-processing for rendered briefing HTML.
// Transforms the model's markdown structure into styled components:
// BLUF card, horizon tags, "the line" callouts, section anchors.

// Briefing chips are decision verbs, not the shared Wire taxonomy. The numeric
// h1/h2/h3 classes and source `[Horizon n]` tokens remain unchanged underneath,
// so filters, scoring, and archived markdown keep their existing contract.
const BRIEF_TIER_LABELS = Object.freeze({
  1: 'ACT NOW',
  2: 'PREPARE',
  3: 'MONITOR',
});

function parseFieldSegment(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const strong = tmp.querySelector('strong');
  if (!strong) return null;
  const label = strong.textContent.trim().replace(/:$/, '').toLowerCase();
  const value = tmp.textContent.replace(/^[^:]*:\s*/, '').trim();
  return { label, value };
}

// Split a block into "**Label:** value" segments. Handles both a single-field block
// and a <br>-packed multi-field block (markdown breaks:true with no blank line).
function fieldSegments(el) {
  if (!el || !el.innerHTML) return [];
  return el.innerHTML.split(/<br\s*\/?>/i).map(parseFieldSegment).filter(Boolean);
}

// Remove only selected labeled lines while preserving every other line in a packed
// paragraph. This keeps legacy editions readable without exposing prompt scaffolding.
function stripLabeledSegments(el, labels) {
  if (!el || !el.innerHTML) return;
  const parts = el.innerHTML.split(/<br\s*\/?>/i);
  const kept = parts.filter(html => {
    const field = parseFieldSegment(html);
    return !field || !labels.includes(field.label);
  });
  if (kept.length === parts.length) return;
  const probe = document.createElement('div');
  probe.innerHTML = kept.join('<br>');
  if (!probe.textContent.trim()) el.remove();
  else el.innerHTML = kept.join('<br>');
}

const THE_LINE_PREFIX = /^\s*<strong\b[^>]*>\s*the line\s*:?\s*<\/strong>\s*:?\s*/i;

/** Partition a possibly <br>-packed block without requiring a DOM. Exported so
 * the malformed-list regression can run in the project's Node test environment. */
export function partitionTheLineHtml(html) {
  const line = [];
  const kept = [];
  for (const part of String(html || '').split(/<br\s*\/?>/i)) {
    if (THE_LINE_PREFIX.test(part)) line.push(part.replace(THE_LINE_PREFIX, '').trim());
    else kept.push(part);
  }
  return {
    keptHtml: kept.join('<br>'),
    lineHtml: line.filter(Boolean).join('<br>'),
  };
}

// Lift a labeled field without discarding its neighbours. In malformed/legacy
// Markdown, "The line" may be a <br>-packed segment inside a paragraph or list
// item; replacing the whole host either loses adjacent content or leaves the
// pull quote visually trapped beneath a bullet marker.
function liftTheLine(el) {
  if (!el?.innerHTML) return;
  const { keptHtml, lineHtml } = partitionTheLineHtml(el.innerHTML);
  if (!lineHtml) return;

  const div = document.createElement('div');
  div.className = 'the-line';
  div.innerHTML = lineHtml;
  if (!div.textContent.trim()) return;

  const listItem = el.closest('li');
  const list = listItem?.closest('ul, ol');
  const probe = document.createElement('div');
  probe.innerHTML = keptHtml;
  const keepHost = !!probe.textContent.trim();

  if (list) {
    if (keepHost) {
      el.innerHTML = keptHtml;
    } else if (el === listItem) {
      listItem.remove();
    } else {
      el.remove();
      if (!listItem.textContent.trim()) listItem.remove();
    }
    // Keep valid list structure: a callout cannot be a direct child of ul/ol.
    if (list.querySelector('li')) list.after(div);
    else list.replaceWith(div);
  } else if (keepHost) {
    el.innerHTML = keptHtml;
    el.after(div);
  } else {
    el.replaceWith(div);
  }
}

// Metadata rationale is conventionally separated with a top-level em/en dash.
// Do not split on a dash inside parentheses: a decision such as
// "Monitor (chronic exposure — upgrades required)" is one complete label.
function metadataSummary(value) {
  const text = String(value || '').trim();
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '—' || ch === '–') && /\s/.test(text[i - 1] || '') && /\s/.test(text[i + 1] || '')) {
      return text.slice(0, i).trim();
    }
  }
  return text;
}

function editionDate(container) {
  const mastheadText = [...container.querySelectorAll('h1, h3')]
    .slice(0, 2)
    .map(el => el.textContent || '')
    .join(' ');
  return (mastheadText.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0] || '';
}

function isRelativeWindow(value) {
  return /\b(?:this shift|this week|this month|this weekend|today|tonight|tomorrow|before monday|end of (?:day|week|month))\b/i.test(value || '');
}

function normalizeDeadline(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:]+$/g, '')
    .trim();
}

/** Return the deadline-like final field from an Owner — imperative — deadline
 * action. Requiring a spaced dash keeps dates mentioned inside the imperative
 * from being mistaken for the action's actual target. */
export function actionDeadlineSuffix(value) {
  const parts = String(value || '').split(/\s+[\u2013\u2014]\s+/).map(part => part.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 1] : '';
}

/** Presentation-only duplicate check. The Markdown keeps Decision window for
 * the Wall/schema; Briefing and Edition suppress it only when the same exact
 * target is already printed at the end of an action in that judgment. */
export function decisionWindowDuplicatesAction(windowValue, actionValues = []) {
  const windowKey = normalizeDeadline(windowValue);
  return !!windowKey && actionValues.some(value => normalizeDeadline(actionDeadlineSuffix(value)) === windowKey);
}

export function applySemanticStyling(container) {
  // The generated dateline is visual masthead copy, not a subsection. Keep its
  // established H3 styling while removing the otherwise skipped heading level
  // from assistive-technology navigation (the briefing title remains the H1).
  const briefingTitle = container.querySelector('h1');
  const dateline = briefingTitle?.nextElementSibling;
  if (dateline?.tagName === 'H3') dateline.setAttribute('role', 'presentation');

  // 1. BLUF → card
  if (!container.querySelector('.bluf')) {
    for (const h2 of container.querySelectorAll('h2')) {
      if (/^\s*BLUF\b/i.test(h2.textContent)) {
        const div = document.createElement('div');
        div.className = 'bluf';
        let next = h2.nextElementSibling;
        let content = '';
        while (next && next.tagName !== 'H2' && next.tagName !== 'HR') {
          content += next.outerHTML;
          const toRemove = next;
          next = next.nextElementSibling;
          toRemove.remove();
        }
        if (content) {
          div.innerHTML = content;
          h2.replaceWith(div);
        }
        break;
      }
    }
  }

  // 2. Horizon tags
  container.querySelectorAll('p, h3, strong, li').forEach(el => {
    if (el.innerHTML.includes('[Horizon')) {
      el.innerHTML = el.innerHTML.replace(/\[Horizon (\d)\]/g, (_, n) =>
        `<span class="c-chip h${n}" data-horizon="${n}" aria-label="Horizon ${n}: ${BRIEF_TIER_LABELS[n] || ('Horizon ' + n)}">${BRIEF_TIER_LABELS[n] || ('HORIZON ' + n)}</span>`
      );
    }
  });

  // 2b. Judgment metadata bar — lift Confidence + Decision window into a
  // compact visual line under each signal heading. Legacy briefs may still carry
  // a "Revises if" field; consume it with the metadata block but do not render it.
  // It was useful generation scaffolding, not part of the finished edition.
  const DISPLAY_META_LABELS = ['confidence', 'decision window'];
  const RETIRED_LABELS = ['revises if', 'increases if', 'decreases if'];
  const asOfDate = editionDate(container);
  container.querySelectorAll('h3').forEach(h3 => {
    if (!/^\s*Signal\b/i.test(h3.textContent)) return;
    h3.dataset.judgment = 'true';
    // The ordinal is generation scaffolding, not editorial copy. Keep the title,
    // and move its tier chip into the metadata line beneath the heading.
    h3.innerHTML = h3.innerHTML.replace(/^\s*Signal\s+\d+\s*[—–:\-]?\s*/i, '');
    const tierChip = h3.querySelector('.c-chip');
    tierChip?.remove();
    let confidence = '', windowLabel = '', windowSource = '';
    const metadataNodes = [];
    let n = h3.nextElementSibling;
    while (n && !['H3', 'H2', 'HR'].includes(n.tagName)) {
      // The three fields may be SEPARATE <p>s (a blank line between them) OR packed
      // into one <p> with <br>s (markdown breaks:true with no blank line). Parse both:
      // split the block on <br> and read each "**Label:** value" segment. Without this,
      // a packed block matched only its first <strong> and silently dropped the rest.
      const segs = fieldSegments(n);
      for (const { label, value } of segs) {
        if (label === 'confidence' && !confidence) {
          confidence = metadataSummary(value);   // term + band ("Likely (55–80%)"); drop the top-level " — basis" tail
        } else if (label === 'decision window' && !windowLabel) {
          // A deadline is operational content, not rationale. Preserve it in full,
          // including any top-level dash that separates a date from a time/condition.
          windowLabel = value.trim();
          windowSource = value.trim();
        }
      }
      if (segs.some(s => DISPLAY_META_LABELS.includes(s.label))) metadataNodes.push(n);
      n = n.nextElementSibling;
    }
    if (tierChip || confidence || windowLabel) {
      const bar = document.createElement('div');
      bar.className = 'brief-judgment-meta';
      if (tierChip) bar.appendChild(tierChip);
      if (confidence) {
        const c = document.createElement('span');
        c.className = 'bjm-confidence';
        c.textContent = confidence;
        c.setAttribute('aria-label', `Confidence: ${confidence}`);
        bar.appendChild(c);
      }
      if (windowLabel) {
        const w = document.createElement('span');
        w.className = 'bjm-window';
        w.textContent = windowLabel;
        w.dataset.decisionWindow = windowSource || windowLabel;
        const relativeAsOf = asOfDate && isRelativeWindow(windowSource || windowLabel) ? asOfDate : '';
        if (relativeAsOf) w.dataset.editionDate = relativeAsOf;
        w.setAttribute('aria-label', `Decision window${relativeAsOf ? ` as of ${relativeAsOf}` : ''}: ${windowLabel}`);
        bar.appendChild(w);
      }
      h3.after(bar);
    }
    metadataNodes.forEach(el => stripLabeledSegments(el, DISPLAY_META_LABELS));
  });

  // Archived editions may contain these internal confidence-adjustment prompts.
  // Consume them wherever they occur, including inside a mixed packed paragraph.
  container.querySelectorAll('p, li').forEach(el => stripLabeledSegments(el, RETIRED_LABELS));

  // 3. "The line" → callout
  container.querySelectorAll('p, li').forEach(liftTheLine);

  // 4. Source citations — keep the prose clean by replacing the model's full
  // inline source label with one clickable superscript reference. Hover, keyboard
  // focus, and tap expose the exact URL through the shared infotip primitive; the
  // full human-readable label remains in the Sources appendix below.
  // DOMPurify already stripped dangerous hrefs; only http(s) links reach this path.
  // Numbering is deduped by href so one source keeps one number.
  const sources = [];                 // [{ href, label }] in first-seen order
  const numberByHref = new Map();
  container.querySelectorAll('a[href]').forEach(a => {
    if (a.closest('.brief-cite, .brief-sources-appendix')) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:/i.test(href)) return;
    let n = numberByHref.get(href);
    if (n == null) {
      n = sources.length + 1;
      numberByHref.set(href, n);
      // Prefer the anchor's own text — the model writes links as "[Source Name,
      // Date](url)", so its text is a real citation; the bare hostname is only a
      // fallback for links whose text was empty or a raw URL.
      const text = (a.textContent || '').trim();
      const label = text && !/^https?:\/\//i.test(text) ? text : hostLabel(href);
      sources.push({ href, label, host: hostLabel(href) });
    }
    const source = sources[n - 1];
    const ref = document.createElement('a');
    ref.className = 'brief-cite-link';
    ref.href = href;
    ref.target = '_blank';
    ref.rel = 'noopener noreferrer';
    ref.textContent = `[${n}]`;
    ref.dataset.tip = href;
    ref.tabIndex = 0;
    ref.setAttribute('aria-label', `Source ${n}: ${source?.label || source?.host || href}. Opens ${href} in a new tab.`);

    const sup = document.createElement('sup');
    sup.className = 'brief-cite';
    sup.appendChild(ref);
    a.replaceWith(sup);
  });

  // 5. Section heading IDs for the TOC
  let idx = 0;
  container.querySelectorAll('h2').forEach(h2 => {
    if (!h2.id) {
      const clean = h2.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 40);
      h2.id = `section-${idx++}-${clean}`;
    }
    // The Executive Summary restates the BLUF — de-emphasize it so the read flows
    // BLUF → Key Judgments without a redundant equal-weight stop.
    if (/^\s*EXECUTIVE SUMMARY\b/i.test(h2.textContent)) {
      // Archived model output used to put the shift cutoff in this heading,
      // then repeat it in every action. Keep the section label stable and let
      // the decision queue carry genuine, action-specific targets.
      h2.textContent = 'EXECUTIVE SUMMARY \u2014 SHIFT DECISIONS';
      h2.classList.add('brief-exec-heading');
    }
  });

  // 6. Judgment cards — wrap each Signal (heading + metadata bar + body +
  // the line) in a bounded card with a tier left-rule, so each judgment is a
  // self-contained triage unit and a leader can scan for the Tactical ones fast.
  let judgmentN = 0;
  container.querySelectorAll('h3').forEach(h3 => {
    if (h3.dataset.judgment !== 'true') return;
    if (h3.closest('.brief-judgment-card')) return;
    if (!h3.id) h3.id = `judgment-${++judgmentN}`;   // deep-linkable + a TOC sub-entry
    const chip = h3.querySelector('.c-chip') || h3.nextElementSibling?.querySelector('.c-chip');
    const tier = chip ? ((chip.className.match(/\bh([123])\b/) || [])[1] || '') : '';
    const card = document.createElement('div');
    card.className = 'brief-judgment-card' + (tier ? ` h${tier}` : '');
    h3.parentNode.insertBefore(card, h3);
    const collect = [];
    let n = h3;
    while (n) {
      if (n !== h3 && (n.tagName === 'H2' || n.tagName === 'HR' ||
          (n.tagName === 'H3' && n.dataset.judgment === 'true'))) break;
      collect.push(n);
      n = n.nextElementSibling;
    }
    collect.forEach(el => card.appendChild(el));

    // A quiet "View signals →" nav link at the card foot, deep-linking
    // to the Wire pre-filtered to this judgment. Prefer the card's own CVE (an exact
    // q= substring match on the ledger); fall back to the tier horizon filter (h=) when
    // the judgment names no CVE, so the link always lands somewhere relevant. This is
    // trusted app HTML — the CVE/tier are model/derived tokens, never user input — but
    // encodeURIComponent keeps the hash well-formed regardless.
    const cve = (card.textContent.match(/CVE-\d{4}-\d{4,7}/i) || [])[0];
    const href = cve
      ? `/wire?q=${encodeURIComponent(cve.toUpperCase())}`
      : `/wire?h=${encodeURIComponent(tier || '1')}`;
    const link = document.createElement('a');
    link.className = 'brief-judgment-link';
    link.href = href;
    link.textContent = 'View signals →';
    card.appendChild(link);
  });

  // 7. Action directive — lift each judgment's "Act now:" imperative into the
  // canonical .c-action block (the shared blue act-rule, ported from the Wall's
  // .nb-act) and make it the card's closing climax, so "what do I do this shift"
  // is the visual answer rather than one bullet buried in the recommendations.
  container.querySelectorAll('.brief-judgment-card').forEach(card => {
    if (card.querySelector('.c-action')) return;
    let actLi = null;
    for (const li of card.querySelectorAll('li')) {
      const strong = li.querySelector('strong');
      if (strong && /^act now:?$/i.test(strong.textContent.trim())) { actLi = li; break; }
    }
    if (!actLi) return;
    const clone = actLi.cloneNode(true);
    clone.querySelector('strong')?.remove();
    const imperative = clone.innerHTML.replace(/^\s*:?\s*/, '').trim();
    if (!imperative) return;
    const block = document.createElement('div');
    block.className = 'c-action';
    block.innerHTML = `<span class="c-action-label">Act now</span><span class="c-action-text">${imperative}</span>`;
    const list = actLi.closest('ul, ol');
    actLi.remove();
    if (list && !list.querySelector('li')) list.remove();   // drop a list emptied by the lift
    // The action directive is the story's climax, but the "View signals" nav link (step 6)
    // is trailing chrome — keep it the true card foot by inserting the block before it.
    card.insertBefore(block, card.querySelector('.brief-judgment-link'));
  });

  // Decision-window metadata is useful when it adds timing information. When
  // it is byte-for-byte the same operational target already printed on an
  // action, showing it again turns the edition date into visual wallpaper.
  container.querySelectorAll('.brief-judgment-card').forEach(card => {
    const windowEl = card.querySelector('.bjm-window');
    if (!windowEl) return;
    const actionValues = [...card.querySelectorAll('.c-action-text, li')]
      .map(el => el.textContent || '');
    const source = windowEl.dataset.decisionWindow || windowEl.textContent || '';
    if (decisionWindowDuplicatesAction(source, actionValues)) windowEl.remove();
  });

  // 8. Source appendix — append the deduped, numbered citations as an ordered
  // list at the end of the brief, so the memo "shows its work". Runs after the cards
  // so the appendix is never swallowed into the last judgment's collection.
  if (sources.length && !container.querySelector('.brief-sources-appendix')) {
    const heading = document.createElement('h2');
    heading.className = 'brief-sources-heading';
    heading.id = 'section-sources';   // so the TOC includes it (it's a real section, not accidentally dropped)
    heading.textContent = 'Sources';
    const ol = document.createElement('ol');
    ol.className = 'brief-sources-appendix';
    for (const s of sources) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'source-link';
      a.textContent = s.label;
      li.appendChild(a);
      // When the citation text is the outlet+date, trail the bare host as a quiet
      // verifier ("CISA KEV Advisory, 25 Jun 2026 — cisa.gov") so the printed
      // edition shows where to confirm it; skip when the label already is the host.
      if (s.host && s.host !== s.label) {
        const host = document.createElement('span');
        host.className = 'brief-cite-host';
        host.textContent = ` — ${s.host}`;
        li.appendChild(host);
      }
      ol.appendChild(li);
    }
    container.appendChild(heading);
    container.appendChild(ol);
  }
}

// Hostname (sans leading www.) as a compact, honest citation label for the appendix.
function hostLabel(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

/** Build the TOC tree: h2 sections in document order, each with any Signal sub-entries
 *  (deep-linkable judgments) nested beneath it. `secondary` flags the de-emphasized
 *  Executive Summary so the TOC can mirror its quieter heading treatment. */
export function extractSections(container) {
  const sections = [];
  let current = null;
  for (const el of container.querySelectorAll('h2[id], h3[id]')) {
    if (el.tagName === 'H2') {
      current = {
        id: el.id,
        label: el.textContent.trim().replace(/\s+/g, ' '),
        secondary: el.classList.contains('brief-exec-heading'),
        children: [],
      };
      sections.push(current);
    } else if (current) {
      current.children.push({ id: el.id, label: el.textContent.trim().replace(/\s+/g, ' ') });
    }
  }
  return sections;
}

// BlueTeam.News — "How to read BlueTeam.News" help overlay.
//
// New operators land on a dense watchfloor with no legend: what does a SCORE
// mean, why is one tag dotted and another solid, what does ×N say? This overlay
// is the single reference for the surface's grammar — the Wire columns, the
// trust affordances, the tier legend, and the keyboard map. Opened from the
// header `?` button and the `?` shortcut; closed with Esc or the close button.
//
// A true modal dialog (mirrors brief-export.js): aria-modal + a labelled title,
// focus moved in on open and trapped, focus returned to the opener on close.
// Idempotent — a second openHelp() while one is up is a no-op (no double scrim).

import { TIER_NAMES } from './tiers.js';
import { navigate } from './router.js';

let overlay = null;         // the mounted overlay, or null when closed
let returnFocusTo = null;   // element to restore focus to on close
let onKey = null;           // the bound keydown handler, removed on close
let previousBodyOverflow = '';

// One trust affordance = one row: the visual token + what it certifies. Kept as
// data so the copy sits next to the class it explains (honest instruments — the
// legend can never drift from the real chips because it renders the same voice).
const TRUST_ROWS = [
  ['<span class="help-aff-solid">solid</span>', 'Reported or catalog-sourced information. Read the label and cited source; this does not establish exposure in your environment.'],
  ['<span class="help-aff-dotted">dotted underline</span>', 'Heuristic auto-tag — matched by pattern, not confirmed.'],
  ['<span class="help-aff-mono">N sources</span>', 'N distinct publisher identities carry related reporting. Multiple articles from one publisher count once; different publishers may rely on the same underlying report.'],
  ['<span class="help-aff-mono">KEV</span>', 'On the CISA Known Exploited Vulnerabilities catalog.'],
  ['<span class="help-aff-mono">EXPLOIT</span>', 'Public exploit references exist.'],
];

// Tier labels reuse the neutral classification treatment from the working views.
function tierLegend() {
  const horizons = {1:'Near-term', 2:'Developing', 3:'Long-range'};
  return [1, 2, 3]
    .map(n => `<p class="help-tier-row"><span class="c-chip h${n}">T${n} · ${TIER_NAMES[n]}</span><span>${horizons[n]}</span></p>`)
    .join('');
}

// Keyboard map — the chords wired in shortcuts.js and the Wall handler. `<kbd>`
// caps mirror the mono machine-fact voice.
const KEY_ROWS = [
  ['<kbd class="help-kbd">G</kbd> then <kbd class="help-kbd">B</kbd> / <kbd class="help-kbd">W</kbd> / <kbd class="help-kbd">L</kbd> / <kbd class="help-kbd">S</kbd>', 'Briefing / Wire / automatic Wall display / Settings'],
  ['<kbd class="help-kbd">Ctrl</kbd>/<kbd class="help-kbd">⌘</kbd> + <kbd class="help-kbd">Enter</kbd>', 'Generate briefing'],
  ['<kbd class="help-kbd">/</kbd>', 'Focus the active search field'],
  ['<kbd class="help-kbd">J</kbd> / <kbd class="help-kbd">K</kbd>', 'Wire: next / previous signal'],
  ['<kbd class="help-kbd">Enter</kbd>', 'Wire: inspect the focused signal'],
  ['<kbd class="help-kbd">R</kbd> / <kbd class="help-kbd">H</kbd> / <kbd class="help-kbd">C</kbd>', 'Wire: toggle read / hide / copy the focused signal'],
  ['<kbd class="help-kbd">?</kbd>', 'This help'],
  ['<kbd class="help-kbd">Esc</kbd>', 'Close help · exit the Wall'],
];

function buildPanel() {
  return `
    <div class="help-panel" role="document">
      <div class="help-heading">
      <h2 class="help-title" id="helpTitle">How to read BlueTeam.News</h2>
      <button type="button" class="help-close" aria-label="Close help">✕</button>
      </div>

      <div class="help-tasks">
        <section><h3>Investigate a signal</h3><p>Choose a headline in Wire, then Inspect evidence to read the retained source and compare revisions.</p><a href="/wire" data-help-route>Open Wire →</a></section>
        <section><h3>Read and share an assessment</h3><p>Start with Overview, use Decision summary for actions, or read the Full report for reasoning and citations. Edition tools holds archive, sources, and print.</p><a href="/briefing" data-help-route>Open Briefing →</a></section>
        <section><h3>Set up the Wall</h3><p>Choose text size, playlist, and display preferences in Settings. Press Escape to return from the automatic Wall.</p><a href="/settings#set-wall" data-help-route>Wall display settings →</a></section>
      </div>

      <details class="help-section" id="help-reading">
        <summary class="help-section-h">Reading the Wire</summary>
        <dl class="help-defs">
          <dt><span class="help-aff-mono">SCORE</span></dt>
          <dd>0–100 ranking priority. Scores with an expansion indicator include a component breakdown; other scores are a summary value. A high score does not confirm exposure in your environment.</dd>
          <dt>SIGNAL</dt>
          <dd>Read the product, CVE, and material development, then open Inspect for applicability and next steps. The original publisher title remains part of the evidence.</dd>
          <dt>SOURCE · AGE</dt>
          <dd>Provenance and staleness — who reported it and how long ago.</dd>
        </dl>
      </details>

      <details class="help-section" id="help-evidence">
        <summary class="help-section-h">Evidence and uncertainty</summary>
        <dl class="help-defs">
          ${TRUST_ROWS.map(([token, meaning]) => `<dt>${token}</dt><dd>${meaning}</dd>`).join('')}
        </dl>
        <p class="help-note"><strong>Reading an assessment.</strong> Briefing assessments are generated interpretations of the cited reporting. Likelihood describes an estimated outcome; confidence describes the stated strength of the evidence. Read the supplied reasoning before acting.</p>
        <p>Open Inspect evidence to choose a publisher and retained revision. Compare changed passages with their surrounding context. A longer retained excerpt can be a capture change; it does not establish a new threat development. Copy an evidence link when handing off a specific passage.</p>
        <p>Source counts measure reporting coverage. Separate repeated vendor statements from independently observed incidents. Unknown enrichment, deployment, or exposure is a gap to investigate.</p>
      </details>
      <details class="help-section" id="help-profile">
        <summary class="help-section-h">Watch profiles and local decisions</summary>
        <p>Settings → Watch profile stores shared server interests: technologies, sectors, regions, and intelligence questions. Wire distinguishes declared term matches from question relevance. A match does not confirm an affected local asset. Use decision records to track investigation separately from reading.</p>
      </details>
      <details class="help-section" id="help-editions">
        <summary class="help-section-h">Editions, drafts, and display</summary>
        <p>Briefing offers Overview, Decision summary, and Full report views with topic navigation. Check evidence confidence and review notes beside an action. Use Archive to find a dated edition, Sources and saved inputs to inspect its receipt, and Copy link or Print edition to share it. Drafts holds rejected work for repair and rechecking against its captured inputs. Preserve the edition identity and review notes when sharing.</p>
        <p>Wall opens directly as an automatic TV loop across the full viewport, without navigation controls or a setup step. Change text size, margins, playback, fullscreen, and supported screen-awake preferences in Settings → Wall display. Fullscreen is attempted from your navigation gesture when enabled; the Wall still fills the viewport if the browser declines. Escape returns to the previous view. Feed freshness remains separate from playback.</p>
      </details>

      <details class="help-section">
        <summary class="help-section-h">Intelligence tiers</summary>
        <div class="help-tier-legend">${tierLegend()}</div>
      </details>

      <details class="help-section" id="help-keyboard">
        <summary class="help-section-h">Keyboard shortcuts</summary>
        <dl class="help-defs help-keys">
          ${KEY_ROWS.map(([keys, meaning]) => `<dt>${keys}</dt><dd>${meaning}</dd>`).join('')}
        </dl>
      </details>
    </div>`;
}

/**
 * Open the help overlay. Idempotent — a no-op if one is already mounted.
 */
export function openHelp() {
  if (overlay) return;
  returnFocusTo = document.activeElement;

  overlay = document.createElement('div');
  overlay.className = 'help-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'helpTitle');
  overlay.innerHTML = buildPanel();
  document.body.appendChild(overlay);
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // Clicking the scrim (outside the panel) closes, like the export overlay.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeHelp(); });
  overlay.querySelector('.help-close').addEventListener('click', closeHelp);
  overlay.querySelectorAll('[data-help-route]').forEach(link => link.addEventListener('click', event => {
    if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const destination = link.getAttribute('href');
    closeHelp();
    navigate(destination);
  }));

  onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeHelp(); return; }
    if (e.key === 'Tab') {   // trap Tab within the panel's own focusables [mirrors brief-export.js]
      const f = [...overlay.querySelectorAll('button, [href], summary, [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || !overlay.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !overlay.contains(a))) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.help-close').focus();   // move focus into the dialog on open
}

/**
 * Close the help overlay and return focus to the opener. Safe to call when
 * nothing is open.
 */
export function closeHelp() {
  if (!overlay) return;
  overlay.remove();
  document.body.style.overflow = previousBodyOverflow;
  overlay = null;
  if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
  if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
  returnFocusTo = null;
}

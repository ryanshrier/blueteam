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

let overlay = null;         // the mounted overlay, or null when closed
let returnFocusTo = null;   // element to restore focus to on close
let onKey = null;           // the bound keydown handler, removed on close

// One trust affordance = one row: the visual token + what it certifies. Kept as
// data so the copy sits next to the class it explains (honest instruments — the
// legend can never drift from the real chips because it renders the same voice).
const TRUST_ROWS = [
  ['<span class="help-aff-solid">solid</span>', 'Verified fact — asserted by the source or a catalog.'],
  ['<span class="help-aff-dotted">dotted underline</span>', 'Heuristic auto-tag — matched by pattern, not confirmed.'],
  ['<span class="help-aff-mono">×N</span>', 'Cross-source reporting — N distinct source identities carry a near-matched signal.'],
  ['<span class="help-aff-mono">KEV</span>', 'On the CISA Known Exploited Vulnerabilities catalog.'],
  ['<span class="help-aff-mono">EXPLOIT</span>', 'Public exploit references exist.'],
];

// Tier legend — reuses the operational .c-chip voice (T1 red / T2 amber /
// T3 violet) so the legend reads in the exact hues the Wire and Wall use.
function tierLegend() {
  return [1, 2, 3]
    .map(n => `<span class="c-chip h${n}">${TIER_NAMES[n]}</span>`)
    .join('');
}

// Keyboard map — the chords wired in shortcuts.js and the Wall handler. `<kbd>`
// caps mirror the mono machine-fact voice.
const KEY_ROWS = [
  ['<kbd class="help-kbd">G</kbd> then <kbd class="help-kbd">B</kbd> / <kbd class="help-kbd">W</kbd> / <kbd class="help-kbd">L</kbd> / <kbd class="help-kbd">S</kbd>', 'Briefing / Wire / waLL / Settings'],
  ['<kbd class="help-kbd">Ctrl</kbd>/<kbd class="help-kbd">⌘</kbd> + <kbd class="help-kbd">Enter</kbd>', 'Generate briefing'],
  ['<kbd class="help-kbd">/</kbd>', 'Focus the active search field'],
  ['<kbd class="help-kbd">?</kbd>', 'This help'],
  ['<kbd class="help-kbd">Esc</kbd>', 'Close help · exit the Wall'],
];

function buildPanel() {
  return `
    <div class="help-panel" role="document">
      <button type="button" class="help-close" aria-label="Close help">✕</button>
      <h2 class="help-title" id="helpTitle">How to read BlueTeam.News</h2>

      <section class="help-section">
        <h3 class="help-section-h">The Wire columns</h3>
        <dl class="help-defs">
          <dt><span class="help-aff-mono">SCORE</span></dt>
          <dd>0–100 defender relevance. Click a score to open the evidence ledger behind it.</dd>
          <dt>SIGNAL</dt>
          <dd>The headline plus its decision chips — what it is and what it demands.</dd>
          <dt>SOURCE · AGE</dt>
          <dd>Provenance and staleness — who reported it and how long ago.</dd>
        </dl>
      </section>

      <section class="help-section">
        <h3 class="help-section-h">Trust affordances</h3>
        <dl class="help-defs">
          ${TRUST_ROWS.map(([token, meaning]) => `<dt>${token}</dt><dd>${meaning}</dd>`).join('')}
        </dl>
      </section>

      <section class="help-section">
        <h3 class="help-section-h">Tiers</h3>
        <p class="help-tier-legend">${tierLegend()}</p>
        <p class="help-tier-note">Tactical (act now) · Operational (this cycle) · Strategic (watch).</p>
      </section>

      <section class="help-section">
        <h3 class="help-section-h">Keyboard</h3>
        <dl class="help-defs help-keys">
          ${KEY_ROWS.map(([keys, meaning]) => `<dt>${keys}</dt><dd>${meaning}</dd>`).join('')}
        </dl>
      </section>
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

  // Clicking the scrim (outside the panel) closes, like the export overlay.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeHelp(); });
  overlay.querySelector('.help-close').addEventListener('click', closeHelp);

  onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeHelp(); return; }
    if (e.key === 'Tab') {   // trap Tab within the panel's own focusables [mirrors brief-export.js]
      const f = [...overlay.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')];
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
  overlay = null;
  if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
  if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
  returnFocusTo = null;
}

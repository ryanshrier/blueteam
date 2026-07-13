// BlueTeam.News — Settings: the Anthropic key (server-persisted) plus appearance
// (theme + accent, stored locally). The only view that writes to the server.

import { fetchSettings, saveSettings, verifyKey } from '../core/api.js';
import { escapeHtml } from '../core/sanitize.js';
import { ACCENTS, getThemePreference, getAccent, applyTheme, applyAccent } from '../core/theme.js';
import { emit } from '../core/store.js';

let feedbackTimer = null;
let armTimer = null;       // two-step Remove-key disarm timer
let watchTermsTimer = null; // watch-terms feedback auto-dismiss
let orgFeedbackTimer = null; // organization-profile feedback auto-dismiss

export function render(main) {
  main.innerHTML = `
    <div class="settings">
      <header class="settings-head">
        <h1>Settings</h1>
        <p class="settings-sub">Settings are stored on this machine. The AI Briefing is the one feature that sends data off it — see below.</p>
      </header>

      <section class="settings-card" aria-labelledby="set-ai">
        <h2 id="set-ai">AI Briefing</h2>
        <p class="settings-note">The optional daily Briefing is the only feature that calls the Anthropic API — your prompts and key are sent to Anthropic to generate it. The Wall and Wire never need one.</p>
        <div class="settings-status" id="aiStatus" data-state="loading" role="status" aria-live="polite">Checking…</div>
        <label class="settings-label" for="apiKey">Anthropic API key</label>
        <div class="key-row">
          <div class="key-input-wrap">
            <input id="apiKey" class="settings-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" aria-describedby="keyHelp">
            <button class="key-reveal" id="revealKey" type="button" aria-label="Show key" aria-pressed="false" title="Show / hide key" tabindex="0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          </div>
          <button class="btn-ghost-sm" id="verifyKey" type="button" title="Make one tiny test call to confirm the key works">Verify</button>
          <button class="btn-primary" id="saveKey" type="button">Save</button>
        </div>
        <p class="settings-help" id="keyHelp">Stored locally in <code>data/settings.local.json</code> (gitignored). Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>. Usage is billed to your Anthropic account; after generation, BlueTeam.News shows the model, token count, and estimated API cost.</p>
        <div class="settings-row-actions">
          <button class="btn-ghost-sm destructive" id="clearKey" type="button">Remove key</button>
          <span class="settings-feedback" id="keyFeedback" role="status" aria-live="polite"></span>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="set-theme">
        <h2 id="set-theme">Appearance</h2>
        <label class="settings-label" id="themeLabel">Theme</label>
        <div class="seg" id="themeSeg" role="radiogroup" aria-labelledby="themeLabel">
          <button type="button" class="seg-btn" role="radio" aria-checked="false" data-theme-choice="system">System</button>
          <button type="button" class="seg-btn" role="radio" aria-checked="false" data-theme-choice="dark">Dark</button>
          <button type="button" class="seg-btn" role="radio" aria-checked="false" data-theme-choice="light">Light</button>
        </div>
        <label class="settings-label" id="accentLabel" style="margin-top:18px">Accent</label>
        <div class="swatches" id="accentSwatches" role="radiogroup" aria-labelledby="accentLabel">
          ${ACCENTS.map(a => `<button type="button" class="swatch" role="radio" aria-checked="false" data-accent="${a.hex}" title="${escapeHtml(a.name)}" aria-label="${escapeHtml(a.name)}" style="--sw:${a.hex}"></button>`).join('')}
        </div>
        <p class="settings-help">Applies to the operator interface — header, Wire, and Briefing. The Wall keeps its watchfloor broadsheet palette.</p>
      </section>

      <section class="settings-card" aria-labelledby="set-org">
        <h2 id="set-org">Organization profile</h2>
        <p class="settings-note">Drives the Briefing's "Relevance" judgment and sector framing — the main daily-value differentiator over a generic feed. Leave any field blank to fall back to the server's default profile.</p>
        <label class="settings-label" for="orgSector">Sector</label>
        <input id="orgSector" class="settings-input" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. Healthcare, Financial services" maxlength="120">
        <label class="settings-label" for="orgProfile" style="margin-top:14px">Team profile</label>
        <textarea id="orgProfile" class="settings-input settings-textarea" rows="3" spellcheck="true" placeholder="e.g. Mid-size enterprise SOC running a hybrid on-prem/cloud estate" maxlength="500"></textarea>
        <label class="settings-label" for="orgRegions" style="margin-top:14px">Operating regions</label>
        <input id="orgRegions" class="settings-input" type="text" autocomplete="off" spellcheck="false" placeholder="Comma-separated, e.g. US, EU" maxlength="200">
        <p class="settings-help" id="orgHelp">Comma-separated list. Saved alongside the API key and applies to the next briefing generated.</p>
        <div class="settings-row-actions">
          <button class="btn-primary" id="saveOrg" type="button">Save profile</button>
          <span class="settings-feedback" id="orgFeedback" role="status" aria-live="polite"></span>
        </div>
      </section>

      <section class="settings-card alert-rules" aria-labelledby="set-alerts">
        <h2 id="set-alerts">Alert rules</h2>
        <p class="settings-note">Rules boost a signal's priority and stamp the <strong>ALERT MATCH</strong> chip. The built-in rules live in <code>config.json</code> (hot-reload on save); your watch-terms are stored locally and apply on the next refresh.</p>
        <div class="alert-rules-list" id="alertRules" role="status" aria-live="polite"></div>
        <label class="settings-label" id="watchLabel" for="watchInput" style="margin-top:18px">Watch-terms</label>
        <div class="watch-terms" id="watchTerms"></div>
        <div class="watch-add-row">
          <input id="watchInput" class="settings-input" type="text" autocomplete="off" spellcheck="false" placeholder="Add a keyword (e.g. Fortinet)" aria-labelledby="watchLabel" maxlength="64">
          <button class="btn-ghost-sm" id="watchAdd" type="button">Add</button>
        </div>
        <span class="settings-feedback" id="watchFeedback" role="status" aria-live="polite"></span>
        <p class="settings-help">Literal keywords, matched case-insensitively against incoming signals — never regex. Up to 25 terms, each 1–64 characters.</p>
      </section>
    </div>
  `;

  // ── AI key ──
  const input = main.querySelector('#apiKey');
  const statusEl = main.querySelector('#aiStatus');
  const feedback = main.querySelector('#keyFeedback');
  const saveBtn = main.querySelector('#saveKey');
  const verifyBtn = main.querySelector('#verifyKey');
  const clearBtn = main.querySelector('#clearKey');
  const revealBtn = main.querySelector('#revealKey');

  // Transient feedback auto-dismisses so it never lingers as a second stale truth
  // beside the repainted status; sticky messages (the env notice, the format hint) hold.
  function setFeedback(msg, { sticky = false } = {}) {
    clearTimeout(feedbackTimer);
    feedback.textContent = msg || '';
    if (msg && !sticky) feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 4000);
  }

  function paintStatus(ai) {
    const envManaged = ai?.keySource === 'env';
    if (!ai) {
      statusEl.dataset.state = 'off';
      statusEl.textContent = 'Status unavailable.';
    } else if (ai.enabled) {
      statusEl.dataset.state = 'on';
      const src = envManaged ? 'from the environment (.env)' : 'set in-app';
      statusEl.textContent = `Briefing enabled — key ${ai.keyMasked || ''} ${src}.`;
    } else {
      statusEl.dataset.state = 'off';
      statusEl.textContent = 'Briefing disabled — no API key set.';
    }
    // An env-managed key wins regardless of what the in-app controls do, so Save and
    // Remove would both be no-ops (Remove especially is a misleading lie). Disable the
    // input AND both buttons, and say why. Verify stays live — testing the active env
    // key is useful.
    input.disabled = envManaged;
    saveBtn.disabled = envManaged;
    clearBtn.disabled = envManaged;
    disarmClear(); // a repaint (post-save or env notice) resets the arm state
    if (envManaged) {
      setFeedback('A key from the environment (.env) is in use and takes precedence. To change it, edit .env and restart the server.', { sticky: true });
    }
    // Tell the header (and any other listener) the AI-enabled state may have changed —
    // paintStatus runs both on initial load AND after save/clear, so this covers the
    // "add a key" happy path without the header needing its own re-fetch. Without this,
    // the header CTA stayed "Enable AI →" (routing back to Settings) even after a key
    // was saved, until a full page reload.
    emit('ai-status-changed', ai);
  }

  fetchSettings().then(d => paintStatus(d.ai)).catch(() => paintStatus(null));

  async function save(value) {
    setFeedback('Saving…', { sticky: true });
    try {
      const d = await saveSettings({ anthropicKey: value });
      paintStatus(d.ai);
      if (!(d.ai?.keySource === 'env')) setFeedback(value ? 'Saved' : 'Removed');   // env path keeps its sticky notice
      input.setAttribute('aria-describedby', 'keyHelp');
      input.value = '';
      syncReveal(false);
    } catch (err) {
      setFeedback(err.message || 'Save failed.', { sticky: true });
      input.setAttribute('aria-describedby', 'keyHelp keyFeedback');
    }
  }

  // Plausible-key gate: block an obvious mis-paste before the round-trip and
  // wire the error to the field for screen readers; revert when it looks ok.
  function validateKeyInput() {
    const v = input.value.trim();
    if (v && !v.startsWith('sk-ant-')) {
      saveBtn.disabled = true;
      setFeedback('Anthropic keys start with "sk-ant-" — check the paste.', { sticky: true });
      input.setAttribute('aria-describedby', 'keyHelp keyFeedback');
    } else {
      if (!input.disabled) saveBtn.disabled = false;
      input.setAttribute('aria-describedby', 'keyHelp');
      if ((feedback.textContent || '').startsWith('Anthropic keys start')) setFeedback('');
    }
  }
  input.addEventListener('input', validateKeyInput);

  saveBtn.addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) { setFeedback('Paste a key first.'); return; }
    if (!v.startsWith('sk-ant-')) { validateKeyInput(); return; }
    save(v);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });

  // Two-step inline confirm for the destructive Remove. Removing the key kills
  // every briefing, so the first click only ARMS: relabel, warn, and set a ~4s disarm
  // timer. A second click inside that window commits. We never arm a disabled (env-
  // managed) button — Remove is a no-op there. Arm state is reset on any successful
  // save/paint so a repaint never strands the button in "Confirm remove".
  const CLEAR_LABEL = 'Remove key';
  function disarmClear() {
    clearTimeout(armTimer);
    armTimer = null;
    clearBtn.classList.remove('armed');
    clearBtn.textContent = CLEAR_LABEL;
  }
  clearBtn.addEventListener('click', () => {
    if (clearBtn.disabled) return; // env-managed — Remove is a no-op, never arm it
    if (!clearBtn.classList.contains('armed')) {
      clearBtn.classList.add('armed');
      clearBtn.textContent = 'Confirm remove';
      setFeedback('Removing the key disables all briefings — click again to confirm.', { sticky: true });
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { disarmClear(); setFeedback(''); }, 4000);
      return;
    }
    disarmClear();
    save('');
  });

  // Verify — one cheap server-side call confirms the key actually works, catching
  // a well-formed-but-dead key before a full brief 503s. Verifies the typed key, or the
  // active key when the field is empty (e.g. the env key).
  verifyBtn.addEventListener('click', async () => {
    const candidate = input.value.trim();
    if (candidate && !candidate.startsWith('sk-ant-')) { validateKeyInput(); return; }
    verifyBtn.disabled = true;
    const prevLabel = verifyBtn.textContent;
    verifyBtn.textContent = 'Verifying…';
    setFeedback('Verifying key…', { sticky: true });
    try {
      const r = await verifyKey(candidate);
      if (r.valid === true) setFeedback(`Key verified ✓${r.note ? ` — ${r.note}` : ''}`);
      else if (r.valid === false) setFeedback(r.error || 'Key rejected.', { sticky: true });
      else setFeedback(r.error || 'Could not verify the key.', { sticky: true });
    } catch (err) {
      setFeedback(err.message || 'Verification failed.', { sticky: true });
    } finally {
      verifyBtn.textContent = prevLabel;
      verifyBtn.disabled = false;
    }
  });

  // Reveal toggle — eyeball a 100-char paste before committing it.
  function syncReveal(show) {
    input.type = show ? 'text' : 'password';
    revealBtn.setAttribute('aria-pressed', String(show));
    revealBtn.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
    revealBtn.classList.toggle('on', show);
  }
  revealBtn.addEventListener('click', () => syncReveal(input.type === 'password'));

  // ── Appearance — single-select radio groups with roving tabindex + arrow keys ──
  const seg = main.querySelector('#themeSeg');
  function paintTheme() {
    const pref = getThemePreference(); // reflect the PREFERENCE (system|light|dark), not the resolved theme
    seg.querySelectorAll('.seg-btn').forEach(b => {
      const on = b.dataset.themeChoice === pref;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  const chooseTheme = (b) => { applyTheme(b.dataset.themeChoice); paintTheme(); };
  seg.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => chooseTheme(b)));
  wireRovingRadios(seg, '.seg-btn', chooseTheme);
  paintTheme();

  const swatches = main.querySelector('#accentSwatches');
  function paintAccent() {
    const a = getAccent().toLowerCase();
    swatches.querySelectorAll('.swatch').forEach(s => {
      const on = s.dataset.accent.toLowerCase() === a;
      s.classList.toggle('active', on);
      s.setAttribute('aria-checked', String(on));
      s.tabIndex = on ? 0 : -1;
    });
  }
  const chooseAccent = (s) => { applyAccent(s.dataset.accent); paintAccent(); };
  swatches.querySelectorAll('.swatch').forEach(s => s.addEventListener('click', () => chooseAccent(s)));
  wireRovingRadios(swatches, '.swatch', chooseAccent);
  paintAccent();

  // ── Organization profile — sector / team profile / regions, the inputs that
  // drive the Briefing's "Relevance" judgment. Persisted the same way as the API
  // key: POST /api/settings, gated on the same trusted-writer check watchTerms
  // uses. A blank field falls back to config.json's default (getEffectiveOrganization
  // in lib/user-settings.js merges the override over it wherever organization is read).
  const orgSectorEl = main.querySelector('#orgSector');
  const orgProfileEl = main.querySelector('#orgProfile');
  const orgRegionsEl = main.querySelector('#orgRegions');
  const orgSaveBtn = main.querySelector('#saveOrg');
  const orgFeedback = main.querySelector('#orgFeedback');

  function setOrgFeedback(msg) {
    clearTimeout(orgFeedbackTimer);
    orgFeedback.textContent = msg || '';
    if (msg) orgFeedbackTimer = setTimeout(() => { orgFeedback.textContent = ''; }, 4000);
  }

  function paintOrg(org) {
    orgSectorEl.value = (org && typeof org.sector === 'string') ? org.sector : '';
    orgProfileEl.value = (org && typeof org.profile === 'string') ? org.profile : '';
    orgRegionsEl.value = (org && Array.isArray(org.regions)) ? org.regions.join(', ') : '';
  }

  orgSaveBtn.addEventListener('click', async () => {
    const organization = {
      sector: orgSectorEl.value.trim(),
      profile: orgProfileEl.value.trim(),
      regions: orgRegionsEl.value.split(',').map(r => r.trim()).filter(Boolean),
    };
    orgSaveBtn.disabled = true;
    setOrgFeedback('Saving…');
    try {
      const d = await saveSettings({ organization });
      if (d.organization) paintOrg(d.organization);   // trust the server's echoed/normalized values
      setOrgFeedback('Saved');
    } catch (err) {
      setOrgFeedback(err.message || 'Save failed.');
    } finally {
      orgSaveBtn.disabled = false;
    }
  });

  // ── Alert rules — read-only config rules + locally-stored literal watch-terms ──
  // The extended GET/POST fields are gated server-side on loopback||authed; an untrusted
  // client just gets a note and no list. Watch-terms are literal keywords (escaped to
  // regex by the scorer, never accepted as regex here), so we treat and store them as
  // plain strings and escape on render.
  const rulesEl = main.querySelector('#alertRules');
  const termsEl = main.querySelector('#watchTerms');
  const watchInput = main.querySelector('#watchInput');
  const watchAddBtn = main.querySelector('#watchAdd');
  const watchFeedback = main.querySelector('#watchFeedback');
  const MAX_TERMS = 25;
  let watchTerms = null;   // null = untrusted client (fields omitted); array = editable
  let rulesTrusted = false;

  function setWatchFeedback(msg) {
    clearTimeout(watchTermsTimer);
    watchFeedback.textContent = msg || '';
    if (msg) watchTermsTimer = setTimeout(() => { watchFeedback.textContent = ''; }, 4000);
  }

  function paintRules(rules) {
    if (!Array.isArray(rules)) {
      rulesEl.innerHTML = '<p class="settings-help">Alert rules are configured in <code>config.json</code>.</p>';
      return;
    }
    if (!rules.length) {
      rulesEl.innerHTML = '<p class="settings-help">No alert rules configured.</p>';
      return;
    }
    rulesEl.innerHTML = rules.map(r =>
      `<div class="alert-rule-row"><span class="alert-rule-pattern">${escapeHtml(String(r.pattern))}</span><span class="alert-rule-boost">+${escapeHtml(String(r.boost))}</span></div>`
    ).join('');
  }

  function paintTerms() {
    if (!Array.isArray(watchTerms)) {
      // Untrusted client — the editor is not available; hide the add row's purpose.
      termsEl.innerHTML = '<p class="settings-help">Watch-terms are available on the local operator machine.</p>';
      watchInput.disabled = true;
      watchAddBtn.disabled = true;
      return;
    }
    termsEl.innerHTML = watchTerms.length
      ? watchTerms.map((t, i) =>
          `<button type="button" class="watch-term" data-idx="${i}" aria-label="Remove watch-term ${escapeHtml(t)}">${escapeHtml(t)} <span class="wt-x" aria-hidden="true">✕</span></button>`
        ).join('')
      : '<p class="settings-help">No watch-terms yet.</p>';
    termsEl.querySelectorAll('.watch-term').forEach(btn => {
      btn.addEventListener('click', () => removeTerm(Number(btn.dataset.idx)));
    });
  }

  async function persistTerms() {
    try {
      const d = await saveSettings({ watchTerms });
      // Trust the server's canonical (sanitized/deduped) list when it echoes it back.
      if (Array.isArray(d.watchTerms)) watchTerms = d.watchTerms;
      paintTerms();
      setWatchFeedback('Saved — applies on the next refresh.');
    } catch (err) {
      setWatchFeedback(err.message || 'Could not save watch-terms.');
    }
  }

  function addTerm() {
    if (!Array.isArray(watchTerms)) return;
    const raw = watchInput.value.trim();
    if (!raw) { setWatchFeedback('Type a keyword first.'); return; }
    if (raw.length > 64) { setWatchFeedback('Keep each term to 64 characters or fewer.'); return; }
    if (watchTerms.length >= MAX_TERMS) { setWatchFeedback(`At most ${MAX_TERMS} watch-terms.`); return; }
    if (watchTerms.some(t => t.toLowerCase() === raw.toLowerCase())) {
      setWatchFeedback('That term is already on the list.');
      watchInput.value = '';
      return;
    }
    watchTerms = [...watchTerms, raw];
    watchInput.value = '';
    paintTerms();
    persistTerms();
  }

  function removeTerm(idx) {
    if (!Array.isArray(watchTerms) || idx < 0 || idx >= watchTerms.length) return;
    watchTerms = watchTerms.filter((_, i) => i !== idx);
    paintTerms();
    persistTerms();
  }

  watchAddBtn.addEventListener('click', addTerm);
  watchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTerm(); } });

  fetchSettings().then(d => {
    rulesTrusted = Array.isArray(d.alertRules);
    paintRules(d.alertRules);
    watchTerms = Array.isArray(d.watchTerms) ? d.watchTerms : (rulesTrusted ? [] : null);
    paintTerms();
    paintOrg(d.organization);   // populate from a trusted GET; blank fields on an untrusted client
  }).catch(() => { paintRules(null); paintTerms(); paintOrg(null); });
}

// Arrow-key navigation for a radiogroup: Left/Up and Right/Down move the selection
// (radio convention: moving focus selects), Home/End jump to the ends. Roving tabindex
// is maintained by the caller's paint function.
function wireRovingRadios(container, itemSelector, select) {
  container.addEventListener('keydown', (e) => {
    const list = [...container.querySelectorAll(itemSelector)];
    const i = list.indexOf(document.activeElement);
    if (i === -1) return;
    let next;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    list[next].focus();
    select(list[next]);
  });
}

export function unmount() { clearTimeout(feedbackTimer); clearTimeout(armTimer); clearTimeout(watchTermsTimer); clearTimeout(orgFeedbackTimer); }

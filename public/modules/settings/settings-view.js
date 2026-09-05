// BlueTeam.News — Settings: the Anthropic key (server-persisted) plus appearance
// (theme + accent, stored locally). The only view that writes to the server.

import { fetchSettings, saveSettings, verifyKey } from '../core/api.js';
import { escapeHtml } from '../core/sanitize.js';
import { ACCENTS, getThemePreference, getAccent, applyTheme, applyAccent } from '../core/theme.js';
import { emit } from '../core/store.js';
import { syncScheduleControlState } from './schedule-form.js';
import { mountSystemHealth } from './system-health.js';

let feedbackTimer = null;
let armTimer = null;       // two-step Remove-key disarm timer
let profileFeedbackTimer = null;

let scheduleFeedbackTimer = null;
let stopSystemHealth = null;
let mountVersion = 0;

export function render(main) {
  const version = ++mountVersion;
  const ownsView = () => version === mountVersion;
  stopSystemHealth?.();
  main.innerHTML = `
    <div class="settings">
      <header class="settings-head">
        <h1 class="view-title">Settings</h1>
        <p class="settings-sub">Settings are stored on this machine. The AI controls below are the only paths to Anthropic; source collection and optional webhooks have separate <a href="https://github.com/ryanshrier/blueteam/blob/main/docs/operations.md#network-behavior" target="_blank" rel="noopener noreferrer">documented outbound paths</a>.</p>
        <nav class="settings-index" aria-label="Settings sections">
          <a href="#set-profile">Watch profile</a><a href="#set-ai">AI Briefing</a><a href="#set-schedule">Schedule</a><a href="#set-theme">Appearance</a><a href="#systemHealth">System health</a>
        </nav>
      </header>
      <div class="settings-status" id="settingsStorageStatus" data-state="error" role="alert" hidden></div>

      <section class="settings-card watch-profile" aria-labelledby="set-profile">
        <h2 id="set-profile">Watch profile</h2>
        <p class="settings-note">Start with the technologies and interests you follow. Wire explains literal matches without an API key. A watch is a declared interest; local exposure stays unknown until checked.</p>
        <div class="settings-status" id="profileStatus" data-state="loading" role="status" aria-live="polite">Loading your profile…</div>
        <label class="settings-label" for="profileTechnologies">Technologies and watch terms</label>
        <textarea id="profileTechnologies" class="settings-input settings-textarea" rows="3" placeholder="Fortinet&#10;Microsoft 365&#10;C++" aria-describedby="profileTermsHelp" disabled></textarea>
        <p class="settings-counter" id="profileTermCount">0 / 25 terms</p>
        <p class="settings-help" id="profileTermsHelp">One literal term per line, up to 25. Existing watch terms are included. Matches can raise relevance; they do not confirm deployment or affected versions.</p>
        <div class="profile-grid">
          <label><span class="settings-label">Sectors</span><textarea id="profileSectors" class="settings-input settings-textarea" rows="2" placeholder="Healthcare" disabled></textarea></label>
          <label><span class="settings-label">Operating regions</span><textarea id="profileRegions" class="settings-input settings-textarea" rows="2" placeholder="North America&#10;Europe" disabled></textarea></label>
        </div>
        <p class="settings-help">One sector or region per line. These are declared interests, not evidence of targeting.</p>
        <details class="profile-details">
          <summary>Questions, exclusions, and analytical horizons</summary>
          <label class="settings-label" for="profileQuestions">Intelligence questions and topics</label>
          <textarea id="profileQuestions" class="settings-input settings-textarea" rows="3" placeholder="Has the vendor changed the affected versions?" disabled></textarea>
          <p class="settings-help">One per line. Questions guide the next optional Briefing; they never count as confirmed facts or literal technology matches.</p>
          <label class="settings-label" for="profileExclusions">Lower-interest topics</label>
          <textarea id="profileExclusions" class="settings-input settings-textarea" rows="2" placeholder="Product marketing" disabled></textarea>
          <p class="settings-help">One per line, up to 25. Exclusions are advisory: Wire keeps matching reporting visible, and urgent threats remain eligible.</p>
          <fieldset class="profile-horizons"><legend class="settings-label">Preferred analytical horizons</legend>
            <label><input type="checkbox" data-profile-horizon="1" disabled> Tactical</label>
            <label><input type="checkbox" data-profile-horizon="2" disabled> Operational</label>
            <label><input type="checkbox" data-profile-horizon="3" disabled> Strategic</label>
          </fieldset>
          <p class="settings-help">Optional relevance preferences. All horizons remain visible; analytical horizon is separate from urgency.</p>
          <label class="settings-label" for="profileTeam">Team context</label>
          <textarea id="profileTeam" class="settings-input settings-textarea" rows="3" maxlength="512" placeholder="Mid-size security team supporting a hybrid estate" disabled></textarea>
          <p class="settings-counter" id="profileTeamCount">0 / 512 characters</p>
        </details>
        <div class="settings-row-actions">
          <button class="btn-primary" id="saveProfile" type="button" disabled>Save watch profile</button>
          <span class="profile-save-state" id="profileSaveState" role="status"></span>
          <span class="settings-feedback" id="profileFeedback" role="status" aria-live="polite"></span>
        </div>
        <p class="settings-help">Save to this machine. Matches update when Wire loads; ranking updates on the next collection refresh. Clearing a field removes that watch from this profile.</p>
        <details class="profile-details"><summary>Server alert rules</summary>
          <p class="settings-help">Additional priority rules configured in <code>config.json</code>.</p>
          <div class="alert-rules-list" id="alertRules" role="status" aria-live="polite"></div>
        </details>
      </section>
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
          <button class="btn-primary" id="saveKey" type="button" disabled>Save</button>
        </div>
        <p class="settings-help" id="keyHelp">Stored locally in <code>data/settings.local.json</code> (gitignored). Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>. Usage is billed to your Anthropic account; after generation, BlueTeam.News shows the model, token count, and estimated API cost.</p>
        <div class="settings-row-actions">
          <button class="btn-ghost-sm destructive" id="clearKey" type="button">Remove key</button>
          <span class="settings-feedback" id="keyFeedback" role="status" aria-live="polite"></span>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="set-schedule">
        <h2 id="set-schedule">Scheduled Briefing</h2>
        <p class="settings-note">Off by default. Adding an API key does not enable unattended generation. Turn this on only if you want a billable Briefing generated automatically.</p>
        <div class="settings-status" id="scheduleStatus" data-state="loading" role="status" aria-live="polite">Checking…</div>
        <label class="schedule-toggle" for="scheduleEnabled">
          <input id="scheduleEnabled" type="checkbox" disabled>
          <span>
            <strong>Generate automatically</strong>
            <small>Explicit opt-in; you can still generate manually while this is off.</small>
          </span>
        </label>
        <p class="schedule-preview" id="schedulePreview">Loading schedule…</p>
        <div class="schedule-grid">
          <label>
            <span class="settings-label">Time</span>
            <input id="scheduleTime" class="settings-input" type="time" value="05:00" disabled>
          </label>
          <label>
            <span class="settings-label">Timezone</span>
            <input id="scheduleTimezone" class="settings-input" type="text" value="local" placeholder="local or America/Chicago" maxlength="100" spellcheck="false" aria-label="Timezone" aria-describedby="scheduleTimezoneHelp" disabled>
            <span class="settings-help" id="scheduleTimezoneHelp">Use local for the server's timezone, or an IANA name such as America/Chicago.</span>
          </label>
          <label>
            <span class="settings-label">If a run was missed</span>
            <select id="scheduleMissedRun" class="settings-input" disabled>
              <option value="skip">Skip it</option>
              <option value="catch-up">Catch up after startup</option>
            </select>
          </label>
          <label>
            <span class="settings-label">Retry delay (minutes)</span>
            <input id="scheduleRetry" class="settings-input" type="number" min="1" max="1440" step="1" value="15" disabled>
          </label>
          <label>
            <span class="settings-label">Maximum attempts</span>
            <input id="scheduleAttempts" class="settings-input" type="number" min="1" max="10" step="1" value="3" disabled>
          </label>
        </div>
        <p class="settings-help">Failed runs stop at the attempt limit; partial or invalid drafts are never published.</p>
        <div class="settings-row-actions">
          <button class="btn-primary" id="saveSchedule" type="button" disabled>Save schedule</button>
          <span class="settings-feedback" id="scheduleFeedback" role="status" aria-live="polite"></span>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="set-theme">
        <h2 id="set-theme">Appearance</h2>
        <p class="settings-note">Changes apply immediately on this browser.</p>
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

      <section class="settings-card system-health" id="systemHealth" aria-labelledby="set-health" tabindex="-1"></section>
    </div>
  `;
  stopSystemHealth = mountSystemHealth(main.querySelector('#systemHealth'));

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
    saveBtn.disabled = envManaged || !input.value.trim().startsWith('sk-ant-');
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

  fetchSettings().then(d => { if (ownsView()) paintStatus(d.ai); })
    .catch(() => { if (ownsView()) paintStatus(null); });

  async function save(value) {
    setFeedback('Saving…', { sticky: true });
    try {
      const d = await saveSettings({ anthropicKey: value });
      paintStatus(d.ai);
      if (!(d.ai?.keySource === 'env')) setFeedback(value ? 'Saved' : 'Removed');   // env path keeps its sticky notice
      input.setAttribute('aria-describedby', 'keyHelp');
      input.value = '';
      saveBtn.disabled = true;
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
      if (!input.disabled) saveBtn.disabled = !v;
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

  // ── Scheduled Briefing — persisted server-side and explicitly opt-in ──
  const scheduleEnabledEl = main.querySelector('#scheduleEnabled');
  const scheduleTimeEl = main.querySelector('#scheduleTime');
  const scheduleTimezoneEl = main.querySelector('#scheduleTimezone');
  const scheduleMissedRunEl = main.querySelector('#scheduleMissedRun');
  const scheduleRetryEl = main.querySelector('#scheduleRetry');
  const scheduleAttemptsEl = main.querySelector('#scheduleAttempts');
  const scheduleSaveBtn = main.querySelector('#saveSchedule');
  const scheduleStatusEl = main.querySelector('#scheduleStatus');
  const scheduleFeedbackEl = main.querySelector('#scheduleFeedback');
  const scheduleFields = [
    scheduleEnabledEl,
    scheduleTimeEl,
    scheduleTimezoneEl,
    scheduleMissedRunEl,
    scheduleRetryEl,
    scheduleAttemptsEl,
  ];
  let scheduleAvailable = false;
  let scheduleSaving = false;
  function paintSchedulePreview() {
    const preview = main.querySelector('#schedulePreview');
    if (!scheduleAvailable) { preview.textContent = 'Schedule unavailable.'; return; }
    if (!scheduleEnabledEl.checked) { preview.textContent = 'Form preview: automatic generation would be off. Save schedule to apply changes. You can still generate a Briefing manually.'; return; }
    const zone = scheduleTimezoneEl.value.trim() || 'local';
    preview.textContent = `Form preview: every day at ${scheduleTimeEl.value || '—'} · ${zone === 'local' ? 'server local time' : zone}. Save schedule to apply changes.`;
  }
  scheduleFields.forEach(el => el.addEventListener('input', paintSchedulePreview));

  function syncScheduleControls() {
    syncScheduleControlState({
      fields: scheduleFields,
      saveButton: scheduleSaveBtn,
      available: scheduleAvailable,
      saving: scheduleSaving,
    });
  }
  // The HTML starts disabled to cover the parse-to-module gap; repeat the state
  // synchronously here so future markup changes cannot reopen the early-save race.
  syncScheduleControls();

  function setScheduleFeedback(msg, { sticky = false } = {}) {
    clearTimeout(scheduleFeedbackTimer);
    scheduleFeedbackEl.textContent = msg || '';
    if (msg && !sticky) {
      scheduleFeedbackTimer = setTimeout(() => { scheduleFeedbackEl.textContent = ''; }, 5000);
    }
  }

  function paintSchedule(schedule, state) {
    if (!schedule) {
      scheduleAvailable = false;
      syncScheduleControls();
      scheduleStatusEl.dataset.state = 'off';
      scheduleStatusEl.textContent = 'Schedule settings are unavailable to this client.';
      paintSchedulePreview();
      return;
    }
    scheduleAvailable = true;
    syncScheduleControls();
    scheduleEnabledEl.checked = Boolean(schedule.enabled);
    scheduleTimeEl.value = schedule.time || '05:00';
    scheduleTimezoneEl.value = schedule.timezone || 'local';
    scheduleMissedRunEl.value = schedule.missedRun || 'skip';
    scheduleRetryEl.value = String(schedule.retryMinutes || 15);
    scheduleAttemptsEl.value = String(schedule.maxAttempts || 3);
    paintSchedulePreview();

    if (!schedule.enabled) {
      scheduleStatusEl.dataset.state = 'off';
      scheduleStatusEl.textContent = 'Off — automatic generation is not armed.';
      return;
    }
    scheduleStatusEl.dataset.state = 'on';
    const outcome = String(state?.outcome || 'scheduled').replaceAll('-', ' ');
    const attempts = Number.isInteger(state?.attempts)
      ? ` · ${state.attempts}/${schedule.maxAttempts} attempts`
      : '';
    let next = '';
    if (state?.nextAttemptAt) {
      const at = new Date(state.nextAttemptAt);
      if (Number.isFinite(at.getTime())) next = ` · next ${at.toLocaleString()}`;
    }
    const lastError = state?.lastError ? ` · ${state.lastError}` : '';
    scheduleStatusEl.textContent = `On — ${outcome}${attempts}${next}${lastError}`;
  }

  scheduleSaveBtn.addEventListener('click', async () => {
    if (!scheduleAvailable || scheduleSaving) return;
    const retryMinutes = Number(scheduleRetryEl.value);
    const maxAttempts = Number(scheduleAttemptsEl.value);
    if (!Number.isInteger(retryMinutes) || retryMinutes < 1 || retryMinutes > 1440) {
      setScheduleFeedback('Retry delay must be a whole number from 1 to 1440.', { sticky: true });
      return;
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      setScheduleFeedback('Maximum attempts must be a whole number from 1 to 10.', { sticky: true });
      return;
    }
    const briefSchedule = {
      enabled: scheduleEnabledEl.checked,
      time: scheduleTimeEl.value,
      timezone: scheduleTimezoneEl.value.trim() || 'local',
      missedRun: scheduleMissedRunEl.value,
      retryMinutes,
      maxAttempts,
    };
    scheduleSaving = true;
    syncScheduleControls();
    setScheduleFeedback('Saving…', { sticky: true });
    try {
      const response = await saveSettings({ briefSchedule });
      paintSchedule(response.briefSchedule, response.briefScheduleStatus);
      setScheduleFeedback(response.briefSchedule?.enabled
        ? 'Saved and armed.'
        : 'Saved. Automatic generation is off.');
    } catch (err) {
      setScheduleFeedback(err.message || 'Could not save the schedule.', { sticky: true });
    } finally {
      scheduleSaving = false;
      syncScheduleControls();
    }
  });

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

  // One atomic profile save; controls stay disabled until a trusted read succeeds.
  const profileCard = main.querySelector('.watch-profile');
  const profileSave = main.querySelector('#saveProfile');
  const profileStatus = main.querySelector('#profileStatus');
  const profileFeedback = main.querySelector('#profileFeedback');
  const profileFields = {
    technologies: main.querySelector('#profileTechnologies'),
    sectors: main.querySelector('#profileSectors'),
    regions: main.querySelector('#profileRegions'),
    intelligenceQuestions: main.querySelector('#profileQuestions'),
    exclusions: main.querySelector('#profileExclusions'),
  };
  const profileTeam = main.querySelector('#profileTeam');
  const horizonFields = [...profileCard.querySelectorAll('[data-profile-horizon]')];
  let profileAvailable = false;
  let savedProfileSignature = '';
  const profileSignature = () => JSON.stringify([
    ...Object.values(profileFields).map(el => el.value), profileTeam.value,
    ...horizonFields.map(el => el.checked),
  ]);
  function paintProfileEditState() {
    const terms = profileFields.technologies.value.split(/\r?\n/).map(t => t.trim()).filter(Boolean).length;
    const counter = main.querySelector('#profileTermCount');
    counter.textContent = `${terms} / 25 terms`;
    counter.classList.toggle('over-limit', terms > 25);
    main.querySelector('#profileTeamCount').textContent = `${profileTeam.value.length} / 512 characters`;
    const state = main.querySelector('#profileSaveState');
    const dirty = profileAvailable && profileSignature() !== savedProfileSignature;
    state.dataset.dirty = String(dirty);
    const label = profileAvailable ? dirty ? 'Unsaved changes' : 'Saved profile' : '';
    if (state.textContent !== label) state.textContent = label;
  }
  [...Object.values(profileFields), profileTeam, ...horizonFields].forEach(el => el.addEventListener('input', paintProfileEditState));
  function setProfileControls(disabled) {
    [...Object.values(profileFields), profileTeam, ...horizonFields, profileSave].forEach(el => { el.disabled = disabled; });
  }
  function paintProfile(profile) {
    profileAvailable = Boolean(profile && Array.isArray(profile.technologies));
    setProfileControls(!profileAvailable);
    profileStatus.dataset.state = profileAvailable ? 'info' : 'error';
    profileStatus.textContent = profileAvailable
      ? 'Declared interests · exposure requires an applicability check.'
      : 'Watch profile unavailable. Use the local operator connection or authenticate.';
    if (!profileAvailable) { paintProfileEditState(); return; }
    Object.entries(profileFields).forEach(([key, el]) => { el.value = (profile[key] || []).join('\n'); });
    profileTeam.value = profile.teamProfile || '';
    horizonFields.forEach(el => { el.checked = (profile.preferredHorizons || []).includes(Number(el.dataset.profileHorizon)); });
    savedProfileSignature = profileSignature();
    paintProfileEditState();
  }
  function setProfileFeedback(message, sticky = false) {
    clearTimeout(profileFeedbackTimer);
    profileFeedback.textContent = message;
    if (!sticky) profileFeedbackTimer = setTimeout(() => { profileFeedback.textContent = ''; }, 6000);
  }
  profileSave.addEventListener('click', async () => {
    if (!profileAvailable || profileSave.disabled) return;
    const watchProfile = Object.fromEntries(Object.entries(profileFields).map(([key, el]) => [key,
      el.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
    ]));
    watchProfile.teamProfile = profileTeam.value.trim();
    watchProfile.preferredHorizons = horizonFields.filter(el => el.checked).map(el => Number(el.dataset.profileHorizon));
    setProfileControls(true);
    setProfileFeedback('Saving…', true);
    try {
      const response = await saveSettings({ watchProfile });
      paintProfile(response.watchProfile);
      setProfileFeedback('Saved. Open Wire to inspect matches; ranking updates on the next refresh.');
    } catch (err) {
      setProfileFeedback(err.message || 'Profile save failed. Your edits are still here.', true);
    } finally {
      setProfileControls(!profileAvailable);
    }
  });
  function paintRules(rules) {
    main.querySelector('#alertRules').innerHTML = !Array.isArray(rules)
      ? '<p class="settings-help">Rules are available to the authenticated operator.</p>'
      : rules.length ? rules.map(r => `<div class="alert-rule-row"><span class="alert-rule-pattern">${escapeHtml(String(r.pattern))}</span><span class="alert-rule-boost">+${escapeHtml(String(r.boost))}</span></div>`).join('')
        : '<p class="settings-help">No server alert rules configured.</p>';
  }
  fetchSettings().then(d => {
    if (!ownsView()) return;
    const storageStatus = main.querySelector('#settingsStorageStatus');
    if (storageStatus) {
      storageStatus.hidden = d.storage?.status !== 'error';
      storageStatus.textContent = d.storage?.status === 'error'
        ? d.storage.message || 'Saved settings could not be read. Repair the settings file before saving changes.'
        : '';
    }
    paintRules(d.alertRules);
    paintProfile(d.watchProfile);
    paintSchedule(d.briefSchedule, d.briefScheduleStatus);
  }).catch(() => {
    if (!ownsView()) return;
    paintRules(null); paintProfile(null); paintSchedule(null, null);
  });
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

export function unmount() {
  mountVersion++;
  stopSystemHealth?.();
  stopSystemHealth = null;
  clearTimeout(feedbackTimer);
  clearTimeout(armTimer);
  clearTimeout(profileFeedbackTimer);

  clearTimeout(scheduleFeedbackTimer);
}

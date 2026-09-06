// BlueTeam.News — Settings: the Anthropic key (server-persisted) plus appearance
// (theme + accent, stored locally). The only view that writes to the server.

import { fetchSettings, saveSettings, verifyKey } from '../core/api.js';
import { escapeHtml } from '../core/sanitize.js';
import { ACCENTS, getThemePreference, getAccent, applyTheme, applyAccent } from '../core/theme.js';
import { emit, on, off } from '../core/store.js';
import { syncScheduleControlState } from './schedule-form.js';
import { mountSystemHealth } from './system-health.js';
import { mountWallDisplaySettings } from './wall-display.js';
import { formatEventTime } from '../core/brief-date.js';
import { createSettingsDrafts, lines, profileErrors, scheduleErrors, timezoneOptions, nextRunLabel, settingsLoadFailure } from './form-state.js';

let feedbackTimer = null;
let profileFeedbackTimer = null;

let scheduleFeedbackTimer = null;
let stopSystemHealth = null;
let mountVersion = 0;
const drafts = createSettingsDrafts();
let stopSectionIndex = null;
let stopWallDisplaySettings = null;
let scheduleStatusTimer = null;

export function render(main) {
  const version = ++mountVersion;
  const ownsView = () => version === mountVersion;
  stopSystemHealth?.();
  stopSectionIndex?.();
  stopWallDisplaySettings?.();
  clearInterval(scheduleStatusTimer);
  main.innerHTML = `
    <div class="settings">
      <header class="settings-head">
        <h1 class="view-title">Settings</h1>
        <p class="settings-sub">Server configuration and your reading preferences.</p>
      </header>
      <nav class="settings-index" aria-label="Settings sections">
          <label class="settings-section-picker">Section<select id="settingsSection" aria-label="Settings section"><option value="set-profile">Watch profile</option><option value="set-ai">AI Briefing</option><option value="set-schedule">Schedule</option><option value="set-wall">Wall display</option><option value="set-theme">Appearance</option><option value="systemHealth">System health</option></select></label>
          <div class="settings-index-links">
          <a href="#set-profile">Watch profile</a><a href="#set-ai">AI Briefing</a><a href="#set-schedule">Schedule</a><a href="#set-wall">Wall display</a><a href="#set-theme">Appearance</a><a href="#systemHealth">System health</a>
          </div>
          <details id="settingsChanges" class="settings-changes" hidden><summary id="settingsChangesSummary">Changes</summary><ul id="settingsChangesList"></ul><p>Edits stay in this open app until saved or discarded.</p></details>
      </nav>
      <div class="settings-content">
      <div class="settings-load-notice" id="settingsLoadNotice" hidden><p id="settingsLoadMessage" role="status"></p><button class="btn-ghost-sm" id="retrySettings" type="button">Retry settings</button></div>
      <div class="settings-status" id="settingsStorageStatus" data-state="error" role="alert" hidden></div>

      <section class="settings-card watch-profile" aria-labelledby="set-profile">
        <div class="settings-section-heading"><h2 id="set-profile">Watch profile</h2><span class="settings-scope">Shared server</span></div>
        <p class="settings-note">Follow technologies and topics in Wire. A match indicates interest; check applicability to establish exposure.</p>
        <div class="settings-status" id="profileStatus" data-state="loading" role="status" aria-live="polite">Loading your profile…</div>
        <div class="settings-field-heading"><label class="settings-label" for="profileTechnologies">Technologies and watch terms</label><span class="settings-counter" id="profileTermCount">0 / 25 terms</span></div>
        <textarea id="profileTechnologies" class="settings-input settings-textarea" rows="3" placeholder="Fortinet&#10;Microsoft 365&#10;C++" aria-describedby="profileTermsHelp" disabled></textarea>
        <p class="settings-help" id="profileTermsHelp">One term per line · 64 characters per term.</p>
        <div class="profile-grid">
          <label><span class="settings-label">Sectors</span><textarea id="profileSectors" class="settings-input settings-textarea" rows="2" placeholder="Healthcare" disabled></textarea></label>
          <label><span class="settings-label">Operating regions</span><textarea id="profileRegions" class="settings-input settings-textarea" rows="2" placeholder="North America&#10;Europe" disabled></textarea></label>
        </div>
        <p class="settings-help">One per line: up to 20 sectors or 100 regions; 128 characters each.</p>
        <details class="profile-details">
          <summary>Questions, exclusions, and analytical horizons</summary>
          <label class="settings-label" for="profileQuestions">Intelligence questions and topics</label>
          <textarea id="profileQuestions" class="settings-input settings-textarea" rows="3" placeholder="Has the vendor changed the affected versions?" disabled></textarea>
          <p class="settings-help">Up to 100 questions, 300 characters each. Guides Briefing and matches related Wire reporting by text overlap. Question relevance does not establish local exposure.</p>
          <label class="settings-label" for="profileExclusions">Lower-interest topics</label>
          <textarea id="profileExclusions" class="settings-input settings-textarea" rows="2" placeholder="Product marketing" disabled></textarea>
          <p class="settings-help">One per line, up to 25. Exclusions are advisory: Wire keeps matching reporting visible, and urgent threats remain eligible.</p>
          <fieldset class="profile-horizons" id="profileHorizons" tabindex="-1"><legend class="settings-label">Preferred analytical horizons</legend>
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
          <button class="btn-ghost-sm" id="discardProfile" type="button" hidden>Discard changes</button>
          <span class="profile-save-state" id="profileSaveState" role="status"></span>
          <span class="settings-feedback" id="profileFeedback" role="status" aria-live="polite"></span>
        </div>
        <details class="profile-details"><summary>When profile changes take effect</summary><p class="settings-help">Saved changes affect everyone using this server. Matches update when Wire loads; ranking updates on the next collection refresh. Clearing a field removes that watch.</p></details>
        <p class="settings-help" id="profileProvenance"></p>
        <details class="profile-details"><summary>Server alert rules</summary>
          <p class="settings-help">Additional priority rules configured in <code>config.json</code>.</p>
          <div class="alert-rules-list" id="alertRules" role="status" aria-live="polite"></div>
        </details>
      </section>
      <section class="settings-card" aria-labelledby="set-ai">
        <div class="settings-section-heading"><h2 id="set-ai">AI Briefing</h2><span class="settings-scope">Shared server</span></div>
        <p class="settings-note">Enable generation with an Anthropic API key. Generation and key verification contact Anthropic and may incur charges. Wall and Wire work without a key.</p>
        <div class="settings-status" id="aiStatus" data-state="loading" role="status" aria-live="polite">Checking…</div>
        <label class="settings-label" for="apiKey">Anthropic API key</label>
        <div class="key-row">
          <div class="key-input-wrap">
            <input id="apiKey" class="settings-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" aria-describedby="keyHelp" disabled>
            <button class="key-reveal" id="revealKey" type="button" aria-label="Show key" aria-pressed="false" title="Show / hide key" tabindex="0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          </div>
          <button class="btn-ghost-sm" id="verifyKey" type="button" title="Make one tiny test call to confirm the key works" disabled>Verify</button>
          <button class="btn-primary" id="saveKey" type="button" disabled>Save</button>
        </div>
        <p class="settings-help" id="keyHelp">The saved key enables generation for everyone on this server. <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">Get an Anthropic key</a>. Unsaved keys stay in this tab's memory.</p>
        <div class="settings-row-actions">
          <button class="btn-ghost-sm destructive" id="clearKey" type="button" disabled>Remove key</button>
          <button class="btn-ghost-sm" id="discardKey" type="button" hidden>Discard typed key</button>
          <span class="profile-save-state" id="keySaveState" role="status"></span>
          <span class="settings-feedback" id="keyFeedback" role="status" aria-live="polite"></span>
        </div>
        <div class="key-remove-confirm" id="keyRemoveConfirm" hidden role="group" aria-labelledby="keyRemoveMessage"><p id="keyRemoveMessage">Remove the saved key? New Briefings will be unavailable until a key is added. Saved Briefings remain readable.</p><button class="btn-ghost-sm destructive armed" id="confirmRemoveKey" type="button">Remove saved key</button><button class="btn-ghost-sm" id="cancelRemoveKey" type="button">Cancel</button></div>
        <details class="profile-details"><summary>Storage and network details</summary><p class="settings-help">The key is saved in <code>data/settings.local.json</code> (gitignored). Generation sends prompts to Anthropic and reports model, tokens, and estimated cost. Source collection and optional webhooks have separate <a href="https://github.com/ryanshrier/blueteam/blob/main/docs/operations.md#network-behavior" target="_blank" rel="noopener noreferrer">documented outbound paths</a>.</p></details>
      </section>

      <section class="settings-card" aria-labelledby="set-schedule">
        <div class="settings-section-heading"><h2 id="set-schedule">Scheduled Briefing</h2><span class="settings-scope">Shared server</span></div>
        <div class="settings-status" id="scheduleStatus" data-state="loading" role="status" aria-live="polite">Checking…</div>
        <label class="schedule-toggle" for="scheduleEnabled">
          <input id="scheduleEnabled" type="checkbox" disabled>
          <span>
            <strong>Generate automatically</strong>
            <small>Uses this server's Anthropic API key and may incur charges. Save to apply.</small>
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
            <input id="scheduleTimezone" class="settings-input" type="text" value="local" list="scheduleTimezones" placeholder="Search a city or timezone" maxlength="100" spellcheck="false" aria-label="Timezone" aria-describedby="scheduleTimezoneHelp" disabled>
            <datalist id="scheduleTimezones">${timezoneOptions().map(zone => `<option value="${escapeHtml(zone)}">${zone === 'local' ? 'Server local timezone' : escapeHtml(zone.replaceAll('_', ' '))}</option>`).join('')}</datalist>
            <span class="settings-help" id="scheduleTimezoneHelp">Search by city. “local” follows the server's timezone.</span>
          </label>
        </div>
        <details class="profile-details" id="scheduleAdvanced"><summary>Run status and retry behavior</summary><p class="settings-help" id="scheduleChecked"></p><div class="schedule-grid">
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
        </details>
        <div class="settings-row-actions">
          <button class="btn-primary" id="saveSchedule" type="button" disabled>Save schedule</button>
          <button class="btn-ghost-sm" id="discardSchedule" type="button" hidden>Discard changes</button>
          <span class="profile-save-state" id="scheduleSaveState" role="status"></span>
          <span class="settings-feedback" id="scheduleFeedback" role="status" aria-live="polite"></span>
        </div>
      </section>

      <section class="settings-card wall-display-settings" aria-labelledby="set-wall"></section>

      <section class="settings-card" aria-labelledby="set-theme">
        <div class="settings-section-heading"><h2 id="set-theme">Appearance</h2><span class="settings-scope">This browser · automatic save</span></div>
        <p class="settings-note">Changes apply immediately to your reading preferences.</p>
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
        <p class="settings-help">Applies to the header, Wire, Briefing, and Wall reading mode. Wall presentation mode keeps its dark watchfloor palette.</p>
      </section>

      <section class="settings-card system-health" id="systemHealth" aria-labelledby="set-health" tabindex="-1"></section>
      </div>
    </div>
  `;
  stopSystemHealth = mountSystemHealth(main.querySelector('#systemHealth'));
  stopWallDisplaySettings = mountWallDisplaySettings(main.querySelector('.wall-display-settings'));
  stopSectionIndex = mountSectionIndex(main);
  const changedSections = new Map();
  const sectionNames = { 'set-ai': 'AI Briefing', 'set-profile': 'Watch profile', 'set-schedule': 'Schedule' };
  function setChangedFields(section, fields) {
    changedSections.set(section, fields);
    const card = main.querySelector(`#${section}`)?.closest('.settings-card');
    if (card) card.dataset.dirty = String(fields.length > 0);
    const link = main.querySelector(`.settings-index-links a[href="#${section}"]`);
    if (link) {
      link.dataset.dirty = String(fields.length > 0);
      link.textContent = `${sectionNames[section]}${fields.length ? ' · Unsaved' : ''}`;
    }
    const option = main.querySelector(`#settingsSection option[value="${section}"]`);
    if (option) option.textContent = sectionNames[section];
    const all = [...changedSections.entries()].flatMap(([name, entries]) => entries.map(field => ({ ...field, section: sectionNames[name] })));
    main.querySelector('#settingsChanges').hidden = !all.length;
    main.querySelector('#settingsChangesSummary').textContent = `Changes · ${all.length}`;
    main.querySelector('#settingsChangesSummary').setAttribute('aria-label', `Review ${all.length} unsaved ${all.length === 1 ? 'field' : 'fields'}`);
    main.querySelector('#settingsChangesList').innerHTML = all.map(field => `<li><a href="#${escapeHtml(field.id)}">${escapeHtml(field.section)} · ${escapeHtml(field.label)}</a></li>`).join('');
  }
  main.querySelector('#settingsChangesList').addEventListener('click', event => {
    const link = event.target.closest('a');
    const field = link && main.querySelector(link.getAttribute('href'));
    if (!field) return;
    event.preventDefault();
    main.querySelector('#settingsChanges').open = false;
    for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    field.focus(); field.scrollIntoView({ block: 'center' });
  });

  // ── AI key ──
  const input = main.querySelector('#apiKey');
  const statusEl = main.querySelector('#aiStatus');
  const feedback = main.querySelector('#keyFeedback');
  const saveBtn = main.querySelector('#saveKey');
  const verifyBtn = main.querySelector('#verifyKey');
  const clearBtn = main.querySelector('#clearKey');
  const revealBtn = main.querySelector('#revealKey');
  const keyConfirmation = main.querySelector('#keyRemoveConfirm');
  const confirmRemove = main.querySelector('#confirmRemoveKey');
  const cancelRemove = main.querySelector('#cancelRemoveKey');
  const discardKey = main.querySelector('#discardKey');
  let canEdit = false;
  let keyBusy = false;
  let activeAi = null;
  let verifiedCandidate = null;
  input.value = drafts.get('key') || '';
  function syncKeyControls() {
    const envManaged = activeAi?.keySource === 'env';
    input.disabled = !canEdit || envManaged || keyBusy;
    saveBtn.disabled = input.disabled || !input.value.trim().startsWith('sk-ant-');
    verifyBtn.disabled = !canEdit || !activeAi || keyBusy;
    if (!keyBusy) verifyBtn.textContent = input.value.trim() ? 'Verify entered key' : 'Verify saved key';
    clearBtn.disabled = !canEdit || envManaged || !activeAi?.enabled || keyBusy;
    confirmRemove.disabled = clearBtn.disabled;
    discardKey.hidden = !input.value;
    discardKey.disabled = keyBusy;
    main.querySelector('#keySaveState').textContent = input.value ? verifiedCandidate === input.value.trim() ? 'Verified · not saved' : 'Unsaved key' : '';
    setChangedFields('set-ai', input.value ? [{ id: 'apiKey', label: 'Entered API key' }] : []);
  }

  // Transient feedback auto-dismisses so it never lingers as a second stale truth
  // beside the repainted status; sticky messages (the env notice, the format hint) hold.
  function setFeedback(msg, { sticky = false } = {}) {
    clearTimeout(feedbackTimer);
    feedback.textContent = msg || '';
    if (msg && !sticky) feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 4000);
  }

  function paintStatus(ai) {
    activeAi = ai;
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
    syncKeyControls();
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

  async function save(value) {
    if (!canEdit || keyBusy || activeAi?.keySource === 'env') return;
    keyBusy = true;
    syncKeyControls();
    setFeedback('Saving…', { sticky: true });
    try {
      const d = await saveSettings({ anthropicKey: value });
      drafts.clearIf('key', value);
      if (!ownsView()) return;
      paintStatus(d.ai);
      if (!(d.ai?.keySource === 'env')) setFeedback(value ? 'Saved' : 'Removed');   // env path keeps its sticky notice
      input.setAttribute('aria-describedby', 'keyHelp');
      if (value) input.value = '';
      saveBtn.disabled = true;
      syncReveal(false);
    } catch (err) {
      if (!ownsView()) return;
      setFeedback(err.message || 'Save failed.', { sticky: true });
      input.setAttribute('aria-describedby', 'keyHelp keyFeedback');
    } finally {
      keyBusy = false;
      if (ownsView()) syncKeyControls();
    }
  }

  // Plausible-key gate: block an obvious mis-paste before the round-trip and
  // wire the error to the field for screen readers; revert when it looks ok.
  function validateKeyInput() {
    const v = input.value.trim();
    drafts.set('key', v || null);
    syncKeyControls();
    if (v && !v.startsWith('sk-ant-')) {
      saveBtn.disabled = true;
      setFeedback('Anthropic keys start with "sk-ant-" — check the paste.', { sticky: true });
      input.setAttribute('aria-describedby', 'keyHelp keyFeedback');
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
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

  function disarmClear() {
    keyConfirmation.hidden = true;
    clearBtn.setAttribute('aria-expanded', 'false');
  }
  clearBtn.setAttribute('aria-controls', 'keyRemoveConfirm');
  clearBtn.setAttribute('aria-expanded', 'false');
  clearBtn.addEventListener('click', () => {
    if (clearBtn.disabled) return;
    keyConfirmation.hidden = false;
    clearBtn.setAttribute('aria-expanded', 'true');
    cancelRemove.focus();
  });
  cancelRemove.addEventListener('click', () => { disarmClear(); clearBtn.focus(); });
  confirmRemove.addEventListener('click', () => {
    if (clearBtn.disabled) return;
    disarmClear();
    clearBtn.focus();
    void save('');
  });
  discardKey.addEventListener('click', () => { input.value = ''; drafts.set('key', null); syncReveal(false); validateKeyInput(); input.focus(); });

  // Verify — one cheap server-side call confirms the key actually works, catching
  // a well-formed-but-dead key before a full brief 503s. Verifies the typed key, or the
  // active key when the field is empty (e.g. the env key).
  verifyBtn.addEventListener('click', async () => {
    if (!canEdit || keyBusy || verifyBtn.disabled) return;
    const candidate = input.value.trim();
    if (candidate && !candidate.startsWith('sk-ant-')) { validateKeyInput(); return; }
    keyBusy = true;
    syncKeyControls();
    const prevLabel = verifyBtn.textContent;
    verifyBtn.textContent = 'Verifying…';
    setFeedback('Verifying key…', { sticky: true });
    try {
      const r = await verifyKey(candidate);
      if (!ownsView()) return;
      if (r.valid === true) {
        verifiedCandidate = candidate || null;
        setFeedback(`${candidate ? 'Entered key verified; save to activate it.' : 'Saved key verified.'}${r.note ? ` — ${r.note}` : ''}`, { sticky: Boolean(candidate) });
      }
      else if (r.valid === false) setFeedback(r.error || 'Key rejected.', { sticky: true });
      else setFeedback(r.error || 'Could not verify the key.', { sticky: true });
    } catch (err) {
      if (!ownsView()) return;
      setFeedback(err.message || 'Verification failed.', { sticky: true });
    } finally {
      keyBusy = false;
      if (ownsView()) { verifyBtn.textContent = prevLabel; syncKeyControls(); }
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
  let savedSchedule = null;
  let savedScheduleStatus = null;
  const scheduleMap = { enabled: scheduleEnabledEl, time: scheduleTimeEl, timezone: scheduleTimezoneEl,
    missedRun: scheduleMissedRunEl, retryMinutes: scheduleRetryEl, maxAttempts: scheduleAttemptsEl };
  const scheduleDraft = () => ({ enabled: scheduleEnabledEl.checked, time: scheduleTimeEl.value,
    timezone: scheduleTimezoneEl.value.trim(), missedRun: scheduleMissedRunEl.value,
    retryMinutes: scheduleRetryEl.value, maxAttempts: scheduleAttemptsEl.value });
  const scheduleSignature = value => JSON.stringify({ ...value, retryMinutes: Number(value?.retryMinutes), maxAttempts: Number(value?.maxAttempts) });
  const scheduleDirty = () => scheduleAvailable && scheduleSignature(scheduleDraft()) !== scheduleSignature(savedSchedule);
  function applyScheduleFields(schedule) {
    scheduleEnabledEl.checked = Boolean(schedule.enabled);
    scheduleTimeEl.value = schedule.time || '05:00';
    scheduleTimezoneEl.value = schedule.timezone || 'local';
    scheduleMissedRunEl.value = schedule.missedRun || 'skip';
    scheduleRetryEl.value = String(schedule.retryMinutes ?? 15);
    scheduleAttemptsEl.value = String(schedule.maxAttempts ?? 3);
  }
  function paintSchedulePreview() {
    const preview = main.querySelector('#schedulePreview');
    if (!scheduleAvailable) { preview.hidden = true; return; }
    const dirty = scheduleDirty();
    const labels = { enabled: 'Automatic generation', time: 'Time', timezone: 'Timezone', missedRun: 'Missed-run policy', retryMinutes: 'Retry delay', maxAttempts: 'Attempt limit' };
    const draft = scheduleDraft();
    setChangedFields('set-schedule', dirty ? Object.entries(scheduleMap).filter(([key]) => String(draft[key]) !== String(savedSchedule?.[key]))
      .map(([key, field]) => ({ id: field.id, label: labels[key] })) : []);
    const state = main.querySelector('#scheduleSaveState');
    state.textContent = dirty ? 'Unsaved changes' : 'Saved schedule';
    state.dataset.dirty = String(dirty);
    main.querySelector('#discardSchedule').hidden = !dirty;
    const zone = scheduleTimezoneEl.value.trim() || 'local';
    const value = scheduleEnabledEl.checked ? `Every day at ${scheduleTimeEl.value || '—'} · ${zone === 'local' ? 'server local time' : zone}.` : 'Automatic generation is off.';
    preview.textContent = dirty ? `Proposed change: ${value} Save to apply.` : value;
    preview.hidden = !dirty;
    syncScheduleControls();
  }
  scheduleFields.forEach(el => el.addEventListener('input', () => {
    if (!scheduleAvailable) return;
    clearFieldError(el);
    drafts.set('schedule', scheduleDirty() ? scheduleDraft() : null);
    paintSchedulePreview();
  }));

  function syncScheduleControls() {
    syncScheduleControlState({
      fields: scheduleFields,
      saveButton: scheduleSaveBtn,
      available: scheduleAvailable,
      saving: scheduleSaving,
      dirty: scheduleDirty(),
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

  function paintSchedule(schedule, state, restoreDraft = false) {
    if (!schedule) {
      scheduleAvailable = false;
      syncScheduleControls();
      scheduleStatusEl.dataset.state = 'off';
      scheduleStatusEl.textContent = 'Schedule unavailable. See the connection notice above.';
      paintSchedulePreview();
      return;
    }
    scheduleAvailable = true;
    savedSchedule = { enabled: Boolean(schedule.enabled), time: schedule.time || '05:00', timezone: schedule.timezone || 'local',
      missedRun: schedule.missedRun || 'skip', retryMinutes: schedule.retryMinutes ?? 15, maxAttempts: schedule.maxAttempts ?? 3 };
    savedScheduleStatus = state;
    applyScheduleFields(restoreDraft && drafts.get('schedule') || savedSchedule);
    if (!scheduleDirty()) drafts.set('schedule', null);
    paintSchedulePreview();
    paintScheduleHealth(schedule, state);
  }
  function paintScheduleHealth(schedule, state) {
    if (!schedule) return;
    main.querySelector('#scheduleChecked').textContent = `Run status checked ${formatEventTime(new Date().toISOString())} · refreshes every 30 seconds`;
    if (!schedule.enabled) {
      scheduleStatusEl.hidden = false;
      scheduleStatusEl.dataset.state = 'off';
      scheduleStatusEl.textContent = 'Automation · Disabled';
      return;
    }
    scheduleStatusEl.hidden = false;
    scheduleStatusEl.dataset.state = /failed|blocked|error|exhausted/i.test(state?.outcome || '') ? 'error' : 'info';
    const outcome = String(state?.outcome || 'scheduled').replaceAll('-', ' ');
    const attempts = Number.isInteger(state?.attempts)
      ? ` · ${state.attempts}/${schedule.maxAttempts} attempts`
      : '';
    let next = '';
    if (state?.nextAttemptAt) {
      const label = nextRunLabel(state.nextAttemptAt, state.nextTimezone || schedule.timezone);
      if (label) next = ` · Next run: ${label}`;
    }
    const lastError = state?.lastError ? ` · ${state.lastError}` : '';
    scheduleStatusEl.textContent = `Enabled · Last run: ${outcome}${attempts}${next}${lastError}`;
  }
  main.querySelector('#discardSchedule').addEventListener('click', () => {
    if (scheduleSaving || !savedSchedule) return;
    drafts.set('schedule', null);
    Object.values(scheduleMap).forEach(clearFieldError);
    paintSchedule(savedSchedule, savedScheduleStatus);
    scheduleEnabledEl.focus();
  });

  scheduleSaveBtn.addEventListener('click', async () => {
    if (!scheduleAvailable || scheduleSaving) return;
    if (!scheduleDirty()) return;
    const submitted = scheduleDraft();
    const errors = scheduleErrors(submitted);
    if (showFieldErrors(scheduleMap, errors)) {
      setScheduleFeedback('Check the highlighted schedule fields.', { sticky: true });
      return;
    }
    const briefSchedule = {
      ...submitted, retryMinutes: Number(submitted.retryMinutes), maxAttempts: Number(submitted.maxAttempts),
    };
    scheduleSaving = true;
    syncScheduleControls();
    setScheduleFeedback('Saving…', { sticky: true });
    try {
      const response = await saveSettings({ briefSchedule });
      drafts.clearIf('schedule', submitted);
      if (!ownsView()) return;
      paintSchedule(response.briefSchedule, response.briefScheduleStatus);
      setScheduleFeedback(response.briefSchedule?.enabled
        ? 'Saved and armed.'
        : 'Saved. Automatic generation is off.');
    } catch (err) {
      if (!ownsView()) return;
      setScheduleFeedback(err.message || 'Could not save the schedule.', { sticky: true });
    } finally {
      scheduleSaving = false;
      if (ownsView()) syncScheduleControls();
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
  let profileSaving = false;
  let savedProfile = null;
  let savedProfileSignature = '';
  const profileDraft = () => ({ ...Object.fromEntries(Object.entries(profileFields).map(([key, el]) => [key, el.value])),
    teamProfile: profileTeam.value, preferredHorizons: horizonFields.filter(el => el.checked).map(el => Number(el.dataset.profileHorizon)) });
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
    const names = { technologies: 'Technologies', sectors: 'Sectors', regions: 'Regions', intelligenceQuestions: 'Questions and topics', exclusions: 'Lower-interest topics' };
    const changes = Object.entries(profileFields).filter(([key, field]) => field.value !== (savedProfile?.[key] || []).join('\n'))
      .map(([key, field]) => ({ id: field.id, label: names[key] }));
    if (profileTeam.value !== (savedProfile?.teamProfile || '')) changes.push({ id: 'profileTeam', label: 'Team context' });
    if (JSON.stringify(horizonFields.filter(field => field.checked).map(field => Number(field.dataset.profileHorizon))) !== JSON.stringify(savedProfile?.preferredHorizons || [])) changes.push({ id: 'profileHorizons', label: 'Preferred horizons' });
    setChangedFields('set-profile', dirty ? changes : []);
    profileSave.disabled = !profileAvailable || profileSaving || !dirty;
    main.querySelector('#discardProfile').hidden = !dirty;
    state.dataset.dirty = String(dirty);
    const label = profileAvailable ? dirty ? 'Unsaved changes' : 'Saved profile' : '';
    if (state.textContent !== label) state.textContent = label;
  }
  [...Object.values(profileFields), profileTeam, ...horizonFields].forEach(el => el.addEventListener('input', () => {
    clearFieldError(el);
    paintProfileEditState();
    if (profileAvailable) drafts.set('profile', profileSignature() !== savedProfileSignature ? profileDraft() : null);
  }));
  function setProfileControls(disabled) {
    [...Object.values(profileFields), profileTeam, ...horizonFields, profileSave].forEach(el => { el.disabled = disabled; });
  }
  function paintProfile(profile, restoreDraft = false) {
    profileAvailable = Boolean(profile && Array.isArray(profile.technologies));
    setProfileControls(!profileAvailable);
    profileStatus.dataset.state = profileAvailable ? 'info' : 'off';
    profileStatus.textContent = profileAvailable
      ? '' : 'Watch profile unavailable. See the connection notice above.';
    profileStatus.hidden = profileAvailable;
    if (!profileAvailable) { paintProfileEditState(); return; }
    Object.entries(profileFields).forEach(([key, el]) => { el.value = (profile[key] || []).join('\n'); });
    profileTeam.value = profile.teamProfile || '';
    horizonFields.forEach(el => { el.checked = (profile.preferredHorizons || []).includes(Number(el.dataset.profileHorizon)); });
    savedProfile = structuredClone(profile);
    const inheritedFields = Object.entries(profile.provenance || {}).filter(([, origin]) => origin !== 'operator-declared').map(([field]) => field.replace(/([A-Z])/g, ' $1').toLowerCase());
    main.querySelector('#profileProvenance').textContent = inheritedFields.length ? `Inherited server or legacy settings: ${inheritedFields.join(', ')}. Saving makes these explicit operator declarations.` : 'Effective values are saved operator declarations.';
    savedProfileSignature = profileSignature();
    const draft = restoreDraft && drafts.get('profile');
    if (draft) {
      Object.entries(profileFields).forEach(([key, el]) => { el.value = draft[key] || ''; });
      profileTeam.value = draft.teamProfile || '';
      horizonFields.forEach(el => { el.checked = (draft.preferredHorizons || []).includes(Number(el.dataset.profileHorizon)); });
    }
    if (profileSignature() === savedProfileSignature) drafts.set('profile', null);
    paintProfileEditState();
  }
  function setProfileFeedback(message, sticky = false) {
    clearTimeout(profileFeedbackTimer);
    profileFeedback.textContent = message;
    if (!sticky) profileFeedbackTimer = setTimeout(() => { profileFeedback.textContent = ''; }, 6000);
  }
  profileSave.addEventListener('click', async () => {
    if (!profileAvailable || profileSave.disabled) return;
    const submitted = profileDraft();
    if (showFieldErrors({ ...profileFields, teamProfile: profileTeam }, profileErrors(submitted))) {
      setProfileFeedback('Check the highlighted profile fields.', true);
      return;
    }
    const watchProfile = Object.fromEntries(Object.entries(profileFields).map(([key, el]) => [key,
      lines(el.value),
    ]));
    watchProfile.teamProfile = profileTeam.value.trim();
    watchProfile.preferredHorizons = horizonFields.filter(el => el.checked).map(el => Number(el.dataset.profileHorizon));
    profileSaving = true;
    setProfileControls(true);
    setProfileFeedback('Saving…', true);
    try {
      const response = await saveSettings({ watchProfile });
      drafts.clearIf('profile', submitted);
      if (!ownsView()) return;
      paintProfile(response.watchProfile);
      setProfileFeedback('Saved. Open Wire to inspect matches; ranking updates on the next refresh.');
    } catch (err) {
      if (!ownsView()) return;
      setProfileFeedback(err.message || 'Profile save failed. Your edits are still here.', true);
    } finally {
      profileSaving = false;
      if (ownsView()) { setProfileControls(!profileAvailable); paintProfileEditState(); }
    }
  });
  main.querySelector('#discardProfile').addEventListener('click', () => {
    if (profileSaving || !savedProfile) return;
    drafts.set('profile', null);
    [...Object.values(profileFields), profileTeam].forEach(clearFieldError);
    paintProfile(savedProfile);
    profileFields.technologies.focus();
  });
  function paintRules(rules) {
    main.querySelector('#alertRules').innerHTML = !Array.isArray(rules)
      ? '<p class="settings-help">Rules unavailable. See the connection notice above.</p>'
      : rules.length ? rules.map(r => `<div class="alert-rule-row"><span class="alert-rule-pattern">${escapeHtml(String(r.pattern))}</span><span class="alert-rule-boost">+${escapeHtml(String(r.boost))}</span></div>`).join('')
        : '<p class="settings-help">No server alert rules configured.</p>';
  }
  let loadingSettings = false;
  const retrySettings = main.querySelector('#retrySettings');
  async function loadSettings() {
    if (loadingSettings) return;
    loadingSettings = true;
    retrySettings.disabled = true;
    retrySettings.textContent = 'Loading…';
    try {
    const d = await fetchSettings();
    if (!ownsView()) return;
    canEdit = Boolean(d.watchProfile && d.briefSchedule && d.storage?.status !== 'error');
    const restricted = !d.watchProfile || !d.briefSchedule;
    main.querySelector('#settingsLoadNotice').hidden = canEdit;
    main.querySelector('#settingsLoadMessage').textContent = restricted ? settingsLoadFailure(null, true)
      : !canEdit ? 'Saved settings need repair. Check the storage error below, then retry.' : '';
    const storageStatus = main.querySelector('#settingsStorageStatus');
    if (storageStatus) {
      storageStatus.hidden = d.storage?.status !== 'error';
      storageStatus.textContent = d.storage?.status === 'error'
        ? d.storage.message || 'Saved settings could not be read. Repair the settings file before saving changes.'
        : '';
    }
    paintRules(d.alertRules);
    paintStatus(d.ai);
    paintProfile(canEdit ? d.watchProfile : null, true);
    paintSchedule(canEdit ? d.briefSchedule : null, d.briefScheduleStatus, true);
    } catch (err) {
    if (!ownsView()) return;
    canEdit = false;
    paintStatus(null);
    main.querySelector('#settingsLoadNotice').hidden = false;
    main.querySelector('#settingsLoadMessage').textContent = settingsLoadFailure(err);
    paintRules(null); paintProfile(null); paintSchedule(null, null);
    } finally {
      loadingSettings = false;
      if (ownsView()) { retrySettings.disabled = false; retrySettings.textContent = 'Retry settings'; }
    }
  }
  retrySettings.addEventListener('click', loadSettings);
  void loadSettings();
  let refreshingRunStatus = false;
  scheduleStatusTimer = setInterval(async () => {
    if (!ownsView() || refreshingRunStatus || !scheduleAvailable || scheduleSaving || document.hidden) return;
    refreshingRunStatus = true;
    try {
      const current = await fetchSettings();
      if (!ownsView()) return;
      savedScheduleStatus = current.briefScheduleStatus;
      paintScheduleHealth(current.briefSchedule, current.briefScheduleStatus);
    } catch {
      if (ownsView()) main.querySelector('#scheduleChecked').textContent = 'Run status could not be refreshed. Showing the last check; draft fields are retained.';
    } finally { refreshingRunStatus = false; }
  }, 30_000);
}
// Arrow-key navigation for a radiogroup: Left/Up and Right/Down move the selection
// (radio convention: moving focus selects), Home/End jump to the ends. Roving tabindex
// is maintained by the caller's paint function.
function clearFieldError(field) {
  if (!field?.id) return;
  const errorId = `${field.id}-error`;
  field.removeAttribute('aria-invalid');
  const describedBy = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== errorId);
  if (describedBy.length) field.setAttribute('aria-describedby', describedBy.join(' '));
  else field.removeAttribute('aria-describedby');
  document.getElementById(errorId)?.remove();
}
function showFieldErrors(fields, errors) {
  Object.values(fields).forEach(clearFieldError);
  let first = null;
  for (const [key, message] of Object.entries(errors)) {
    const field = fields[key];
    if (!field) continue;
    const error = document.createElement('p');
    error.id = `${field.id}-error`;
    error.className = 'settings-field-error';
    error.textContent = message;
    field.insertAdjacentElement('afterend', error);
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', `${field.getAttribute('aria-describedby') || ''} ${error.id}`.trim());
    first ||= field;
  }
  if (first) {
    for (let node = first.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    first.focus();
  }
  return Boolean(first);
}

function mountSectionIndex(main) {
  const nav = main.querySelector('.settings-index');
  const picker = main.querySelector('#settingsSection');
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const targets = links.map(link => main.querySelector(link.getAttribute('href')));
  let frame = null;
  let fragmentFrame = null;
  let selectedLanding = null;
  let stopped = false;
  const update = () => {
    frame = null;
    if (stopped) return;
    const header = document.getElementById('appHeader')?.getBoundingClientRect().height || 0;
    const compact = window.matchMedia('(max-width: 1000px)').matches;
    const top = header + (compact ? nav.getBoundingClientRect().height : 0) + 28;
    const scrollPadding = parseFloat(window.getComputedStyle?.(document.documentElement).scrollPaddingTop) || 0;
    let current = 0;
    targets.forEach((target, index) => {
      if (!target) return;
      // Use the browser's actual anchor landing offset, including the sticky
      // mobile picker margin, so arriving at a heading selects that section.
      const margin = parseFloat(window.getComputedStyle?.(target).scrollMarginTop) || 0;
      if (target.getBoundingClientRect().top <= Math.max(top, scrollPadding + margin) + 2) current = index;
    });
    if (selectedLanding && Math.abs(window.scrollY - selectedLanding.scrollY) <= 2) current = selectedLanding.index;
    else {
      selectedLanding = null;
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) current = targets.length - 1;
    }
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    picker.value = targets[current]?.id || 'set-profile';
  };
  const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(update); };
  const goToTarget = target => {
    if (stopped) return;
    target.scrollIntoView({ block: 'start' });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    selectedLanding = { index: targets.indexOf(target), scrollY: window.scrollY };
    update();
  };
  const restoreFragment = () => {
    let id;
    try { id = decodeURIComponent(window.location?.hash?.slice(1) || ''); } catch { return; }
    const target = targets.find(item => item?.id === id);
    if (!target) return;
    if (fragmentFrame !== null) window.cancelAnimationFrame?.(fragmentFrame);
    // The app focuses the view heading after render; wait until that transaction
    // finishes so a deep link lands and stays focused on the requested section.
    fragmentFrame = window.requestAnimationFrame(() => { fragmentFrame = null; goToTarget(target); });
  };
  const onRoute = ({ mode }) => { if (mode === 'settings') restoreFragment(); };
  picker.addEventListener('change', () => {
    const target = targets.find(item => item?.id === picker.value);
    if (!target) return;
    window.history.replaceState(null, '', `#${target.id}`);
    goToTarget(target);
  });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('hashchange', restoreFragment);
  on('route-changed', onRoute);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(main.querySelector('.settings-content'));
  update();
  restoreFragment();
  return () => {
    stopped = true;
    window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
    window.removeEventListener('hashchange', restoreFragment); off('route-changed', onRoute);
    observer?.disconnect();
    if (frame !== null) window.cancelAnimationFrame?.(frame);
    if (fragmentFrame !== null) window.cancelAnimationFrame?.(fragmentFrame);
  };
}

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
  clearInterval(scheduleStatusTimer);
  scheduleStatusTimer = null;
  stopSystemHealth?.();
  stopSystemHealth = null;
  clearTimeout(feedbackTimer);
  stopSectionIndex?.();
  stopSectionIndex = null;
  stopWallDisplaySettings?.();
  stopWallDisplaySettings = null;
  clearTimeout(profileFeedbackTimer);

  clearTimeout(scheduleFeedbackTimer);
}

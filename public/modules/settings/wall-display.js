import { escapeHtml } from '../core/sanitize.js';
import { loadDisplaySettings, normalizeDisplaySettings, persistDisplaySettings } from '../wall/wall-presentation.js';

const selections = {
  size: ['Text size', [['standard', 'Standard'], ['large', 'Large'], ['largest', 'Largest']]],
  margin: ['Safe margins', [['normal', 'Normal · 2%'], ['safe', 'Safe · 4%'], ['wide', 'Wide · 6%']]],
  speed: ['Reading speed', [['slow', 'Relaxed'], ['normal', 'Standard'], ['fast', 'Brisk']]],
  playlist: ['Playlist', [['balanced', 'Balanced'], ['assessment', 'Assessment'], ['updates', 'Updates']]],
  feedSeconds: ['Preferred feed interval', [[60, '60 seconds'], [90, '90 seconds'], [120, '2 minutes']]],
};
const hourOptions = Array.from({ length:24 }, (_, hour) => [hour, `${String(hour).padStart(2, '0')}:00`]);
const playlistDescriptions = { balanced: 'Assessment, developing situations, and current reporting.', assessment: 'Assessment and current reporting.', updates: 'Developing situations, watchlist, and current reporting.' };
const select = (name, label, choices, selected) => `<label><span class="settings-label">${label}</span><select class="settings-input" name="${name}"${name === 'playlist' ? ' aria-describedby="wallPlaylistHelp"' : ''}>${choices.map(([value, text]) => `<option value="${value}"${String(selected) === String(value) ? ' selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select>${name === 'playlist' ? `<span class="settings-help wall-playlist-help" id="wallPlaylistHelp">${playlistDescriptions[selected] || playlistDescriptions.balanced}</span>` : ''}</label>`;
const toggle = (name, label, checked) => `<label class="wall-display-toggle"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}><span>${label}</span></label>`;

export function wallDisplaySettingsHtml(value = {}) {
  const settings = normalizeDisplaySettings(value);
  return `<div class="settings-section-heading"><h2 id="set-wall">Wall display</h2><span class="settings-scope">This browser</span></div>
    <p class="settings-note">Changes save automatically. Wall opens directly into its continuous presentation.</p>
    <form id="wallDisplayForm" aria-label="Wall display preferences">
      <div class="wall-display-grid">${Object.entries(selections).map(([name, [label, choices]]) => select(name, label, choices, settings[name])).join('')}</div>
      <p class="settings-help">Feed stories appear between complete topics, so a long response can extend the preferred interval. The assessment playlists include every judgment action; the full reading context remains in Briefing.</p>
      <div class="wall-display-capabilities">
        ${toggle('fullscreen', 'Request fullscreen when opening Wall', settings.fullscreen)}
        ${toggle('awake', 'Keep the screen awake while Wall is open', settings.awake)}
      </div>
      <p class="settings-help">Fullscreen and screen-awake requests depend on browser support. Wall starts even if either request is unavailable; use browser fullscreen and display power settings as needed.</p>
      <details class="profile-details"><summary>Overnight display care</summary>
        ${toggle('dim', 'Dim during these local hours', settings.dim)}
        <div class="wall-display-grid">${select('dimStart', 'Dim from', hourOptions, settings.dimStart)}${select('dimEnd', 'Until', hourOptions, settings.dimEnd)}</div>
        ${toggle('maintenance', 'Allow one maintenance reload per day', settings.maintenance)}
        <div class="wall-display-grid">${select('maintenanceHour', 'Reload hour (local)', hourOptions, settings.maintenanceHour)}</div>
        <p class="settings-help">These hours use the display device’s clock. Maintenance waits for a successful refresh and restores the current topic. Equal dim start and end hours disable the dim window.</p>
      </details>
      <div class="settings-row-actions"><a class="btn-primary" href="/wall">Open Wall</a><span class="settings-feedback" data-wall-save-status role="status" aria-live="polite"></span></div>
    </form>`;
}

export function wallDisplaySettingsFromForm(form, previous = {}) {
  const value = { ...previous };
  for (const name of [...Object.keys(selections), 'dimStart', 'dimEnd', 'maintenanceHour']) value[name] = form.elements.namedItem(name)?.value;
  for (const name of ['fullscreen', 'awake', 'dim', 'maintenance']) value[name] = form.elements.namedItem(name)?.checked === true;
  return normalizeDisplaySettings(value);
}

export function syncWallDisplayControls(form) {
  const enabled = name => form.elements.namedItem(name)?.checked === true;
  for (const name of ['dimStart', 'dimEnd']) form.elements.namedItem(name).disabled = !enabled('dim');
  form.elements.namedItem('maintenanceHour').disabled = !enabled('maintenance');
}

export function mountWallDisplaySettings(section) {
  if (!section) return () => {};
  let settings = loadDisplaySettings();
  section.innerHTML = wallDisplaySettingsHtml(settings);
  const form = section.querySelector('form');
  const status = section.querySelector('[data-wall-save-status]');
  syncWallDisplayControls(form);
  const change = () => {
    const result = persistDisplaySettings(wallDisplaySettingsFromForm(form, settings));
    settings = result.settings;
    syncWallDisplayControls(form);
    const playlistHelp = form.querySelector?.('#wallPlaylistHelp');
    if (playlistHelp) playlistHelp.textContent = playlistDescriptions[settings.playlist];
    status.textContent = result.persisted ? 'Saved in this browser.' : 'Applied for this app session. Browser storage is unavailable; reload will restore previous preferences.';
    window.dispatchEvent(new CustomEvent('wall-display-settings-changed', { detail:{ ...settings } }));
  };
  const submit = event => event.preventDefault();
  form.addEventListener('change', change);
  form.addEventListener('submit', submit);
  return () => { form.removeEventListener('change', change); form.removeEventListener('submit', submit); };
}

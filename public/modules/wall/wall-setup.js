import { loadDisplaySettings, saveDisplaySettings } from './wall-presentation.js';
let ownsFullscreen = false;
let fullscreenMessage = '';
const presentationRoute = () => /^\/wall\/?$/.test(window.location.pathname) && !new URLSearchParams(window.location.search).has('operator');

// Native dialog owns its focus trap and Escape. Wake lock belongs to this Wall
// mount, is released on exit, and is re-requested when the document is visible.
export function mountDisplaySetup({ onApply, onOpen, isPresentation }) {
  let dialog = null;
  let lock = null;
  let wakePending = false;
  let destroyed = false;
  let settings = loadDisplaySettings();
  let wakeMessage = 'Screen awake is off';
  const status = (message, feature = 'wake') => {
    if (feature === 'fullscreen') fullscreenMessage = message; else wakeMessage = message;
    const combined = [fullscreenMessage, wakeMessage].filter(Boolean).join(' · ');
    const node = document.getElementById('nbDisplayStatus'); if (node) node.textContent = combined;
    const notice = document.getElementById('nbCapabilityStatus');
    if (notice) { notice.textContent = combined; notice.hidden = !/unavailable|declined|released/.test(combined); }
  };
  async function requestAwake() {
    if (destroyed || !isPresentation() || !settings.awake || document.visibilityState === 'hidden' || lock || wakePending) return;
    if (!navigator.wakeLock?.request) { status('Screen awake unavailable · use the browser or operating system display settings'); return; }
    try {
      wakePending = true;
      const requested = await navigator.wakeLock.request('screen');
      if (destroyed || !isPresentation() || !settings.awake) { await requested.release(); return; }
      lock = requested;
      status('Screen awake requested');
      requested.addEventListener('release', () => { if (lock === requested) lock = null; if (!destroyed) status(settings.awake ? 'Screen awake released · check display power settings' : 'Screen awake is off'); });
    } catch { status('Screen awake request declined · use operating system display settings'); }
    finally { wakePending = false; }
  }
  const visibility = () => { if (document.visibilityState !== 'hidden') requestAwake(); };
  document.addEventListener('visibilitychange', visibility);
  status(wakeMessage);
  if (isPresentation() && settings.awake) requestAwake();
  const options = (values, selected) => values.map(([value, label]) => `<option value="${value}"${String(selected) === String(value) ? ' selected' : ''}>${label}</option>`).join('');
  const hours = selected => options(Array.from({ length: 24 }, (_, n) => [n, `${String(n).padStart(2, '0')}:00`]), selected);
  function open(trigger, start = false) {
    if (dialog) return;
    onOpen();
    dialog = document.createElement('dialog');
    dialog.className = 'wall-setup';
    dialog.setAttribute('aria-labelledby', 'wallSetupTitle');
    dialog.innerHTML = `<form method="dialog"><header><h2 id="wallSetupTitle">${start ? 'Present on a display' : 'Display setup'}</h2><button type="button" data-close aria-label="Close display setup">×</button></header><div class="wall-setup-body">
      <p>These settings apply to this browser. Check legibility from the viewing position before leaving the display unattended.</p>
      <div class="wall-setup-grid">
        <label>Text size<select name="size">${options([['standard', 'Standard'], ['large', 'Large'], ['largest', 'Largest']], settings.size)}</select></label>
        <label>Safe margins<select name="margin">${options([['normal', 'Normal · 2%'], ['safe', 'Safe · 4%'], ['wide', 'Wide · 6%']], settings.margin)}</select></label>
      </div><details><summary>Playback and playlist</summary><div class="wall-setup-grid">
        <label>Reading speed<select name="speed">${options([['slow', 'Relaxed'], ['normal', 'Standard'], ['fast', 'Brisk']], settings.speed)}</select></label>
        <label>Playlist<select name="playlist">${options([['balanced', 'Assessment + situations + feed'], ['assessment', 'Assessment + feed'], ['updates', 'Situations + watchlist + feed']], settings.playlist)}</select></label>
        <label>Preferred feed interval<select name="feedSeconds">${options([[60, '60 seconds'], [90, '90 seconds'], [120, '2 minutes']], settings.feedSeconds)}</select></label>
        <label>Reading interaction holds playback<select name="holdSeconds">${options([[0, 'Until I resume'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']], settings.holdSeconds)}</select></label>
      </div>
      <p class="wall-setup-hint">Feeds appear between complete topics; long responses can extend this interval. The primary cycle includes all judgment actions, with supporting context and the full watchlist in All actions. Timed holds wait while focus remains in the content; Pause holds until you resume.</p>
      </details>
      <label class="wall-setup-check"><input type="checkbox" name="fullscreen"${start ? ' checked' : ''}> Enter fullscreen</label>
      <label class="wall-setup-check"><input type="checkbox" name="awake"${settings.awake ? ' checked' : ''}> Request screen awake while presenting</label>
      <p class="wall-setup-hint" id="nbDisplayStatus" role="status">${wakeMessage}</p>
      <p class="wall-setup-hint">If these browser features are unavailable, use the browser fullscreen command and your operating system’s display power settings.</p>
      <details><summary>Overnight display care</summary><label class="wall-setup-check"><input name="dim" type="checkbox"${settings.dim ? ' checked' : ''}> Dim during these local hours</label><div class="wall-setup-grid"><label>Dim from<select name="dimStart">${hours(settings.dimStart)}</select></label><label>Until<select name="dimEnd">${hours(settings.dimEnd)}</select></label></div>
      <label class="wall-setup-check"><input name="maintenance" type="checkbox"${settings.maintenance ? ' checked' : ''}> Allow one maintenance reload per day</label><label>Reload hour (local)<select name="maintenanceHour">${hours(settings.maintenanceHour)}</select></label><p class="wall-setup-hint">Reload waits for resumed playback and a successful refresh. The selected topic is restored. Dimming stops while paused.</p></details>
      </div><footer><button type="button" data-close>Cancel</button><button type="submit">${start ? 'Start presentation' : 'Apply settings'}</button></footer></form>`;
    const close = () => dialog?.close();
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; trigger?.focus?.({ preventScroll: true }); }, { once: true });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = Object.fromEntries(new FormData(form));
      settings = saveDisplaySettings({ ...fields, awake: !!fields.awake, dim: !!fields.dim, maintenance: !!fields.maintenance });
      if (fields.fullscreen && !document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().then(() => {
          ownsFullscreen = true;
          status('', 'fullscreen');
          if (destroyed && !presentationRoute()) { document.exitFullscreen?.(); ownsFullscreen = false; }
        }).catch(() => status('Fullscreen declined · use the browser fullscreen command', 'fullscreen'));
        else status('Fullscreen unavailable · use the browser fullscreen command', 'fullscreen');
      }
      if (!settings.awake && lock) { lock.release(); lock = null; }
      onApply(settings, start);
      requestAwake();
      close();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  }
  return { open, destroy() {
    destroyed = true;
    document.removeEventListener('visibilitychange', visibility);
    dialog?.remove(); dialog = null; lock?.release(); lock = null;
    if (ownsFullscreen && !presentationRoute()) { document.exitFullscreen?.(); ownsFullscreen = false; }
  } };
}

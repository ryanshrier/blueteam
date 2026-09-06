// BlueTeam.News — application header: wordmark, nav, actions.

import { on } from '../core/store.js';
import { followInternalLink, setEditionTitle, currentViewUrl } from '../core/router.js';
import { fetchEdition } from '../core/api.js';
import { openHelp } from '../core/help.js';

let headerObserver = null;

export function initHeader() {
  const header = document.getElementById('appHeader');
  if (!header) return;
  headerObserver?.disconnect();

  header.innerHTML = `
    <div class="header-inner">
      <a class="wordmark" id="hdrHome" href="/wire" aria-label="home">
        <span id="hdrWordmark">BLUETEAM.NEWS</span>
      </a>
      <nav class="header-nav" aria-label="Main navigation">
        <a class="nav-btn active" href="/wire" data-mode="wire" aria-current="page" title="Wire (G then W)">Wire</a>
        <a class="nav-btn" href="/briefing" data-mode="briefing" title="Briefing (G then B)">Briefing</a>
        <a class="nav-btn" href="/wall" data-mode="wall" title="The Wall — automatic TV display (G then L)">Wall</a>
      </nav>
      <div class="header-right">
        <button class="icon-btn header-utility" id="hdrHelp" title="Help (?)" aria-label="Help">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg><span>Help</span>
        </button>
        <a class="icon-btn header-utility" id="hdrSettings" href="/settings" title="Settings" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg><span>Settings</span>
        </a>
      </div>
    </div>
  `;

  header.querySelectorAll('a[href]').forEach(link => link.addEventListener('click', followInternalLink));
  const reflectDestinations = () => {
    header.querySelectorAll('.nav-btn[data-mode]').forEach(link => {
      link.href = link.dataset.mode === 'wall' ? '/wall' : currentViewUrl(link.dataset.mode);
    });
  };
  on('route-changed', reflectDestinations);
  on('view-memory-changed', reflectDestinations);
  reflectDestinations();

  // A compact header and larger user text can occupy more than one row.
  const measureHeader = () => {
    const height = header.getBoundingClientRect?.().height;
    if (height > 0) document.documentElement?.style?.setProperty('--header-rendered-height', `${Math.ceil(height)}px`);
  };
  measureHeader();
  if (typeof ResizeObserver !== 'undefined') {
    headerObserver = new ResizeObserver(measureHeader);
    headerObserver.observe(header);
  }

  document.getElementById('hdrHelp')?.addEventListener('click', () => openHelp());

  on('mode-changed', (mode) => {
    header.querySelectorAll('.nav-btn[data-mode]').forEach(btn => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle('active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    const settingsButton = document.getElementById('hdrSettings');
    settingsButton?.classList.toggle('active', mode === 'settings');
    if (mode === 'settings') settingsButton?.setAttribute('aria-current', 'page');
    else settingsButton?.removeAttribute('aria-current');
  });

  // Apply the active edition's identity (wordmark + window title) from the pack,
  // so the app shell isn't hardcoded to a particular edition. Cyber resolves to
  // the public BlueTeam.News identity used by the briefing and exported artifact.
  // strings, so there's no visible change for the default edition.
  fetchEdition()
    .then(e => {
      const label = e?.label || e?.title;
      if (!label) return;
      const mark = document.getElementById('hdrWordmark');
      if (mark) mark.textContent = label.toUpperCase();
      const publicLabel = label;
      document.getElementById('hdrHome')?.setAttribute('aria-label', `${publicLabel} home`);
      setEditionTitle(publicLabel);
    })
    .catch(() => { /* keep the default wordmark/title */ });
}

// BlueTeam.News — KEV Wall section renderer.
// DOM-free so the live Wall, deterministic visual fixtures, and Jest exercise
// the exact same markup and fallback behavior.

import { escapeHtml } from '../core/sanitize.js';
import { usableKevRecords } from './wall-format.js';

export function renderKevSection(kev = {}) {
  const usable = usableKevRecords(kev);
  const recent = usable.slice(0, 6);
  const incomplete = (Array.isArray(kev.recent) ? kev.recent.length : 0) - usable.length;
  if (!recent.length) return '<section class="nb-section"><div class="nb-empty">No identifiable KEV additions are available.</div></section>';
  const rows = recent.map(renderKevRecent).join('');
  const weekCount = kev.added7d != null && Number.isFinite(Number(kev.added7d)) && Number(kev.added7d) >= 0 ? Number(kev.added7d) : null;
  const todayCount = Number.isFinite(Number(kev.added24h)) ? Number(kev.added24h) : 0;
  const weeklyRead = weekCount !== null ? `Catalog total · ${weekCount} ${weekCount === 1 ? 'addition' : 'additions'} in the past 7 days` : 'Latest catalog additions';
  const todayRead = todayCount > 0
    ? `<div class="nb-kev-today" aria-label="${todayCount} added today UTC, as of the feed update"><strong>${todayCount}</strong><span>today (UTC)<small>As of feed update</small></span></div>`
    : '';

  return `
    <section class="nb-section nb-kev-page row-count-${recent.length}">
      <header class="nb-kev-lead">
        <div class="nb-kev-intro">
          <span class="nb-kev-eyebrow">Confirmed exploited · catalog change</span>
          <strong class="nb-kev-total">${escapeHtml(weeklyRead)}</strong>
          <p class="nb-kev-deck">Check whether these confirmed exploited vulnerabilities affect your systems.</p>
          <p class="nb-coverage">Preview · ${recent.length} of the ${usable.length} newest catalog entries in this snapshot</p>
          ${incomplete ? `<p class="nb-coverage nb-coverage-warning">${incomplete} incomplete ${incomplete === 1 ? 'record' : 'records'} omitted</p>` : ''}
        </div>
        ${todayRead}
      </header>
      <div class="nb-kev-columns" aria-hidden="true">
        <span>CVE identity</span><span>Affected vendor · product</span><span>Catalog recency</span>
      </div>
      <div class="nb-ledger nb-kev">${rows}</div>
    </section>`;
}

export function renderKevRecent(kev = {}) {
  const rawDate = String(kev.dateAdded || '');
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? new Date(`${rawDate}T00:00:00Z`) : null;
  const added = parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === rawDate ? `${rawDate} (UTC)` : '';
  const vendor = kev.vendor ? escapeHtml(kev.vendor) : '';
  const product = kev.product ? escapeHtml(kev.product) : '';
  const name = kev.name ? escapeHtml(kev.name) : '';

  return `
    <div class="nb-led-row">
      <div class="nb-led-id">
        <span class="nb-led-cve">${escapeHtml(kev.cve || 'CVE not listed')}</span>
      </div>
      <div class="nb-led-vp">
        ${product ? `<strong class="nb-led-product"><span class="nb-clamp nb-clamp-2">${product}</span></strong>` : ''}
        ${vendor ? `<span class="nb-led-vendor">${vendor}</span>` : ''}
        ${name ? `<span class="nb-led-name"><span class="nb-clamp nb-clamp-1">${name}</span></span>` : ''}
      </div>
      <span class="nb-led-due"><small>Added</small>${added ? escapeHtml(added) : 'Date not listed'}</span>
    </div>`;
}

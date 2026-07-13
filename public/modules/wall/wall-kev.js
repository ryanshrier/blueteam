// BlueTeam.News — KEV Wall section renderer.
// DOM-free so the live Wall, deterministic visual fixtures, and Jest exercise
// the exact same markup and fallback behavior.

import { escapeHtml } from '../core/sanitize.js';
import { relDayAge } from './wall-format.js';

export function renderKevSection(kev = {}) {
  const recent = Array.isArray(kev.recent) ? kev.recent.slice(0, 6) : [];
  const rows = recent.map(renderKevRecent).join('');
  const weekCount = Number.isFinite(Number(kev.added7d)) ? Number(kev.added7d) : recent.length;
  const todayCount = Number.isFinite(Number(kev.added24h)) ? Number(kev.added24h) : 0;
  const weeklyRead = weekCount > 0 ? `${weekCount} new this week` : 'Latest catalog additions';
  const todayRead = todayCount > 0
    ? `<div class="nb-kev-today" aria-label="${todayCount} added today"><strong>${todayCount}</strong><span>today</span></div>`
    : '';

  return `
    <section class="nb-section nb-kev-page row-count-${recent.length}">
      <header class="nb-kev-lead">
        <div class="nb-kev-intro">
          <span class="nb-kev-eyebrow">Confirmed exploited · catalog change</span>
          <strong class="nb-kev-total">${escapeHtml(weeklyRead)}</strong>
          <p class="nb-kev-deck">Check exposure to the newest additions before older catalog work.</p>
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
  const added = relDayAge(kev.dateAdded);
  const vendor = kev.vendor ? escapeHtml(kev.vendor) : 'Vendor not listed';
  const product = kev.product ? escapeHtml(kev.product) : 'Product not listed';
  const name = kev.name ? escapeHtml(kev.name) : '';

  return `
    <div class="nb-led-row">
      <div class="nb-led-id">
        <span class="nb-led-cve">${escapeHtml(kev.cve || 'CVE not listed')}</span>
      </div>
      <div class="nb-led-vp">
        <span class="nb-led-vendor">${vendor}</span>
        <strong class="nb-led-product"><span class="nb-clamp nb-clamp-2">${product}</span></strong>
        ${name ? `<span class="nb-led-name"><span class="nb-clamp nb-clamp-1">${name}</span></span>` : ''}
      </div>
      <span class="nb-led-due"><small>Added</small>${added ? escapeHtml(added) : 'Date not listed'}</span>
    </div>`;
}

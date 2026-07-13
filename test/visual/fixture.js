import { renderKevSection } from '/public/modules/wall/wall-kev.js';
import { FIXTURE_CASES, buildFixtureData } from './fixture-cases.js';

const params = new URLSearchParams(location.search);
const requested = params.get('state') || FIXTURE_CASES[0].id;
const fixture = FIXTURE_CASES.find(item => item.id === requested) || FIXTURE_CASES[0];
const data = buildFixtureData();

document.body.classList.toggle('capture', params.has('capture'));
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.title = `BlueTeam.News fixture · ${fixture.label}`;

document.getElementById('fixtureNav').innerHTML = FIXTURE_CASES.map(item => {
  const current = item.id === fixture.id ? ' aria-current="page"' : '';
  return `<a href="?state=${item.id}"${current}>${item.label}</a>`;
}).join('');

const root = document.getElementById('fixtureRoot');
root.innerHTML = fixture.surface === 'wall'
  ? renderWallFixture(fixture.id, data)
  : renderOperatorFixture(fixture.id);

function renderWallFixture(id, fixtures) {
  const stale = id === 'wall-stale';
  const loading = id === 'wall-loading';
  const kev = fixtures[id] || fixtures['kev-one'];
  const body = loading
    ? `<div class="nb-empty nb-opening">
        <span class="nb-opening-kicker">Preparing the watchfloor</span>
        <strong>Assembling today’s edition</strong>
        <span>Signals will surface as the feeds respond.</span>
      </div>`
    : renderKevSection(kev);

  return `<div class="wall-layer">
    <main class="wall news-mode${stale ? ' nb-stale' : ''}" aria-label="${fixture.label}">
      <header class="nb-folio">
        <div class="nb-folio-id"><span class="nb-wordmark">BLUETEAM.NEWS</span><span>SUN, JUL 12</span></div>
        <div class="nb-folio-slug">${loading ? 'CYBER DEFENSE INTELLIGENCE' : 'KEV · NEWLY ADDED'}</div>
        <div class="nb-folio-status"><span>FEEDS ${stale ? '35/42 · UPDATED 2H' : '42/42 · UPDATED NOW'}</span><span class="nb-live${stale ? ' warn' : ''}"><i class="nb-live-dot"></i>${stale ? 'STALE' : 'LIVE'}</span><b>10:24</b></div>
      </header>
      <div class="nb-dwell"><i style="transform:scaleX(.62)"></i></div>
      <div class="nb-body" id="nbBody">${body}</div>
      <footer class="nb-foot"><span class="nb-pager">${loading ? '—' : '1 / 1'}</span></footer>
    </main>
  </div>`;
}

function renderOperatorFixture(id) {
  const content = id === 'wire-loading' ? renderWireLoading()
    : id === 'brief-error' ? renderBriefError()
    : renderBriefEmpty();

  return `<div class="fixture-operator">
    <header class="app-header">
      <div class="header-inner">
        <span class="wordmark"><span>BLUETEAM.NEWS</span></span>
        <nav class="header-nav" aria-label="Main navigation"><span class="nav-btn">BRIEFING</span><span class="nav-btn active">WIRE</span><span class="nav-btn">WALL</span></nav>
      </div>
    </header>
    <main class="fixture-shell-main"><div class="fixture-state">${content}</div></main>
  </div>`;
}

function renderWireLoading() {
  const rows = Array.from({ length: 6 }, () =>
    '<div class="wire-skel-row" aria-hidden="true"><span class="wsk-ring"></span><span class="wsk-lines"><i></i><i></i></span><span class="wsk-meta"></span></div>'
  ).join('');
  return `<section class="wire-view" aria-label="Wire loading fixture">
    <header class="wire-head"><div><p class="view-kicker">Live signal feed</p><h1 class="view-title">Wire</h1><p class="view-sub">Every scored signal from the last pipeline run — ranked by defender relevance.</p></div><span class="wire-meta">Loading signals…</span></header>
    <div class="wire-controls"><div class="wire-command-row"><div class="wire-search-wrap"><span class="search-input">Search title, CVE, vendor, actor…</span></div></div></div>
    <div class="wire-colhead"><span>SCORE</span><span>SIGNAL</span><span class="ch-meta">SOURCE · AGE</span></div>
    <div class="wire-list">${rows}</div>
  </section>`;
}

function renderBriefError() {
  return `<section aria-label="Briefing error fixture">
    <p class="view-kicker">Daily threat landscape</p><h1 class="view-title">Briefing</h1><p class="view-sub">Jul 12, 2026 · latest edition</p>
    <div class="briefing-sheet" style="margin-top:24px"><div class="error-message"><strong>Failed to load this briefing.</strong><span>The archive remains available; retry when the server reconnects.</span><button class="btn-ghost-sm" type="button">Retry</button></div></div>
  </section>`;
}

function renderBriefEmpty() {
  return `<section aria-label="Briefing empty fixture">
    <p class="view-kicker">Daily threat landscape</p><h1 class="view-title">Briefing</h1>
    <div class="briefing-sheet" style="margin-top:24px"><div class="empty-state"><p class="empty-kicker">Daily threat landscape</p><h2>No briefing yet</h2><p>Generate the first edition after signals arrive.</p><button class="btn-primary" type="button">Generate Briefing</button></div></div>
  </section>`;
}

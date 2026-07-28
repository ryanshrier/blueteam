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
    : id === 'brief-full' ? renderBriefFull()
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

function renderBriefFull() {
  const tocOpen = matchMedia('(max-width: 560px)').matches ? '' : ' open';
  return `<section class="briefing-view" aria-label="Full briefing fixture">
    <header class="briefing-masthead">
      <div>
        <p class="view-kicker">Daily threat landscape</p>
        <h1 class="view-title">Briefing</h1>
        <p class="view-sub">Jul 24, 2026 · 9 min read · Sonnet 5 · est. $0.20</p>
        <p class="brief-provenance">AI-synthesized from sourced signals — verify before acting</p>
      </div>
      <div class="briefing-toolbar">
        <span class="search-input">Search archive…</span>
        <span class="history-select">Jul 24, 2026 · brief 2</span>
        <button class="btn-ghost brief-export-btn" type="button">Edition</button>
      </div>
    </header>
    <div class="briefing-layout">
      <aside class="briefing-toc" aria-label="Briefing sections">
        <details class="briefing-toc-disclosure"${tocOpen}>
          <summary class="briefing-toc-label">
            <span class="toc-label-wide">In this briefing</span>
            <span class="toc-label-compact">Jump to section</span>
          </summary>
          <ul>
            <li><a class="active" aria-current="location" href="#fixture-shift">Shift decisions</a></li>
            <li><a href="#fixture-judgments">Key judgments</a></li>
            <li><a href="#fixture-developing">Developing</a></li>
            <li><a href="#fixture-convergence">Convergence</a></li>
            <li><a href="#fixture-watchlist">Watchlist</a></li>
            <li><a href="#fixture-sources">Sources</a></li>
          </ul>
        </details>
      </aside>
      <article class="briefing-sheet">
        <div class="brief-content">
          <h1>BlueTeam.News</h1>
          <h3 role="presentation">Threat Landscape Briefing · July 24, 2026 · Friday</h3>
          <div class="bluf"><p>Actively exploited edge vulnerabilities remain the immediate priority; verify the exposed inventory and patch state before the next shift.</p></div>
          <h2 class="brief-exec-heading" id="fixture-shift">Executive summary — shift decisions</h2>
          <ul>
            <li><strong>Threat:</strong> Active exploitation is concentrated on internet-facing management planes.</li>
            <li><strong>Exposure:</strong> Confirm every externally reachable appliance and collaboration server.</li>
            <li><strong>Required decisions:</strong> Infrastructure verifies patch state; detection engineering hunts the published indicators.</li>
          </ul>
          <h2 id="fixture-judgments">Key judgments</h2>
          <div class="brief-judgment-card h1">
            <h3>SharePoint exploit chain remains active</h3>
            <div class="brief-judgment-meta"><span class="c-chip h1">Act now</span><span class="bjm-confidence">Almost certain (95–99%)</span><span class="bjm-window" data-edition-date="July 24, 2026">Current shift</span></div>
            <p class="brief-field" data-brief-field="assessment"><strong>Assessment:</strong> Attackers continue to exploit unremediated on-premises servers after fixes became available.</p>
            <p class="brief-field" data-brief-field="what happened"><strong>What happened:</strong> Multiple related vulnerabilities were added to an authoritative exploited-vulnerability catalog, with remediation dates now due.</p>
            <p class="brief-field" data-brief-field="defender impact"><strong>Defender impact:</strong> Verify patch level and review web-server logs for post-exploitation activity.</p>
            <div class="the-line">Unpatched collaboration servers are being compromised now.</div>
            <div class="c-action"><span class="c-action-label">Act now</span><span class="c-action-text">Infrastructure — verify or isolate every affected server — recommended target July 25, 2026.</span></div>
            <a class="brief-judgment-link" href="#">View signals →</a>
          </div>
          <div class="brief-judgment-card h2">
            <h3>Management-plane bypass raises administrator risk</h3>
            <div class="brief-judgment-meta"><span class="c-chip h2">Prepare</span><span class="bjm-confidence">Highly likely (80–95%)</span><span class="bjm-window">72 hours</span></div>
            <p class="brief-field" data-brief-field="assessment"><strong>Assessment:</strong> A confirmed authentication bypass makes exposed consoles a high-value entry point.</p>
            <p class="brief-field" data-brief-field="what happened"><strong>What happened:</strong> The vendor confirmed limited exploitation and issued a patch.</p>
            <div class="the-line">Management consoles should never be treated as ordinary public services.</div>
          </div>
          <h2 id="fixture-developing">Developing situations</h2>
          <h3>Autonomous agents move into post-exploitation</h3>
          <p class="brief-field"><strong>Trajectory:</strong> Accelerating as unattended tooling becomes easier to deploy.</p>
          <p class="brief-field"><strong>Watch criteria:</strong> Escalate on a second independently confirmed enterprise intrusion.</p>
          <h2 id="fixture-convergence">Convergence</h2>
          <h3>Identity and unmanaged edge access converge</h3>
          <p class="brief-field"><strong>The intersection:</strong> Both paths exploit controls that sit outside normal endpoint visibility.</p>
          <p class="brief-field"><strong>The cascade:</strong> Unlogged access becomes persistence, then privileged movement.</p>
          <p class="brief-field"><strong>The move:</strong> Prepare — bring edge-device identity and logs into the same review.</p>
          <h2 id="fixture-watchlist">Watchlist — through July 27, 2026</h2>
          <ul><li>A new exploited vulnerability joins the catalog.</li><li>A vendor expands the affected-product range.</li></ul>
          <h2 class="brief-sources-heading" id="fixture-sources">Sources</h2>
          <ol class="brief-sources-appendix"><li><a class="source-link" href="#">Vendor advisory, Jul 24, 2026</a><span class="brief-cite-host"> — example.test</span></li></ol>
        </div>
      </article>
    </div>
  </section>`;
}

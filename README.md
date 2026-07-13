# BlueTeam.News

[![CI](https://github.com/ryanshrier/blueteam/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanshrier/blueteam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

**BlueTeam.News is a self-hosted threat-intelligence desk for cyber defense teams.**

It groups and enriches open threat reporting, prioritizes each signal with visible evidence, and presents the result as:

- **The Wall** — passive situational awareness for an operations display
- **The Wire** — a filterable analyst feed with score evidence, KEV, CVSS, EPSS, and attribution tags
- **The Briefing** — the AI-generated synthesis layer: a daily assessment for defenders and leadership (Anthropic key required)

The Wall and Wire operate without API keys. For the complete daily experience—BLUF, judgments, actions, and leadership-ready synthesis—connect an Anthropic key and enable the Briefing. Data is stored locally in SQLite, and the application sends no telemetry.

*Built for the floor, grounded in evidence. Hold the line.*

**[Quick start](#quick-start) · [The Wall](#the-wall) · [The Wire](#the-wire) · [The Briefing](#the-briefing) · [Tiers](#the-three-tiers) · [Architecture](#architecture) · [Configuration](#configuration) · [API](#api) · [Security](#security-posture) · [Development](#development)**

---

## Quick start

```bash
git clone https://github.com/ryanshrier/blueteam.git blueteam && cd blueteam
npm install
npm start
```

> **Node 22+ required** (`node --version`). Use a supported LTS release; Node 20 reached end of life in March 2026.

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The Wall and Wire begin filling as the first source responses arrive, with no configuration or API keys.

For the full daily experience, enable the recommended AI Briefing with an Anthropic API key in **Settings** or `.env`:

```bash
cp .env.example .env
# add ANTHROPIC_API_KEY=sk-ant-...
npm start
```

You can generate on demand. The server also refreshes its evidence and creates one new edition automatically at **05:00 local time**; missed runs catch up after restart and failures retry every 15 minutes. Each successful scheduled or manual generation is billed directly to your Anthropic account. BlueTeam.News reports the model, token count, and estimated API cost.

### Put it on the wall

Run BlueTeam.News on the machine that drives the screen—a mini-PC or Raspberry Pi behind the TV, or your own laptop on a second monitor—and open:

```text
http://127.0.0.1:3000/wall
```

`/wall` is the passive display route and hides the cursor automatically; `Esc` exits. Keyless mode carries KEV changes and prioritized signals. With the Briefing enabled, the Wall adopts each complete daily edition without operator input. The intended deployment stays on loopback, with the host driving or mirroring the display.

## The Wall

Put it on a TV. Walk past it. Know the landscape.

![The Wall's wire page — scored signals racked into broadsheet rows](docs/assets/screenshot-wall-wire.jpg)
*The rotation's wire page — the freshest scored signals, racked to be read from ten feet.*

The Wall provides passive situational awareness for an operations display. Its watchfloor broadsheet rotates through the latest brief, key judgments, developing situations, convergence, KEV changes, and prioritized signals.

- **The Briefing** — the BLUF and an "in brief" digest of the latest AI briefing
- **Key Judgments** — one focal judgment per page, with the punchy "line", confidence, and decision window
- **Developing + Convergence** — what is moving, what would escalate it, and where separate signals combine into a larger defensive consequence
- **KEV changes** — the newest confirmed-exploited catalog additions
- **The Wire** — the live scored signals, racked into column-aligned rows: tier · headline + gist · severity (KEV / CVSS) · age, with the freshest flagged

Open `/wall` for an unattended floor display. It hides the cursor automatically; `Esc` exits. With an Anthropic key configured, the server generates a new brief at 05:00 local time and the Wall adopts it automatically. No WebGL or canvas—just a browser.

## The Wire

The Wire is the analyst workspace: every prioritized signal from the latest pipeline run, with the evidence behind its score. Filter by tier, urgency, KEV status, and unread state; inspect source breadth, CVSS and EPSS data, attribution tags, timestamps, and CVE detail; export the result as CSV or JSON.

Open `/wire`; filtered views keep their state in a shareable query string, such as `/wire?kev=1&sort=newest`.

![The Wire — every scored signal with filters and evidence chips](docs/assets/screenshot-wire.png)
*A real capture of the Wire: the converging-stories strip up top, then every signal with its score and the evidence behind it.*

## The Briefing

The Briefing gives analysts and leadership one shared threat picture: a BLUF, calibrated judgments, defensive actions, developing situations, convergence, and a 72-hour watchlist.

Open `/briefing`; archived briefs have durable links at `/briefing/<filename>`.

Generation runs on demand and once daily at 05:00 local time. It streams over SSE, is structurally validated before storage, archives to Markdown, and is indexed in SQLite FTS5. Scheduled success is persisted to prevent duplicate daily spend after restart; missed runs catch up and failures retry. Every brief is labeled AI-generated and carries a standing “verify before acting” caveat.

![The Briefing — an AI-written daily threat brief with its own honesty box](docs/assets/screenshot-briefing.png)
*A real capture — including the validation box calling out the brief's own imperfections. Every brief is labeled AI-generated with a standing "verify before acting" caveat, on screen and in the export; generation is grounded in the day's scored signals plus a deterministic KEV facts block, and a structural hard-fail triggers one corrective retry.*

## The three tiers

BlueTeam.News classifies every signal into one of three CTI tiers — the Tactical / Operational / Strategic pyramid that drives scoring, the UI, the Wall, and the briefing:

| Tier | Name | Window | Reader | Question it answers |
|---|---|---|---|---|
| **T1** | Tactical | Current shift to 7 days | SOC · IR · detection | What demands attention before the next shift change? |
| **T2** | Operational | Coming weeks to 12 months | Hunt · intel · security eng | What developing threat activity, capability, exposure, or policy change requires a defensive adjustment? |
| **T3** | Strategic | Beyond 12 months | Directors · CISO · board | What structural change will materially alter the threat environment, defensive model, or risk posture? |

The tiers map to who consumes the intelligence: the SOC lives in Tactical, threat hunters and intel in Operational, leadership in Strategic. The briefing serves all three on purpose: every signal carries analyst-grade specifics (CVEs, versions, actions) *and* a one-sentence judgment a director can carry into a meeting.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (vanilla ES modules)                               │
│  Briefing · Wire · Wall (watchfloor broadsheet)             │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST + SSE
┌───────────────────────────▼─────────────────────────────────┐
│  Express (server.js)                                        │
│  routes/brief (SSE generation, history, FTS5 search)        │
│  routes/landscape (wall payload, wire headlines, refresh)   │
└──────┬──────────────────┬──────────────────┬────────────────┘
       │                  │                  │
  lib/feeds          lib/landscape      lib/prompts
  lib/scoring        lib/refresher      lib/history
  lib/enrichment     lib/db (SQLite + FTS5)
       │
  RSS/Atom feeds · Google News · CISA KEV · NVD          Claude API
  (no keys required)                               (Anthropic key)
```

**The pipeline** (`lib/feeds.js`) runs on a schedule (default: every 10 minutes) and on demand:

1. Fetch the configured RSS/Atom feeds (bounded concurrency, conditional GET, per-feed circuit breakers) plus a news search sweep
2. Group similar stories with TF-IDF cosine similarity and record how many distinct configured sources reported them — useful source diversity, not proof that the reporting is independent
3. Classify urgency, apply alert-rule boosts and profile overrides, and promote operationally urgent items to the Tactical tier
4. Pre-enrich every candidate with CISA KEV membership plus entity and MITRE ATT&CK tags, so verified exploitation can influence selection
5. Score on five weighted axes—recency, source diversity, exploitation, severity, and relevance—then enforce per-tier floors and per-source caps so one loud feed cannot drown the landscape
6. Post-enrich the selected set with NVD CVSS detail, article extraction, EPSS, and indicators
7. Re-score and sort with the verified enrichment evidence; every score component remains inspectable and tunable

Results are archived in SQLite (rolling window) to power trends: actor leaderboard and headline velocity.

**The briefing** (`routes/brief.js`) streams Claude output over SSE with timeout recovery and model fallback, validates structure (BLUF, judgments, convergence, watchlist), saves markdown to `briefs/`, and indexes it in SQLite FTS5 for full-text search.

## Configuration

Everything tunes from `config.json` (hot-reloaded on save, validated with Zod):

| Block | What it controls |
|---|---|
| `organization` | Optional context for the briefing: team profile, sector, watch topics, and regions |
| `horizons` | Names, windows, and driving questions for the three tiers |
| `trustedFeeds` | RSS/Atom sources with tier, weight, and deep-extract flags |
| `alertRules` | Regex patterns that boost matching headlines (zero-days, ransomware, your stack's vendors…) |
| `analysisSettings` | Models, token budgets, refresh cadence, freshness windows, tier weights, scoring debug, and the optional alert `webhook` |

Want briefings tailored to your environment? Add your stack to `alertRules` and `organization.watchTopics`:

```json
"organization": {
  "sector": "Financial services",
  "watchTopics": ["payment fraud", "SWIFT", "core banking platforms"]
},
"alertRules": [
  { "pattern": "Okta|Entra|Workday", "boost": 4 }
]
```

### Alert webhook (optional)

`analysisSettings.webhook` can push alert-matched signals after each pipeline run, a completed daily Briefing, or both. It is **disabled by default** — an empty `url` means no requests are ever made:

```json
"analysisSettings": {
  "webhook": { "url": "", "format": "slack", "events": "alerts" }
}
```

Set `url` to your incoming-webhook endpoint to enable it. `format` is `slack` (Slack/Teams-compatible message) or `json`. Set `events` to `alerts` (the default), `brief`, or `both`. Alert delivery includes only signals that match an `alertRule`, and each story fires at most once; Briefing delivery sends the completed edition's date, BLUF, key judgments, and deep link. Set `PUBLIC_BASE_URL` when recipients should open that link through a public deployment; otherwise it safely points to `http://localhost:PORT`. Outbound requests are SSRF-guarded like every other fetch. Delivery is best-effort: a failed webhook is logged and never blocks a pipeline run or briefing save.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | No | Enables AI briefing generation (`ANTHROPIC_API_KEY_PRIMARY` is accepted as an alias) |
| `ANTHROPIC_API_KEY_SECONDARY` | No | Automatic fallback on auth failure |
| `NVD_API_KEY` | No | Raises the NVD CVE-lookup rate limit (5 → 50 requests / 30s). [Free key.](https://nvd.nist.gov/developers/request-an-api-key) |
| `BLUETEAM_USER_AGENT` | No | Override the named feed-reader identity, for example to add your organization's contact URL. |
| `PORT` | No | HTTP port (default `3000`) |
| `HOST` | No | Bind address (default `127.0.0.1`). BlueTeam.News is built to run on the machine that drives the display, so loopback is the intended deployment. |
| `PUBLIC_BASE_URL` | No | Canonical HTTP(S) origin for RSS/JSON feed metadata and completed-Briefing webhook links, e.g. `https://blueteam.news`. Origin only: credentials, paths, queries, and fragments are rejected at startup. Unset preserves request-derived local feed URLs and the safe `http://localhost:PORT` webhook fallback. |
| `API_SECRET` | No | Bearer-token auth on `/api/*`. The server refuses to bind a non-loopback `HOST` without it — a fail-closed guard so a stray `HOST=0.0.0.0` can't silently expose the API. |
| `ENABLE_EMBED` | No | `/embed` (the keyless iframe widget) is disabled by default whenever `API_SECRET` is set, since it can't carry a bearer token. Set to `1` to opt back in on a locked-down deployment. |
| `CORS_ORIGIN` | No | Allowed origin (default: same-origin) |
| `TRUST_PROXY` | No | Set when running behind a reverse proxy (nginx, Caddy, Cloudflare) — a hop count (e.g. `1`) or a subnet/`loopback`. Only then are `X-Forwarded-*` headers honored for rate-limiting, client IP, and request-derived feed URLs when `PUBLIC_BASE_URL` is unset; without it they're ignored so a direct client can't spoof them. |
| `NODE_ENV` | No | `production` enables JSON logs + HSTS |

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/landscape` | GET | Full wall payload: signals, KEV, actors, velocity |
| `/api/headlines` | GET | Every scored headline from the latest pipeline run |
| `/api/feed.xml` | GET | RSS/Atom feed of the top scored signals (title, link, source, tier, score, KEV) |
| `/api/feed.json` | GET | [JSON Feed](https://www.jsonfeed.org/) of the same top scored signals |
| `/api/briefs.xml` | GET | RSS 2.0 feed of the daily briefing itself |
| `/api/refresh` | POST | Force a pipeline run |
| `/api/brief` | POST | Generate a briefing (SSE stream) |
| `/api/briefs` | GET | Briefing history |
| `/api/brief/:filename` | GET | A specific briefing |
| `/api/search?q=` | GET | Full-text search across all briefings (SQLite FTS5) |
| `/api/health` | GET | Feeds, pipeline, database, memory, and AI status |
| `/api/edition` | GET | Active CTI profile's identity (id, title, label, regions) |
| `/api/settings` | GET / POST | Read/update local organization context and watch terms; read masked AI-key status or set/clear the key at runtime |
| `/api/settings/verify` | POST | Make one cheap Anthropic call to confirm a key actually works |
| `/embed` | GET | Keyless, header-less HTML signal strip for embedding in an `<iframe>` (`?tier=`, `?limit=`). Disabled by default when `API_SECRET` is set — see `ENABLE_EMBED` above. |

## Development

```bash
npm test                    # 500+ tests — scoring, dedupe, SSRF guard,
                            # brief contract, SSE framing, routes, sanitization
npm run test:watch
npm run check:secrets       # CI guards: no committed credentials,
npm run check:history-secrets #   including every reachable branch/tag tree,
npm run check:cti-scope     #   release code and public copy stay CTI-focused,
npm run check:contrast      #   WCAG contrast on every text token,
npm run check:placeholders  #   no placeholder slugs in docs,
npm run check:assets        #   every referenced asset exists
npm run check:scoring       #   score-model invariants and gold-band ordering
```

A quick map of the repo:

```
server.js          composition root — config → db → refresher → middleware → routes
lib/               the engine: feeds, scoring, enrichment, landscape, db, net (SSRF guard)
routes/            Express routers: brief (SSE generation), landscape, settings
public/            frontend, vanilla ES modules, no build step
public/modules/    briefing/ · wire/ · wall/ · core/ · layout/ · settings/
config/domains/    shipping CTI profile and enrichment registry
config.json        the tuning surface: feeds, alert rules, scoring weights, models
test/              release and regression suites
docs/              the landing page (GitHub Pages → blueteam.news)
```

Keyboard shortcuts: `G then B / W / L / S` to switch Briefing / Wire / Wall / Settings · `/` focus search · `Ctrl+Enter` generate · `?` help · `Esc` exit Wall.

### Internal CTI profile boundary

BlueTeam.News ships one enterprise CTI product. Internally, `config/domains/cyber.js` separates threat actors, vendors, regions, urgency rules, enrichment, scoring vocabulary, landscape panels, search queries, and briefing voice from the engine. `config/domains/cyber-enrichers.js` wires the enrichment stages, and core modules access the profile through `lib/domain.js`.

This boundary keeps CTI-specific knowledge out of engine code and leaves room for future CTI specializations such as OT/ICS, cloud and identity, ransomware, or sector-specific threat intelligence.

The npm package, runtime identity, feeds, and operator-facing logs all use the BlueTeam.News name. The legacy `data/watchfloor.db` filename is retained so an upgrade cannot orphan an existing local archive.

## Security posture

- Helmet CSP with per-request script nonces; all assets served same-origin (marked and DOMPurify from `node_modules`; Inter, JetBrains Mono, and Newsreader self-hosted as woff2 in `public/vendor/fonts`) — no runtime CDN, nothing fetched from Google
- All briefing markdown sanitized with DOMPurify before rendering
- Rate limiting on all API routes, stricter on generation; optional bearer auth
- Binds localhost by default; SSE responses never compressed (no proxy buffering surprises)
- No telemetry. Expected outbound traffic is limited to configured feed/data fetches, the optional Anthropic briefing call, and an optional alert webhook you configure yourself.

Found a vulnerability? See [SECURITY.md](SECURITY.md) for how to report it privately.

## FAQ

**Does it need an Anthropic key?** The collection, scoring, Wall, and Wire work without one. The recommended Briefing requires a key and delivers the product's full value: daily synthesis, calibrated judgments, defensive actions, and the complete Wall edition.

**Can I use different feeds?** Yes, that's the point. `trustedFeeds` is yours. Keep the tier assignments honest and the scoring does the rest.

**Why a broadsheet instead of a pew-pew attack map?** Attack maps animate noise. The broadsheet reads like a newspaper: the day's most important judgments and the freshest scored signals, in words a defender can act on from ten feet away.

**Where do actor attributions come from?** A small static map of publicly attributed groups (vendor and government reporting) in `config/domains/cyber.js`.

**Why localhost-only by design?** The Wall runs on the machine that drives the display — a mini-PC behind the TV, or your laptop on a second monitor — so nothing ever needs to be exposed. The server refuses to bind a non-loopback address unless `API_SECRET` is set, and even then that's your explicit opt-in, not the intended deployment. If you need a networked setup, put your own reverse proxy and TLS in front (see `TRUST_PROXY`).

## Governance and support

BlueTeam.News is a maintainer-led project. Unsolicited pull requests and feature requests are not accepted; forks are welcome under the MIT License. Focused bug reports may be opened, but the software is provided as-is with no support commitment, response-time guarantee, maintenance schedule, roadmap, or promise of a fix. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SUPPORT.md](SUPPORT.md). Report security issues privately via [SECURITY.md](SECURITY.md).

---

*AI-assisted and engineered under an untrusted-output model: threat-modeled, tested across 500+ cases, and explicit about where heuristics and generated analysis can fail.*

## License

[MIT](LICENSE). Bundled font software remains under the SIL Open Font License;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

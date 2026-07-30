# BlueTeam.News

[![CI](https://github.com/ryanshrier/blueteam/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanshrier/blueteam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-22.19%2B%20%7C%2024%20%7C%2026-brightgreen)

BlueTeam.News is a self-hosted threat-intelligence desk for cyber defense teams. It collects public threat reporting, enriches and scores each signal, and presents it in three views:

- **The Wall** - an unattended operations display
- **The Wire** - a filterable analyst feed with score evidence, KEV, CVSS, EPSS, and attribution tags
- **The Briefing** - an AI-generated, on-demand or scheduled assessment that requires an operator-provided Anthropic API key; each saved Briefing can be opened as a locally rendered Print Edition for paper or PDF

The Wall and Wire work without API keys. The complete Watch–Investigate–Brief workflow requires an Anthropic API key for Briefing generation.

## Quick start

```bash
git clone https://github.com/ryanshrier/blueteam.git blueteam
cd blueteam
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The first feed refresh begins after startup.

Node 22.19 or newer in the Node 22 line, Node 24, and Node 26 are supported; use the npm version bundled with that Node release. CI exercises the run-from-source workflow on Linux, Windows, and both Intel and Apple Silicon macOS.

In Windows PowerShell, use `npm.cmd install` and `npm.cmd start` if execution policy blocks the `npm.ps1` shim.

## Product views

### The Wall

Open `/wall` on the display driven by the server. It rotates through current signals and CISA KEV changes, and includes the latest saved Briefing when one is available. Press `Esc` to leave the display.

![The Wall showing synthetic scored signals in broadsheet rows](docs/assets/screenshot-wall-wire.jpg)

### The Wire

Open `/wire` to inspect every prioritized signal and the evidence behind its score. Filters cover tier, urgency, KEV status, and unread state. Results include source breadth, timestamps, CVE, CVSS, EPSS, attribution tags, and CSV or JSON export.

![The Wire showing public-source demonstration reporting, filters, and score evidence](docs/assets/screenshot-wire.jpg)

### The Briefing

Open `/briefing` to generate a BLUF, key judgments, defensive actions, developing situations, convergence, and a 72-hour watchlist. Briefing generation requires your Anthropic API key, configured in **Settings** or `.env`. Key verification makes a minimal provider request and may consume billable tokens.

Automatic generation is a separate opt-in and is disabled by default. Settings controls whether it runs, the time and timezone, missed-run behavior, retry interval, and daily attempt limit. Manual and automatic generation use the same pipeline and are billed to the configured Anthropic account; corrective or fallback model calls can add usage.

Before a generation is archived as complete, BlueTeam.News checks required structure, source constraints, citation chronology, incomplete provider output, and trust-critical grounding failures. Other checks remain visible as review warnings. These checks do not replace analyst review or guarantee factual correctness. Completed Briefings are labeled AI-generated, archived as Markdown, and normally indexed in SQLite FTS5. The interface shows the model, token count, estimated cost, and review warnings; an indexing failure is reported and retried during startup reconciliation.

**One Briefing. Two formats.** After a Briefing completes, review it in the application or open its **Print Edition**, a newspaper-style layout for paper or PDF rendered locally from the same saved assessment without another model request.

| Briefing | Print Edition |
|---|---|
| ![The Briefing reader showing a synthetic sourced assessment](docs/assets/screenshot-briefing-reader.jpg) | ![The same synthetic saved assessment in its Print Edition](docs/assets/screenshot-print-edition.jpg) |

The Wall, Briefing, and Print Edition examples use synthetic fixtures. The Wire screenshot shows public-source demonstration reporting. No private or customer operational data is shown.

## How it works

```text
public feeds and advisories
          |
     collect and group
          |
 enrich, score, and retain evidence
          |
  Wall | Wire | AI-generated Briefing
                  (Anthropic API key)
```

Each signal is assigned to an analytic tier. A generated Briefing separately
states the operator's decision window for each key judgment.

| Tier | Analytic horizon | Window | Primary reader |
|---|---|---|---|
| **T1** | Tactical | Current shift to 7 days | SOC, IR, detection |
| **T2** | Operational | Coming weeks to 12 months | Hunt, intelligence, security engineering |
| **T3** | Strategic | Beyond 12 months | Directors, CISO, board |

Source diversity records the distinct publisher identities inferred from article domains and source labels across feeds and news search. It does not prove that the reporting is independent. Score components remain visible in the interface.

## Local data and network behavior

Operational state is stored in `data/watchfloor.db`, saved Briefings in `briefs/*.md`, and operator settings in the gitignored `data/settings.local.json`. BlueTeam.News does not encrypt local state, so protect the host account and backups.

The self-hosted application sends no product telemetry. It does make outbound requests to:

- configured feeds, article pages, and enrichment sources;
- Anthropic when key verification or Briefing generation is requested; and
- an operator-configured webhook.

Briefing requests include selected public-source evidence and configured organization context. See [Operations and deployment](docs/operations.md#network-behavior) for the exact boundary.

Feed, article, and enrichment requests identify BlueTeam.News and its version through a configurable User-Agent; set `BLUETEAM_USER_AGENT` when an operator contact identity is preferred.

The server binds to `127.0.0.1` by default. Network deployment requires a strong `API_SECRET`; remote interactive use also requires an authenticating TLS reverse proxy that injects the bearer token upstream.

## Documentation

| Guide | Contents |
|---|---|
| [Operations and deployment](docs/operations.md) | Runtime support, scheduling and cost, backups, upgrades, supervision, logs, troubleshooting, and remote access |
| [Configuration](docs/configuration.md) | `config.json`, runtime Settings, environment variables, organization context, and webhooks |
| [Architecture](docs/architecture.md) | Collection, scoring, Briefing generation, storage, and module boundaries |
| [API overview](docs/api.md) | REST, SSE, RSS and JSON feeds, authentication, and embedding |
| [Development](docs/development.md) | Tests, policy checks, release checks, and repository layout |
| [Security policy](SECURITY.md) | Deployment model, supported versions, scope, and private reporting |

The project website is [blueteam.news](https://blueteam.news/), and published versions are listed on [GitHub Releases](https://github.com/ryanshrier/blueteam/releases).

## Development

```bash
npm test
npm run check:release
npm run check:secrets
npm run check:cti-scope
npm run check:assets
```

The policy job uses a pinned npm version to enforce the reviewed dependency lifecycle-script allowlist. Runtime jobs deliberately use the npm bundled with each supported Node version so the documented run-from-source workflow stays tested.

## Security, support, and license

Read [SECURITY.md](SECURITY.md) before exposing the service beyond loopback and use GitHub private vulnerability reporting for security issues. The project is maintainer-led and provided without a support or update commitment; see [SUPPORT.md](SUPPORT.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

BlueTeam.News is available under the [MIT License](LICENSE). Bundled fonts remain under the SIL Open Font License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# BlueTeam.News

[![CI](https://github.com/ryanshrier/blueteam/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanshrier/blueteam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-22.19%2B%20%7C%2024%20%7C%2026-brightgreen)

**1.1.0 release candidate.** These notes describe the candidate working tree.
Available published versions are listed on [GitHub Releases](https://github.com/ryanshrier/blueteam/releases).

BlueTeam.News is a self-hosted threat-intelligence desk for cyber defense teams. It collects public threat reporting, enriches and scores each signal, and presents it in three views:

- **The Wall** - an operations display with reading and playback controls
- **The Wire** - a filterable analyst feed with score evidence, KEV, CVSS, EPSS, and attribution tags
- **The Briefing** - an AI-generated, on-demand or scheduled assessment that requires an operator-provided Anthropic API key; each saved Briefing can be opened as a locally rendered Print Edition for paper or PDF

The Wall and Wire work without API keys. The complete Watch–Investigate–Brief workflow requires an Anthropic API key for Briefing generation.

## Quick start

Install Node 22.19 or newer in the Node 22 line, Node 24, or Node 26 first, and
use the npm bundled with it. This is a source-installed Node service.

```bash
git clone https://github.com/ryanshrier/blueteam.git blueteam
cd blueteam
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The first feed refresh begins
after startup; Wire fills as sources respond, without an API key. Check
**Settings → System health** if collection remains unavailable. A Briefing may
wait for enough fresh source evidence even when an Anthropic key is configured.

SQLite uses a native dependency. Run `npm install` on the machine and Node major
that will run the service; do not copy `node_modules` from another installation.
After changing Node majors, stop the server and reinstall dependencies in that
clone. See [native-binding troubleshooting](docs/operations.md#troubleshooting)
if installation or startup reports an ABI error. CI exercises Linux, Windows,
and both Intel and Apple Silicon macOS.

In Windows PowerShell, use `npm.cmd install` and `npm.cmd start` if execution policy blocks the `npm.ps1` shim.

## Product views

### The Wall

Select **WALL** in the app, or press `G` then `L`, to open `/wall?operator` with visible previous, next, and pause/resume controls. Previous/next (or the left/right arrow keys) selects a page and holds it for reading; `Space` pauses or resumes rotation. Compact and portrait screens start paused and allow scrolling through the full page. Press `Esc` to return to the prior app view.

Long sections continue across numbered parts at the same readable type size. Next/previous visits those parts before changing sections; unattended displays advance them automatically. Scrolling holds the page. Feed health keeps updating while paused, and the displayed edition or feed snapshot stays dated until you resume or advance.

For an unattended display, open `/wall` (or `/wall?kiosk`). These existing kiosk routes keep automatic rotation, a hidden pointer, overnight dimming, and burn-in shifting. The Wall rotates through current signals and CISA KEV changes and includes the latest saved Briefing when available. Feed freshness, Briefing publication time, and playback state are labeled separately; an older Briefing does not become current when its page rotates back into view. Publication times use UTC; archives without a known time show their edition date.

![The Wall showing a synthetic executive summary and shift decisions](docs/assets/screenshot-wall-wire.jpg)

### The Wire

Open `/wire` to inspect every prioritized signal and the evidence behind its score. Filters cover tier, urgency, KEV status, and unread state. Results include source breadth, timestamps, CVE, CVSS, EPSS, attribution tags, and CSV or JSON export.

Use **Hidden (N)** to recover signals you hid, including after a reload or after Undo disappears. Restore one signal or all hidden signals still available in the latest feed. Filters also apply in Hidden; restoring preserves read/unread state. These preferences belong to this browser and do not record operational completion.

Set a **Watch profile** in Settings: technologies, sectors, regions, intelligence
questions, exclusions and preferred horizons. Wire explains literal matches and
keeps exposure explicitly unknown. **Inspect evidence** opens each grouped
source's retained feed excerpt, observation dates and earlier revisions; changed
passages appear together with the original wording. Collection after this upgrade
creates that history. A changed badge compares source text with its predecessor,
not with the analyst's last review.

For example, watch a product, inspect its retained advisory, and compare a
later affected-version change. A watch match explains why reporting is relevant;
it does not establish that the product is deployed or exposed in your network.

![The Wire showing synthetic reporting, filters, and retained source evidence](docs/assets/screenshot-wire.jpg)

**Inspect evidence** keeps the source name, observation dates, and changed
wording together. This fictional example compares an earlier affected-version
passage with its correction while leaving local exposure unknown.

![Inspect evidence comparing retained before-and-after passages from a synthetic vendor advisory](docs/assets/screenshot-evidence.jpg)

### The Briefing

Open `/briefing` to generate a BLUF, key judgments, defensive actions, developing situations, convergence, and a 72-hour watchlist. Briefing generation requires your Anthropic API key, configured in **Settings** or `.env`. Key verification makes a minimal provider request and may consume billable tokens.

**Generate briefing** is in the Briefing controls; `Ctrl+Enter` (`⌘+Enter` on macOS) remains available. Generation uses the latest collection selection. Wire searches, filters, and hidden items do not select or exclude its inputs. Judgment reasoning remains visible alongside its likelihood or legacy confidence label. Links into Wire say whether they search a CVE or browse a broader tier; they are not a historical evidence manifest.

On a saved judgment with authored actions, **Copy decision** copies the action text, supplied ownership and timing, cited source links, and an edition link for a handoff. This reuses saved content without another model call. Check the cited reporting and the edition date before acting.

New editions also retain a versioned JSON generation input receipt. **Inspect
saved generation inputs** opens the selected evidence, enrichment, profile,
scoring settings, prompt/model identities and validation used for that edition.
Historical editions without receipts say so. Receipts may contain organizational
context and are available only through the trusted operator connection.
They record what was supplied and checked; they do not independently prove
every claim, verify local exposure, or replace review of the cited reporting.

Read [Evidence and relevance](docs/evidence-and-relevance.md) for usage, retention
and limitations. The [decision-desk roadmap](docs/decision-desk-roadmap.md)
describes proposed priorities: persistent situations, explicit input selection,
reviewed handoffs, and durable analyst decisions. Those review and completion
records are not implemented yet, and no delivery schedule is promised.

Automatic generation is a separate opt-in and is disabled by default. Settings controls whether it runs, the time and timezone, missed-run behavior, retry interval, and daily attempt limit. Manual and automatic generation use the same pipeline and are billed to the configured Anthropic account; corrective or fallback model calls can add usage.

Before a generation is archived as complete, BlueTeam.News checks required decision fields, citation identities and dates, incomplete provider output, and specified CVE, CVSS, version, and KEV claim forms. Other checks remain visible as review warnings. These bounded checks do not establish that all freeform narrative follows from the sources or confirm organizational exposure. Completed Briefings are labeled AI-generated, archived as Markdown, and normally indexed in SQLite FTS5. The interface shows the model, token count, estimated cost, and review warnings; an indexing failure is reported and retried during startup reconciliation.

**One Briefing. Two formats.** After a Briefing completes, review it in the application or open its **Print Edition**, a newspaper-style layout for paper or PDF rendered locally from the same saved assessment without another model request.

| Briefing | Print Edition |
|---|---|
| ![The Briefing reader showing a synthetic sourced assessment](docs/assets/screenshot-briefing-reader.jpg) | ![The same synthetic saved assessment in its Print Edition](docs/assets/screenshot-print-edition.jpg) |

Read the [complete synthetic sample](docs/sample-briefing.html), its exact
[Markdown](docs/sample-briefing.md), and the [saved input receipt](docs/sample-briefing.manifest.json).
The four-page [PDF companion](docs/sample-briefing.pdf) preserves the full sample
and source appendix with separate typesetting; it is not a captured native
browser print result.

The Wall, Wire, Briefing, and Print Edition examples use synthetic fixtures. All
sample sources, systems, and events are fictional. No private or customer
operational data is shown.

### Settings and diagnostics

**Settings → System health** shows the latest readiness check, collection status, source failures, and available storage diagnostics. **Refresh diagnostics** checks again without starting collection or generation. A failed check retains a clearly dated previous result. **Copy diagnostics** copies a limited report without source names, URLs, secrets, organization settings, or raw error messages; it does not send anything to support.

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

# Operations and deployment

[Back to the README](../README.md)

BlueTeam.News is designed to run on the computer that drives the display. Its default configuration listens only on loopback and requires no API keys for collection, scoring, the Wall, or the Wire.

## Local operation

BlueTeam.News is a local Node server, not a desktop application or standalone installer. The installation is the same on macOS, Linux, and Windows:

```bash
git clone https://github.com/ryanshrier/blueteam.git blueteam
cd blueteam
npm install
npm start
```

```text
http://127.0.0.1:3000
```

On Windows PowerShell, use `npm.cmd install` and `npm.cmd start` if execution policy blocks the `npm.ps1` shim.

The first feed refresh begins after startup. Later refreshes run on the cadence configured in `analysisSettings` (10 minutes by default).

### Wall display

Open the passive display route on the same machine:

```text
http://127.0.0.1:3000/wall
```

The Wall hides the pointer automatically and rotates through the available landscape pages. Press `Esc` to leave it. A mini-PC or Raspberry Pi behind a display, or a laptop connected to a second monitor, can host both the server and browser. The display uses regular HTML and CSS rather than WebGL or canvas.

Without an Anthropic key, the rotation still includes KEV changes and prioritized signals. When Briefing generation is enabled, the Wall adopts each completed edition automatically.

## Briefing schedule and cost

Briefings can be generated on demand. The scheduler also attempts one edition at 05:00 local time:

- A missed scheduled run catches up after restart.
- A failed scheduled run retries every 15 minutes.
- A successful run is recorded so restarting does not duplicate that day's scheduled edition.
- Scheduled and manual generations are both billed to the configured Anthropic account.

The interface reports the model, token count, and estimated API cost for a completed generation.

## Runtime support

Node 22 or later is required. CI exercises Node 22, 24, and 26, including Node 26 on both Apple Silicon and Intel macOS. Node 26 support is part of the normal source installation; it does not imply a separate macOS package.

`better-sqlite3` contains a native component, so `node_modules` must not be copied between operating systems, CPU architectures, or incompatible Node runtimes. Clone the repository and run `npm install` on the machine that will run the server. If startup reports a `NODE_MODULE_VERSION` mismatch, remove that machine's stale `node_modules` directory and run `npm install` again with the intended Node version.

npm 11.18 or later is recommended because it enforces the exact dependency install scripts approved in `package.json`; CI pins that version and fails closed on an unreviewed script. An older npm bundled with a supported Node release still completes `npm install`, but prints a compatibility warning and cannot enforce the allowlist locally. Normal installs do not submit an automatic audit request; CI runs explicit, severity-gated dependency audits.

## Network deployment

The default `HOST=127.0.0.1` is the intended deployment. If remote browsers must connect:

1. Generate and set an `API_SECRET` of at least 32 characters. The server refuses weak secrets and refuses to bind a non-loopback address without one:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. Put a reverse proxy with TLS in front of the application.
3. Set `TRUST_PROXY` to the exact proxy hop count or trusted subnet. Leave it unset when no proxy is present.
4. Set `PUBLIC_BASE_URL` when feed metadata and Briefing webhook links need a stable public origin.
5. Set `CORS_ORIGIN` only when a separate allowed origin needs API access.

All `/api/*` requests except `/api/health` then require:

```http
Authorization: Bearer <API_SECRET>
```

The browser frontend does not store or attach the shared bearer secret. Direct remote browser use with `API_SECRET` therefore needs a trusted reverse proxy that authenticates users and injects the bearer header on upstream `/api/*` requests. API clients can send the header directly. Do not put the shared secret in a URL or browser storage.

The `/embed` route cannot supply that header and is disabled automatically when `API_SECRET` is set. `ENABLE_EMBED=1` opts it back in; use that only when the proxy and embedding origin are locked down.

The server validates Host and browser Origin boundaries as well as bearer authentication. Keep `PUBLIC_BASE_URL` and `CORS_ORIGIN` exact; do not use a wildcard for a network deployment.

See [configuration](configuration.md) for the environment-variable reference and [SECURITY.md](../SECURITY.md) for the complete hardening checklist.

## Health and outbound traffic

`GET /api/health` remains available without authentication for uptime probes. When `API_SECRET` is configured, an unauthenticated request receives only the overall status even if a reverse proxy connects to the server over loopback; a valid bearer token unlocks detailed feed, pipeline, database, memory, and AI diagnostics. In the default keyless loopback deployment, local callers receive the detailed payload. A fresh installation can report a degraded state until its first source responses arrive.

The application sends no telemetry. Expected outbound requests are limited to:

- configured feeds, search, article pages selected for extraction, and enrichment sources such as CISA KEV, NVD, and EPSS;
- Anthropic when Briefing generation or key verification is requested; and
- an alert webhook explicitly configured by the operator.

Briefing generation sends Anthropic the configured team profile, audience, sector, watch topics, and regions; the selected public-source titles, descriptions or short article excerpts, source labels, publication dates, URLs, and enrichment facts; and compact topic labels from recent Briefings for continuity. The Anthropic API key is used only to authenticate that request. Key verification sends a minimal verification request.

Webhook delivery sends only the configured event payload. Alert payloads contain matched titles, links, sources, horizon and score metadata, and KEV status. Briefing payloads contain the edition date, BLUF, key-judgment titles and confidence, and an optional link. Treat the webhook endpoint as a data recipient.

Webhook failures are logged and do not block refreshes or Briefing storage.

On POSIX systems, startup tightens `data/` and `briefs/` to mode `0700` and sensitive settings, Briefing, SQLite, WAL, and SHM files to `0600`. Windows keeps the account's normal ACL behavior. BlueTeam.News does not encrypt local state; protect the operating-system account and backups.

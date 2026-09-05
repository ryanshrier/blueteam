# Operations and deployment

[Back to the README](../README.md)

BlueTeam.News runs as one local Node process. Collection, scoring, the Wall, and the Wire require no API key. AI-generated Briefings require the operator's Anthropic API key. The default listener is loopback-only.

## Start, stop, and restart

```bash
git clone https://github.com/ryanshrier/blueteam.git blueteam
cd blueteam
npm install
npm start
```

Open `http://127.0.0.1:3000`. The first feed refresh begins after startup; later refreshes use `analysisSettings.refreshMinutes`.

Stop an interactive process with `Ctrl+C`. On `SIGINT` or `SIGTERM`, the server stops schedules and new HTTP work immediately. Shutdown normally retains a 30-second guard; if a Briefing is already generating, it keeps SQLite and outbound pools available for the supported generation maximum (up to 600 seconds) plus a bounded three-minute completion-cleanup margin. Restart it with `npm start`.

Only run one process against a repository's `data/` directory. Concurrent server processes are not a supported clustering model.

### Wall display

Open `http://127.0.0.1:3000/wall` on the display. The Wall hides the pointer, rotates through the available views, and uses regular HTML and CSS rather than WebGL or canvas. Press `Esc` to leave it.

For staffed use, the app's **WALL** button and `G`, then `L` shortcut open `/wall?operator`. Visible previous/next controls and the arrow keys select and pause on a page; `Space` or the pause/resume button controls rotation. Compact and portrait layouts start paused and support scrolling. `/wall` and `/wall?kiosk` remain the unattended entry points. The status area distinguishes feed freshness, the saved Briefing's publication time (UTC, or its edition date if no time is known), and playback state.

Without an Anthropic key, the Wall still shows KEV changes and prioritized signals. It adopts the latest saved Briefing when one is available.

## Runtime support

Use Node 22.19 or newer in the Node 22 line, Node 24, or Node 26 and the npm version bundled with it. Other Node majors are not part of the supported matrix.

`better-sqlite3` contains a native component. Run `npm install` on the machine and Node version that will run the server; do not copy `node_modules` between operating systems, CPU architectures, or Node majors. After changing Node versions, reinstall dependencies before starting.

The Node 22.19 floor comes from the supported Undici transport used for SSRF-pinned outbound requests. Do not bypass the engine check with an older Node release.

The CI policy job separately pins npm 11.18 to enforce the exact lifecycle scripts approved in `package.json`. Runtime-matrix jobs use each Node release's bundled npm, matching the documented local workflow. Normal installs do not automatically submit the dependency graph for audit; CI runs explicit full and production dependency audits.

## Briefing schedule and cost

Manual Briefing generation is available whenever a valid Anthropic key is configured. Automatic generation is a separate, explicit opt-in under **Settings** and is disabled by default. Its controls are:

| Setting | Default | Meaning |
|---|---:|---|
| Enabled | Off | Allows unattended, billable generation |
| Time | `05:00` | 24-hour wall-clock time |
| Timezone | Server local | Server timezone or an IANA timezone |
| Missed run | Skip | Skip today's initial missed run, or queue one delayed catch-up attempt after startup |
| Retry interval | 15 minutes | Delay after a failed attempt |
| Maximum attempts | 3 | Daily automatic-attempt limit |

Schedule state and outcomes persist in SQLite, so a restart does not erase the attempt count or duplicate a successful daily run. Catch-up applies only to today's missed scheduled time and does not replay multiple missed days. An attempt chain that already began can resume after restart within the saved daily attempt limit, even when the initial missed-run policy is **Skip**. If no Anthropic key is available, an enabled schedule waits and reports that state instead of enabling itself or issuing a provider call.

Manual and automatic requests share the same generation route, cooldown, rate limits, validation, storage, and webhook path. Route-level request limits use process-local fixed windows and reset when the server restarts; the separate automatic-schedule attempt count persists in SQLite. Key verification sends a minimal provider request, and every provider request may consume billable tokens on the configured Anthropic account. Corrective retries, timeout recovery, and model or key fallback can make additional provider calls, so these limits are guardrails rather than spending caps. Review Anthropic account limits and billing separately.

The default generation settings use `thinkingEffort: "low"`, a 16,000-token output cap, and a 300-second generation deadline. Explicit operator configuration remains authoritative.

If the provider stops at the configured output-token limit, BlueTeam.News uses the existing one-retry allowance at lower thinking effort without raising the configured cap. With the default low setting, that recovery disables thinking for the retry. If that retry also exhausts the limit, the app returns the recoverable draft but does not archive, index, dispatch, or announce it as complete. Raise `analysisSettings.maxTokens` in `config.json` or reduce the Briefing scope before trying again.

Completed Briefings report the model, token counts, and an estimated cost. Estimates can differ from the provider invoice.

New completed editions also save a bounded JSON input manifest beside the Markdown. The manifest is flushed before the archive becomes the completion marker. A manifest or archive publication error prevents a completion event and webhook; check filesystem space, permissions, and logs before retrying. A crash before the Markdown rename can leave an orphan manifest, which a later publication of that edition replaces. This protects completed-edition integrity; it does not persist a recoverable generation job or guarantee that a failed paid attempt will never need another provider call.

Opening a completed Briefing's **Print Edition** reuses that saved assessment. The Print Edition is rendered locally in the browser, and printing or saving it as a PDF uses the browser's print pipeline. Viewing or exporting the Print Edition does not make another Anthropic request.

## State and backups

Back up these paths:

| Path | Contents |
|---|---|
| `data/` | SQLite database, WAL/SHM sidecars, source observations/revisions, schedule and alert state, feed caches, and local Settings/watch profile |
| `briefs/` | Saved Briefing Markdown and matching `*.manifest.json` generation inputs |
| `config.json` | Feeds, scoring, organization/watch-profile defaults, models, and webhooks |
| `.env` or service environment | Optional secrets and server configuration |

`data/settings.local.json` can contain the Anthropic key in plaintext. Store backups with the same care as the live host. Do not back up `node_modules`; reinstall it on the restore target.

For a consistent backup:

1. Stop the server and wait for it to exit.
2. Copy the entire `data/` and `briefs/` directories, plus `config.json`.
3. Back up `.env` or the service-manager secret configuration separately in protected storage.
4. Record the application tag/commit and Node major used by the backup.
5. Test restoration in a separate clone before relying on the backup.

To restore:

1. Stop the target server.
2. Check out the recorded application version.
3. Replace the target `data/`, `briefs/`, and `config.json` with the backup and restore secrets through the chosen secret mechanism.
4. Run `npm install` with a supported Node version.
5. Start the server and inspect `/api/health`, the Wire, and Briefing history. Open a retained source revision and a new edition's **Inspect saved generation inputs (JSON)** link to verify that evidence and its matching manifest were restored.

Never replace a live SQLite database. Copying only `watchfloor.db` while the process is running can omit committed data still represented by its WAL file.

Keep each Briefing and its manifest together. Manifest reads verify the exact Markdown hash; changing the Markdown outside the application causes a verification failure. Old editions legitimately have no manifest, and restoration does not reconstruct inputs that were never saved. Protect manifests like local Settings because they include organizational interests and selected source excerpts, even though provider credentials and raw configuration are excluded.

### Evidence retention and redistribution

Collection prunes source records not observed for 30 days, caps retained sources at 5,000, and keeps at most eight revisions per source across its feed representations. A source still being observed can retain an older revision until the count cap removes it. These are bounded code defaults; there is no retention-policy editor. Passages are normalized feed extracts bounded to 8,192 characters, with clipping/title-only labels where applicable. Collection or storage failures leave the Wire usable and mark retained evidence unavailable rather than inventing revisions.

Saved Briefings and manifests are retained until the operator removes them. Their copied passages survive rolling database pruning. Removing database evidence does not delete copied excerpts from manifests or backups; include these artifacts in the local retention policy and storage monitoring. Backups require their own access and expiration controls.

Source licensing and handling restrictions are not yet tracked or enforced per passage. Keeping a local excerpt does not make it a preapproved public export. Preserve attribution and source links and check the source's sharing conditions before redistributing a manifest or excerpt. See [Evidence and relevance](evidence-and-relevance.md) for the boundaries of this milestone.

## Upgrade and rollback

Before an upgrade, take a stopped-process backup and record the current tag or commit.

### From v1.0.3 to v1.1.0

The v1.1.0 startup migrates SQLite from schema 7 to schema 9, adding retained
source evidence and first-observation snapshot storage. Existing records remain
available, but older observations are not retroactively reconstructed. Saved
Briefings without generation-input manifests remain readable and explicitly
report that their original inputs are unavailable.

Keep the stopped v1.0.3 code and its complete pre-upgrade backup until you have
verified the upgraded service. Preserve local configuration and source changes
before changing versions; do not force a checkout over operator edits. Review
new defaults when merging configuration: generation now defaults to low thinking
effort, while existing explicit settings remain authoritative.

### Install and verify an available release

```bash
git fetch --tags
git checkout vX.Y.Z
npm install
npm start
```

Use a published release tag you intend to run; a candidate changelog entry does
not mean that its tag or download is available yet. After startup, verify the
version and pipeline state in `/api/health`, then open the Wall, Wire, Settings,
and a saved Briefing. Allow a new collection to finish and inspect a retained
source passage. Review **Settings → System health** for persistent storage or
feed failures before requesting a billable Briefing.

Database migrations run forward at startup. The safest rollback is therefore code **and** the matching pre-upgrade `data/` and `briefs/` backup:

1. Stop the server.
2. Check out the prior tag.
3. Restore its matching backup.
4. Run `npm install`.
5. Start and verify the service.

Do not assume a database opened by a newer release remains compatible with older
code. In particular, a rollback from v1.1.0 to v1.0.3 must restore the matching
schema-7 `data/`, `briefs/`, and configuration backup; do not lower the SQLite
schema marker manually or merge newer database files into that backup. Restore
the corresponding protected secret configuration as needed.

## Process supervision and logs

A service manager can start BlueTeam.News after boot. Configure it to:

- run `npm start` with the repository as its working directory;
- run as a dedicated, unprivileged account that owns `data/` and `briefs/`;
- inject secrets through the environment or a protected `.env`;
- restart on failure with a backoff, but not restart continuously on configuration errors;
- forward `SIGTERM`; allow at least 35 seconds normally, or 14 minutes when an active Briefing must drain safely;
- capture stdout and stderr with size- or time-based rotation; and
- prevent two instances from using the same state directory.

BlueTeam.News writes operational logs to stdout and stderr. `NODE_ENV=production` changes them to one JSON object per line. It does not provide log shipping or rotation. Logs sanitize common credentials and terminal controls, but can still contain source URLs, titles, request paths, and diagnostic context; apply the organization's normal retention and access rules.

When `analysisSettings.debugScoring` is enabled, score diagnostics append to `data/scoring-debug.log`. Disable it outside focused diagnosis and rotate or remove that file according to local policy. Saved Briefings and generation manifests are not automatically expired, so monitor `briefs/` as well as the database size reported by `/api/health`.

## Health checks

Use `GET /api/live` as the process liveness check. It returns HTTP 200 while the server can answer requests. Use `GET /api/ready` for traffic readiness; `/api/health` is its compatibility alias.

Readiness reports `ok` or `degraded`. A fresh installation can be degraded until the first source responses arrive. Persistent degradation indicates stale pipeline data, broad feed failure, or a database problem. A rejected configuration reload does not change readiness while the last good configuration remains active, but its error appears in the detailed response.

When `API_SECRET` is configured, an unauthenticated readiness request receives only the overall status. A valid bearer token unlocks version, feed, pipeline, database, memory, and AI diagnostics. Readiness returns HTTP 503 while degraded; configure restarts from repeated liveness failures, not one readiness failure.

The same readiness information is available in **Settings → System health**. The panel reads useful diagnostics from a degraded HTTP 503 response, identifies sources needing attention, and labels retained results when a later request fails. **Refresh diagnostics** is read-only and does not trigger feed collection or generation. Schedule timing and outcomes remain in the Scheduled Briefing section.

**Copy diagnostics** prepares a limited report containing health counts, version, timing, and database size. Source names and URLs, credentials, organization settings, and raw configuration errors are excluded. Copying does not submit a support request. When clipboard access is unavailable, a selectable sanitized report is shown. A client receiving only the overall readiness status sees that detailed diagnostics are unavailable; the panel does not bypass the existing authentication boundary.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `POST /api/brief` returns 429 | Another generation may be active, a request may have started within the last 15 seconds (including an early failure), or the short-window/daily limit may be reached. Honor `Retry-After`, do not repeatedly click Generate, and inspect the JSON error and logs. |
| Briefing reports stale or unavailable evidence (`E_EVIDENCE`) despite a saved key | Generation stops before calling Anthropic when current source evidence is insufficient. Check **Settings → System health**, restore the server's outbound connectivity to its configured sources, and allow collection to finish before retrying. Replacing the API key does not repair feed connectivity. |
| Automatic Briefing did not run | Confirm the schedule is enabled in Settings, a valid key is available, the configured timezone is correct, and the displayed schedule status has not reached its daily attempt limit. |
| `NODE_MODULE_VERSION`, ABI, or native-binding error | Stop the server, confirm Node is a supported release, delete only this clone's `node_modules`, then run `npm install` again. Never reuse another machine's dependency directory. |
| `EADDRINUSE` at startup | Another process already uses `PORT`; stop that process or choose another port. Do not start a second copy against the same `data/`. |
| Health stays degraded after first start | Inspect feed statuses and `configReloadError` in authenticated health details, then review logs for proxy, DNS, certificate, rate-limit, or config validation failures. |
| Feeds fail behind a corporate proxy | Confirm the host can reach the configured HTTPS origins and that TLS inspection trusts the organization's CA. BlueTeam.News does not include a proxy-bypass mode. |
| Briefing is disabled | Add or verify an Anthropic key in Settings or through `ANTHROPIC_API_KEY`; an environment key takes precedence over the Settings key. |
| Database or Briefing history is missing after a move | Restore `data/` and `briefs/` together, confirm filesystem ownership, and use the application version recorded with the backup. |
| Source evidence is missing or an attached revision is no longer retained | Evidence starts with collection after the upgrade and has rolling count/age limits. Newer observations do not reconstruct an older missing passage. Inspect the source link and collection/storage diagnostics; do not treat missing evidence as a negative finding. |
| A Briefing has no saved inputs or its manifest fails verification | Old editions have no reconstructed manifest. For newer editions, restore the matching Markdown/manifest pair; check for an external edit, partial restore, corrupt file, or storage failure. A manifest hash does not authorize replacing the original assessment. |

## Network deployment

The default `HOST=127.0.0.1` is the intended deployment. If remote browsers must connect:

1. Generate an `API_SECRET` of at least 32 random characters:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. Set the non-loopback `HOST`. The server refuses that bind without a strong secret.
3. Put a TLS-terminating, authenticating reverse proxy in front of the application.
4. Set `TRUST_PROXY` to the exact proxy hop count or trusted subnet.
5. Set `PUBLIC_BASE_URL` to the canonical public origin.
6. Set `CORS_ORIGIN` only when a separate, exact origin needs API access.
7. Restrict direct listener access with the host firewall.

All `/api/*` requests except `/api/live`, `/api/ready`, and `/api/health` then require:

```http
Authorization: Bearer <API_SECRET>
```

The browser does not store or attach the shared secret. A remote interactive deployment needs its trusted reverse proxy to authenticate users and inject the bearer header on upstream API requests. API clients can send it directly. Do not place the secret in a URL or browser storage.

`/embed` cannot supply the header and is disabled when `API_SECRET` is set. `ENABLE_EMBED=1` opts it back in; use that only when the proxy and embedding origin are otherwise locked down.

## Network behavior

Source freshness uses the last successful publisher observation, including a
confirmed HTTP 304. A failed origin served from local cache remains visible but
is marked stale and does not count as reachable. Paid generation requires at
least five current source groups observed within 30 minutes, and successful
checks for at least half of configured RSS sources when coverage is known.
Freshness is measured over the same bounded source members sent to the model.
An empty refresh preserves the previous landscape without renewing its age.

Collection scans at most 200 entries per feed before ranking; collection
diagnostics expose this limit, feeds exceeding it, and the number of unscanned
items. Source diversity still limits the final selection to 50 headlines.
Cached CVSS and EPSS can affect that selection; new expensive lookups operate
within their configured budgets after selection. Upstream enrichment failures
remain nonfatal and are reported explicitly.

SQLite schema v9 retains an immutable first-observation ranking snapshot for
new archive rows. Existing rows are deliberately not backfilled from current
scores or KEV labels. `npm run backtest` reads these selected-only observations;
it does not estimate predictive precision or replay historical ranking inputs.
Database readiness combines a read probe with the recorded outcomes of actual
evidence, archive, settings, and generation persistence operations. A failed
write keeps the affected area degraded until that operation succeeds again.

The self-hosted application sends no product telemetry. Expected outbound requests are:

- configured RSS/Atom feeds, news search, selected article pages, and enrichment sources such as CISA KEV, NVD, and EPSS;
- Anthropic when Briefing generation or key verification is requested; and
- an alert webhook configured by the operator.

Briefing generation sends Anthropic the configured team profile, audience, and effective watch profile, including technologies, sectors, regions, intelligence questions, lower-interest topics, and preferred horizons; selected public-source titles, descriptions or short excerpts, source labels, publication dates, URLs, and enrichment facts; and compact topic labels from recent Briefings for continuity. Key verification sends a minimal provider request. Opening retained evidence or a saved generation manifest makes no publisher or model request.

Feed, article, and enrichment requests use the default User-Agent `BlueTeam.News/<version> (+https://blueteam.news)`. This identifies the application to source operators but does not report usage back to BlueTeam.News. Set `BLUETEAM_USER_AGENT` to use an operator-controlled identity, such as one containing a contact URL.

Webhook payloads contain the configured event's fields. Signal alerts include matched titles, links, sources, tier and score metadata, and KEV status. Briefing notifications include the edition date, BLUF, judgment titles and confidence, an optional link, and—when present—the total review-warning count plus bounded warning text. Webhook failure is logged and does not block refreshes or Briefing storage.

On POSIX systems, startup requests mode `0700` for `data/` and `briefs/` and mode `0600` for sensitive settings, Briefing, SQLite, WAL, and SHM files. New generation manifests are written with mode `0600`. Windows retains the account's ACL behavior. Local state is not encrypted; protect the operating-system account, filesystem, and backups.

See [Configuration](configuration.md) for environment variables and [SECURITY.md](../SECURITY.md) for the deployment security model.

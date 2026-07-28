# Operations and deployment

[Back to the README](../README.md)

BlueTeam.News runs as one local Node process. Collection, scoring, the Wall, and the Wire require no API key. The default listener is loopback-only.

## Start, stop, and restart

```bash
git clone https://github.com/ryanshrier/blueteam.git blueteam
cd blueteam
npm install
npm start
```

Open `http://127.0.0.1:3000`. The first feed refresh begins after startup; later refreshes use `analysisSettings.refreshMinutes`.

Stop an interactive process with `Ctrl+C`. On `SIGINT` or `SIGTERM`, the server stops schedules and new HTTP work immediately. Shutdown normally retains a 30-second guard; if a Briefing is already generating, it keeps SQLite and outbound pools available for the supported generation maximum (up to 600 seconds) plus a bounded three-minute publication-cleanup margin. Restart it with `npm start`.

Only run one process against a repository's `data/` directory. Concurrent server processes are not a supported clustering model.

### Wall display

Open `http://127.0.0.1:3000/wall` on the display. The Wall hides the pointer, rotates through the available views, and uses regular HTML and CSS rather than WebGL or canvas. Press `Esc` to leave it.

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
| Missed run | Skip | Skip or catch up after the server was offline |
| Retry interval | 15 minutes | Delay after a failed attempt |
| Maximum attempts | 3 | Daily automatic-attempt limit |

Schedule state and outcomes persist in SQLite, so a restart does not erase the attempt count or duplicate a successful daily run. If no AI key is available, an enabled schedule waits and reports that state instead of enabling itself or issuing a provider call.

Manual and automatic requests share the same generation route, cooldown, rate limits, validation, storage, and webhook path. Route-level request limits use process-local fixed windows and reset when the server restarts; the separate automatic-schedule attempt count persists in SQLite. Each provider request is billed to the configured Anthropic account. Corrective retries, timeout recovery, and model or key fallback can make additional provider calls, so these limits are guardrails rather than spending caps. Review Anthropic account limits and billing separately.

Completed editions report the model, token counts, and an estimated cost. Estimates can differ from the provider invoice.

## State and backups

Back up these paths:

| Path | Contents |
|---|---|
| `data/` | SQLite database, WAL/SHM sidecars, schedule and alert state, feed caches, and local Settings |
| `briefs/` | Saved Briefing Markdown |
| `config.json` | Feeds, scoring, organization defaults, models, and webhooks |
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
5. Start the server and inspect `/api/health`, the Wire, and Briefing history.

Never replace a live SQLite database. Copying only `watchfloor.db` while the process is running can omit committed data still represented by its WAL file.

## Upgrade and rollback

Before an upgrade, take a stopped-process backup and record the current tag or commit.

```bash
git fetch --tags
git checkout vX.Y.Z
npm install
npm start
```

Use the release tag you intend to run. After startup, verify the version and pipeline state in `/api/health`, then open the Wall, Wire, Settings, and a saved Briefing.

Database migrations run forward at startup. The safest rollback is therefore code **and** the matching pre-upgrade `data/` and `briefs/` backup:

1. Stop the server.
2. Check out the prior tag.
3. Restore its matching backup.
4. Run `npm install`.
5. Start and verify the service.

Do not assume a database opened by a newer release remains compatible with older code.

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

When `analysisSettings.debugScoring` is enabled, score diagnostics append to `data/scoring-debug.log`. Disable it outside focused diagnosis and rotate or remove that file according to local policy. Saved Briefings are not automatically expired, so monitor `briefs/` as well as the database size reported by `/api/health`.

## Health checks

Use `GET /api/live` as the process liveness check. It returns HTTP 200 while the server can answer requests. Use `GET /api/ready` for traffic readiness; `/api/health` is its compatibility alias.

Readiness reports `ok` or `degraded`. A fresh installation can be degraded until the first source responses arrive. Persistent degradation indicates stale pipeline data, broad feed failure, or a database problem. A rejected configuration reload does not change readiness while the last good configuration remains active, but its error appears in the detailed response.

When `API_SECRET` is configured, an unauthenticated readiness request receives only the overall status. A valid bearer token unlocks version, feed, pipeline, database, memory, and AI diagnostics. Readiness returns HTTP 503 while degraded; configure restarts from repeated liveness failures, not one readiness failure.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `POST /api/brief` returns 429 | Another generation may be active, the 15-second completion cooldown may still apply, or the short-window/daily limit may be reached. Honor `Retry-After`, do not repeatedly click Generate, and inspect the JSON error and logs. |
| Automatic Briefing did not run | Confirm the schedule is enabled in Settings, a valid key is available, the configured timezone is correct, and the displayed schedule status has not reached its daily attempt limit. |
| `NODE_MODULE_VERSION`, ABI, or native-binding error | Stop the server, confirm Node is a supported release, delete only this clone's `node_modules`, then run `npm install` again. Never reuse another machine's dependency directory. |
| `EADDRINUSE` at startup | Another process already uses `PORT`; stop that process or choose another port. Do not start a second copy against the same `data/`. |
| Health stays degraded after first start | Inspect feed statuses and `configReloadError` in authenticated health details, then review logs for proxy, DNS, certificate, rate-limit, or config validation failures. |
| Feeds fail behind a corporate proxy | Confirm the host can reach the configured HTTPS origins and that TLS inspection trusts the organization's CA. BlueTeam.News does not include a proxy-bypass mode. |
| Briefing is disabled | Add or verify an Anthropic key in Settings or through `ANTHROPIC_API_KEY`; an environment key takes precedence over the Settings key. |
| Database or Briefing history is missing after a move | Restore `data/` and `briefs/` together, confirm filesystem ownership, and use the application version recorded with the backup. |

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

The self-hosted application sends no product telemetry. Expected outbound requests are:

- configured RSS/Atom feeds, news search, selected article pages, and enrichment sources such as CISA KEV, NVD, and EPSS;
- Anthropic when Briefing generation or key verification is requested; and
- an alert webhook configured by the operator.

Briefing generation sends Anthropic the configured team profile, audience, sector, watch topics, and regions; selected public-source titles, descriptions or short excerpts, source labels, publication dates, URLs, and enrichment facts; and compact topic labels from recent Briefings for continuity. Key verification sends a minimal provider request.

Webhook payloads contain the configured event's fields. Signal alerts include matched titles, links, sources, tier and score metadata, and KEV status. Briefing notifications include the edition date, BLUF, judgment titles and confidence, and an optional link. Webhook failure is logged and does not block refreshes or Briefing storage.

On POSIX systems, startup requests mode `0700` for `data/` and `briefs/` and mode `0600` for sensitive settings, Briefing, SQLite, WAL, and SHM files. Windows retains the account's ACL behavior. Local state is not encrypted; protect the operating-system account, filesystem, and backups.

See [Configuration](configuration.md) for environment variables and [SECURITY.md](../SECURITY.md) for the deployment security model.

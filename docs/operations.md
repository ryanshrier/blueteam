# Operations and deployment

[Back to the README](../README.md)

BlueTeam.News runs as one local Node process. Collection, scoring, the Wall, and the Wire require no API key. Its built-in Briefing providers require an Anthropic or OpenAI API key. Configure both keys and switch providers in Settings; OpenAI supports Codex models through the Responses API. The default listener is loopback-only.

**Custom (local module) is experimental; its contract may change.** It loads an operator-supplied adapter that runs trusted code with the server's permissions and reads credentials from the environment. Configure and review the module before enabling generation; see the [local provider contract](configuration.md#local-provider-modules).

## Start, stop, and restart

```bash
git clone --branch v1.4.7 --single-branch https://github.com/ryanshrier/blueteam.git blueteam
cd blueteam
npm install
npm start
```

Open `http://127.0.0.1:3000`. The first feed refresh begins after startup; later refreshes use `analysisSettings.refreshMinutes`.

Stop an interactive process with `Ctrl+C`. On `SIGINT` or `SIGTERM`, the server stops schedules and new HTTP work immediately. Shutdown normally retains a 30-second guard; if a Briefing is active, it keeps SQLite and outbound pools available for the supported generation maximum (up to 1,200 seconds), up to three minutes of collection, and a three-minute preflight/completion margin. The resulting 26-minute guard is a ceiling; shutdown finishes as soon as accepted work drains. Restart it with `npm start`.

Only run one process against a repository's `data/` directory. Concurrent server processes are not a supported clustering model.

`BLUETEAM_STATE_DIR` optionally relocates `data/`, `briefs/`, and `reviews/` together; `BLUETEAM_CONFIG_PATH` selects the configuration file. Relative paths resolve from the working directory. Keep backups and filesystem permissions aligned with these paths. The `BLUETEAM_DISABLE_COLLECTION=1` switch is honored only with `NODE_ENV=test` and disables collection, scheduled generation, and webhook retries for isolated tests; it is not a production operating mode.

### Wall display

Open `http://127.0.0.1:3000/wall` on the display. The Wall hides the pointer, rotates through the available views, and uses regular HTML and CSS rather than WebGL or canvas. Press `Esc` to leave it.

The app's **WALL** button and `G`, then `L` shortcut also open `/wall` directly as an automatic TV loop with no visible navigation or setup step. Configure text size, margins, playback, fullscreen, and supported screen-awake behavior in **Settings → Wall display**. If fullscreen is enabled, the navigation gesture requests it without blocking entry; a direct URL or reload does not. The Wall fills the viewport even if the browser declines fullscreen. Feed freshness remains separate from the saved Briefing's publication time (UTC, or its edition date if no time is known).

Without an AI provider key, the Wall still shows KEV changes and prioritized signals. It adopts the latest eligible saved Briefing when one is available; review-required and superseded editions remain outside that default selection.

## Runtime support

The application pins Node 24.22.1 LTS through `.node-version` and `.nvmrc`. Windows operators can run `powershell -File .\scripts\setup-lts.ps1` from the project directory to install a verified official runtime under `.runtime/` and reinstall dependencies. This leaves other applications' system runtime in place. All application npm commands select the managed LTS runtime when invoked from an unsupported system Node. An explicitly selected supported Node 22, 24, or 26 runtime remains in use for development and CI. Use `npm run runtime:check` to see the actual executable and confirm its native binding. Direct `node server.js` rejects unsupported runtimes; direct `npm install` is also engine-strict.

Use Node 22.23.4 or newer in the Node 22 line, Node 24.22.1 or newer in the Node 24 line, or Node 26.12.1 or newer in the Node 26 line, with the npm version bundled with it. Other Node majors are not part of the supported matrix.

`better-sqlite3` contains a native component. Run `npm install` on the machine and Node version that will run the server; do not copy `node_modules` between operating systems, CPU architectures, or Node majors. After changing Node versions, reinstall dependencies before starting.

These minimum versions include the [October 21, 2026 Node security fixes](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), including DNS/TLS and Brotli handling. Keep deployments on the latest security patch in the chosen supported major. Updating npm dependencies does not update Node's native libraries or bundled transport.

The CI policy job separately pins npm 11.18 to enforce the exact lifecycle scripts approved in `package.json`. Runtime-matrix jobs use each Node release's bundled npm, matching the documented local workflow. Normal installs do not automatically submit the dependency graph for audit; CI runs explicit full and production dependency audits.

## Briefing schedule and cost

Manual Briefing generation requires a configured provider and enough current source evidence. Built-in providers need a valid key; an experimental Custom module supplies its own client and environment credentials. Automatic generation is a separate, explicit opt-in under **Settings** and is disabled by default. Its controls are:

| Setting | Default | Meaning |
|---|---:|---|
| Enabled | Off | Allows unattended, billable generation |
| Time | `05:00` | 24-hour wall-clock time |
| Timezone | Server local | Server timezone or an IANA timezone |
| Missed run | Skip | Skip today's initial missed run, or queue one delayed catch-up attempt after startup |
| Retry interval | 15 minutes | Delay after a failed attempt |
| Maximum attempts | 3 | Daily automatic-attempt limit |

Schedule state and outcomes persist in SQLite, so a restart does not erase the attempt count or duplicate a successful daily run. Catch-up applies only to today's missed scheduled time and does not replay multiple missed days. An attempt chain that already began can resume after restart within the saved daily attempt limit, even when the initial missed-run policy is **Skip**. If the selected provider has no client, an enabled schedule waits instead of issuing a provider call. For built-in providers this normally means a missing key; for Custom it means the module did not supply a valid client.

Manual and automatic requests share the same generation route, cooldown, rate limits, validation, storage, and webhook path. Route-level request limits use process-local fixed windows and reset when the server restarts; the separate automatic-schedule attempt count persists in SQLite. Built-in key verification sends a minimal provider request, and provider requests may consume billable tokens. Corrective retries, timeout recovery, and model or key fallback can make additional provider calls, so these limits are guardrails rather than spending caps. Review provider account limits and billing separately. OpenAI retries use the selected model; they never switch providers. Anthropic retains its configured model and key fallback behavior. Custom status checks call only the module's optional health hook; any work or charges inside that hook are module-defined.

The checked-in generation settings use `thinkingEffort: "low"`, a 16,000-token output cap, and a 1,200-second shared generation deadline. Omitting the deadline retains the 300-second fallback; explicit operator configuration remains authoritative.

Malformed persisted settings, including an invalid enabled schedule, disable automatic generation and mark settings health as failed. Failed saves retain the previous effective values and remain visible in diagnostics until a successful save. Correct the reported values and save the schedule explicitly before relying on unattended generation again.

If the provider stops at the configured output-token limit, BlueTeam.News uses its one-retry allowance without raising the cap. Anthropic recovery lowers thinking effort, disabling it when the original setting was low. Codex uses its lowest supported effort, `low`. If the retry also exhausts the limit, the app returns the recoverable draft without publishing it. Raise `analysisSettings.maxTokens` in `config.json` or reduce the Briefing scope before trying again.

Completed Briefings report the model, token counts, and cost when available. A finite nonnegative `cost_usd` reported by the provider takes precedence over the application's token-rate estimate for that attempt. The total includes all attempts and retries. If any attempt has neither a reported cost nor a known model rate, the total is unavailable (`null`), not zero; an experimental Custom module can report cost even for an unknown model. Receipts identify provider-reported amounts separately from list-rate estimates. Both can differ from the invoice; OpenAI reasoning tokens are included in output usage rather than charged twice.

New editions require the provider's terminal event and a completed stop reason, then save a JSON input manifest before publishing their Markdown. A publication error prevents completion and webhook delivery. The generation ledger starts before collection and reports collecting, preparing, generating, validating, and publishing phases, together with paid attempts, usage checkpoints, and outcomes. After a restart it reconciles verified publications and marks unfinished jobs interrupted. A job interrupted before a provider attempt records no provider attempt; an ambiguous paid attempt is not automatically repeated. Inspect **Settings → System health**, `/api/brief/status`, and provider usage before requesting another generation. Usage checkpoints can be incomplete and discarded output cannot be resumed. See [Generation stream](api.md#generation-stream).

After a browser connection fails, use **Check generation status** before starting another attempt. Recovery follows the generation ID announced for that request; an unrelated recent edition is not proof it completed. If the connection failed before an ID arrived, inspect generation status and History. Status checks make no provider call.

A complete response needing factual correction or editorial review appears as a generated draft with a **Fix saved draft** or **Review saved draft** action. Required fixes appear first; editorial review waits until those fixes clear, and optional notes stay collapsed and do not prevent publication. Its job remains `draft-ready` across restarts and the scheduler does not purchase another response for that edition. Open, edit, save, and recheck the draft against its captured sources without another model call. An unchanged blocked draft leads to its required fixes instead of another failing publication request; edited text can be checked and published in one request. Edition-wide coverage findings can open their related captured passages directly. Missing or malformed hidden bookkeeping and harmless citation display differences are notes; unsupported claims, unsafe source links, contradictory dates, and required security-control reviews still prevent publication. Incomplete streams and provider failures remain explicitly explained.

An existing reserved scheduled edition is recovered only when its receipt, completion flags, date, and timezone verify. Missing, corrupt, or mismatched artifacts return `E_SCHEDULE_INTEGRITY`; no new provider call starts and the original is preserved. Restore a known-good matching Markdown/receipt pair before retrying.

Opening a completed Briefing's **Print Edition** reuses that saved assessment. The Print Edition is rendered locally in the browser, and printing or saving it as a PDF uses the browser's print pipeline. Viewing or exporting the Print Edition does not make another model request.

## State and backups

Back up these paths:

| Path | Contents |
|---|---|
| `data/` | SQLite database, WAL/SHM sidecars, source observations/revisions, decision records/history/evidence copies, schedule and alert state, feed caches, local Settings/watch profile, and bounded ranking benchmark captures |
| `briefs/` | Saved Briefing Markdown, matching `*.manifest.json` generation inputs, and the hidden `.receipt-policy.json` legacy inventory |
| `reviews/` | Editorial corrections, publication dispositions, and approvals bound to saved editions |
| `config.json` | Feeds, scoring, organization/watch-profile defaults, models, and webhooks |
| `.env` or service environment | Optional secrets and server configuration |

`data/settings.local.json` can contain both built-in provider keys in plaintext. Custom module credentials come from the environment rather than Settings; preserve the trusted module and its service configuration separately when backing up an experimental installation. Store backups with the same care as the live host. Do not back up `node_modules`; reinstall it on the restore target.

For a consistent backup:

1. Stop the server and wait for it to exit.
2. Copy the entire `data/`, `briefs/`, and `reviews/` directories, plus `config.json`.
3. Back up `.env` or the service-manager secret configuration separately in protected storage.
4. Record the application tag/commit and Node major used by the backup.
5. Test restoration in a separate clone before relying on the backup.

To restore:

1. Stop the target server.
2. Check out the recorded application version.
3. Replace the target `data/`, `briefs/`, `reviews/`, and `config.json` with the backup and restore secrets through the chosen secret mechanism.
4. Run `npm install` with a supported Node version.
5. Start the server and inspect `/api/health`, the Wire, and Briefing history. Open a retained source revision and an edition's **Edition tools → Sources and saved inputs** to verify that evidence and its matching manifest were restored. Check a corrected or excluded edition to confirm its review records were restored too.

Never replace a live SQLite database. Copying only `watchfloor.db` while the process is running can omit committed data still represented by its WAL file.

The archive identity migration (schema v10) retains existing rows and their first-observed snapshots; it cannot reconstruct incidents already collapsed by the previous title-prefix key. Schema v11 adds server decision records and immutable edit/evidence history. Migrations run in transactions. Roll back the application and a matching pre-upgrade database backup together. An older release refuses a newer schema.

On the first upgrade, `.receipt-policy.json` records hashes of pre-existing editions without manifests, excluding known modern publications in the generation ledger. Later missing manifests are required receipts, so those editions stay outside Latest, Wall, RSS, and continuity. A modified legacy copy loses its exemption. Keep the hidden inventory and SQLite initialization marker together in backups; a missing inventory after initialization prevents startup. The bounded generation ledger cannot classify every receipt lost before the upgrade, so verify remaining manifest-free editions before that first start.

Keep each Briefing and its manifest together. Manifest reads verify the exact Markdown hash; changing the Markdown outside the application causes a verification failure. Old editions legitimately have no manifest, and restoration does not reconstruct inputs that were never saved. Protect manifests like local Settings because they include organizational interests and selected source excerpts, even though provider credentials and raw configuration are excluded.

Keep `reviews/` with those editions. Losing it loses corrections, approvals, and supersession or review-required decisions. An approval is tied to the exact current reading copy and does not transfer to later corrections. Saved Wire decisions, their edit history, and retained evidence copies now live in SQLite and are included in a complete server backup. Legacy browser records remain outside that backup until imported; keep their JSON export until the import has been verified.

Wire decision saves require the expected server revision. Conflicts or connection failures preserve unsaved edits for review; a retry of an uncertain save uses the same request identifier. Additive imports report conflicts rather than replacing existing server records. Limits of 20,000 decisions and 1,000 revisions per decision stop new writes without evicting authored records. The server records edit history but cannot attribute edits to a named person through its shared API secret. Named accounts, permissions, and team approval workflows remain outside this single-operator deployment.

After a server restart or database restore, open Wire tabs revalidate decisions against the new server history. **Refresh decisions** preserves unsaved edits. If a draft was based on a revision newer than the restored copy, review the conflict and rebase before saving. Delayed replies from the old history cannot confirm a save in the restored database.

### Evidence retention and redistribution

Collection prunes source records not observed for 30 days, caps retained sources at 5,000, and keeps at most eight revisions per source across its feed representations. A source still being observed can retain an older revision until the count cap removes it. These are bounded code defaults; there is no retention-policy editor. Passages are normalized feed extracts bounded to 8,192 characters, with clipping/title-only labels where applicable. Collection or storage failures leave the Wire usable and mark retained evidence unavailable rather than inventing revisions.

Saved Briefings and manifests are retained until the operator removes them. Their copied passages survive rolling database pruning. Removing database evidence does not delete copied excerpts from manifests or backups; include these artifacts in the local retention policy and storage monitoring. Backups require their own access and expiration controls.

Source licensing and handling restrictions are not tracked or enforced per passage. Preserve attribution and source links and check the source's sharing conditions before redistributing a manifest or excerpt. See [Evidence and relevance](evidence-and-relevance.md).

## Upgrade and rollback

Before an upgrade, take a stopped-process backup and record the current tag or commit.

### From v1.4.6 to v1.4.7

Stop the service and wait for accepted work to finish. Back up the effective
state directories, hidden receipts and drafts, configuration, protected settings
and operator-managed profiles together. Install the `v1.4.7` code with a
supported runtime, preserving local configuration edits. No dependency or SQLite
schema migration is included. Restart after merging the intended configuration
changes below.

All new generation and repair use one analytical format without mandatory owners,
action targets or confidence fields. The current reader handles earlier saved
briefings without rewriting them. Older application versions do not understand
the new document schema: rollback requires the previous code and its matching
pre-upgrade state backup. Keep any newly created editions separately rather than
opening them with an older reader. SQLite stays at schema 11.

The bundled Bob profile now allows 240 seconds of silence and 580 seconds total.
The checked-in shared generation budget is 1,200 seconds, including one corrective
attempt; the omitted-setting fallback remains 300 seconds. Operator profile
copies are not automatically overwritten. Merge these limits into the profile
used on the machine running the service when ready. This configuration change
does not install, invoke or verify Bob.

Repair restores unrelated story prose and optional sections automatically before
rechecking the merged copy. Routine notes remain in Edition record instead of
appearing as notification warning banners; reviewed material exceptions remain
identified. No new approval step or automatic paid retry is introduced. Before
deploying, verify the new format and an archived edition in the reader, Wall and
print. Live provider acceptance remains separate from synthetic regression tests.

### From v1.4.5 to v1.4.6

Test v1.4.6 separately before replacing an installed service. No SQLite schema
migration or major dependency upgrade is included: schema 11 and the existing
12.x `better-sqlite3` driver remain in use. SQLite replacement and other major
upgrades remain undecided.

1. Stop the service and wait for shutdown to finish. Back up the effective
   `data/`, `briefs/` including hidden receipt and rejected-draft files,
   `reviews/`, configuration, protected secret settings, and operator-managed
   CLI profiles together. Respect `BLUETEAM_STATE_DIR` and
   `BLUETEAM_CONFIG_PATH` if set.
2. Preserve local source/configuration edits, install the `v1.4.6` release code,
   and retain a supported Node runtime. Reinstall native dependencies if the
   runtime or installation changes; do not copy bindings between Node majors.
3. Merge the bundled Bob profile's `silence_timeout_ms: 120000` and
   `total_timeout_ms: 300000` into any active operator-managed copy. Keep its
   streaming selectors, completion/usage checks, tool restrictions and
   `restarts: 0`. Copied profiles are not replaced automatically.
4. Review `analysisSettings.generationTimeoutSec`. The default is now 300
   seconds shared by the initial call and any single corrective retry;
   an explicit existing value still overrides it. A profile's 300-second
   invocation limit cannot extend the application's remaining deadline.
5. Restart, run `npm run runtime:check`, and inspect health, a retained source,
   a saved Briefing and draft repair before requesting billable generation.

Generation receipts now allow 16 MiB of compact schema-1 JSON, and rejected
draft artifacts allow 32 MiB for the receipt and bounded revision history.
Existing indented schema-1 records remain readable. Keep the complete captured
inputs when repairing a draft; the limits do not authorize dropping evidence.
Older code with smaller limits cannot read every new large artifact. Rollback
requires the prior code, runtime-compatible native dependencies, and its
matching pre-upgrade backup; avoid writing new larger records into the rollback
copy.

Recognized Bob budget/allowance failures now surface a safe diagnosis while raw
stderr remains private. A stopped corrective attempt retains the original draft
and its required source findings. The error does not establish whether the
allowance belongs to a session, key, user, team or billing period, and a new key
does not establish a fresh allowance. Confirm the applicable provider limit
before requesting another attempt. The finite timeout increase does not prove
the cause of earlier silent stalls. Offline contract and workflow tests do not
certify a funded live Bob corrective retry or successful publication.

New prompts ask for visible event discussion and captured citations rather than
auxiliary coverage/action mappings. Existing explicit mappings still receive
their normal checks. Required factual fixes remain non-overridable; optional
notes do not hold publication. The recovery screen prioritizes required fixes,
opens related evidence directly and keeps provider failures visible.

### From v1.4.4 to v1.4.5

Test the v1.4.5 release separately before replacing an installed service.
It keeps SQLite at schema 11 and the existing 12.x `better-sqlite3` driver;
SQLite replacement and other major dependency upgrades remain undecided.

1. Stop the service and wait for shutdown to finish. Back up the effective
   `data/`, `briefs/` including hidden receipt and draft files, `reviews/`,
   `config.json`, operator-managed CLI profiles, and protected secret settings
   together. Respect `BLUETEAM_STATE_DIR` and `BLUETEAM_CONFIG_PATH` if set.
2. Preserve local source/configuration edits, then install the `v1.4.5` release
   code from the published tag or source archive.
3. Select Node 22.23.4+, 24.22.1+, or 26.12.1+ within those respective major
   lines. Node 24.22.1 LTS is pinned in `.node-version` and `.nvmrc`. On Windows,
   run `powershell -File .\scripts\setup-lts.ps1` to install the verified project
   runtime and reinstall dependencies; it leaves the system Node installation
   in place for other applications. With a separately selected supported
   runtime, reinstall dependencies with its bundled npm. Do not reuse native
   modules from a different Node major or installation.
4. Run `npm run runtime:check` to confirm the actual executable and native
   SQLite binding, then `npm start`. Inspect `/api/health`, collection status,
   a retained source, a saved Briefing and a retained draft before requesting
   billable generation.

The bundled Bob profile changes from `bob-shell-v1` final JSON to
`bob-shell-v2` and `--format stream-json`. Merge its assistant-message selectors
and delta-output rules into operator-managed copies; copied profiles are not
updated automatically. Keep reasoning and user messages excluded, terminal
result/exit and usage checks enabled, silence and total limits at 180 seconds,
and automatic restarts at zero. Bob remains separately installed. Offline
profile tests and the installation check do not establish live authentication
or generation readiness.

Inspect **Settings → System health** for uncertain webhook deliveries. Confirm
the recipient's state before marking delivered, abandoning, or deliberately
retrying one. Ambiguous deliveries are never automatically replayed, and manual
retry requires explicit duplicate-risk acknowledgement and the original
destination. A completed scheduled generation whose matching archive is missing
fails closed; restore its verified archive rather than buying another attempt.

New receipts preserve signed destinations through exact URL identities while
redacting sensitive display values. An older receipt that already discarded
that identity cannot reconstruct the original signed link; it remains
fail-closed. Original saved copies and captured inputs are retained.

Open Wire tabs revalidate decisions after restart or restore while keeping
unsaved edits. Use **Refresh decisions** and review/rebase a conflict against
the restored revision before saving. Responses from the previous history cannot
confirm a save in the restored database. Rollback uses the previous code,
runtime-compatible native dependencies, and its matching complete backup.

### From v1.4.3 to v1.4.4

No database migration or mandatory configuration change is required; SQLite
remains at schema 11. Stop the service, back up `data/`, `briefs/` (including
hidden files), `reviews/`, configuration, operator-managed CLI profiles, and
protected secrets together, install v1.4.4, and restart.

The v1.4.4 bundled `bob-shell-v1` profile accepts the license explicitly,
trusts its fresh workspace, and reads `last_message` from final JSON output.
Review the `--accept-license` flag, retain `BOB_API_KEY` in the service
environment, and merge the bundled profile changes into any operator-managed
copy. Existing copies are not updated automatically. Bob's silence and overall
timeouts are both 180 seconds; the application's remaining deadline still
bounds the run. Automatic restarts remain disabled. The streamed
`bob-shell-v2` profile belongs to the v1.4.5 release described above.

CLI errors now include fixed diagnoses for recognized license, authentication,
and gateway-timeout failures without returning raw stderr. An uncertain remote
outcome still requires review before another manual attempt. After startup,
verify the selected provider and profile path. The installation check confirms
only that the configured executable can run its health command; it does not
verify authentication or generation readiness. See [CLI provider profiles](cli-provider.md).

Existing API and Custom providers, archived editions, and saved drafts retain
their behavior. Rollback requires the previous code and its matching
pre-upgrade state/configuration backup.

### From v1.4.2 to v1.4.3

No database migration or mandatory configuration change is required; SQLite
remains at schema 11. Stop the service, back up `data/`, `briefs/` (including
hidden files), `reviews/`, configuration, and protected secrets together, install
v1.4.3, and restart. Existing API and Custom provider configurations still work.

The reader derives its compact executive view from complete visible actions and
binds caveats to the displayed copy. New receipts capture shared action records
and coverage accounting version 3; older coverage versions and recorded
publication policies remain intact. Archive reads do not rewrite saved Markdown.
Routine editorial notes remain available in the edition record, while factual
contradictions and unsupported claims still require correction.

The experimental CLI provider is optional. Review its trusted JSON profile and
separately installed executable, provide the required environment variables, set
`AI_PROVIDER=cli` and `AI_CLI_PROFILE`, restart, and select CLI in Settings if a
different provider was previously saved. Back up operator-managed profiles with
configuration. There are no automatic CLI restarts; an uncertain remote outcome
requires review before another manual attempt. See [CLI provider profiles](cli-provider.md).

After startup, check collection health, reopen a saved edition and retained
draft, and verify the selected provider. A CLI installation check does not verify
authentication or generation readiness. Rollback requires the previous code
and its matching pre-upgrade state/configuration backup.

### From v1.4.0 or v1.4.1 to v1.4.2

The October 23, 2026 patch requires no database migration or configuration change;
SQLite remains at schema 11. Stop the service, back up `data/`, `briefs/` (including
hidden files), `reviews/`, configuration and protected secrets together, install
v1.4.2 and restart. Existing Custom provider modules remain compatible.

New generations record publication policy 2 and composition version 1. The app
renders captured source IDs as citations, builds executive decisions from the
judgment actions, and adds federal deadline wording from captured catalog facts.
Hidden metadata is optional. Unsupported factual claims, conflicting captured
dates, invalid source identities and incomplete generation still require
correction; uncertain score/action associations become notes.

Reading archived editions preserves their saved wording and retained check
policy. Explicit draft rechecks use captured inputs without another model call.
An unchanged draft containing a known but unrendered source ID may receive a new
repair revision; the original remains available. Legacy drafts keep their action
and deadline format. For new composition-version-1 drafts, edits rebuild the
shared presentation from the same captured inputs. Restarting alone does not
rewrite existing drafts or editions.

After startup, verify health and reopen a saved edition and any retained drafts.
To roll back, stop the service and restore the previous code and its matching
pre-upgrade state/configuration backup together; preserve a separate protected
copy of newly created state before restoring.

### From v1.3.2 to v1.4.0

The October 9, 2026 release migrates SQLite from schema 9 to 11 at startup.
Schema 10 changes archive identity from a clipped title to source identity,
preserving existing rows and first-observation snapshots; it cannot reconstruct
incidents already collapsed by the old key. Schema 11 adds server-side Wire
decisions with edit history and retained evidence copies. Each migration runs
in a transaction.

Before the first v1.4.0 start:

1. Stop v1.3.2 and back up `data/`, `briefs/` (including hidden files), `reviews/`,
   `config.json`, and the protected secret configuration together. Preserve local
   code/configuration changes and record the exact old version.
2. Check saved editions that lack a `*.manifest.json`. Restore any known lost
   modern receipts before startup: the first-start legacy inventory records
   hashes of existing manifest-free editions, except modern publications known
   to the bounded generation ledger. It cannot identify every older receipt loss.
3. Preserve legacy browser decisions with a JSON export from each browser that
   holds them. They are not yet included in the server backup.

After installing v1.4.0, verify health, a completed collection, retained source
evidence, saved editions and their review records. Confirm
`briefs/.receipt-policy.json` is included in subsequent backups with SQLite's
initialization marker. Missing or corrupt inventories must be restored; deleting
the inventory does not safely reset receipt policy. Newly missing required
receipts exclude an edition from Latest, Wall, RSS, and continuity.

In Wire, use **Copy browser decisions to server** when offered, or **Import saved
decisions (JSON)** for an export. Review the import report: existing conflicting
server records stay unchanged, and imported evidence copies may be unverified on
this server. Keep the original exports until you have checked the records,
history, and a new server export. Browser read/hidden preferences remain local.

New Briefings assess bounded distinct-event coverage and require review for
material overflow, unresolved priority evidence, or detected bundled response
phases. Older receipt policies keep their captured coverage contract. Dated
same-source context does not refresh evidence or establish new current facts.
These checks and offline replay do not verify every narrative claim, prove
ranking quality, or confirm local exposure; review the cited reporting before
acting. See [Briefing evaluation](brief-evaluation.md).

This remains a single-operator release. Named accounts, team permissions, and
team approval workflows are deferred.

To roll back, stop v1.4.0 and restore v1.3.2 code **and its complete pre-upgrade
state/configuration backup** together. Keep a separate protected copy of any
newer state for recovery; it is not compatible rollback input. Do not lower
`user_version`, remove the receipt inventory, or mix newer database files and
edition records into the old backup. Decisions and editions created after the
backup will not appear in the restored service.

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

Database migrations run forward at startup. The safest rollback is therefore code **and** the matching pre-upgrade `data/`, `briefs/`, and `reviews/` backup:

1. Stop the server.
2. Check out the prior tag.
3. Restore its matching backup.
4. Run `npm install`.
5. Start and verify the service.

Startup rejects a database schema newer than this version supports. Older
releases may lack this guard, so always restore the matching backup when rolling
back. In particular, a rollback from v1.1.0 to v1.0.3 must restore the matching
schema-7 `data/`, `briefs/`, `reviews/`, and configuration backup; do not lower the SQLite
schema marker manually or merge newer database files into that backup. Restore
the corresponding protected secret configuration as needed.

## Process supervision and logs

A service manager can start BlueTeam.News after boot. Configure it to:

- run `npm start` with the repository as its working directory;
- run as a dedicated, unprivileged account that owns `data/`, `briefs/`, and `reviews/`;
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

For experimental Custom modules, **Settings → AI Briefing → Check status** invokes the optional `health({ signal })` hook with a 15-second deadline. It never invokes the module's `stream` method. A missing hook reports that the client loaded, with its version if supplied, but leaves readiness unknown. Timeouts and thrown hook errors also report unknown readiness. The ordinary liveness/readiness probes do not call this hook, and its result does not gate manual or scheduled generation. Use the hook to report operator-safe diagnostics and keep any module-specific network checks lightweight.

**Copy diagnostics** prepares a limited report containing health counts, version, timing, and database size. Source names and URLs, credentials, organization settings, and raw configuration errors are excluded. Copying does not submit a support request. When clipboard access is unavailable, a selectable sanitized report is shown. A client receiving only the overall readiness status sees that detailed diagnostics are unavailable; the panel does not bypass the existing authentication boundary.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `POST /api/brief` returns 429 | Another generation may be active, a request may have started within the last 15 seconds (including an early failure), or the short-window/daily limit may be reached. Honor `Retry-After`, do not repeatedly click Generate, and inspect the JSON error and logs. |
| Briefing reports stale or unavailable evidence (`E_EVIDENCE`) despite a saved key | Generation stops before calling the provider when current source evidence is insufficient. Check **Settings → System health**, restore the server's outbound connectivity to its configured sources, and allow collection to finish before retrying. Replacing the API key does not repair feed connectivity. |
| Automatic Briefing did not run | Confirm the schedule is enabled in Settings, the selected provider is configured, the configured timezone is correct, and the displayed schedule status has not reached its daily attempt limit. Built-in providers need a valid key; an experimental Custom module must return a valid client. |
| The generation connection failed or stopped without completion | Use **Check generation status** and History before retrying. Recovery must match the request's generation ID. An incomplete provider stream is not a completed edition; retained output may be available in Drafts, and final usage can be unknown. Status checks do not start another generation. |
| Scheduled recovery returns `E_SCHEDULE_INTEGRITY` | The reserved edition's receipt or completion metadata did not verify. No provider call was started and the original was preserved. Inspect storage and restore a known-good matching Markdown/receipt pair; repeated retries do not repair it. |
| `NODE_MODULE_VERSION`, ABI, or native-binding error | Stop the server, confirm Node is a supported release, delete only this clone's `node_modules`, then run `npm install` again. Never reuse another machine's dependency directory. |
| `EADDRINUSE` at startup | Another process already uses `PORT`; stop that process or choose another port. Do not start a second copy against the same `data/`. |
| Startup reports a database schema newer than supported | Use an application version that supports the database, or restore the matching pre-upgrade backup with its code. Do not lower the SQLite schema marker manually. |
| Health stays degraded after first start | Inspect feed statuses and `configReloadError` in authenticated health details, then review logs for proxy, DNS, certificate, rate-limit, or config validation failures. |
| Feeds fail behind a corporate proxy | Confirm the host can reach the configured HTTPS origins and that TLS inspection trusts the organization's CA. BlueTeam.News does not include a proxy-bypass mode. |
| Briefing is disabled | Choose a provider and verify its key in Settings, or set `AI_PROVIDER` with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Environment keys override saved keys for that provider. Check the selected OpenAI model if verification reports an access error. |
| Experimental Custom module is unavailable | Confirm `AI_PROVIDER_MODULE` names a trusted module exporting `createClient(env)`, select Custom, and restart after changing its path, code, or environment credentials. Use **Check status** for initialization or hook diagnostics. A loaded client alone does not verify model access or credentials. |
| Database, Briefing history, or editorial decisions are missing after a move | Restore `data/`, `briefs/`, and `reviews/` together, confirm filesystem ownership, and use the application version recorded with the backup. |
| Source evidence is missing or an attached revision is no longer retained | Evidence starts with collection after the upgrade and has rolling count/age limits. Newer observations do not reconstruct an older missing passage. Inspect the source link and collection/storage diagnostics; do not treat missing evidence as a negative finding. |
| A Briefing has no saved inputs or its manifest fails verification | Old editions have no reconstructed manifest. For newer editions, restore the matching Markdown/manifest pair; check for an external edit, partial restore, corrupt file, or storage failure. A manifest hash does not authorize replacing the original assessment. |
| A saved edition is absent from Latest, Wall, or RSS | Open it in History and inspect its disposition and current reading-copy checks. Material review findings, supersession, failed corrected-copy checks, or an invalid receipt exclude it. Approval cannot override structural or source-trust failures or invalid receipts; later edits can require new approval. |

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
- the selected built-in AI provider, Anthropic or OpenAI, when Briefing generation or key verification is requested, or destinations chosen by an experimental Custom module; and
- an alert webhook configured by the operator.

Briefing generation sends the selected provider the configured team profile, audience, and effective watch profile, including technologies, sectors, regions, intelligence questions, lower-interest topics, and preferred horizons; selected public-source titles, descriptions or short excerpts, source labels, publication dates, URLs, and enrichment facts; and compact topic labels from recent Briefings for continuity. Built-in key verification sends a minimal provider request. Opening retained evidence or a saved generation manifest makes no publisher or model request.

Custom modules receive the generation parameters and process environment, run without a sandbox, and define their own network behavior, including any health-hook requests. Review the module's destinations and data handling before use; application feed-fetch protections do not constrain arbitrary module code.

Feed, article, and enrichment requests use the default User-Agent `BlueTeam.News/<version> (+https://blueteam.news)`. This identifies the application to source operators but does not report usage back to BlueTeam.News. Set `BLUETEAM_USER_AGENT` to use an operator-controlled identity, such as one containing a contact URL.

Webhook payloads contain the configured event's fields. Signal alerts include matched titles, links, sources, tier and score metadata, and KEV status. Briefing notifications include the edition date, BLUF, judgment titles and confidence, an optional link, and—when present—the total review-warning count plus bounded warning text. They use the current reading copy and require eligibility when generation completes; an edition retained for material review sends no notification, and later corrections or approval do not resend it. Webhook failure is logged and does not block refreshes or Briefing storage.

Webhook payloads are persisted before sending. A 60-second worker retries transient failures with exponential backoff, at most eight attempts and seven days, within a 100-job/2 MB outbox. Redirects and permanent client errors fail visibly; a redirected login page cannot count as delivery. Each destination and material alert state has a separate identity, allowing a newly exploited or newly KEV-listed item to alert again. Existing legacy sent-title records are adopted as a baseline, without replaying past alerts.

Changing the destination or disabling its event type pauses queued jobs; they are never forwarded to a different URL. Briefing retries also require the same eligible reading-copy hash. An interrupted send, uncertain transport failure, or failed success-receipt write has an ambiguous outcome and is not automatically repeated. Automatic retries are limited to proven connection-setup failures and retryable HTTP responses. Delivery is still not exactly once: a recipient can accept work before returning an error response, so recipients should deduplicate the stable `Idempotency-Key` header. Inspect **Settings → System health** for retrying, paused, failed, or ambiguous work and check the recipient before any manual resend. Outbox storage errors block new sends and require storage recovery; they do not erase queued payloads.

Use **Settings → System health → Review queued webhook deliveries** to load delivery IDs and resolve work after checking the recipient. **Recipient confirms delivered** and **Abandon delivery** free queue capacity and retain bounded duplicate-protection records. A deliberate **Retry original delivery** requires acknowledgement that the recipient may receive a duplicate, and the original destination and event type must still be enabled. It retains the original payload and idempotency key and starts a fresh bounded retry window. Ambiguous deliveries are never automatically replayed merely to free capacity.

Public `/api/health` and `/api/ready` responses use a five-second process-local status snapshot and do not reconcile archived publications. Authenticated generation diagnostics retain archive verification. Article parsing runs in a bounded worker with a two-second admission/execution deadline, a 2 MB input limit and DOM structure limits. Draft and generated Briefing validation also run in a bounded worker; excessive document size or markup is rejected before parsing. These limits keep liveness responsive when an upstream page or draft is malformed. Accepted generation work drains before these workers close during shutdown.

When `analysisSettings.debugScoring` is enabled, `scoring-debug.log` lives under the effective state directory's `data/` folder, including when `BLUETEAM_STATE_DIR` is set. The current file and two rotated archives are each limited to 1 MiB; oversized legacy debug logs are discarded on the next write. POSIX creation modes are `0700` for the directory and `0600` for files; Windows uses the account's ACLs. Debug dumps may include source information and belong with protected operator state.

`npm run check:production:render` runs the real application and Chromium against synthetic temporary state, with collection and scheduled jobs disabled and no inherited provider credentials. It checks CSP/authentication, settings persistence, cross-tab decision conflict handling, saved-draft publication, and reader navigation without a model call. CI runs it alongside the narrower rendering fixtures.

On POSIX systems, startup requests mode `0700` for `data/` and `briefs/` and mode `0600` for sensitive settings, Briefing, SQLite, WAL, and SHM files. New generation manifests are written with mode `0600`. Windows retains the account's ACL behavior. Local state is not encrypted; protect the operating-system account, filesystem, and backups.

See [Configuration](configuration.md) for environment variables and [SECURITY.md](../SECURITY.md) for the deployment security model.

## Configured pattern isolation

Configurable domain, promotion, severity, and urgency patterns are compiled and matched in worker threads. A collection batch has a two-second deadline, a 24 MB input bound, a 20,000-item bound, a bounded queue, and a 96 MiB worker heap limit. Invalid patterns fail configuration admission; a timeout or evaluation failure is an error, never a successful no-match result. Configuration admission has a separate bounded synchronous worker wait.

Collection failures retain the previous successful collection in memory and SQLite. Readiness becomes degraded and **Settings → System health** reports the failed attempt; `/live` remains a process-liveness check. Inspect the collection error and correct the relevant patterns before retrying. HTTP rendering and alert delivery use the assessment saved with the collection. Older cached records without that assessment need a successful refresh to regain classification.

## Ranking evaluation captures

Normal collection can retain at most one complete ranking capture per hour in `data/ranking-benchmark/`, with limits of 48 captures, 14 days, 64 MiB total, and 8 MiB per capture. Oversized captures are rejected visibly rather than sampled or truncated. Capture failure does not stop collection; the health details expose capture availability separately. Captures include private watch-profile and source material and belong with protected server data, not public fixtures.

The offline `npm run benchmark:ranking -- --help` workflow exports blinded review material and computes metrics from independent completed reviews. Copy a dataset into a protected review directory before annotation so rolling retention cannot change it during review. The tooling does not supply expert judgments or establish ranking quality on its own. See [Briefing evaluation](brief-evaluation.md) for annotation, adjudication, split, and reporting requirements.

## Briefing completion and delivery diagnostics

New checks use publication policy 4. Optional stale coverage mappings are
discarded with an audit note and coverage is derived from the visible report.
A task to review a vendor control exception can pass when it explicitly keeps
that same control enabled pending approval; an instruction to execute the
exception still requires human review. Historical checks retain their policy.
Repeated CVSS diagnostics for the same located claim appear as one repair item,
with all underlying diagnostics retained. A corrective response can omit one
located defective judgment and repair another while preserving unaffected judgments.

A supporting source may be cited beside a claim anywhere in the same judgment.
A missing provisional label on an otherwise supported score is a note, not a
factual contradiction. New generation and draft rechecks insert the label when
the exact occurrence is unambiguous, revalidate, and record the automatic repair.
Explicitly wrong scores, versions, assessment types and final-status claims still
block. Review-only findings now receive the available corrective model attempt;
the repair can turn a proposed control exception into an approval task that
keeps the control enabled. It cannot approve or execute the exception.

Scheduled saved drafts receive a deterministic recheck at the configured retry
interval, including after restart, without a provider call or another paid
attempt. A complete draft that passes current checks without human-review
requirements can publish automatically. Incomplete originals, factual blockers,
unavailable evidence and control exceptions remain held. Missing draft storage
never turns a recheck into a fresh generation. Rechecks retire at the next daily
slot so the next edition can proceed. Publication records distinguish automatic
rechecks from operator repairs and preserve the original inputs, checks and usage.

The configured generation timeout bounds model work after collection and
preflight. Its default is 300 seconds shared across the initial model call and
any corrective retry; an explicit `analysisSettings.generationTimeoutSec` from
30 through 1,200 seconds overrides it. The checked-in configuration uses 1,200 seconds,
enough for two completed Bob calls of up to 580 seconds each with 40 seconds
for setup and intervening checks. Collection has its own wait cap of 180 seconds, or the configured
generation timeout when smaller. Collection, preflight, provider and validation
durations are captured in new receipts. A corrective paid attempt requires at
least 30 seconds of remaining model time; otherwise the original draft and
inputs remain available for recovery. A CLI call that actually times out remains
incomplete and is not automatically repeated. The scheduler waits for the configured
generation budget, the separate collection allowance, and a three-minute preflight/publication
margin (26 minutes at the maximum); it does not impose a shorter 15-minute ceiling.
NVD observations persist in the local
external cache for up to 24 hours without renewing their age on restart.

Health reports distinguish scheduled publication from process liveness. A
scheduled draft awaiting review, failed or overdue attempt, or unresolved
publication reconciliation needs attention even while `/live` stays healthy.
Publication status does not establish delivery to an external notification
destination. These checks do not send or retry notifications.

Generation receipts retain up to 16 MiB of compact schema-1 JSON. Rejected
draft artifacts retain that immutable receipt and up to eight repair revisions
within a 32 MiB envelope. Larger evidence collections fail visibly instead of
silently discarding passages or source identities. Worker preparation admits
requests up to 32 MiB, with a shared 128 MiB admission budget, at most eight
pending requests and one worker at a time. Its five-second deadline and 192 MiB
old-generation heap bound remain in force. Only the current repair revision is
sent to the worker; the server retains the complete history and rechecks the
saved revision before committing. Older indented schema-1 artifacts remain
readable, but rollback to code with smaller limits needs its matching backup.

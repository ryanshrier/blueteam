# Changelog

## 1.4.7 — 2026-10-30

This release makes Briefings analytical and conditional, reduces avoidable draft
review friction, and preserves unaffected reporting during automatic repair.

- Use one analytical briefing format with conditional implications, descriptive stories and optional supporting sections; preserve existing saved briefings without a format selector or mandatory owners, actions and deadlines.
- Restore unaffected reporting before validating corrective output, retaining story order, investigation guidance and uncertainty without adding a provider attempt or approval requirement.
- Copy supplied CVSS versions, assessment types and provisional qualifiers with source-ID citations. Repair unambiguous missing qualifiers automatically; distinguish optional notes from material contradictions without claiming to verify every factual assertion.
- Remove absent-tier placeholders and routine-note warning banners from new briefing notifications; retain reviewed material exceptions. Update retained replay selectors/counts and Wall links and labels for analytical stories.
- Set the bundled Bob profile to 240 seconds of silence and 580 seconds total; use a 1,200-second checked-in shared generation budget. Omitted configuration still falls back to 300 seconds. No automatic CLI restart is added.
- Align scheduler and shutdown deadlines with the generation budget. Reconcile saved scheduled drafts without another provider call, including after restart, while preserving publication and spending records.

### Upgrade notes

Read the [v1.4.7 upgrade procedure](docs/operations.md#from-v146-to-v147).
Stop the service and back up state, configuration and operator-managed profiles
together. Existing Briefings retain their saved wording and remain readable;
new generation and repair use one format without a format selector. SQLite stays
at schema 11 and no dependencies change. Rollback requires the prior code and
its matching pre-upgrade state backup because older readers cannot interpret
the new document schema.

Merge the 240-second silence and 580-second total limits into copied Bob profiles
when ready, and review any explicit shared generation timeout. These changes do
not install or invoke Bob. Synthetic validation does not establish live provider
acceptance. The development-only dependency advisory disclosed for v1.4.6 remains
applicable; see that release's dependency audit note below.

## 1.4.6 — 2026-10-28

This patch keeps busy-day Briefing inputs recoverable, makes Bob budget failures
actionable, and reduces the work needed to review a generated draft. Factual
source checks and exact-copy publication approvals remain enforced.

- Retain busy-day generation manifests up to 16 MiB as compact schema-1 JSON, and align draft storage and bounded worker admission without dropping captured evidence, provenance or signed citation identities.
- Report an actionable provider budget/allowance diagnosis from recognized CLI stderr signatures while keeping arbitrary stderr and credentials private. Preserve the original rejected draft when its single corrective attempt fails.
- Set the bundled Bob profile to 120 seconds of silence and 300 seconds total, and the shared generation default to 300 seconds. Explicit operator deadlines still apply; no automatic CLI restarts are added.
- Clarify that corrective recovery can omit an unsupported optional version without deleting its otherwise supported judgment, citations, applicability qualifications or complete actions. Trust-level publication gates remain enforced.
- Reduce review friction: derive coverage associations from visible discussion instead of asking the model for hidden bookkeeping, separate required fixes from collapsed optional notes, and guide unchanged blocked drafts to repair before another publication request. Keep explicit legacy mappings and factual claims subject to their existing checks.
- Patch `qs` to 6.16.2 within its existing release line for [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).

### Upgrade notes

Read the [v1.4.6 upgrade procedure](docs/operations.md#from-v145-to-v146).
SQLite stays at schema 11 with the existing 12.x driver; SQLite and other major
dependency upgrades remain undecided. Back up complete state, configuration and
operator-managed profiles while the service is stopped.

Merge the 120-second silence and 300-second total limits into copied Bob
profiles. The application now defaults to a shared 300-second generation budget;
explicit configured values still win, and automatic CLI restarts remain zero.
Larger schema-1 receipts and drafts require their matching code or a pre-upgrade
backup when rolling back. Offline tests do not certify a funded live Bob retry
or successful publication, and a reported allowance does not identify its
account or billing-period scope.

### Dependency audit note

The full development dependency graph retains the low-severity
[`deepmerge` advisory GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
in Jest's development-only dependency tree. No patched upstream version was
available during release validation. The issue was reproduced in the dependency;
the audit reports five affected development entries from this one advisory.
Review found no application import or path from HTTP requests, collected sources
or replay data; the installed use is local Jest configuration merging.
`deepmerge` is excluded from the production dependency graph. The advisory
remains open and disclosed; this release does not claim zero vulnerabilities
across all development dependencies. The production graph is audited separately.

## 1.4.5 — 2026-10-24

This patch keeps collection and Briefing repair responsive to hostile source
text, restores decision editing after a database restore, and gives operators a
way to reconcile uncertain webhook deliveries. It also updates security patch
floors and switches the bundled Bob profile to streamed assistant output.

- Make source-evidence classification linear and bounded. Isolate article extraction with byte, structure, memory and deadline limits so publisher content cannot monopolize the server thread.
- Run receipt restoration, citation rendering, assembly, Markdown repair, metadata rebinding, validation and action-record derivation inside the bounded Briefing worker pipeline. Preserve immutable input snapshots and recheck persisted revisions before saving or publishing.
- Retain exact citation URL hashes separately from redacted display values. Signed links can survive receipt replay and repair while changed destinations remain unauthorized; protected code examples stay intact.
- Resynchronize open Wire tabs after a server restart or same-history database restore. Preserve unsaved edits, reject delayed responses and stale write acknowledgements, and retain normal revision-conflict protection.
- Include structured CVE identities in Wire cluster filtering and search. Remove XML-forbidden code points from RSS output, and require browser revalidation of updated sanitizer and Markdown modules.
- Keep public readiness bounded without repeated archive recovery. Store optional scoring debug output under the configured private state directory with a one-MiB limit and two rotated archives.
- Add delivery-review controls in Settings and an authenticated reconciliation API for marking delivered, abandoning, or deliberately retrying queued webhooks. Keep original-destination and duplicate-risk checks; ambiguous sends are never automatically replayed.
- Refuse another scheduled provider attempt when completed accounting lacks a verifiable archive. Correct generation-quota refunds across window resets and cross-origin decision-save preflights; apply consistent credential redaction to custom-provider failures.
- Switch the bundled Bob profile to `bob-shell-v2` and `--format stream-json`. Join assistant message chunks in order while excluding user messages and reasoning; preserve result checks, usage accounting, 180-second silence and total limits, and zero automatic restarts. Add offline streaming and silence-progress coverage.
- Update body-parser to 1.20.9, Undici to 8.12.3, and Zod to 4.6.7 for compressed-request, outbound-transport, and collection-validation security fixes.
- Require Node 22.23.4, 24.22.1, or 26.12.1 or newer within the respective major line. Pin Node 24.22.1 LTS for the application, add a verified Windows runtime setup, select supported runtimes for npm commands, and preserve graceful shutdown while rebuilding native dependencies under the selected runtime.

### Upgrade notes

Read the [v1.4.5 upgrade procedure](docs/operations.md#from-v144-to-v145)
before upgrading. The raised Node security floors require a
supported runtime and a native-dependency reinstall. SQLite remains at schema 11
with the existing 12.x driver; SQLite and other major dependency upgrades are
still deferred. Stop the service and back up complete state, hidden receipt
files, configuration and operator-managed profiles together.

Merge the new Bob streaming rules into copied profiles; the upgrade does not
replace them. Offline contract fixtures do not establish live Bob authentication
or generation readiness. Existing receipts that redacted a signed destination
without retaining its exact identity cannot reconstruct that destination and
remain fail-closed. Rollback requires the prior code and its matching backup.

## 1.4.4 — 2026-10-23

This patch fixes Bob Shell startup and answer extraction in the experimental
CLI provider and makes common CLI failures easier to diagnose.

- Add `--accept-license` and `--trust` to the Bob profile so each isolated attempt can start without saved home-directory consent. Use `--format json` and parse the completed result's `last_message`.
- Expand disabled tool groups with `browser`, `command`, `subtask`, `workflow`, `artifact`, and `plan`, retaining the dedicated MCP and subagent disabling flags and tool-activity checks.
- Match Bob's silence timeout to its 180-second overall deadline so a quiet JSON run can finish. Keep zero automatic restarts and the application's remaining generation deadline.
- Surface fixed diagnostics for license acceptance, API-key/authentication failures, and gateway timeouts, including HTTP 504 and 524. Bound diagnostic processing without exposing raw stderr or credentials; preserve failure codes, usage, and uncertain outcomes.
- Add offline Bob contract regressions for isolated startup, JSON completion, tool restrictions, accounting, failure diagnostics, and zero restarts.

### Upgrade notes

No database migration or mandatory configuration change is required from v1.4.3;
SQLite remains at schema 11. Stop the service, back up state and configuration
together, install v1.4.4, and restart. If you copied the Bob profile to an
operator-managed location, merge these changes into that copy; upgrading does
not replace it. Review the explicit license-acceptance flag and keep
`BOB_API_KEY` in the service environment. Bob itself remains a separately
installed dependency. Offline fixtures do not establish live authentication or
generation readiness. See [Upgrade and rollback](docs/operations.md#from-v143-to-v144).

## 1.4.3 — 2026-10-23

This patch makes briefings easier to read and act on, restores large CISA
advisory feeds, and adds an experimental CLI provider configured with JSON
profiles. Factual safeguards remain enabled; routine editorial notes stay in
the edition record.

- Compact the executive view into the leading three assessments with linked owners and recommended targets. Share exact-copy action records through the reader, copied decisions, and print while preserving complete conditions, investigation, and recovery instructions.
- Associate material caveats with actual Markdown judgment order across Overview, the reader, copied decisions, and print. Accept generic and renumbered headings; keep stale or ambiguous findings in the edition record instead of attaching them to the wrong assessment.
- Record source-backed coverage across judgments, Developing Situations, and Watchlist entries. Distinguish partially covered multi-CVE reports from missing or fully covered events, without requiring hidden records or an action for every CVE.
- Accept ordinary conditional applicability and hypothetical cascade wording, remove duplicate score-association advice, and keep optional coverage notes out of reading views. Unsupported scores, contradictory facts, source identity, and completion safeguards remain enforced.
- Separate evidence confidence, local applicability, and response urgency in generation guidance. Reduce repeated narrative before complete actions; word budgets and varied priority labels are not publication requirements. Add frozen-evidence comparison of authored revisions with action preservation and case-specific factual checks.
- Allow bounded full-content responses from the two CISA advisory feed endpoints. Treat valid empty search results as successful queries and cache them; network and parser failures remain visible.
- Add the experimental CLI provider with versioned JSON profiles, isolated per-attempt workspaces, bounded JSON/NDJSON parsing, process-tree cancellation, verified terminal/exit completion, and zero automatic restarts. Preserve profile identity and native cost units in receipts; uncertain outcomes prevent automatic scheduled repurchase. Assistant-specific commands and mappings remain in profiles.
- Align Briefing, Wire, and Settings within the same outer layout, widen Overview, and preserve the full report's reading width. Move Review drafts into Edition tools, keep Generate and reading modes visible, bound mobile menus to the viewport, and improve keyboard focus, dialog controls, and Settings descriptions.

### Upgrade notes

No database migration or mandatory configuration change is required from v1.4.2;
SQLite remains at schema 11. Stop the service, back up state and configuration
together, install v1.4.3, and restart. Existing Anthropic, OpenAI, and Custom
provider configurations continue to work. The CLI provider is opt-in: install
the chosen executable separately, review its JSON profile, supply its required
environment variables, and select CLI in Settings. No assistant is bundled or
installed by BlueTeam. Profiles are trusted execution configuration, not an OS
sandbox; fixture tests do not certify a third-party CLI's behavior or billing.

New generation receipts use coverage accounting version 3 and capture shared
action records. Historical coverage versions and publication policies remain
recorded as before; reading an archive does not rewrite its Markdown. Keep
`briefs/` and its hidden files, `reviews/`, the database, configuration, and any
operator-managed profiles together in backups. See [Upgrade and rollback](docs/operations.md#upgrade-and-rollback).

## 1.4.2 — 2026-10-23

This patch reduces draft-checking friction across Anthropic, OpenAI and Custom
providers while keeping factual safeguards. The app now renders citations,
executive actions and federal deadline context from shared captured inputs.

- Assemble citation labels/links from captured source IDs, executive decisions from the leading judgments' complete actions, and federal remediation wording from exact captured KEV dates. Use the same tolerant Markdown pipeline for Anthropic, OpenAI and Custom; preserve factual checks and legacy citation support.
- Record composition version 1 in new generation receipts. Edited drafts from these runs rebuild shared presentation without a provider call; explicit rechecks can render previously unrendered source IDs into a new repair revision. Archive reads preserve the saved copy. Federal date context stays visible in the Briefing, Wall, copied decisions and print.
- Keep newly retained drafts visible with their findings, and classify generation failures by server code so shutdown/storage errors do not send users to API-key setup. Provider setup guidance includes Custom modules.
- Make uncertain CVE/score associations and inferred action associations or phase grouping advisory under publication policy 2. Preserve factual contradictions, unsupported scores, source identity, completion and receipt protections; record the policy version with checks.
- Allow a corrective attempt to omit a judgment identified by a blocking finding only when every remaining judgment is preserved. Keep the single-retry limit and reject incomplete replacements or new material findings.
- Resolve citations by a unique complete captured URL and repair their display labels without changing destinations or claims. Keep unsafe URLs, ambiguous identities, and unsupported facts blocked.
- Separate explicitly internal patch targets from federal deadline claims; preserve checks for contradictory captured federal dates.
- Make generated action/coverage bookkeeping optional, derive supported coverage from visible citations, and retain unchanged bindings during edits. Malformed hidden records cannot bypass the visible action and evidence checks.
- Present completed drafts needing correction or review separately from provider failures. Preserve optional metadata through factual repair, retain draft status across restarts, and avoid repeat scheduled purchases.
- Share Anthropic request configuration between production and evaluation, retain declared provider capabilities in receipts, and add Custom offline conformance checks and normalized-event replay. Existing Custom adapters remain compatible; unspecified capabilities stay unknown.
- Reposition the project site around the daily edition, refresh the sample front-page, Overview, Full report, Print Edition and social-card captures, and correct the description of server-stored Wire decisions. Preserve responsive, accessibility and asset-budget checks.
- Update DOMPurify to 3.4.17 and the ip-address override to 10.7.4 to address dependency security advisories found during release validation.

### Upgrade notes

No database migration or configuration change is required from v1.4.0 or v1.4.1;
SQLite remains at schema 11. Back up the stopped service and restart after
upgrading. Existing Custom adapters remain compatible, and no hidden metadata
record or strict JSON output is required.

New generations record publication policy 2 and composition version 1. Archive
reads preserve the saved wording and retained check policy. Explicit draft
rechecks use captured inputs without a provider call; a previously unrendered
known source ID can create a new repair revision while preserving the original.
Legacy drafts do not adopt the new action/deadline composition. Keep `briefs/`,
its hidden files, `reviews/`, the database and configuration together in backups.
For rollback, restore the previous code with its matching pre-upgrade state.

## 1.4.1 — 2026-10-22

This patch removes unnecessary briefing publication holds and fixes unchanged
drafts losing their coverage metadata during revalidation.

- Treat coverage-accounting overflow and valid, explained editorial deferrals as optional notes. Keep review for missing or unsupported coverage claims and unresolved evidence presented as covered.
- Preserve the exact content and bound metadata when saving, rechecking, or publishing an untouched draft. Continue revalidating against captured evidence; actual edits still invalidate stale metadata and approvals.
- Show the actual finding in review forms. Keep edition-wide coverage findings separate from paragraph-specific errors, without misleading CVE excerpts or line jumps.
- Add regressions for the retained busy-day draft, real-server save/reopen/publication, and factual blockers that cannot be waived by editorial notes or approval. Unsupported CVEs, contradictory federal deadlines, invalid citations, and security-control review remain enforced.

### Upgrade notes

No database migration or configuration change is required from v1.4.0. Restart
the service after upgrading. Existing drafts are rechecked under the corrected
publication policy when saved or published; original receipts remain intact.

## 1.4.0 — 2026-10-09

This release adds durable Wire decisions and strengthens briefing evidence,
action review, collection isolation, and publication recovery.

- Budget article retrieval and priority coverage by distinct events, retain unresolved high-priority leads for review, and expose material overflow. Preserve bounded, dated same-source qualifications from earlier receipts without treating them as current fact evidence.
- Require review when one response action bundles containment, investigation, and recovery; prompt for separately owned milestones and a shorter full report.
- Track generation from collection through publication, keep visible tabs synchronized, and surface newer editions without moving the reader. Promote Generate and Review drafts beside the reader modes, and calculate edition age from elapsed time.
- Bind executive action targets to their specific judgment/action, require explicit review of unexplained priority coverage, and retain exact-copy editorial dispositions. Keep generated bookkeeping outside published prose and preserve it through draft repair.
- Exclude advertisement and related-story extracts, version the article cache, and reclassify retained evidence during offline replay without changing original receipts. Show accepted and excluded captures in draft review.
- Move Wire decisions into SQLite with optimistic revision checks, idempotent saves, retained evidence copies, paginated history, additive legacy import, and per-tab unsaved drafts. Preserve existing browser records for separate export. Keep routine decision controls in View tools and show offline or migration recovery above the signals.
- Isolate configurable pattern compilation and matching in bounded workers. Failed matching retains the last good collection and reports degraded readiness without blocking HTTP handling.
- Capture bounded private ranking datasets with complete candidate pools, frozen scoring inputs, blinded review exports, independent adjudication, incident/time splits, and metrics that expose unknown judgments and incomplete coverage.
- Apply security-control review to Convergence actions and block objective contradictions in counts, catalog windows, and action targets. Retain publisher calendar dates and named edition timezones for citation checks.
- Recognize article-only and shortened CVE lists in KEV matching, and bound NVD/EPSS observation caches.
- Track legacy receipt exemptions independently of manifests; missing modern receipts cannot restore automatic publication eligibility. Page archive reads before loading edition contents.
- Persist bounded webhook delivery jobs, reject redirects, retry transient failures, and distinguish material escalations per destination. Surface uncertain delivery, settings persistence, and configuration watcher failures in health diagnostics.
- Preserve independent headline archive identities beyond the old 160-character title prefix with a transactional schema v10 migration.
- Detect stale Wire decision edits across tabs, block new decisions at capacity without discarding existing records, and retain unsaved text. Bound embed waits and synchronize Wall display settings across tabs.
- Add a real-server browser gate covering security middleware, settings persistence, decision conflicts, saved-draft publication, and reader navigation in isolated temporary state.

### Upgrade notes

Stop the service and back up `data/`, `briefs/`, `reviews/`, configuration, and
secrets before upgrading. Startup migrates SQLite from schema 9 through schemas
10 and 11 and creates the hidden `briefs/.receipt-policy.json` inventory. Keep
that inventory with the database and saved editions. Rollback requires the prior
code and its matching pre-upgrade backup; older code cannot open schema 11.

Import legacy browser Wire decisions additively and keep their export until the
import is verified. Stronger current-copy checks can remove older editions from
Latest, Wall, RSS, or continuity until reviewed; original editions and receipts
remain intact. Named accounts, permissions, and team approval workflows remain
outside this release. See [Upgrade and rollback](docs/operations.md#upgrade-and-rollback).

## 1.3.2 — 2026-10-09

- Preserve CVE/score associations across soft line wraps and explicit trailing CVE parentheses, while rejecting ambiguous objects and scores borrowed from adjacent vulnerabilities. Locate score blockers on the affected draft line and link their captured evidence.
- Enforce normalized Custom provider completion reasons, retain usage reported at the end of a stream, and record how reasoning requests were configured for each attempt.
- Bound provider iteration and cleanup waits, preserve interrupted drafts and uncertain outcomes, and prevent automatically purchasing the same scheduled attempt again after a timeout. Document CLI adapter requirements, including corrective conversations and structured output handling.

## 1.3.1 — 2026-10-09

- Correct CVSS version/score parsing, parenthetical CVE associations, shortened CVE lists, and equivalent product-version wording. Preserve exact supporting citations, provenance, and actionable retry guidance while rejecting unsupported scores, deadlines, and exploitation claims.
- Rework Wall views for quick reading at a distance, with full-width responsive layouts, complete vulnerability headlines, concise takeaways, and essential operational facts. Improve laptop, ultrawide, 1080p, and 4K layouts; retain meaningful uncertainty in the assessment text. Prevent wrapped continuation headings from trapping narrow-screen navigation.
- Restore JPCERT feed ingestion and require more than half of feeds to be unavailable before showing degraded collection status, while retaining stale-data warnings.
- Add budgeted OpenAI support to the separate live evaluation harness and recognize GPT-6.1 Sol reasoning and cost estimates.
- Separate current-copy checks, scoped approvals, operational notices, and original findings across Briefing, Wall, copy, and print. Keep material exceptions actionable in both reading modes and routine checks in the optional edition record.
- Remove repeated generic verification language from published outputs, preserve decision-changing qualifications and source references, and refresh Wall diagnostics without resetting held text.
- Publish ordinary briefings with advisory notes; reserve recovery for serious evidence, integrity, incomplete-content, and security-control findings.
- Complete draft recovery with separate Save draft and Publish briefing actions. Recheck captured inputs without another model call, preserve the original evidence date, prevent duplicate publication, and retain the current briefing while a draft needs attention.
- Preserve deliberately saved drafts from automatic recovery cleanup, retain the original plus recent repair revisions, and make unchanged rechecks repeatable without consuming revisions.
- Require complete captured citation URLs, including tracking parameters and fragments; reject URL credentials and hidden controls. Keep story-grouping normalization separate from citation authorization.
- Require review of detected recommendations to weaken security controls or remove audit evidence before automatic publication eligibility. Keep the exact-copy approval and retained-finding behavior; bounded checks do not certify all generated advice.
- Isolate RSS/Atom parsing in a worker with time, heap, queue, and structural limits, preserving large full-content feeds and stale-cache recovery.
- Transform Horizon markers in text nodes only, and run an adversarial browser rendering corpus in CI with external requests blocked.

## 1.3.0 — 2026-10-09

- Give Briefing Overview a news-style front page with a featured story, an edition summary, and supporting headlines. Keep complete assessments, response actions, qualifications, and citations in Full report, with direct links from each story.
- Improve Briefing, Wire, Wall, draft recovery, and Settings layouts for 13-inch laptops, including 1440 × 900 and 1280 × 800 displays.
- Balance Full report reading margins, remove its duplicate assessment index, improve metadata wrapping, and keep section navigation aligned with the current reading position.
- Refine briefing prose for executive scanning and analyst follow-through: lead with consequences and applicability, preserve concise decision summaries, show uncertainty before response steps, and distinguish saved assessments from live reporting. Add editorial evaluation guidance and owner/target consistency checks.
- Add experimental Custom provider support through a trusted local module. Credentials remain in the environment; modules can report status, version, usage, cost, and actionable failure reasons. The module contract may change.
- Use provider capabilities in generation, preserve reported failure reasons, and expose local module health through Settings verification.
- Accept more supported no-intersection wording, validate KEV dates per bullet, and include expected wording in validation failures. Repair safe convergence and list formatting when revalidating saved drafts without a provider call.
- Refresh GitHub Pages branding, briefing screenshots, release documentation, and visual/contrast checks.
- Patch compression and proxy-addr, and update the test tooling's YAML dependency to remove newly reported dependency advisories.

## 1.2.1 — 2026-10-01

- Require a terminal provider event for complete generation, verify scheduled replay receipts, and use the same current-copy publication eligibility in Briefing, Wall, RSS, and continuity.
- Bind CVSS claims to their CVE, version, and provisional status; retain NVD assessment provenance and configuration conditions in generation receipts. Enforce supporting citation identities and complete Convergence entries.
- Preserve multiline assessment qualifications and supported trajectory labels. Correct article excerpt selection, feed parsing and freshness, actor/urgency matches, and zero source weights.
- Preserve Wire decisions across tabs and export the saved decision set. Track read state by source revision, retain decision input focus, and show newer revisions in Wall updates.
- Bound generation request waits, recover the exact generation attempt, and prevent stale history responses from replacing refreshed results. Correct Wall mode links, review deep links, evidence filtering, and model verification state.
- Refuse to open databases from a newer schema before changing their journal mode.
- Bind editorial approval to the exact reading copy, include review records in backup guidance, and document eligibility, recovery, and notification behavior.
- Refresh the fictional public sample and its HTML, PDF, and receipt against current publication checks. Simplify setup guidance to recommend Node.js 24 with npm and correct the sample link and screenshot descriptions.
- Update DOMPurify, Undici, brace-expansion, and ip-address to resolve dependency advisories found during release validation.

## 1.2.0 — 2026-09-06

- Add OpenAI Codex Briefing generation through the Responses API. Settings supports both provider keys, provider selection, OpenAI model selection, and live verification. Manual and scheduled generation use the selected provider.
- Update setup, API, security, and GitHub Pages documentation for both providers. Shorten the README and replace repeated marketing copy and stale recovery/support claims.

- Remove unused screenshot variants and an obsolete local audit command; retain future CI design artifacts for 14 days.

## 1.1.1 — 2026-09-06

- Align the GitHub Pages Briefing showcase with the shared graphite palette,
  keeping captions, links, and the transition to Wall consistent across the page.
- Refresh release metadata and asset versions so the corrected styling loads
  for returning visitors.

## 1.1.0 — 2026-09-06

### Evidence and assessment review

- Separate original generation findings from supported checks on the corrected
  reading copy, preserving the original receipt and correction history.
- Simplify Briefing to Overview and Full report, expose every assessment, and
  preserve paired response actions in generated executive previews.
- Make the header and automatic Wall follow the selected light/dark theme.
  Recompose the Wall opening and refine the shared Print Edition typography.

- Add a watch profile, retained source excerpts and revision comparisons, and
  explanations of literal relevance matches while keeping local exposure unknown.
- Preserve each publisher's passage, URL, and publication date through grouping.
  Keep NVD enrichment separate and require its own citation for NVD-only facts.
- Save bounded generation-input receipts beside new Briefings, including source
  references, configuration, provider attempts, and validation results. Existing
  editions remain readable without invented historical receipts.
- Require populated decision fields and matching citation identities before new
  publication; strengthen bounded CVE, CVSS, version, and KEV checks. Freeform
  narrative and organizational applicability still require analyst review.
- Classify retained evidence quality, recover useful same-publisher feed text
  from unusable article openings, and stop weak-only inputs before provider spend.
  Flag bounded unsupported durations, comparisons, and contradictory list counts.
- Preserve historical citations and warnings across Briefing, Wall, and Print
  Edition. Add Wire Hidden recovery, evidence inspection, and Settings health
  diagnostics, with keyboard and storage-failure handling.

### Security and operational reliability

- Close the mixed-case API path bypass in browser-origin and content-type guards;
  enforce the configured proxy trust predicate and support local HTTP CSP.
- Preserve last-good settings and block overwriting an unreadable settings file.
  Include actual storage failures in readiness diagnostics.
- Split Slack alerts into complete bounded messages and checkpoint only
  successfully delivered items.
- Keep scheduled retries attached to their original edition across midnight and
  restart, and order latest/history views by publication time.
- Persist bounded generation-attempt accounting so interrupted work reports
  unknown final usage without automatically replaying a possibly paid request.
- Use low thinking effort by default within the existing 16,000-token cap and
  300-second deadline. Preserve explicit operator settings; output-limit recovery
  lowers effort once and keeps incomplete output as a recoverable draft.
- Drain refresh, KEV loading, alert delivery, and scheduled-generation accounting
  before closing storage during shutdown; prevent schedule rearming while stopping.

### Collection and release maintenance

- Scan more feed entries with visible truncation, retain publisher observation
  times through outages, and gate generation on prompt-visible fresh evidence.
  Final collection selection remains bounded to 50 signals.
- Expose enrichment failures, apply cached ranking context before selection,
  improve grouping/taxonomy, and preserve first-observation scoring snapshots.
- Update affected dependencies, add weekly dependency-update proposals, and
  combine repository policy and supported-runtime jobs into a release gate.
- Add offline Briefing evaluation, actual CSV/JSON download checks, Chromium
  Print Edition PDF inspection, and an actual Safari gate on macOS CI. Native
  print dialogs remain a manual acceptance check.
- Keep parallel Print Edition summary columns together when they fit on a page.
- Keep public evidence guidance and a concise roadmap separate from working
  audit records. Wire filters do not curate Briefing inputs. Analyst decision
  records persist in this browser; exported handoffs include their context. They
  do not synchronize between users or devices.

### Known generation limitations

Generated Briefings require analyst review. The final live rehearsal still
needed corrections to aggregate counts, action conditions, and event-timeline
inferences. Automated checks cover bounded claim forms, not every narrative
claim. Rejected drafts and their captured inputs can be inspected, repaired,
and revalidated without another provider call; revalidation does not publish
the draft. The marketing screenshots use an earlier editorially reviewed edition.

### Upgrade

Stop the server and back up `data/`, `briefs/`, `config.json`, and protected
secrets before updating. Startup migrates the v1.0.3 database from schema 7 to 9;
new evidence history starts with subsequent collection. Reinstall dependencies
for the supported Node runtime in use. Roll back with the prior code **and** its
matching pre-upgrade backup, never by opening the upgraded database with older
code. See [Upgrade and rollback](docs/operations.md#upgrade-and-rollback).

## 1.0.3 — 2026-07-29

### Briefing reliability and control

- Move unattended Briefing generation into an explicit, disabled-by-default
  Settings control with timezone, missed-run, retry, and daily-attempt options.
- Reload persisted scheduler state before every run so overlapping scheduler
  instances cannot duplicate a paid generation.
- Require enough fresh source evidence before contacting Anthropic and publish
  an edition only after its complete structure and trust checks pass.
- Apply one generation deadline across model setup and streaming, and return
  distinct rate-limit and evidence errors to the interface.
- Include bounded non-blocking validation warnings in completed-Briefing
  webhook notifications so downstream reviewers receive the same caveats.

### Interface, editions, and printing

- Refine Briefing and Edition typography, spacing, navigation, metadata, and
  validation messages across desktop and narrow layouts.
- Print Editions as one white document with safer pagination instead of tan,
  section-fragmented pages.
- Remove the redundant HTML export path and retain the reviewed print/PDF flow.
- Separate each judgment's analytic tier from its operator decision window,
  label that timing explicitly on the Wall and Briefing, and reserve **Act now**
  for actions that the assessment actually marks for the current shift.

### Runtime, data, and security

- Use an Undici Agent with a custom pinned DNS lookup for protected outbound
  requests, avoiding dispatcher-handler contract drift across supported Node
  releases while preserving SSRF address pinning.
- Add persistent article and search caching, deterministic story grouping, FTS
  reconciliation, and content-aware enrichment invalidation.
- Fail closed on malformed configuration, duplicate feeds, unsafe browser
  origins, weak remote authentication, and stale readiness state.
- Add dedicated liveness and readiness endpoints, bounded external calls, and
  dependency-policy updates.

### Documentation and verification

- Split operational, configuration, architecture, API, and development detail
  out of the README and refine the GitHub Pages landing page.
- Scope no-key claims to Wall and Wire, state the Anthropic requirement for
  Briefing generation, and describe the project as a source-run Node service
  rather than an operating-system-specific installer.
- Expand automated coverage for Node 26, scheduler races, publication gates,
  caching, transport security, settings, rendering, and print behavior.

## 1.0.2 — 2026-07-24

### Runtime compatibility

- Add Node 26 to the tested runtime matrix, including Apple Silicon and Intel
  macOS coverage for the native SQLite dependency.
- Bridge the legacy and Node 26 fetch dispatcher callback contracts, including
  legacy pause/resume backpressure, so SSRF-pinned feed requests and webhooks
  work on every supported runtime.
- Require `better-sqlite3` 12.10 or newer, the first release line with Node 26
  prebuilt binaries.
- Explicitly approve the locked native install scripts so clean installs keep
  working with npm's opt-in lifecycle-script policy.

### Security hardening

- Reject DNS-rebinding Host values and mismatched browser origins before they
  can reach the default keyless loopback API.
- Require configured API bearer secrets to be at least 32 characters and hide
  detailed health diagnostics from unauthenticated reverse-proxy callers.
- Bound untrusted feed fields before expensive processing and reject URLs that
  contain embedded credentials.
- Sanitize log output against terminal-control injection and credential leakage.
- Refresh vulnerable transitive dependencies and expand CI dependency-policy
  checks.

### Documentation and operations

- Clarify that BlueTeam.News remains a source-only local Node server on macOS,
  Windows, and Linux: clone the repository, run `npm install`, then `npm start`.
- Refine the README and move detailed operations, configuration, architecture,
  API, and development guidance into focused documents.
- Document optional outbound data, reverse-proxy requirements, local file
  protections, and the reviewed dependency lifecycle-script policy.

## 1.0.1 — 2026-07-13

Correctness and artifact-quality patch for the initial public release.

### Briefing trust and reliability

- Prevent prior-edition watchlist details from becoming unsourced facts in a later briefing, and validate pending or negative KEV claims against the catalog as well as affirmative membership.
- Keep citation URLs server-grounded: sources without URLs are explicit, unsupported URLs become plain citations, and unresolved factual trust failures cannot publish.
- Retry factual validation failures once, while preserving the original failure when a second attempt still cannot be grounded.
- Preserve the source precision and authority of external deadlines, ground visible KEV due dates directly from the catalog, and keep internal action targets clearly separate from mandates instead of inventing repeated clock times.

### Edition and PDF

- Normalize packed briefing fields into readable semantic blocks, keeping only the lead assessment centered and recommended actions outside narrative bullets.
- Make printed and exported Editions match the warm, single-column reading view, with safer pagination, unbroken CVE identifiers, and fonts settled before export.

### Interface and compatibility

- Distinguish provider and server generation failures from a genuinely dropped streaming connection.
- Report a Settings-stored Anthropic key accurately at startup while keeping it local and masked.
- Rework the Wall executive summary into a balanced situation-and-owner view with shared deadlines shown once and no redundant title block.
- Remove the question-mark help cursor from passive Wire evidence labels without removing their explanatory tooltips.
- Document the `npm.cmd` quick-start fallback for PowerShell systems that block the `npm.ps1` shim.

## 1.0.0 — 2026-07-13

Initial public release of BlueTeam.News, a self-hosted threat-intelligence desk
for cyber defense teams.

### Product

- The Wall: an unattended, status-aware operations display.
- The Wire: a searchable and filterable scored-signal queue with visible
  evidence, KEV, CVSS, EPSS, attribution, and alert context.
- The Briefing: optional Anthropic-powered daily synthesis with BLUF, calibrated
  judgments, actions, source links, local history, and export.
- Forty-one configured public threat feeds, with local SQLite operational state
  and Markdown brief archives.

### Release hardening

- Loopback-first deployment with fail-closed non-loopback authentication.
- Redirect-aware SSRF controls, private-address blocking, outbound timeouts, and
  untrusted feed/article/prompt boundaries.
- Sanitized rendered content, CSP nonces, rate limits, secret guards, bounded
  storage/search, atomic settings and alert-delivery state, and last-good data
  behavior.
- Cross-platform CI on Node 22 and 24 for Linux, Windows, and macOS, plus
  dependency auditing, secret/history scanning, asset verification, contrast
  checks, and scoring-model invariants.

### Project policy

- MIT licensed; forks and self-hosted modification are welcome.
- Maintainer-led: unsolicited pull requests and feature requests are not
  accepted.
- Released as-is with no support, response-time, maintenance, roadmap, or update
  guarantee. See [SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md).

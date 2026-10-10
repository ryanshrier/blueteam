# Changelog

## 1.4.0 — 2026-10-09

This release adds durable Wire decisions and strengthens briefing evidence,
action review, collection isolation, and publication recovery.

- Budget article retrieval and priority coverage by distinct events, retain unresolved high-priority leads for review, and expose material overflow. Preserve bounded, dated same-source qualifications from earlier receipts without treating them as current fact evidence.
- Require review when one response action bundles containment, investigation, and recovery; prompt for separately owned milestones and a shorter full report.
- Track generation from collection through publication, keep visible tabs synchronized, and surface newer editions without moving the reader. Promote Generate and Review drafts beside the reader modes, and calculate edition age from elapsed time.
- Bind executive action targets to their specific judgment/action, require explicit review of unexplained priority coverage, and retain exact-copy editorial dispositions. Keep generated bookkeeping outside published prose and preserve it through draft repair.
- Exclude advertisement and related-story extracts, version the article cache, and reclassify retained evidence during offline replay without changing original receipts. Show accepted and excluded captures in draft review.
- Move Wire decisions into SQLite with optimistic revision checks, idempotent saves, retained evidence copies, paginated history, additive legacy import, and per-tab unsaved drafts. Preserve existing browser records for separate export.
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
- Bound provider iteration and cleanup waits, preserve interrupted drafts and uncertain outcomes, and prevent automatically purchasing the same scheduled attempt again after a timeout. Document CLI adapter requirements, including corrective conversations and IBM Bob output handling.

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

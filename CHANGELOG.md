# Changelog

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

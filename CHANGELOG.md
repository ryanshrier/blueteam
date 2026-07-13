# Changelog

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

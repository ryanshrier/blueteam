# Security Policy

If you find a vulnerability in BlueTeam.News, please report it privately so it
can be evaluated responsibly. Reporter credit will be offered if an advisory is
published, unless you prefer to remain anonymous.

## Supported versions

BlueTeam.News is a single-maintainer project. Reports are evaluated against the
latest release; any investigation, mitigation, or fix is at the maintainer's
discretion.

| Version | Supported |
|---|---|
| Latest release | Best effort |
| Older releases | Not supported |

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public disclosure before a fix is available puts every operator running the tool at risk.

Report privately through GitHub's [private vulnerability reporting](https://github.com/ryanshrier/blueteam/security/advisories/new) — the **Security** tab → **Report a vulnerability**. This opens a private advisory visible only to you and the maintainer.

Include what you'd want to receive yourself:

- The affected version or commit, and your platform (OS, Node version).
- A description of the issue and its impact.
- Reproduction steps or a proof of concept, if you have one.
- Any suggested remediation.

## What to expect

This is a single-maintainer, no-SLA open-source project. There is no guaranteed
acknowledgement, response time, assessment, fix, mitigation, or release. A
significant and reproducible report may be investigated when maintainer capacity
allows. If an advisory is published, reporter credit will be offered unless the
reporter asks to remain anonymous.

Coordinated disclosure is requested: please allow a reasonable opportunity to
investigate before publishing details, while understanding that no remediation
schedule is promised.

## Scope

BlueTeam.News is **self-hosted and loopback-by-default**, with no hosted service, no accounts, and no telemetry. Security expectations are framed accordingly.

**In scope** — issues in this repository's code, for example:

- Bypass of the SSRF guard (`lib/net.js`) that fetches feeds and articles.
- Cross-site scripting via feed content, brief markdown, or any rendered field (briefs are sanitized with DOMPurify — a sanitizer bypass is in scope).
- A Host, Origin, CSP, rate-limiting, or bearer-auth (`API_SECRET`) weakness that exposes `/api/*`, including DNS rebinding against the loopback service.
- The non-loopback fail-closed bind guard not failing closed.
- Leakage of the Anthropic API key (in logs, responses, or the persisted settings file).
- Any path that lets a malicious feed pivot into the operator's network or read local files.

**Out of scope:**

- Generic vulnerability reports about a third-party dependency with no
  BlueTeam.News-specific impact or reachable path. If a dependency issue is
  exploitable through the app, report that impact here as well as upstream.
- Exposure caused by binding a non-loopback `HOST` with `API_SECRET` set (bearer auth is deliberately the operator's opt-in for that case), against the README's guidance that BlueTeam.News is localhost-only by design.
- The content of third-party threat feeds themselves.
- Missing hardening that is documented as a deliberate non-goal (multi-user auth, RBAC, tenancy).

## Hardening the deployment

Operator-side guidance for running it safely — bind address, `API_SECRET`, and
what leaves your network — lives in the [README](README.md#security-posture).

The in-app Anthropic key is stored locally in `data/settings.local.json` so the
service can restart without prompting. It is never returned raw by the API, but
it is not encrypted at rest: protect the host account and the `data/` directory,
and prefer an environment variable or OS-managed secret injection where local
disk access is in your threat model. On POSIX systems the application tightens
its state directories to `0700` and sensitive settings, Briefing, SQLite, WAL,
and SHM files to `0600`; Windows retains the host account's ACLs.

BlueTeam.News is not a multi-user security boundary. For access beyond the local
machine, put a TLS-terminating and authenticating reverse proxy in front, set an
`API_SECRET` of at least 32 random characters, configure `PUBLIC_BASE_URL` and
`TRUST_PROXY` precisely, and restrict network reachability at the host firewall.
The browser frontend does not store the shared bearer token, so a remote
interactive deployment must have its trusted proxy inject that token on upstream
API requests. Do not expose the default HTTP listener directly to the internet.

The server validates local Host values and present browser origins; do not weaken
those controls with a wildcard origin on a network deployment. When
`API_SECRET` is set, unauthenticated health checks intentionally receive only a
minimal status even if the reverse proxy connects over loopback.

The exact optional data sent to Anthropic and configured webhooks is documented
in [Operations and deployment](docs/operations.md#health-and-outbound-traffic).

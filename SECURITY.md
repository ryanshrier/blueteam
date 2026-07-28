# Security Policy

Please report suspected vulnerabilities privately so they can be assessed before public disclosure.

## Supported versions

Security reports are evaluated against the latest published release.

| Version | Support |
|---|---|
| Latest release | Best effort |
| Older releases | Not supported |

BlueTeam.News is a single-maintainer project with no response-time or remediation SLA.

## Reporting a vulnerability

Do not open a public issue containing vulnerability details. Use GitHub [private vulnerability reporting](https://github.com/ryanshrier/blueteam/security/advisories/new) from the repository's **Security** tab.

Include:

- the affected version or commit, operating system, and Node version;
- the deployment mode, including bind address, proxy, and authentication settings;
- a clear impact statement;
- reproduction steps or a minimal proof of concept; and
- any suggested remediation.

Reporter credit will be offered for a published advisory unless anonymity is requested. Please allow reasonable time for assessment before public disclosure, recognizing that no fix schedule is guaranteed.

## Security model

BlueTeam.News is a self-hosted, single-operator application. It has no hosted control plane, user accounts, role-based access control, tenancy boundary, or encrypted application vault. A person who can use the trusted local interface can change operator settings and initiate billable Briefing generation.

The supported deployment models are:

1. **Local:** the default server binds to loopback and is used by the host operator.
2. **Managed network access:** a strong `API_SECRET`, restrictive firewall, and TLS-terminating authenticating reverse proxy protect access beyond the host. The proxy injects the bearer token for the browser interface.

The shared API secret authenticates requests; it is not a multi-user authorization system. BlueTeam.News should not be exposed directly to the public internet.

The self-hosted application has no product telemetry. It intentionally makes outbound requests to configured threat sources and enrichment services, to Anthropic when key verification or Briefing generation is requested, and to a configured webhook. See [Network behavior](docs/operations.md#network-behavior) for the data boundary.

## Scope

Examples of issues that are in scope:

- SSRF guard bypasses in feed, article, enrichment, or webhook fetching;
- cross-site scripting or unsafe Markdown/HTML rendering through any untrusted field;
- path traversal, local-file disclosure, or arbitrary file modification;
- leakage of Anthropic keys, `API_SECRET`, or other credentials through storage, logs, responses, or generated output;
- Host, Origin, CSP, rate-limit, or bearer-authentication bypasses in a supported deployment;
- failure of the non-loopback bind guard or trusted-proxy boundary;
- unauthorized Settings changes or billable generation through the documented local or managed-network configurations; and
- a vulnerable dependency that has a reachable, BlueTeam.News-specific impact.

Examples that are out of scope by themselves:

- direct internet exposure without the documented firewall, TLS, authentication, and proxy controls;
- isolation between mutually untrusted users, tenants, or local operating-system accounts;
- plaintext local state when an attacker already has access to the service account's files;
- inaccurate or malicious content supplied by third-party threat feeds, unless the application handles it unsafely;
- model output quality or factual errors without a security impact; and
- automated dependency-version reports that do not demonstrate a reachable impact in this application.

If the correct classification is unclear, report privately.

## Deployment hardening

- Keep the default `HOST=127.0.0.1` unless remote access is required.
- For remote access, use at least 32 random characters for `API_SECRET`, configure `PUBLIC_BASE_URL` and `TRUST_PROXY` precisely, and require authentication and TLS at the reverse proxy.
- Restrict the listener with the host firewall. Do not use wildcard CORS for a network deployment.
- Run the process as a dedicated, unprivileged account and keep dependencies and the host patched.
- Protect `.env`, `data/`, `briefs/`, logs, and backups. Test restoration regularly.
- Treat configured webhooks and Anthropic as data recipients.
- Monitor process logs and authenticated `/api/ready` details for persistent failures.

An Anthropic key saved through Settings is stored in plaintext at `data/settings.local.json`. It is masked in API responses and common credentials are redacted from logs, but those controls do not protect against local file access. Prefer environment or service-manager secret injection when disk access is in the threat model.

On POSIX systems the application requests mode `0700` for state directories and `0600` for sensitive state files. Windows uses the service account's filesystem ACLs. These are defense-in-depth defaults, not encryption.

See [Operations and deployment](docs/operations.md) for backups, logging, upgrades, and the full remote-access procedure.

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

The application sends no product telemetry. Outbound requests go to configured threat sources and enrichment services, the selected built-in AI provider (Anthropic or OpenAI) during verification or Briefing generation, and an optional webhook. An experimental Custom module defines its own destinations and data handling. See [Network behavior](docs/operations.md#network-behavior) for the data boundary.

**Custom (local module) is experimental; its contract may change.** `AI_PROVIDER_MODULE` loads trusted operator-supplied code into the server process. Modules run with the server account's permissions, receive its environment, and are not sandboxed. Their credentials are configured in the environment, never through the Settings key fields. Only install code you trust; the application's fetch protections do not restrict arbitrary module networking or file access. The optional health hook can perform module-defined work, although the application's status check never invokes generation.

## AI-generated content and untrusted sources

Feed and article text is untrusted data. Source fencing and provider instructions
reduce prompt-injection risk but cannot eliminate it. The built-in generation
clients have no model-controlled tools, shell, or file access; provider keys are
transport credentials, not prompt content. Configured organization context is
sent to the selected provider, so keep secrets out of that context.

Generated live citations must match a captured complete HTTP(S) destination,
including query parameters and fragments. Credentials and hidden control
characters in source URLs are rejected. The lossy URL key used to group stories
does not authorize links. HTML sanitization and draft-link removal remain
separate output boundaries.

Bounded checks flag explicit recommendations to weaken named security controls
or remove audit evidence, including selected command forms. These editions are
retained with `SECURITY_CONTROL_CHANGE` findings and require approval of the exact
reading copy before default Latest, Wall, RSS, continuity, or completion-webhook
eligibility. Approval does not erase findings or replay a completion webhook.
This is a review tripwire, not a semantic safety check: paraphrases, other
languages, and other harmful advice can escape it. Review recommendations against
the original source and local conditions before taking action. Existing archives
are not silently rewritten or comprehensively re-audited by an upgrade.

RSS/Atom XML parsing runs in one isolated worker at a time with a five-second
deadline, bounded queue, V8 heap limits, and structural limits. These constrain
hostile-feed resource use; the heap limit is not a total process-memory limit.
Parse failures retain the existing stale-cache/failure reporting behavior.

Configurable regular expressions also compile and execute in bounded workers.
Collection matching has a two-second deadline, bounded input and queue sizes,
and a worker heap limit. Timeout or worker failure rejects that collection and
preserves the last good snapshot; it never counts as a successful no-match.
HTTP presentation and alert delivery consume the captured assessment. These
workers constrain computation; they do not sandbox trusted local domain modules.

Wire decisions, revision history, and copied evidence are private SQLite state.
Revision checks prevent stale overwrites, but the shared deployment credential
does not identify individual editors. Ranking captures are bounded local files
that include watch-profile and source material; protect them and their exports
with the same filesystem and backup controls as other operator state.

`npm run check:security:render` exercises the actual sanitizer, Markdown renderer,
and subsequent DOM transformations in a browser with external requests blocked.
The regression corpus is bounded and does not establish that all XSS or prompt
injection attacks are impossible.

## Scope

Examples of issues that are in scope:

- SSRF guard bypasses in feed, article, enrichment, or webhook fetching;
- cross-site scripting or unsafe Markdown/HTML rendering through any untrusted field;
- path traversal, local-file disclosure, or arbitrary file modification;
- leakage of provider keys, `API_SECRET`, or other credentials through storage, logs, responses, or generated output;
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
- Protect `.env`, `data/`, `briefs/`, `reviews/`, logs, backups, and any trusted local provider module. Restore the state directories together so corrections and publication decisions remain attached to their editions. Test restoration regularly.
- Treat configured webhooks and the selected AI provider as data recipients.
- Monitor process logs and authenticated `/api/ready` details for persistent failures.

Built-in provider keys saved through Settings are stored in plaintext at `data/settings.local.json`. They are masked in API responses and common credentials are redacted from logs, but those controls do not protect against local file access. Prefer environment or service-manager secret injection when disk access is in the threat model. Experimental Custom modules use environment credentials; keep secrets out of their errors, health responses, and generated text.

Keep credentials out of troubleshooting snapshots and review artifacts. If an
operator backup does not need to restore credentials, omit saved provider keys
and re-enter them after restoration. Protect any backup that does contain keys
with the same access restrictions as the live settings; gitignore is not an
access-control mechanism. Rotate credentials if such a copy was exposed.

On POSIX systems the application requests mode `0700` for state directories and `0600` for sensitive state files. Windows uses the service account's filesystem ACLs. These are defense-in-depth defaults, not encryption.

See [Operations and deployment](docs/operations.md) for backups, logging, upgrades, and the full remote-access procedure.

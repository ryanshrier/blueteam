# Configuration

[Back to the README](../README.md)

BlueTeam.News uses `config.json` for product behavior and environment variables for secrets and server settings. `config.json` is validated with Zod and hot-reloaded when saved.

## `config.json`

| Block | Controls |
|---|---|
| `organization` | Optional team profile, sector, watch topics, and regions used by the Briefing |
| `horizons` | Names, time windows, and questions for the Tactical, Operational, and Strategic tiers |
| `trustedFeeds` | RSS/Atom sources, including tier, weight, and deep-extraction settings |
| `alertRules` | Regular expressions that boost matching headlines |
| `analysisSettings` | Models, token budgets, refresh cadence, freshness windows, tier weights, scoring debug, and webhook delivery |

To tailor results to an environment, add relevant technologies and concerns to `organization.watchTopics` and `alertRules`:

```json
{
  "organization": {
    "sector": "Financial services",
    "watchTopics": ["payment fraud", "SWIFT", "core banking platforms"]
  },
  "alertRules": [
    { "pattern": "Okta|Entra|Workday", "boost": 4 }
  ]
}
```

Keep feed tiers and weights deliberate. Source diversity records how many configured sources report similar stories; it does not establish that the underlying reporting is independent.

## Environment variables

Copy `.env.example` to `.env` for local use. Do not commit populated secret files.

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | No | Enables Briefing generation. `ANTHROPIC_API_KEY_PRIMARY` is accepted as an alias. |
| `ANTHROPIC_API_KEY_SECONDARY` | No | Fallback key used after an authentication failure. |
| `NVD_API_KEY` | No | Raises the NVD CVE lookup limit from 5 to 50 requests per 30 seconds. [Request a free key.](https://nvd.nist.gov/developers/request-an-api-key) |
| `BLUETEAM_USER_AGENT` | No | Overrides the feed-reader identity, for example to add an operator contact URL. |
| `PORT` | No | HTTP port. Default: `3000`. |
| `HOST` | No | Bind address. Default: `127.0.0.1`. A non-loopback value requires `API_SECRET`. |
| `PUBLIC_BASE_URL` | No | Canonical HTTP(S) origin for feed metadata and Briefing webhook links. Credentials, paths, queries, and fragments are rejected. |
| `API_SECRET` | No | Bearer-token protection for `/api/*` except the public `/api/health` uptime probe. If set, it must be at least 32 characters and must not be an obvious placeholder. Required for a non-loopback bind. |
| `ENABLE_EMBED` | No | Set to `1` to enable `/embed` while `API_SECRET` is configured. |
| `CORS_ORIGIN` | No | Exact allowed cross-origin caller. Default: same-origin only. Avoid `*` on a network deployment. |
| `TRUST_PROXY` | No | Trusted proxy hop count, subnet, or `loopback`. Leave unset without a reverse proxy. |
| `NODE_ENV` | No | Set to `production` for JSON logs and HSTS. |

`PUBLIC_BASE_URL` must be an origin such as `https://blueteam.news`. When it is unset, local feed URLs are derived from the request and webhook links use the safe `http://localhost:PORT` fallback.

`TRUST_PROXY` controls whether Express honors `X-Forwarded-*` headers for client IPs, rate limiting, and request-derived feed URLs. Without it, direct clients cannot use those headers to spoof proxy information. `PUBLIC_BASE_URL` takes precedence for emitted feed URLs.

The Anthropic key can also be set, cleared, and verified at runtime from **Settings**.

Generate an `API_SECRET` with Node so the command works on every supported operating system:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Host validation protects the default local server from DNS-rebinding requests. Present browser origins are also checked on state-changing API requests. If a reverse proxy changes the public host, configure `PUBLIC_BASE_URL` to its canonical origin and keep proxy trust narrowly scoped.

## Alert webhook

`analysisSettings.webhook` can send alert-matched signals, completed Briefings, or both:

```json
{
  "analysisSettings": {
    "webhook": {
      "url": "",
      "format": "slack",
      "events": "alerts"
    }
  }
}
```

An empty `url` disables delivery. Set:

- `format` to `slack` for Slack/Teams-compatible messages or `json` for a generic payload;
- `events` to `alerts`, `brief`, or `both`; and
- `PUBLIC_BASE_URL` if recipients need links to a public deployment.

Alert delivery includes only signals matching an `alertRule`, and each story is sent at most once. Briefing delivery includes the edition date, BLUF, key judgments, and a deep link.

Outbound webhook requests use the same SSRF protections as other fetches. Delivery is best-effort: failure is logged but never blocks a pipeline refresh or Briefing save.

## Related guides

- [Operations and deployment](operations.md)
- [API reference](api.md)
- [Security policy](../SECURITY.md)

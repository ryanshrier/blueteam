# API reference

[Back to the README](../README.md)

All endpoints are served by the same process as the browser application. The default loopback deployment does not require authentication. If `API_SECRET` is set, every `/api/*` request except `/api/health` requires a bearer token.

```http
Authorization: Bearer <API_SECRET>
```

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/landscape` | `GET` | Full Wall payload: signals, KEV, actors, and velocity |
| `/api/headlines` | `GET` | Every scored headline from the latest pipeline run |
| `/api/feed.xml` | `GET` | RSS/Atom feed of top signals with source, tier, score, and KEV status |
| `/api/feed.json` | `GET` | [JSON Feed](https://www.jsonfeed.org/) of the same top signals |
| `/api/briefs.xml` | `GET` | RSS 2.0 feed of daily Briefings |
| `/api/refresh` | `POST` | Start a pipeline refresh |
| `/api/brief` | `POST` | Generate a Briefing as a server-sent events stream |
| `/api/briefs` | `GET` | List Briefing history |
| `/api/brief/:filename` | `GET` | Return a specific archived Briefing |
| `/api/search?q=` | `GET` | Full-text search across Briefings using SQLite FTS5 |
| `/api/health` | `GET` | Public uptime status; detailed diagnostics for the default keyless loopback deployment or a caller with a valid bearer token |
| `/api/edition` | `GET` | Active CTI profile identity: id, title, label, and regions |
| `/api/settings` | `GET`, `POST` | Read/update organization context and watch terms; inspect masked AI-key status or set/clear the key |
| `/api/settings/verify` | `POST` | Make a minimal Anthropic request to verify the configured key |
| `/embed` | `GET` | Headerless signal strip for an iframe; supports `tier` and `limit` query parameters |

## Generation stream

`POST /api/brief` uses server-sent events so the interface can show generation progress and recover cleanly from timeouts. SSE responses are not compressed, which avoids buffering surprises in common proxy configurations.

## Feeds and public URLs

`PUBLIC_BASE_URL` supplies the canonical origin for RSS and JSON Feed metadata. It also supplies deep links in completed-Briefing webhooks. If it is unset, local feed URLs are request-derived and webhook links fall back to `http://localhost:PORT`.

When a reverse proxy supplies the public request details, configure `TRUST_PROXY` narrowly. Forwarded headers are ignored when that setting is absent.

## Embedding

`/embed` is a keyless HTML route intended for an iframe:

```html
<iframe src="http://127.0.0.1:3000/embed?tier=1&limit=10"></iframe>
```

It is disabled by default whenever `API_SECRET` is set because an iframe cannot attach the bearer token required by protected `/api/*` routes. Set `ENABLE_EMBED=1` only when the embedding origin and proxy are otherwise secured.

## Health probes

`/api/health` remains reachable without a token so an uptime monitor can check the service. When `API_SECRET` is configured, every unauthenticated caller receives only the overall `status`, including a reverse proxy connecting over loopback. Supply the valid bearer token for detailed diagnostics. With the default keyless loopback configuration, local callers receive the detailed payload.

## Browser request boundary

The server validates the HTTP Host for the local deployment and rejects a mismatched browser Origin on state-changing requests. These checks defend the otherwise keyless loopback API from DNS rebinding and cross-origin mutation. Requests from scripts and uptime probes may omit `Origin`; API authentication rules still apply.

The browser frontend does not persist or attach `API_SECRET`. For remote interactive use, place a trusted authenticating reverse proxy in front of BlueTeam.News and have it inject the bearer header on upstream API requests. Direct API clients can send the header themselves.

## Related guides

- [Configuration](configuration.md)
- [Operations and deployment](operations.md)
- [Security policy](../SECURITY.md)

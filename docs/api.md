# API overview

[Back to the README](../README.md)

All endpoints are served by the same process as the browser application. The default loopback deployment does not require authentication. If `API_SECRET` is set, every `/api/*` request except the public `/api/live`, `/api/ready`, and `/api/health` probes requires a bearer token.

```http
Authorization: Bearer <API_SECRET>
```

Every state-changing `/api/*` request must also send JSON, including requests with no parameters:

```http
Content-Type: application/json
```

For example, send `{}` as the body of `POST /api/brief` and `POST /api/refresh`. A missing or different content type returns HTTP 415.

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/landscape` | `GET` | Full Wall payload: signals, KEV, actors, and velocity |
| `/api/headlines` | `GET` | Every scored headline from the latest pipeline run |
| `/api/evidence/:sourceId` | `GET` | Bounded retained source revisions and exact stored feed passages; no publisher fetch |
| `/api/feed.xml` | `GET` | RSS 2.0 feed of top signals with source, tier, score, and KEV status |
| `/api/feed.json` | `GET` | [JSON Feed](https://www.jsonfeed.org/) of the same top signals |
| `/api/briefs.xml` | `GET` | RSS 2.0 feed of daily Briefings |
| `/api/refresh` | `POST` | Start a pipeline refresh |
| `/api/brief` | `POST` | Generate a Briefing as a server-sent events stream |
| `/api/brief/status` | `GET` | Durable status and usage checkpoints for the last 20 generation jobs; local or authenticated callers only |
| `/api/briefs` | `GET` | List Briefing history |
| `/api/brief/:filename` | `GET` | Return a specific archived Briefing |
| `/api/brief/:filename/manifest` | `GET` | Read and verify a saved generation input manifest; local or authenticated callers only |
| `/api/search?q=` | `GET` | Full-text search across Briefings using SQLite FTS5 |
| `/api/live` | `GET` | Process liveness; returns HTTP 200 while the server can answer requests |
| `/api/ready` | `GET` | Readiness status and the same trusted diagnostics as `/api/health` |
| `/api/health` | `GET` | Compatibility alias for readiness |
| `/api/edition` | `GET` | Active CTI profile identity: id, title, label, and regions |
| `/api/settings` | `GET`, `POST` | Read/update the watch profile, generation schedule, provider/model selection, and separate masked Anthropic/OpenAI keys |
| `/api/settings/verify` | `POST` | Make a small billable request to verify a provider key and, for OpenAI, selected model access |
| `/embed` | `GET` | Headerless signal strip for an iframe; supports `tier`, `limit`, and `theme` query parameters |

## Generation stream

`POST /api/brief` uses server-sent events so the interface can show generation progress and recover cleanly from timeouts. SSE responses are not compressed, which avoids buffering surprises in common proxy configurations.

The route permits only one in-process generation at a time and applies a short cooldown from request start plus per-client fixed windows for short-term and daily requests. These limiter counters live in process memory and reset when the server restarts; they are a guardrail, not a spending cap. A 429 response includes a machine-readable error and `Retry-After`; clients should wait instead of immediately retrying. Requests rejected before a provider call do not consume the generation allowance. Manual and automatic generation use this same route and its limits.

`GET /api/brief/status` returns `persistence`, `active`, `latest`, and a bounded `jobs` list. Each paid attempt is recorded before its provider call, with model, prompt hashes, usage checkpoints, estimated cost, and final outcome. No prompts, source excerpts, provider credentials, or raw provider errors are retained in this ledger. Trusted health diagnostics also include a compact `generation` summary. The stream announces its `generationId` and status URL before starting paid work.

After a process restart, a job without a verified matching publication is `interrupted`, with `billing: "unknown-final-usage"` and `automaticRetry: false`. Token counts and costs are only the last recorded provider usage, not a final billing statement. A verified saved manifest can reconcile a publication even if the final ledger write failed. The scheduler cannot automatically repeat an ambiguous paid attempt for the same edition; review its status and provider usage before explicitly requesting another manual generation. Initial ledger failure stops generation before a provider call; later checkpoint failures stop further attempts and surface a storage error. This endpoint reports status; it does not replay the stream or resume a discarded draft.

## AI provider settings

Trusted clients can configure both provider keys and choose which one generates Briefings:

```json
{
  "aiProvider": "openai",
  "openaiModel": "gpt-5.3-codex",
  "openaiKey": "<your OpenAI API key>"
}
```

Send this body to `POST /api/settings`. Use `aiProvider: "anthropic"` and `anthropicKey` for Anthropic. Omitted keys remain unchanged; an empty key string removes that saved key. Both keys can be stored at once. Environment keys override saved keys for the same provider and cannot be removed through this endpoint. Saved provider/model choices override `AI_PROVIDER` and `OPENAI_MODEL` defaults. See [Configuration](configuration.md#environment-variables).

`GET /api/settings` returns the effective `ai.provider`, `ai.model`, `ai.enabled`, `ai.keySource`, and masked `ai.keyMasked`. Trusted responses also include `ai.providers.anthropic` and `ai.providers.openai`, each with `enabled`, `keySource`, `keyMasked`, and `model`. Raw keys are never returned.

To verify OpenAI before saving:

```json
{
  "provider": "openai",
  "openaiKey": "<your OpenAI API key>",
  "openaiModel": "gpt-5.3-codex"
}
```

Send this body to `POST /api/settings/verify`. Omit the key to use the effective environment or saved key. Anthropic accepts `provider: "anthropic"` with optional `anthropicKey`. For compatibility, omitting `provider` selects Anthropic unless `openaiKey` is supplied. Verification does not save settings. OpenAI verification and generation call the Responses API; Codex CLI and ChatGPT subscription logins are not accepted.

## Watch profile and applicability

Trusted `GET /api/settings` responses include the effective `watchProfile` with `schemaVersion: 1`. Updates are field patches:

```json
{
  "watchProfile": {
    "schemaVersion": 1,
    "technologies": ["Fortinet"],
    "sectors": ["Healthcare"],
    "regions": ["United States"],
    "intelligenceQuestions": ["Have affected versions or fixes changed?"],
    "exclusions": ["Product launches"],
    "preferredHorizons": [1, 2],
    "teamProfile": "Single analyst preparing the daily handoff"
  }
}
```

Omitted fields preserve the saved/default value; an explicit empty list clears that field. Strings are normalized and lists deduplicated case-insensitively. Limits are: 25 technologies of 64 characters each; 20 sectors of 128; 100 regions of 128; 100 intelligence questions of 300; 25 exclusions of 64; a 512-character team profile; and horizon numbers from 1–3. Unknown fields, unsupported versions, or invalid values return 400 `E_WATCHPROFILE`. Do not combine `watchProfile` with legacy `watchTerms` or `organization` in one request.

Profile reads/writes require the local deployment or an authenticated request. A disallowed update returns 403 `E_EXPOSED`. Existing global bearer requirements still apply on loopback when `API_SECRET` is configured. Untrusted settings reads omit profile details, and `/api/headlines` omits `applicability` for untrusted callers.

For a trusted caller, each headline's `applicability` includes `state` (`declared-match` or `unknown`), `exposure: "unknown"`, `method: "literal-match"`, `matches` (`field`, `term`, and matched text-field names in `in`), `exclusionMatches`, `preferredHorizon`, and `explanation`. Matches use original retained feed text, not an inventory. Exclusions do not filter out reporting. Applicability reflects the current profile; saved scores update on collection.

## Retained evidence

`/api/headlines` includes an `evidence` array of source references: `sourceId`, `revisionId`, source label/title, `canonicalUrl`, `passageKind`, `changed`, and publication/retrieval/observation times. An empty array means no retained reference is available. Group members can share a stable source identity while representing different feeds.

`GET /api/evidence/:sourceId` accepts only `src_` followed by 64 lowercase hexadecimal characters. The response contains source identity/URL, first and last observation times, `latestRevisionId`, `retention`, and `revisions` in newest-created order. Each revision contains its ID, title, attribution, URLs/identifier, `passage`, `passageKind` (`feed-excerpt` or `title-only`), `passageTruncated`, publication/source-update/retrieval/observation times, `previousRevisionId`, `previousPassage`, and `changes`.

`changes` is null or an object with `before`, `removed`, `added`, and `after` strings. It compares the prior retained representation from the same feed and passage kind. `latestRevisionId` describes the most recently created representation across the source; clients should prefer the `revisionId` attached to their feed snapshot. If that revision was pruned, do not silently substitute newer text.

Successful reads use `Cache-Control: no-store` and make no outbound request. Invalid identities return 400 `E_EVIDENCE_ID`; missing/pruned sources return 404 `E_EVIDENCE_MISSING`; storage failures return 503 `E_EVIDENCE_UNAVAILABLE`. Credential query parameters are redacted in inspection URLs. Evidence follows the existing Wire API authentication boundary.

The database keeps up to 5,000 sources, removes sources unobserved for 30 days, and retains up to eight revisions per source across all representations. Passages are bounded normalized feed extracts, up to 8,192 characters, not full articles. See [Evidence and relevance](evidence-and-relevance.md) for observation timing and clipping semantics.

## Generation input manifests

Briefing list/detail responses and generation completion events include `inputManifest`:

```json
{"status":"available","url":"/api/brief/brief-2026-09-05-01.md/manifest"}
```

Older editions return `status: "unavailable"`, `url: null`, and a reason. The endpoint accepts only a Briefing filename shaped as `brief-YYYY-MM-DD.md` or `brief-YYYY-MM-DD-NN.md`, with at most six suffix digits. It returns the saved schema-version-1 receipt with the generation identity, selected/grouped evidence, revision references, deterministic enrichment, collection/generation profiles, scoring and allowed prompt settings, model attempts, prompt/implementation hashes, validation, filename, and Markdown hash. The maximum manifest size is 4 MiB.

Manifest reads require the local deployment or an authenticated request and always use `Cache-Control: private, no-store`. Responses include 403 `E_EXPOSED` for an untrusted caller, 400 for an invalid filename, 404 for a missing edition, 404 `E_MANIFEST_UNAVAILABLE` for an edition without saved inputs, and 500 `E_MANIFEST_INVALID` when receipt size, schema, filename, parsing, or Markdown-hash verification fails. Paths and raw filesystem errors are not returned.

`available` reports a sidecar's presence; retrieval verifies its contents against the archive. A receipt is not a cryptographic signature. Exact prompts are represented by SHA-256 hashes rather than stored text; those hashes support identification, not complete historical replay. Rejected or interrupted output can be retained as a separate draft artifact with captured inputs and repair revisions; not every intermediate retry draft is retained. New publication writes the receipt before the Markdown completion marker. An unsuccessful publication does not emit `briefComplete` or send a Briefing webhook.

## Feeds and public URLs

`PUBLIC_BASE_URL` supplies the canonical origin for RSS and JSON Feed metadata. It also supplies deep links in completed-Briefing webhooks. If it is unset, local feed URLs are request-derived and webhook links fall back to `http://localhost:PORT`.

When a reverse proxy supplies the public request details, configure `TRUST_PROXY` narrowly. Forwarded headers are ignored when that setting is absent.

## Embedding

`/embed` is a keyless HTML route intended for an iframe:

```html
<iframe src="http://127.0.0.1:3000/embed?tier=1&limit=10"></iframe>
```

Add `theme=light` or `theme=dark` to match the containing page; otherwise the embed follows the browser's color-scheme preference. Update checks run once a minute while visible and offer a new snapshot for manual application. **Refresh signals** checks immediately; **Apply update** replaces the displayed snapshot while retaining the reading position where possible.

It is disabled by default whenever `API_SECRET` is set because an iframe cannot attach the bearer token required by protected `/api/*` routes. Set `ENABLE_EMBED=1` only when the embedding origin and proxy are otherwise secured.

## Health probes

Use `/api/live` for process supervision and `/api/ready` for traffic readiness. `/api/health` remains a compatibility alias for readiness. All three remain reachable without a token.

Liveness returns HTTP 200 while the process can serve HTTP. Readiness returns HTTP 503 when current pipeline, feed, or database state is degraded. When `API_SECRET` is configured, unauthenticated readiness callers receive only the overall `status`, including a reverse proxy connecting over loopback. Supply the valid bearer token for detailed diagnostics. With the default keyless loopback configuration, local callers receive the detailed payload.

## Browser request boundary

The server validates the HTTP Host for the local deployment and rejects a mismatched browser Origin on state-changing requests. These checks defend the otherwise keyless loopback API from DNS rebinding and cross-origin mutation. Requests from scripts and uptime probes may omit `Origin`; API authentication rules still apply.

The browser frontend does not persist or attach `API_SECRET`. For remote interactive use, place a trusted authenticating reverse proxy in front of BlueTeam.News and have it inject the bearer header on upstream API requests. Direct API clients can send the header themselves.

## Related guides

- [Configuration](configuration.md)
- [Evidence and relevance](evidence-and-relevance.md)
- [Operations and deployment](operations.md)
- [Security policy](../SECURITY.md)

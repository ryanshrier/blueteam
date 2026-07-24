# Architecture

[Back to the README](../README.md)

BlueTeam.News uses an Express backend and a browser frontend made from vanilla ES modules. There is no frontend build step.

```text
Browser
  Briefing | Wire | Wall | Settings
                 |
              REST + SSE
                 |
Express server and route modules
  routes/brief | routes/landscape | routes/settings
                 |
Collection | scoring | enrichment | landscape | history | SQLite
                 |
RSS/Atom | Google News | CISA KEV | NVD | EPSS | Anthropic
```

## Main components

| Path | Responsibility |
|---|---|
| `server.js` | Composition root: configuration, database, refresh service, middleware, and routes |
| `lib/feeds.js` | Feed collection, grouping, classification, selection, and pipeline coordination |
| `lib/scoring.js` | Weighted score calculation and score evidence |
| `lib/enrichment.js` | CVE, KEV, EPSS, entity, ATT&CK, article, and indicator enrichment |
| `lib/net.js` | Outbound networking and SSRF controls |
| `lib/landscape.js` | Landscape data used by the Wire and Wall |
| `lib/db.js` | SQLite persistence and FTS5 indexes |
| `routes/brief.js` | Briefing generation stream, validation, history, and search |
| `routes/landscape.js` | Landscape, headline, feed, and refresh endpoints |
| `public/` | Browser application and static runtime assets |

## Signal pipeline

The pipeline runs on demand and on the configured refresh cadence:

1. Fetch configured RSS/Atom sources with bounded concurrency, conditional requests, and per-feed circuit breakers; run the configured news-search sweep.
2. Group similar stories using TF-IDF cosine similarity and record configured-source diversity.
3. Classify urgency, apply alert-rule boosts and profile overrides, and promote operationally urgent items to Tactical when appropriate.
4. Pre-enrich candidates with CISA KEV membership, entities, and MITRE ATT&CK tags.
5. Score recency, source diversity, exploitation, severity, and relevance; apply per-tier floors and per-source caps.
6. Post-enrich selected signals with NVD CVSS data, article extraction, EPSS, and indicators.
7. Re-score and sort with verified enrichment evidence.

Each score component remains available to the interface. Source diversity means multiple configured sources covered a story; it is not proof that those sources relied on independent reporting.

Rolling signal history is stored in SQLite for trends such as actor frequency and headline velocity.

## Briefing flow

`routes/brief.js`:

1. grounds the request in the current scored signals and a deterministic KEV facts block;
2. streams Anthropic output to the browser over server-sent events;
3. validates required sections such as BLUF, judgments, convergence, and watchlist;
4. performs one corrective retry after a structural hard failure;
5. saves the edition as Markdown under `briefs/`; and
6. indexes it in SQLite FTS5 for search.

Timeout recovery and model fallback are handled by the route. Scheduled-run state prevents duplicate daily generation after a successful edition.

## CTI profile boundary

The project ships one enterprise CTI product. CTI-specific rules are kept out of the generic engine:

- `config/domains/cyber.js` defines actors, vendors, regions, urgency rules, scoring vocabulary, landscape panels, search queries, and Briefing voice.
- `config/domains/cyber-enrichers.js` connects the CTI enrichment stages.
- `lib/domain.js` exposes the active profile to core modules.

This boundary supports future CTI specializations, such as OT/ICS, cloud and identity, ransomware, or sector-specific intelligence, without duplicating the engine.

The runtime, package, feeds, and operator-facing logs use the BlueTeam.News name. The legacy `data/watchfloor.db` filename remains in place so upgrades do not orphan an existing local archive.

## Related guides

- [Configuration](configuration.md)
- [API reference](api.md)
- [Development](development.md)

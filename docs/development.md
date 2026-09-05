# Development

[Back to the README](../README.md)

BlueTeam.News supports Node 22.19 or newer in the Node 22 line, Node 24, and Node 26. The browser code uses vanilla ES modules, so there is no frontend compilation step.

Use the npm bundled with a supported Node release for normal development. CI's policy job separately pins npm 11.18 so the dependency lifecycle-script allowlist is enforced; the runtime matrix intentionally uses bundled npm.

## Run locally

```bash
npm install
npm start
```

The default URL is `http://127.0.0.1:3000`.

## Tests and release checks

```bash
npm test                       # Test suite
npm run test:watch             # Tests in watch mode
npm run check:secrets          # Credentials in the working tree
npm run check:history-secrets  # Credentials in reachable branch and tag history
npm run check:cti-scope        # CTI scope in release code and public copy
npm run check:contrast         # WCAG contrast for text tokens
npm run check:placeholders     # Placeholder slugs in public material
npm run check:assets           # Referenced assets and package paths
npm run check:landing          # Landing HTML, links, semantics, metadata, and CSP
npm run check:landing:render   # Desktop and phone browser smoke test
npm run check:evidence:render  # Production evidence/Settings fixtures: phone, desktop, light/dark, keyboard
npm run check:scoring          # Score invariants and gold-band ordering
npm run check:release          # Version/date/tag consistency across release surfaces
npm install-scripts ls --json  # Must report no unreviewed dependency scripts (npm 11.18+)
```

Run the focused check for the area being changed, then run `npm test`. The CI policy job runs repository checks once on Linux. The runtime matrix covers Node 22.19, 24, and 26 on Linux; Node 22.19 and 26 on Windows; and Node 26 on Apple Silicon and Intel macOS. The **Release readiness** check succeeds only when repository policy and the entire runtime matrix succeed, including when an upstream job fails or is skipped. Tag builds also require the `vX.Y.Z` tag to match `package.json`, the changelog, the landing page, and the sitemap date.

Dependabot proposes npm and GitHub Actions updates weekly. Production and major
dependency changes remain separate proposals; minor and patch development
updates may share a PR. Review native install-script allowlist entries and
explicit dependency overrides when updating packages. Update PRs run the same
checks as other changes and are not automatically merged.

For browser verification without live data or paid generation, run `npm run visual:serve`.
The [fixture guide](../test/visual/README.md) documents production-app previews,
all seven Wall types, long/sparse content, failures, recovery, and playback controls.

The evidence smoke test starts its own loopback fixture server and isolated
Chrome/Chromium/Edge profile. It requires no browser package, real sources,
database or API key, and fails on browser errors or unexpected external requests.
Set `CHROME_PATH` if the browser is not found. Set `EVIDENCE_SCREENSHOT_DIR` to an
output directory for optional PNG review artifacts. The Linux policy job runs
this gate; it complements rather than completes the broader rendered matrix.

For the new evidence/profile contracts, migration limits and contributor test
entry points, read [Evidence and relevance](evidence-and-relevance.md) and the
[roadmap](decision-desk-roadmap.md). Keep exact source observation
fixtures separate from model prose and analyst judgments. Do not run paid
generation as a test; provider behavior has mocked regression fixtures.

## Repository map

| Path | Contents |
|---|---|
| `server.js` | Composition root for configuration, database, refresh services, middleware, and routes |
| `lib/` | Collection, scoring, enrichment, landscape, database, history, and network controls |
| `routes/` | Express routers for Briefing, landscape, settings, and feeds |
| `public/` | Browser application, static assets, and vendor files |
| `public/modules/` | Briefing, Wire, Wall, core, layout, and Settings modules |
| `config/domains/` | CTI profile and enrichment registry |
| `config.json` | Feeds, alert rules, score weights, models, and organization context |
| `test/` | Release and regression suites |
| `scripts/` | Release checks, backtesting, and visual fixtures |
| `docs/` | GitHub Pages site and project reference guides |

See [Architecture](architecture.md) for the runtime flow and CTI profile boundary.

## GitHub Pages security boundary

The landing page uses a restrictive document-level Content Security Policy and
`no-referrer`, makes no third-party requests, and versions its published assets
with the release number. GitHub Pages does not allow this repository to set
arbitrary response headers. If the custom domain is moved behind an edge or
reverse proxy, also set `Content-Security-Policy` with `frame-ancestors 'none'`,
`Permissions-Policy`, `X-Content-Type-Options: nosniff`, and an equivalent
`Referrer-Policy` response header. Re-run both landing checks after changing the
page, its metadata, or its asset paths.

Validate the exact candidate on a review branch before merging or tagging.
When Pages publishes from `main/docs`, a merge to `main` also publishes those
files; it does not wait for a separate CI workflow. Coordinate the release and
site update so the version badge and release notes point to an available release.
Use a required **Release readiness** check or an equivalent enforced gate before
merging; adding the workflow alone does not configure branch protection.
After deployment, verify the
canonical URL and social card against the production page, inspect the live
response headers, and submit `https://blueteam.news/sitemap.xml` through the
configured search-engine webmaster tools.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `G`, then `B` | Open Briefing |
| `G`, then `W` | Open Wire |
| `G`, then `L` | Open Wall with reading/playback controls |
| `←` / `→` | Wall: previous / next page and pause for reading |
| `Space` | Wall: pause / resume rotation |
| `G`, then `S` | Open Settings |
| `/` | Focus search |
| `J` / `K` | Wire: next / previous signal |
| `Ctrl+Enter` | Generate a Briefing |
| `?` | Open help |
| `Esc` | Exit the Wall |

## Contributions and support

The project is maintainer-led. Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a change and [SUPPORT.md](../SUPPORT.md) before requesting help. Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).

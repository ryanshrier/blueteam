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
npm run check:scoring          # Score invariants and gold-band ordering
npm run check:release          # Version/date/tag consistency across release surfaces
npm install-scripts ls --json  # Must report no unreviewed dependency scripts (npm 11.18+)
```

Run the focused check for the area being changed, then run `npm test`. The CI policy job runs repository checks once on Linux. The runtime matrix covers Node 22.19, 24, and 26 on Linux; Node 22.19 and 26 on Windows; and Node 26 on Apple Silicon and Intel macOS. Tag builds also require the `vX.Y.Z` tag to match `package.json`, the changelog, the landing page, and the sitemap date.

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

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `G`, then `B` | Open Briefing |
| `G`, then `W` | Open Wire |
| `G`, then `L` | Open Wall |
| `G`, then `S` | Open Settings |
| `/` | Focus search |
| `Ctrl+Enter` | Generate a Briefing |
| `?` | Open help |
| `Esc` | Exit the Wall |

## Contributions and support

The project is maintainer-led. Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a change and [SUPPORT.md](../SUPPORT.md) before requesting help. Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).

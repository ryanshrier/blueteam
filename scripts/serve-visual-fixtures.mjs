import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { APP_SCENARIOS, buildAppFixture } from '../test/visual/app-fixtures.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(root, 'test', 'visual');
const marketingReceipt = JSON.parse(readFileSync(join(fixtureRoot, 'marketing-brief.manifest.json'), 'utf8'));
const port = Number(process.env.PORT || 4173);

export function createFixtureApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use('/public', express.static(join(root, 'public'), { etag: false, maxAge: 0 }));
  // Print Edition srcdoc resolves these URLs from the fixture origin, just as it
  // does in the application. Keep the capture on the real self-hosted typefaces.
  app.get('/fonts.css', (_req, res) => {
    res.sendFile(join(root, 'public', 'fonts.css'));
  });
  const vendorFiles = {
    '/vendor/marked.esm.js': join(root, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
    '/vendor/purify.es.mjs': join(root, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs'),
    '/vendor/brief-schema.js': join(root, 'lib', 'brief-schema.js'),
  };
  for (const [route, filePath] of Object.entries(vendorFiles)) {
    app.get(route, (_req, res) => res.sendFile(filePath));
  }
  // Authored fixtures have no generation ledger or provider job. Report an
  // available empty status instead of letting the generic Briefing route
  // return the document payload for this production status endpoint.
  app.get('/api/brief/status', (_req, res) => {
    res.json({ persistence: 'ok', active: false, latest: null, synthetic: true });
  });
  app.get('/api/brief/:file/manifest', (req, res) => {
    if (req.params.file === marketingReceipt.filename) return res.json(marketingReceipt);
    const data = buildAppFixture(req.params.file.endsWith('-evidence-inputs.md') ? 'source-revision' : 'normal');
    if (data.brief.inputManifest.status !== 'available') return res.status(404).json({ error: 'Synthetic historical inputs unavailable' });
    res.json({ schemaVersion: 1, synthetic: true, edition: { filename: req.params.file }, evidence: data.evidence });
  });
  app.get('/api/:resource/:file?', (req, res) => {
    const scenario = APP_SCENARIOS.includes(req.query.scenario) ? req.query.scenario : 'normal';
    const resource = req.params.resource;
    if (resource === 'evidence' && scenario === 'evidence-unavailable') return res.status(503).json({ error: 'Synthetic evidence unavailable' });
    if (resource === 'ready' && scenario === 'health-unavailable') return res.status(502).json({ error: 'Synthetic diagnostics unavailable' });
    if (resource === 'settings' && scenario === 'settings-unavailable') return res.status(503).json({ error: 'Synthetic settings unavailable' });
    if (scenario === 'sourceerror' && ['landscape', 'headlines'].includes(resource)) {
      return res.status(503).json({ error: 'Synthetic source refresh unavailable' });
    }
    if (scenario === 'brieferror' && resource === 'brief') {
      return res.status(503).json({ error: 'Synthetic Briefing unavailable' });
    }
    if ((scenario === 'loading' && ['landscape', 'headlines', 'brief'].includes(resource))
      || (scenario === 'health-loading' && resource === 'ready')
      || (scenario === 'settings-loading' && resource === 'settings')) {
      const timer = setTimeout(() => { if (!res.destroyed) res.status(503).json({ error: 'Synthetic loading timeout' }); }, 30_000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const requestedNow = Number(req.query.now);
    const data = buildAppFixture(scenario, Number.isFinite(requestedNow) && requestedNow > 0 ? new Date(requestedNow) : new Date());
    if (resource === 'edition') return res.json({ name: 'BlueTeam.News', regions: {} });
    if (resource === 'evidence' && req.params.file === 'src_' + 'c'.repeat(64)) return res.json({ ...data.evidence, sourceId: req.params.file, source: 'Synthetic independent observer', revisions: [{ ...data.evidence.revisions[1], revisionId: 'rev_' + 'd'.repeat(64), source: 'Synthetic independent observer', title: 'Gateway investigation notes', passage: 'The affected version range remains under investigation by this independent source.' }] });
    if (resource === 'ready') return res.status(data.ready.status === 'degraded' ? 503 : 200).json(
      scenario === 'health-minimal' ? data.ready : { ...data.ready, uptime: process.uptime() });
    if (Object.hasOwn(data, resource)) return res.json(data[resource]);
    return res.status(404).json({ error: 'Unknown synthetic API fixture' });
  });
  // Never route writes to application code: generation, verification, persistence,
  // exports, and outbound requests are intentionally unavailable in this server.
  app.use('/api', (_req, res) => res.status(405).json({ error: 'Read-only synthetic fixture server; no writes or provider calls' }));
  app.use('/fixtures', express.static(fixtureRoot, { etag: false, maxAge: 0 }));
  app.get(/^\/(?:wall|wire|briefing|settings)(?:\/.*)?$/, (_req, res) => {
    const html = readFileSync(join(root, 'public', 'index.html'), 'utf8')
      .replaceAll('{{BOOT}}', 'fixture')
      .replace('<script id="theme-init">', '<script src="/fixtures/app-fixture-controls.js"></script>\n  <script id="theme-init">');
    res.type('html').send(html);
  });
  app.use('/vendor', express.static(join(root, 'public', 'vendor'), { etag: false, maxAge: 0 }));
  app.use(express.static(fixtureRoot, { etag: false, maxAge: 0, index: 'index.html' }));
  app.use(express.static(join(root, 'public'), { etag: false, maxAge: 0, index: false }));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) createFixtureApp().listen(port, '127.0.0.1', () => {
  console.log(`BlueTeam.News visual fixtures: http://127.0.0.1:${port}/`);
  console.log(`Production app with synthetic APIs: http://127.0.0.1:${port}/wall?operator&scenario=long&kind=bluf`);
});

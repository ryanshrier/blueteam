import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(root, 'test', 'visual');
const app = express();
const port = Number(process.env.PORT || 4173);

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
app.use('/vendor', express.static(join(root, 'public', 'vendor'), { etag: false, maxAge: 0 }));
app.use(express.static(fixtureRoot, { etag: false, maxAge: 0, index: 'index.html' }));

app.listen(port, '127.0.0.1', () => {
  console.log(`BlueTeam.News visual fixtures: http://127.0.0.1:${port}/`);
});

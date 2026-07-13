import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(root, 'test', 'visual');
const app = express();
const port = Number(process.env.PORT || 4173);

app.disable('x-powered-by');
app.use('/public', express.static(join(root, 'public'), { etag: false, maxAge: 0 }));
app.use(express.static(fixtureRoot, { etag: false, maxAge: 0, index: 'index.html' }));

app.listen(port, '127.0.0.1', () => {
  console.log(`BlueTeam.News visual fixtures: http://127.0.0.1:${port}/`);
});

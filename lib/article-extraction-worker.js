import { parentPort, workerData } from 'node:worker_threads';
import { extractArticleHtml } from './article-extraction-engine.js';

try {
  parentPort.postMessage({ ok: true, body: extractArticleHtml(workerData.html, workerData.context) });
} catch {
  // Source text and parser diagnostics stay inside the isolated worker.
  parentPort.postMessage({ ok: false });
}

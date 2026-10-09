// Untrusted XML is parsed outside the HTTP event loop, with the worker's heap
// and lifetime constrained by feed-xml.js. Never load application state here.
import { parentPort, workerData } from 'node:worker_threads';
import { XMLParser } from 'fast-xml-parser';

let nodes = 0;
let attributes = 0;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: name => ['item', 'entry'].includes(name),
  processEntities: false,
  trimValues: true,
  maxNestedTags: 64,
  // Full-content research feeds can contain megabytes of escaped HTML in one
  // field. Keep those passages as raw strings instead of building XML children
  // or per-character text ropes. The ingestion layer already clips and strips
  // these exact fields before using them.
  stopNodes: ['..description', '..summary', '..content', '..content:encoded'],
  updateTag(name, _path, attrs) {
    const count = attrs ? Object.keys(attrs).length : 0;
    attributes += count;
    if (++nodes > 20_000 || count > 128 || attributes > 20_000) {
      throw new Error('Feed XML structure limit exceeded');
    }
    return name;
  },
});

function normalizePassages(node) {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (['description', 'summary', 'content', 'content:encoded'].includes(key)) {
      const unwrap = text => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      if (typeof value === 'string') node[key] = unwrap(value);
      else if (typeof value?.['#text'] === 'string') value['#text'] = unwrap(value['#text']);
    }
    if (value && typeof value === 'object') normalizePassages(value);
  }
}

try {
  const parsed = parser.parse(workerData);
  normalizePassages(parsed);
  parentPort.postMessage({ ok: true, parsed });
} catch {
  // Parser diagnostics can quote source content. Expose one stable, safe error.
  parentPort.postMessage({ ok: false });
}

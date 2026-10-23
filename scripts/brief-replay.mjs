import { parseArgs } from 'node:util';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { replayBriefArchive, compareCapturedBriefs } from '../lib/brief-replay.js';
import { sha256 } from '../lib/generation-manifest.js';

const { values } = parseArgs({ options: {
  archive: { type: 'string', default: 'briefs' }, limit: { type: 'string', default: '100' }, output: { type: 'string' },
  baseline: { type: 'string' }, candidate: { type: 'string' }, manifest: { type: 'string' }, expectations: { type: 'string' },
} });
const comparing = ['baseline', 'candidate', 'manifest', 'expectations'].some(key => values[key]);
const boundedRead = (path, maxBytes) => {
  if (statSync(path).size > maxBytes) throw new Error(`Replay input exceeds ${maxBytes} bytes: ${path}`);
  return readFileSync(path, 'utf8');
};
let report;
if (comparing) {
  if (!values.baseline || !values.candidate || !values.manifest) throw new Error('Comparison requires --baseline, --candidate and --manifest');
  const original = boundedRead(resolve(values.baseline), 500000);
  const candidate = boundedRead(resolve(values.candidate), 500000);
  const manifest = JSON.parse(boundedRead(resolve(values.manifest), 8 * 1024 * 1024));
  if (manifest.outputSha256 !== sha256(original)) throw new Error('Captured manifest does not match the baseline copy');
  const expectations = values.expectations ? JSON.parse(boundedRead(resolve(values.expectations), 100000)) : null;
  report = compareCapturedBriefs(original, candidate, manifest, { expectations });
} else report = replayBriefArchive(resolve(values.archive), { limit: Number(values.limit) });
const archive = comparing ? dirname(resolve(values.manifest)) : resolve(values.archive);
if (values.output) {
  const output = resolve(values.output);
  const rel = relative(archive, output);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Replay output must be outside the archive');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Report: ${output}`);
}
console.log(JSON.stringify(comparing ? report.comparison : report.summary, null, 2));
console.log('Read-only replay completed; no provider calls. Findings are diagnostics, not edits or publication decisions.');
if (comparing ? !report.comparison.comparisonChecksPassed
  : report.summary.unreplayable || report.drafts.some(draft => draft.status === 'unreplayable')) process.exitCode = 1;

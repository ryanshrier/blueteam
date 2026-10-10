// Local-only CLI. It reads frozen captures and never collects or calls a provider.
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRankingCaptures, writePrivateJson } from '../lib/ranking-benchmark.js';
import { buildRankingReviewExport, importRankingReview, buildRankingAdjudication, buildRankingSplitTemplate, evaluateRankingBenchmark } from '../lib/ranking-review.js';

const USAGE = `Offline ranking benchmark (all output paths must be new files):
  node scripts/ranking-benchmark.mjs export --captures DIR --out review.json
  node scripts/ranking-benchmark.mjs import --captures DIR --review completed-review.json --out accepted-review.json
  node scripts/ranking-benchmark.mjs adjudication-template --captures DIR --review reviewer-a.json --review reviewer-b.json --out adjudication.json
  node scripts/ranking-benchmark.mjs split-template --captures DIR --out split.json
  node scripts/ranking-benchmark.mjs evaluate --captures DIR --review reviewer-a.json --review reviewer-b.json --adjudication adjudication.json --split split.json --out report.json
Review independently, fill blank annotations locally, then import each review. Adjudication is optional when all reviewed judgments agree.
Use a frozen private copy of the desired capture files: capture retention can otherwise change the dataset while reviewers work.`;
function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Review input must be a regular JSON file under 128 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function runRankingBenchmarkCli(args, { log = console.log } = {}) {
  if (!args.length || args.includes('--help')) { log(USAGE); return; }
  const [command, ...rest] = args, options = { review: [] };
  const allowed = new Set(['captures', 'out', 'review', 'adjudication', 'split']);
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, ''), value = rest[i + 1];
    if (!rest[i]?.startsWith('--') || !allowed.has(name) || !value || value.startsWith('--') || (name !== 'review' && options[name])) throw new Error(USAGE);
    if (name === 'review') options.review.push(value); else options[name] = value;
  }
  if (!options.captures || !options.out) throw new Error(USAGE);
  const captures = readRankingCaptures(resolve(options.captures));
  let output;
  if (command === 'export') output = buildRankingReviewExport(captures);
  else if (command === 'split-template') output = buildRankingSplitTemplate(captures);
  else if (command === 'import' && options.review.length === 1) output = importRankingReview(readJson(options.review[0]), captures);
  else if (command === 'adjudication-template') output = buildRankingAdjudication(captures, options.review.map(readJson));
  else if (command === 'evaluate' && options.split) output = evaluateRankingBenchmark(captures, options.review.map(readJson), {
    adjudication: options.adjudication ? readJson(options.adjudication) : null, split: readJson(options.split) });
  else throw new Error(USAGE);
  writePrivateJson(resolve(options.out), output);
  log(`${output.kind} saved locally; ${captures.length} captured run(s).`);
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runRankingBenchmarkCli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

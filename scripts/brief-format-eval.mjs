// Offline, authored contract/mutation evaluation. Live A/B execution is separate.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { evaluateFormat, evaluateMutations, reviewHtml, evidence } from './lib/brief-format-evaluation.mjs';
import { authoredFormatCandidate } from '../test/fixtures/brief-format-evaluation.js';
import { sha256 } from '../lib/generation-manifest.js';
import { assembleBrief } from '../lib/brief-assembly.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { parseBrief } from '../lib/brief-schema.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('--output is required; choose a new evaluation directory.');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Evaluation output must be a new directory.');
const candidate = authoredFormatCandidate();
const currentPrompt = readFileSync(new URL('../test/fixtures/legacy-brief-prompt.txt', import.meta.url), 'utf8');
const proposedPrompt = readFileSync(new URL('../test/fixtures/brief-format-prompt.txt', import.meta.url), 'utf8');
const count = text => text.trim().split(/\s+/).length;
const versioned = assembleBrief(candidate, { ...evidence, briefFormatVersion: 2 }).content;
const versionedChecks = validateBrief(versioned, '2026-10-30', { ...evidence, briefFormatVersion: 2 });
const report = { schemaVersion: 1, mode: 'offline-authored-format-experiment', evaluatedAt: new Date().toISOString(),
  prompts: { current: { sha256: sha256(currentPrompt), words: count(currentPrompt) }, proposed: { sha256: sha256(proposedPrompt), words: count(proposedPrompt) } },
  candidate: evaluateFormat(candidate), mutations: evaluateMutations(candidate),
  version2: { ...publicationDecision(versionedChecks), readerStories: parseBrief(versioned).stories.length,
    contentSha256: sha256(versioned), checks: versionedChecks } };
report.summary = { authoredChecksPassed: report.candidate.authoredChecksPassed, factAuditTrustBlockers: report.candidate.factAudit.trustBlockers.length,
  mutationCases: report.mutations.length, mutationsDetected: report.mutations.filter(row => row.detected).length,
  productionCompatible: report.candidate.productionCompatibility.canPublish,
  version2ProductionCompatible: report.version2.canPublish, publicationEnabled: false, liveProviderCalls: 0 };
mkdirSync(output, { recursive: true });
for (const [name, text] of [['report.json', JSON.stringify(report, null, 2)], ['candidate.txt', candidate],
  ['current-prompt.txt', currentPrompt], ['proposed-prompt.txt', proposedPrompt], ['version2.txt', versioned],
  ['review.html', reviewHtml('Briefing format experiment — authored reference', [{ label: 'Proposed format reference', text: candidate }], report.summary)]]) {
  writeFileSync(join(output, name), text, { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ output, ...report.summary }, null, 2));
if (!report.summary.authoredChecksPassed || report.summary.factAuditTrustBlockers || !report.summary.version2ProductionCompatible || report.summary.mutationsDetected !== report.summary.mutationCases) process.exitCode = 1;

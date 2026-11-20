// Offline, authored contract/mutation evaluation. Live A/B execution is separate.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { evaluateFormat, evaluateMutations, evaluateEditorialRepair, evaluateFirstDrafts, reviewHtml, evidence } from './lib/brief-format-evaluation.mjs';
import { authoredFormatCandidate } from '../test/fixtures/brief-format-evaluation.js';
import { sha256 } from '../lib/generation-manifest.js';
import { assembleBrief } from '../lib/brief-assembly.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { parseBrief } from '../lib/brief-schema.js';
import { buildNarrativePrompt } from '../lib/brief-narrative-prompt.js';
import { getBrief } from '../lib/domain.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('--output is required; choose a new evaluation directory.');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Evaluation output must be a new directory.');
const candidate = authoredFormatCandidate();
const currentPrompt = readFileSync(new URL('../test/fixtures/legacy-brief-prompt.txt', import.meta.url), 'utf8');
const proposedPrompt = readFileSync(new URL('../test/fixtures/brief-format-prompt.txt', import.meta.url), 'utf8');
const writerPrompt = buildNarrativePrompt(getBrief());
const count = text => text.trim().split(/\s+/).length;
const versioned = assembleBrief(candidate, { ...evidence, briefFormatVersion: 2 }).content;
const versionedChecks = validateBrief(versioned, '2026-10-30', { ...evidence, briefFormatVersion: 2 });
const report = { schemaVersion: 1, mode: 'offline-authored-format-experiment', evaluatedAt: new Date().toISOString(),
  prompts: { current: { sha256: sha256(currentPrompt), words: count(currentPrompt) }, proposed: { sha256: sha256(proposedPrompt), words: count(proposedPrompt) },
    productionNarrative: { sha256: sha256(writerPrompt), words: count(writerPrompt) } },
  candidate: evaluateFormat(candidate), mutations: evaluateMutations(candidate), editorialRepair: evaluateEditorialRepair(candidate),
  firstDrafts: await evaluateFirstDrafts(candidate),
  version2: { ...publicationDecision(versionedChecks), readerStories: parseBrief(versioned).stories.length,
    contentSha256: sha256(versioned), checks: versionedChecks } };
report.summary = { authoredChecksPassed: report.candidate.authoredChecksPassed, factAuditTrustBlockers: report.candidate.factAudit.trustBlockers.length,
  mutationCases: report.mutations.length, mutationsDetected: report.mutations.filter(row => row.detected).length,
  editorialRepairCases: report.editorialRepair.length,
  firstDraftCorrections: report.firstDrafts.filter(row => !row.inputAlreadyMeetsEditorialChecks && row.textMeetsEditorialChecks).length,
  firstDraftDisplayRestorations: report.firstDrafts.filter(row => row.displayRestoresOpeningCondition).length,
  cleanFirstDraftPreserved: report.firstDrafts[0].unchanged && report.firstDrafts[0].canPublish,
  meaningRestored: report.editorialRepair.filter(row => !row.beforePreservation.authoredChecksPassed
    && row.afterPreservation.authoredChecksPassed && row.afterPreservation.canPublish && row.recovery.accepted).length,
  productionCompatible: report.candidate.productionCompatibility.canPublish,
  version2ProductionCompatible: report.version2.canPublish, publicationEnabled: false, liveProviderCalls: 0 };
mkdirSync(output, { recursive: true });
for (const [name, text] of [['report.json', JSON.stringify(report, null, 2)], ['candidate.txt', candidate],
  ['current-prompt.txt', currentPrompt], ['proposed-prompt.txt', proposedPrompt], ['production-narrative-prompt.txt', writerPrompt], ['version2.txt', versioned],
  ['review.html', reviewHtml('Briefing format experiment — authored reference', [{ label: 'Proposed format reference', text: candidate }], report.summary)]]) {
  writeFileSync(join(output, name), text, { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ output, ...report.summary }, null, 2));
if (!report.summary.authoredChecksPassed || report.summary.factAuditTrustBlockers || !report.summary.version2ProductionCompatible || !report.summary.cleanFirstDraftPreserved
  || report.firstDrafts.some(row => ['unsupported-edition-lead','invented-local-compromise'].includes(row.id) && !row.textMeetsEditorialChecks)
  || report.firstDrafts.some(row => row.id === 'execution-condition-buried' && row.missingDisplayAnchors.length)
  || report.summary.mutationsDetected !== report.summary.mutationCases || report.summary.meaningRestored !== report.summary.editorialRepairCases) process.exitCode = 1;

// Offline by default. Explicit live mode uses only the synthetic collection
// and the real generation route, never the operator archive or settings state.
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OPENAI_MODEL } from '../lib/ai-provider.js';
import { parseProviderReplay, MAX_PROVIDER_REPLAY_BYTES } from '../lib/provider-replay.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, 'budget-usd': { type: 'string' },
  output: { type: 'string' }, 'key-file': { type: 'string' },
  provider: { type: 'string', default: 'anthropic' }, model: { type: 'string' },
  'replay-file': { type: 'string' },
} });
if (!['anthropic', 'openai', 'custom'].includes(values.provider)) throw new Error('--provider must be anthropic, openai, or custom.');
if (values.provider === 'custom' && values.live) throw new Error('Custom evaluation is offline only; no local provider module is executed.');
if (values['replay-file'] && (values.live || values.provider !== 'custom' || !values.output)) throw new Error('--replay-file requires offline --provider custom and --output.');
if (values.model !== undefined && (values.provider === 'anthropic' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(values.model))) {
  throw new Error('--model accepts an OpenAI or offline Custom model ID.');
}
let replay;
if (values['replay-file']) {
  if (statSync(values['replay-file']).size > MAX_PROVIDER_REPLAY_BYTES) throw new Error('Provider replay exceeds its size bound.');
  replay = parseProviderReplay(readFileSync(values['replay-file'], 'utf8'));
  if (values.model && values.model !== replay.model) throw new Error('--model must match the replay model.');
}
const model = values.model || replay?.model || (values.provider === 'openai' ? DEFAULT_OPENAI_MODEL : values.provider === 'custom' ? 'custom-replay' : 'claude-sonnet-5');
const budget = Number(values['budget-usd'] || 0);
if (values.live && (!values.output || !Number.isFinite(budget) || budget <= 0 || budget > 5)) {
  throw new Error('Live mode requires --budget-usd (greater than 0, at most 5) and --output.');
}
if (!values.live && values['key-file']) throw new Error('--key-file is only read in explicit --live mode.');
const env = { ...process.env,
  BLUETEAM_EVAL_LIVE: values.live ? 'explicit' : '',
  BLUETEAM_EVAL_BUDGET_USD: String(budget),
  BLUETEAM_EVAL_OUTPUT: values.output ? resolve(values.output) : '',
  BLUETEAM_EVAL_KEY_FILE: values.live && values['key-file'] ? resolve(values['key-file']) : '',
  BLUETEAM_EVAL_PROVIDER: values.provider,
  BLUETEAM_EVAL_MODEL: model,
  BLUETEAM_EVAL_REPLAY_FILE: values['replay-file'] ? resolve(values['replay-file']) : '',
};
console.log(values.live ? `Live synthetic evaluation (${values.provider}, ${model}); conservative standard-rate reservation limit $${budget.toFixed(2)}. No operator archive/database writes.`
  : `Offline ${replay ? 'recorded-output' : 'scripted'} evaluation (${values.provider}, ${model}); no provider calls.`);
const child = spawn(process.execPath, ['--experimental-vm-modules', resolve(root, 'node_modules/jest/bin/jest.js'),
  '--runInBand', '--runTestsByPath', resolve(root, 'test/brief-evaluation.test.js')], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  process.exitCode = signal || code === null ? 1 : code;
  if (!values.output) return;
  try {
    const report = JSON.parse(readFileSync(resolve(values.output, 'evaluation.json'), 'utf8'));
    const unexpected = report.cases.filter(row => row.published !== row.expected.publishable);
    const coverageGaps = report.cases.filter(row => row.expected.publishable && (
      !row.expected.horizons.every(h => row.citedHorizons.includes(h))
      || row.priorityCoverage.some(item => !item.mentioned)
      || row.detailCoverage?.some(item => !item.retained)
      || row.sourceCoverage.some(item => !item.cited)
    ));
    console.log(`${report.cases.length} cases; ${report.cases.filter(row => row.published).length} published; ${unexpected.length} unexpected publication outcomes.`);
    if (values.live || replay) {
      console.log(values.live ? `Usage-based standard-rate estimate: ${report.estimatedProviderCostUsd === null ? 'incomplete' : '$' + report.estimatedProviderCostUsd.toFixed(6)}; conservative reservations: $${report.conservativeReservationUsd.toFixed(6)}.`
        : 'Recorded output only; no new provider calls or charges.');
      console.log(`Authored coverage gaps: ${coverageGaps.map(row => row.id).join(', ') || 'none'}. General semantic correctness still requires review.`);
      if (unexpected.length || coverageGaps.length || !Number.isSafeInteger(report.authoredCollectionCount)
        || report.cases.length !== report.authoredCollectionCount || (values.live && report.estimatedProviderCostUsd === null)
        || report.cases.some(row => row.localPolicyRejections.length || row.blockers?.length || row.requiresReview)) process.exitCode = 1;
    }
    console.log(`Evidence: ${resolve(values.output, 'evaluation.json')}`);
  } catch { console.error('Evaluation report unavailable; inspect the test result.'); process.exitCode = 1; }
});

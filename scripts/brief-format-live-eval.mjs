import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildUserPrompt } from '../lib/prompts.js';
import { runFormatLive } from './lib/brief-format-live.mjs';
import { grounding, evaluateFormat, reviewHtml } from './lib/brief-format-evaluation.mjs';
import { formatEvalHeadlines, FORMAT_EVAL_DATE } from '../test/fixtures/brief-format-evaluation.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { evidence } from './lib/brief-format-evaluation.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, 'budget-usd': { type: 'string' },
  output: { type: 'string' }, 'key-file': { type: 'string' } } });
const budget = Number(values['budget-usd']);
if (!values.live || !values.output || !Number.isFinite(budget) || budget <= 0 || budget > 2) throw new Error('Requires --live, --budget-usd (at most 2), and a new --output directory.');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Output must be new; existing spend ledgers are never overwritten or resumed.');
let key;
if (values['key-file']) {
  if (statSync(values['key-file']).size > 1_000_000) throw new Error('Local settings file exceeds the bound.');
  key = JSON.parse(readFileSync(values['key-file'], 'utf8')).openaiKey;
} else key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('No existing OpenAI key is available.');
const config = { organization: { profile: 'Synthetic evaluation; local deployment and ownership unknown', audience: 'Cyber defenders and security leaders' },
  analysisSettings: { maxSignals: 6, maxPatterns: 1, maxConvergence: 1, continuityDepth: 0 },
  horizons: { 1: { name: 'Tactical' }, 2: { name: 'Operational' }, 3: { name: 'Strategic' } } };
const editionContext = { date: FORMAT_EVAL_DATE, timezone: 'America/Chicago' };
const prompts = { current: readFileSync(new URL('../test/fixtures/legacy-brief-prompt.txt', import.meta.url), 'utf8'),
  proposed: readFileSync(new URL('../test/fixtures/brief-format-prompt.txt', import.meta.url), 'utf8') };
const userPrompt = buildUserPrompt({ headlines: formatEvalHeadlines(), config, groundingManifest: grounding, editionContext })
  + '\n\nCONTROLLED EVALUATION: These sources are synthetic. Cover all six distinct supplied developments so their treatment can be compared. Preserve material uncertainty and source recommendations. Use the format specified by your system instructions; this request does not add owners, dates or a response template.';
mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries(prompts)) writeFileSync(join(output, `${name}-prompt.txt`), value, { flag: 'wx', mode: 0o600 });
writeFileSync(join(output, 'input.txt'), userPrompt, { flag: 'wx', mode: 0o600 });
console.log('Live synthetic A/B evaluation: gpt-6.1-sol; four first attempts; total reservation limit $' + budget.toFixed(2));
let completed = 0;
const report = await runFormatLive({ key, prompts, userPrompt, budget, onUpdate: report => {
  writeFileSync(join(output, 'ledger.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const done = report.attempts.filter(row => row.status !== 'reserved').length;
  if (done > completed) {
    const row = report.attempts.at(-1); completed = done;
    console.log(JSON.stringify({ attempt: row.attempt, arm: row.arm, status: row.status, durationMs: row.durationMs, estimatedCostUsd: row.estimatedCostUsd }));
  }
} });
key = undefined;
const validator = createBriefValidator();
try {
  for (const row of report.attempts) {
    writeFileSync(join(output, `${row.attempt}-${row.arm}-raw.txt`), row.content, { flag: 'wx', mode: 0o600 });
    if (row.status !== 'complete') continue;
    let content = row.content;
    if (row.arm === 'current') {
      const prepared = await validator.prepare(content, FORMAT_EVAL_DATE, evidence, { extractMetadata: true });
      content = prepared.content;
      row.processing = { mode: 'current production preparation', automaticRepairs: prepared.automaticRepairs || [] };
    } else row.processing = { mode: 'experimental raw narrative; no production format adapter' };
    row.evaluation = evaluateFormat(content);
    row.evaluatedContent = content;
    writeFileSync(join(output, `${row.attempt}-${row.arm}.txt`), content, { flag: 'wx', mode: 0o600 });
  }
} finally { await validator.close(); }
report.summary = { completed: report.finished, estimatedCostUsd: report.estimatedCostUsd, conservativeReservationUsd: report.conservativeReservationUsd,
  attempts: report.attempts.map(row => ({ attempt: row.attempt, arm: row.arm, status: row.status,
    words: row.evaluation?.diagnostics.visibleWords, targets: row.evaluation?.diagnostics.prescribedTargetMentions,
    repeatedCveMentions: row.evaluation?.diagnostics.repeatedCveMentions,
    authoredChecksPassed: row.evaluation?.authoredChecksPassed, factAuditTrustBlockers: row.evaluation?.factAudit.trustBlockers.length,
    productionCompatible: row.evaluation?.productionCompatibility.canPublish })) };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
writeFileSync(join(output, 'review.html'), reviewHtml('Briefing format — live OpenAI comparison',
  report.attempts.map(row => ({ label: `Attempt ${row.attempt}: ${row.arm}`, text: row.evaluatedContent || row.content })), report.summary), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, ...report.summary }, null, 2));
if (!report.finished) process.exitCode = 1;

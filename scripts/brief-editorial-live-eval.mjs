// Bounded, retained-input comparison using the production adapter, prompt and
// preparation/validation worker. First attempts only; generation/repair route
// integration is tested separately. Never writes the operator archive/settings.
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createOpenAiClient } from '../lib/ai-provider.js';
import { buildNarrativePrompt } from '../lib/brief-narrative-prompt.js';
import { getBrief } from '../lib/domain.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { validationSourceFromManifest } from '../lib/brief-drafts.js';
import { publicationDecision } from '../lib/validation.js';
import { captureBriefDisplay } from '../lib/brief-display.js';
import { STORY_OPENING_CONTRACT } from '../lib/brief-schema.js';
import { briefPresentation } from '../lib/brief-reading-checks.js';
import { sha256 } from '../lib/generation-manifest.js';
import { evaluateBriefDisplay } from './lib/brief-display-evaluation.mjs';
import { FORMAT_MODEL, FORMAT_RATES, usageCost } from './lib/brief-format-live.mjs';
const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'current-only': { type: 'boolean' }, request: { type: 'string' }, receipt: { type: 'string' },
  output: { type: 'string' }, 'key-file': { type: 'string' }, 'budget-usd': { type: 'string' } } });
const budget = Number(values['budget-usd']);
if (!values.live || !values.request || !values.receipt || !values.output || !(budget > 0 && budget <= 2)) throw new Error('Requires --live, --request, --receipt, a new --output, and --budget-usd (at most 2).');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Output must be new; existing ledgers cannot be overwritten.');
const request = JSON.parse(await readFile(resolve(values.request), 'utf8'));
const receipt = JSON.parse(await readFile(resolve(values.receipt), 'utf8'));
if (request.model !== FORMAT_MODEL || !Array.isArray(request.input) || !request.instructions?.includes('\n\nEDITION AND VOICE\n')
  || !Number.isSafeInteger(request.max_output_tokens) || request.max_output_tokens > 16000) throw new Error('Unsupported retained request.');
const key = values['key-file'] ? JSON.parse(await readFile(resolve(values['key-file']), 'utf8')).openaiKey : process.env.OPENAI_API_KEY;
if (!key) throw new Error('Existing authorized OpenAI key is unavailable.');
const current = buildNarrativePrompt(getBrief()) + request.instructions.slice(request.instructions.indexOf('\n\nEDITION AND VOICE\n'));
await mkdir(output, { recursive: false });
const report = { mode: 'retained-input-first-attempt-comparison', model: FORMAT_MODEL, budgetUsd: budget, pricing: FORMAT_RATES,
  inputSha256: sha256(JSON.stringify(request.input)), order: values['current-only'] ? ['current', 'current'] : ['baseline', 'current', 'current', 'baseline'], attempts: [],
  limits: ['Frozen evidence and edition/voice context; only the narrative prompt changes.',
    'Input compaction is tested separately; both arms receive identical retained input.',
    'Uses production adapter and preparation/checks, not archive publication or corrective retries.',
    'Two runs per arm cannot establish provider parity or general publication success rates.'] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
await save();
const validator = createBriefValidator();
const source = validationSourceFromManifest(receipt);
try {
  for (const arm of report.order) {
    const ordinal = report.attempts.length + 1;
    const params = { model: FORMAT_MODEL, system: arm === 'current' ? current : request.instructions,
      messages: request.input, max_tokens: request.max_output_tokens, reasoning: request.reasoning || { effort: 'low' } };
    const row = { ordinal, arm, promptSha256: sha256(params.system), status: 'preflight' };
    const client = createOpenAiClient(key, FORMAT_MODEL, async (url, options) => {
      if (url !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected evaluation endpoint.');
      const body = JSON.parse(options.body);
      if (body.store !== false || body.model !== FORMAT_MODEL) throw new Error('Unexpected provider controls.');
      const count = await fetch('https://api.openai.com/v1/responses/input_tokens', { method: 'POST', redirect: 'error',
        headers: options.headers, signal: options.signal, body: JSON.stringify({ model: body.model, instructions: body.instructions, input: body.input }) });
      if (!count.ok) throw new Error(`Token preflight failed: HTTP ${count.status}`);
      const tokens = (await count.json()).input_tokens;
      if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error('Invalid token preflight.');
      const bound = Math.ceil(tokens * 1.1) + 4096;
      if (bound > 272000) throw new Error('Input exceeds short-context price reservation.');
      const reserve = (bound * FORMAT_RATES.inputReservation + params.max_tokens * FORMAT_RATES.output) / FORMAT_RATES.perTokens;
      const committed = report.attempts.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? entry.reservationUsd ?? 0), 0);
      if (committed + reserve > budget) throw new Error('Budget exhausted before provider request.');
      Object.assign(row, { status: 'reserved', inputTokens: tokens, reservationUsd: reserve });
      report.attempts.push(row); await save();
      body.service_tier = 'default';
      await writeFile(join(output, `${ordinal}-${arm}-request.json`), JSON.stringify(body));
      return fetch(url, { ...options, body: JSON.stringify(body) });
    });
    let content = '', terminal = false;
    const started = Date.now();
    try {
      for await (const event of client.stream(params, { signal: AbortSignal.timeout(300_000) })) {
        if (event.type === 'content_block_delta') content += event.delta?.text || '';
        if (event.message?.usage) row.usage = event.message.usage;
        if (event.message?.model) row.responseModel = event.message.model;
        if (event.type === 'message_delta') row.stopReason = event.delta.stop_reason;
        if (event.type === 'message_stop') terminal = true;
      }
      row.elapsedMs = Date.now() - started; row.estimatedCostUsd = usageCost(row.usage);
      await writeFile(join(output, `${ordinal}-${arm}-raw.md`), content);
      const prepared = await validator.prepare(content, receipt.edition.date, source, { extractMetadata: true });
      row.decision = publicationDecision({ ...prepared.validation, partial: !terminal || row.stopReason !== 'end_turn' });
      row.status = terminal ? 'complete' : 'incomplete';
      const manifest = { ...receipt, outputSha256: sha256(prepared.content), actionRecords: prepared.actionRecords,
        displayCopy: arm === 'current' ? captureBriefDisplay(prepared.content, source.groundingManifest, STORY_OPENING_CONTRACT) : null,
        publicationValidation: prepared.validation };
      const disposition = { status: row.decision.canPublish ? 'eligible' : 'review-required', eligibleForLatest: row.decision.canPublish };
      const edition = { filename: receipt.filename, content: prepared.content, generatedAt: receipt.generatedAt, disposition,
        presentation: briefPresentation({ original: prepared.content, content: prepared.content, manifest, disposition }),
        inputManifest: { verification: receipt.verification } };
      row.displayEvaluation = evaluateBriefDisplay(prepared.content, manifest, [params]);
      await writeFile(join(output, `${ordinal}-${arm}.md`), prepared.content);
      await writeFile(join(output, `${ordinal}-${arm}-edition.json`), JSON.stringify(edition, null, 2));
    } catch (error) {
      row.status = 'failed'; row.error = error.message;
      if (!report.attempts.includes(row)) report.attempts.push(row);
      process.exitCode = 1;
    }
    await save();
    console.log(JSON.stringify({ ordinal, arm, status: row.status, estimatedCostUsd: row.estimatedCostUsd,
      canPublish: row.decision?.canPublish, displayWords: row.displayEvaluation?.stories.map(story => story.displayWords) }));
    if (row.status === 'failed') break;
  }
} finally { await validator.close(); await save(); }

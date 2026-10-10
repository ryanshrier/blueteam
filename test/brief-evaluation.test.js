// Exercise the production route, prompts, validators, retry policy, receipts,
// and ledger against frozen synthetic inputs. Operator collection/settings,
// archive, database and webhooks are replaced at their external boundaries.
import { jest, test, expect, afterAll } from '@jest/globals';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BRIEF_EVALUATION_CASES, EVAL_DATE, referenceBrief } from './fixtures/brief-evaluation.js';
import { createOpenAiClient, DEFAULT_OPENAI_MODEL } from '../lib/ai-provider.js';

const live = process.env.BLUETEAM_EVAL_LIVE === 'explicit';
const output = process.env.BLUETEAM_EVAL_OUTPUT;
const budget = Number(process.env.BLUETEAM_EVAL_BUDGET_USD || '0');
const selectedProvider = process.env.BLUETEAM_EVAL_PROVIDER || 'anthropic';
const selectedModel = process.env.BLUETEAM_EVAL_MODEL || (selectedProvider === 'openai' ? DEFAULT_OPENAI_MODEL : 'claude-sonnet-5');
if (!['anthropic', 'openai'].includes(selectedProvider)) throw new Error('Unsupported evaluation provider.');
if (selectedProvider === 'openai' ? !/^gpt-/.test(selectedModel) : selectedModel !== 'claude-sonnet-5') throw new Error('Evaluation model does not match the selected provider.');
const metadata = new Map();
let currentCase;
let saved;
let reservedUsd = 0;
let calls = 0;
let acceptedAttempts = [];
let localRejections = [];
let actualClient;
const rows = [];
const config = { organization: { profile: 'Synthetic evaluation', audience: 'Defensive operators' },
  horizons: { 1: { name: 'Tactical' }, 2: { name: 'Operational' }, 3: { name: 'Strategic' } },
  analysisSettings: { preferredModel: 'claude-sonnet-5', model: 'claude-sonnet-5', thinkingEffort: 'low',
    maxTokens: 8000, maxSignals: 3, maxPatterns: 1, maxConvergence: 1, continuityDepth: 0, generationTimeoutSec: 300 } };

jest.unstable_mockModule('../lib/config.js', () => ({ getConfig: () => config, getHorizonName: (_config, h) => `Tier ${h}` }));
jest.unstable_mockModule('../lib/refresher.js', () => ({ getFreshRun: async () => ({ headlines: currentCase.headlines, generatedAt: `${EVAL_DATE}T12:00:00Z`, stats: { enriched: 0 } }) }));
jest.unstable_mockModule('../lib/user-settings.js', () => ({ getEffectiveOrganization: () => config.organization, getEffectiveWatchProfile: () => null }));
jest.unstable_mockModule('../lib/history.js', () => ({
  saveBrief: (_dir, text, options) => { saved = { text, manifest: JSON.parse(JSON.stringify(options.manifest)) }; return `brief-${EVAL_DATE}-01.md`; },
  loadRecentBriefs: () => [], listBriefEditions: () => [], countBriefEditions: () => 0, extractContinuityContext: () => '',
  extractBluf: text => text.slice(0, 200), localDateISO: () => EVAL_DATE,
  scheduledBriefFilename: date => `brief-${date}-00.md`, scheduledBriefJobKey: date => `daily-brief:${date}`,
  briefDateFromFilename: name => /brief-(\d{4}-\d{2}-\d{2})/.exec(name)?.[1] || null,
}));
jest.unstable_mockModule('../lib/db.js', () => ({
  getMeta: key => metadata.get(key) || null, setMeta: (key, value) => metadata.set(key, value),
  saveBriefMeta() {}, getBriefMeta: () => null, indexBrief() {}, searchBriefs: () => [],
  countKEVAddedToday: () => 0, getRecentKEV: () => [], getKEVSet: () => new Set(), getKEVDueDates: () => ({}),
  completeScheduledBriefJob() {}, getScheduledBriefJob: () => null,
}));
jest.unstable_mockModule('../lib/alerts.js', () => ({ dispatchBriefWebhook: async () => {} }));
jest.unstable_mockModule('../lib/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const { createBriefRouter, estimateCostUsd } = await import('../routes/brief.js');
const { buildGroundingManifest } = await import('../lib/grounding.js');
const { validateBrief } = await import('../lib/validation.js');
const { readBriefDraft, validationSourceFromManifest } = await import('../lib/brief-drafts.js');
const quotedPricing = { input: estimateCostUsd(selectedModel, 1000, 0), output: estimateCostUsd(selectedModel, 0, 1000) };
if (Object.values(quotedPricing).some(value => !Number.isFinite(value))) throw new Error('The evaluation model has no known standard-rate estimate; no provider request was made.');
const pricing = Object.fromEntries(Object.entries(quotedPricing).map(([key, value]) => [key, value * 1000]));

if (live) {
  if (!output || !Number.isFinite(budget) || budget <= 0 || budget > 5) throw new Error('Live evaluation requires an output directory and an explicit budget between $0 and $5.');
  let key = process.env[selectedProvider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];
  if (!key && process.env.BLUETEAM_EVAL_KEY_FILE) key = JSON.parse(readFileSync(process.env.BLUETEAM_EVAL_KEY_FILE, 'utf8'))[selectedProvider === 'openai' ? 'openaiKey' : 'anthropicKey'];
  if (!key) throw new Error('No evaluation API key available.');
  if (selectedProvider === 'openai') actualClient = createOpenAiClient(key, selectedModel);
  else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    actualClient = new Anthropic({ apiKey: key, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
  }
}
const historyDir = mkdtempSync(join(tmpdir(), 'blueteam-brief-eval-'));

function reservationFor(params, { model, attempts, usedUsd, budgetUsd }) {
  if (params.model !== model || !Number.isInteger(params.max_tokens) || params.max_tokens < 1 || params.max_tokens > 8000 || attempts >= 2) {
    throw new Error('Evaluation attempt policy rejected the request.');
  }
  // Reserve uncached input and all output, including reasoning. UTF-8 bytes
  // deliberately overestimate normal token counts; reservations are not refunded.
  const inputBound = Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages }), 'utf8') + 4096;
  const reserve = estimateCostUsd(params.model, inputBound, params.max_tokens, undefined, 0, inputBound);
  if (!Number.isFinite(reserve)) throw new Error('Evaluation model has no known cost estimate.');
  if (usedUsd + reserve > budgetUsd) throw new Error('Evaluation budget exhausted before provider request.');
  return reserve;
}

const report = () => ({ schemaVersion: 1, mode: live ? 'live-synthetic' : 'scripted-regression',
  authoredCollectionCount: BRIEF_EVALUATION_CASES.length,
  provider: selectedProvider, model: selectedModel, pricing: { perMillionTokens: pricing, basis: 'Application standard API list-rate estimates' },
  evaluatedAt: new Date().toISOString(), budgetUsd: live ? budget : 0, conservativeReservationUsd: live ? reservedUsd : 0,
  estimatedProviderCostUsd: live ? (rows.length === BRIEF_EVALUATION_CASES.length && rows.every(row => row.usageComplete) ? rows.reduce((sum, row) => sum + (row.costUsd || 0), 0) : null) : 0,
  knownProviderSubtotalUsd: live ? rows.reduce((sum, row) => sum + row.knownAttemptSubtotalUsd, 0) : 0,
  limitations: ['Small authored stress set, not a production success-rate estimate.',
    'Publication checks are not general claim entailment; manual assessment of live drafts remains required.',
    'Coverage counts cited input horizons and priority identifiers; it does not establish judgment usefulness.',
    `Base standard rates are $${pricing.input}/$${pricing.output}; reservations use UTF-8 input bytes plus overhead with any long-context and cache-write premiums. No concurrent attempts, automatic SDK retries, cache discounts in reservations, or premium service tier.`,
    'The output-token allowance includes reasoning tokens; reported usage estimates apply any known cached-input discount.'],
  cases: rows });
function persist() {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'evaluation.json'), JSON.stringify(report(), null, 2) + '\n');
}
afterAll(() => {
  try { persist(); }
  finally { rmSync(historyDir, { recursive: true, force: true }); }
});

async function execute(item, corrective = false, { provider = selectedProvider, model = selectedModel, rejectDraft = false } = {}) {
  currentCase = item; saved = null; calls = 0; acceptedAttempts = []; localRejections = []; metadata.clear();
  const draftText = () => {
    let draft = referenceBrief(item);
    if (rejectDraft || (corrective && calls === 1)) draft = draft.replace('## BLUF', '## MISSING OPENING');
    return draft;
  };
  const scriptedOpenAi = provider === 'openai' && !live ? createOpenAiClient('synthetic-evaluation', model, async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ model, store: false, stream: true, max_output_tokens: 8000, reasoning: { effort: 'low' } });
    expect(body.instructions).toEqual(expect.any(String));
    expect(body.input).toEqual(expect.any(Array));
    const events = [
      { type: 'response.output_text.delta', delta: draftText() },
      { type: 'response.completed', response: { model, status: 'completed', usage: { input_tokens: 100, output_tokens: 200,
        input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 50 } } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }) : null;
  const adapter = live ? actualClient : scriptedOpenAi;
  const client = { provider, model, ...(adapter?.configureRequest ? { configureRequest: adapter.configureRequest } : {}), stream: async (params, options) => {
    if (live) {
      const ordinal = calls + localRejections.length + 1;
      const rejectLocally = reason => { localRejections.push({ attempt: ordinal, reason, providerCalled: false, costUsd: 0 }); throw Object.assign(new Error(reason), { code: 'E_EVAL_BUDGET' }); };
      let reserve;
      try { reserve = reservationFor(params, { model: selectedModel, attempts: calls, usedUsd: reservedUsd, budgetUsd: budget }); }
      catch (error) { rejectLocally(error.message); }
      reservedUsd += reserve; calls++; acceptedAttempts.push(ordinal);
      persist();
      return typeof actualClient.stream === 'function' ? actualClient.stream(params, options) : actualClient.messages.stream(params, options);
    }
    calls++; acceptedAttempts.push(calls);
    if (scriptedOpenAi) return scriptedOpenAi.stream(params, options);
    const draft = draftText();
    return { controller: { abort() {} }, async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { model: params.model, usage: { input_tokens: 100, output_tokens: 0 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: draft } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } };
      yield { type: 'message_stop' };
    } };
  } };
  const app = express(); app.use(express.json());
  app.use('/api', createBriefRouter({ getAiClient: () => client, historyDir, cooldown: { check: () => true } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  let events;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await response.text();
    events = body.split('\n\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  const completion = events.find(event => event.briefComplete);
  const failure = events.findLast(event => event.error);
  const text = saved?.text || failure?.draft || '';
  const rejected = failure?.draftArtifact?.id ? readBriefDraft(historyDir, failure.draftArtifact.id) : null;
  const receipt = saved?.manifest || rejected?.manifest || null;
  const checked = text ? validateBrief(text, EVAL_DATE, receipt ? validationSourceFromManifest(receipt) : { publication: true, groundingManifest: buildGroundingManifest({ headlines: item.headlines }), kevSet: new Set() }) : null;
  const citedIds = new Set(checked?.judgmentEvidence?.flatMap(j => j.sourceIds) || []);
  const grounding = buildGroundingManifest({ headlines: item.headlines });
  const citedHorizons = [...new Set(grounding.members.filter(m => citedIds.has(m.id)).map(m => item.headlines[m.index]?.horizon).filter(Boolean))].sort();
  const ledger = JSON.parse(metadata.get('brief_generation_jobs_v1') || '{"jobs":[]}').jobs.at(-1);
  const providerRecords = (ledger?.attempts || []).filter(attempt => acceptedAttempts.includes(attempt.attempt));
  const knownAttemptSubtotalUsd = providerRecords.filter(attempt => attempt.usageComplete && Number.isFinite(attempt.costUsd)).reduce((sum, attempt) => sum + attempt.costUsd, 0);
  const usageComplete = !calls || Boolean(providerRecords.length === calls && providerRecords.every(attempt => attempt.usageComplete && Number.isFinite(attempt.costUsd)));
  const row = { id: item.id + (corrective ? '-corrective' : '') + (rejectDraft ? '-rejected' : '') + (provider !== selectedProvider ? `-${provider}` : ''), description: item.description,
    provider, model,
    published: Boolean(completion), code: failure?.code || null, providerAttempts: calls,
    recordedAttempts: ledger?.attempts?.length || 0, resets: events.filter(event => event.reset).length,
    providerRecords, localPolicyRejections: [...localRejections],
    usageComplete, knownAttemptSubtotalUsd, costUsd: usageComplete ? knownAttemptSubtotalUsd : null,
    issues: checked?.issues || [], citedHorizons,
    priorityCoverage: item.expected.priorityCves.map(cve => ({ cve, mentioned: text.includes(cve) })),
    detailCoverage: (item.expected.requiredDetails || []).map(detail => ({ detail, retained: text.includes(detail) })),
    sourceCoverage: (item.expected.requiredSourceUrls || []).map(url => ({ url, cited: grounding.members.some(m => m.url === url && citedIds.has(m.id)) })),
    expected: rejectDraft ? { ...item.expected, publishable: false } : item.expected, receipt,
  };
  rows.push(row); persist();
  if (output && text) writeFileSync(resolve(output, `${row.id}.md`), text);
  return row;
}

test.each(BRIEF_EVALUATION_CASES)('$id: $description', async item => {
  const row = await execute(item);
  expect(row.providerAttempts).toBeLessThanOrEqual(2);
  if (item.expected.publishable) {
    // Live failures are findings to inspect, not grounds to keep spending until
    // the model happens to pass. Offline references pin the deterministic path.
    if (!live) {
      expect(row.published).toBe(true);
      expect(row.providerAttempts).toBe(1);
      expect(row.citedHorizons).toEqual(item.expected.horizons);
      expect(row.priorityCoverage.every(item => item.mentioned)).toBe(true);
      expect(row.detailCoverage.every(item => item.retained)).toBe(true);
      expect(row.sourceCoverage.every(item => item.cited)).toBe(true);
    }
  } else {
    expect(row.published).toBe(false);
    expect(row.providerAttempts).toBe(0);
    expect(row.code).toBe('E_EVIDENCE_UNUSABLE');
  }
}, 340_000);

(live ? test.skip : test)('one corrective attempt repairs structure and accounts for both attempts', async () => {
  const row = await execute(BRIEF_EVALUATION_CASES[0], true);
  expect(row.published).toBe(true); expect(row.providerAttempts).toBe(2);
  expect(row.recordedAttempts).toBe(2); expect(row.resets).toBe(1);
  expect(row.receipt.providerAttempts).toHaveLength(2);
  expect(row.receipt.costEstimate.usd).toBeCloseTo(2 * estimateCostUsd(selectedModel, 100, 200, undefined, selectedProvider === 'openai' ? 20 : 0), 8);
});

(live ? test.skip : test).each(BRIEF_EVALUATION_CASES)('other provider adapter: $id', async item => {
  const provider = selectedProvider === 'openai' ? 'anthropic' : 'openai';
  const model = provider === 'openai' ? DEFAULT_OPENAI_MODEL : 'claude-sonnet-5';
  const row = await execute(item, false, { provider, model });
  expect(row.published).toBe(item.expected.publishable);
  expect(row.providerAttempts).toBe(item.expected.publishable ? 1 : 0);
  if (!item.expected.publishable) return;
  expect(row.citedHorizons).toEqual(item.expected.horizons);
  expect(row.priorityCoverage.every(item => item.mentioned)).toBe(true);
  expect(row.detailCoverage.every(item => item.retained)).toBe(true);
  expect(row.sourceCoverage.every(item => item.cited)).toBe(true);
  expect(row.receipt.generationSettings).toMatchObject({ provider, preferredModel: model });
  expect(row.providerRecords[0]).toMatchObject({ model, responseModel: model, usageComplete: true });
  if (provider === 'openai') {
    expect(row.receipt.providerAttempts[0].usage).toEqual({ inputTokens: 100, outputTokens: 200, cachedInputTokens: 20, reasoningTokens: 50 });
    expect(row.costUsd).toBeCloseTo(0.0029435, 9);
  }
});

(live ? test.skip : test)('OpenAI rejection retains final draft checks and captured evidence without publishing', async () => {
  const row = await execute(BRIEF_EVALUATION_CASES[0], false, { provider: 'openai', model: DEFAULT_OPENAI_MODEL, rejectDraft: true });
  expect(row.published).toBe(false);
  expect(row.providerAttempts).toBe(2);
  expect(row.receipt.grounding.sources.length).toBeGreaterThan(0);
  expect(row.receipt.providerAttempts).toHaveLength(2);
  expect(row.issues.some(issue => issue.severity === 'structure')).toBe(true);
  expect(row.usageComplete).toBe(true);
  expect(row.costUsd).toBeCloseTo(0.005887, 9);
});

(live ? test.skip : test)('OpenAI reservation uses the selected model rates and blocks spend before the limit', () => {
  const params = { model: DEFAULT_OPENAI_MODEL, max_tokens: 8000, system: 'Evidence only.', messages: [{ role: 'user', content: 'Synthetic case.' }] };
  const policy = { model: DEFAULT_OPENAI_MODEL, attempts: 0, usedUsd: 0, budgetUsd: 2 };
  const inputBound = Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages }), 'utf8') + 4096;
  const reserve = reservationFor(params, policy);
  expect(reserve).toBeCloseTo(inputBound * 1.75 / 1e6 + 8000 * 14 / 1e6, 12);
  expect(() => reservationFor(params, { ...policy, usedUsd: 2 - reserve / 2 })).toThrow('budget exhausted');
  expect(() => reservationFor(params, { ...policy, attempts: 2 })).toThrow('attempt policy');
  expect(() => reservationFor({ ...params, max_tokens: 8001 }, policy)).toThrow('attempt policy');
  expect(() => reservationFor({ ...params, model: 'unpriced-model' }, { ...policy, model: 'unpriced-model' })).toThrow('no known cost');
});

(live ? test.skip : test)('GPT-6.1 Sol runs the real Responses adapter and reserves long-input cache writes', async () => {
  const model = 'gpt-6.1-sol';
  const row = await execute(BRIEF_EVALUATION_CASES[0], false, { provider: 'openai', model });
  expect(row.published).toBe(true);
  expect(row.receipt.generationSettings).toMatchObject({ provider: 'openai', preferredModel: model, thinkingEffort: 'low' });
  expect(row.costUsd).toBeCloseTo((80 * 2 + 20 * 0.1 + 200 * 10) / 1e6, 9);
  const params = { model, max_tokens: 8000, system: 'x'.repeat(273000), messages: [] };
  const inputBound = Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages }), 'utf8') + 4096;
  expect(reservationFor(params, { model, attempts: 0, usedUsd: 0, budgetUsd: 5 })).toBeCloseTo((inputBound * 5 + 8000 * 15) / 1e6, 9);
});

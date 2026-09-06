// Exercise the production route, prompts, validators, retry policy, receipts,
// and ledger against frozen synthetic inputs. Operator collection/settings,
// archive, database and webhooks are replaced at their external boundaries.
import { jest, test, expect, afterAll } from '@jest/globals';
import express from 'express';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRIEF_EVALUATION_CASES, EVAL_DATE, referenceBrief } from './fixtures/brief-evaluation.js';

const live = process.env.BLUETEAM_EVAL_LIVE === 'explicit';
const output = process.env.BLUETEAM_EVAL_OUTPUT;
const budget = Number(process.env.BLUETEAM_EVAL_BUDGET_USD || '0');
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
  loadRecentBriefs: () => [], listBriefEditions: () => [], extractContinuityContext: () => '',
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
const { createBriefRouter } = await import('../routes/brief.js');
const { buildGroundingManifest } = await import('../lib/grounding.js');
const { validateBrief } = await import('../lib/validation.js');

if (live) {
  if (!output || !Number.isFinite(budget) || budget <= 0 || budget > 5) throw new Error('Live evaluation requires an output directory and an explicit budget between $0 and $5.');
  let key = process.env.ANTHROPIC_API_KEY;
  if (!key && process.env.BLUETEAM_EVAL_KEY_FILE) key = JSON.parse(readFileSync(process.env.BLUETEAM_EVAL_KEY_FILE, 'utf8')).anthropicKey;
  if (!key) throw new Error('No evaluation API key available.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  actualClient = new Anthropic({ apiKey: key, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
}

const report = () => ({ schemaVersion: 1, mode: live ? 'live-synthetic' : 'scripted-regression',
  evaluatedAt: new Date().toISOString(), budgetUsd: live ? budget : 0, conservativeReservationUsd: live ? reservedUsd : 0,
  estimatedProviderCostUsd: live ? (rows.length === BRIEF_EVALUATION_CASES.length && rows.every(row => row.usageComplete) ? rows.reduce((sum, row) => sum + (row.costUsd || 0), 0) : null) : 0,
  knownProviderSubtotalUsd: live ? rows.reduce((sum, row) => sum + row.knownAttemptSubtotalUsd, 0) : 0,
  limitations: ['Small authored stress set, not a production success-rate estimate.',
    'Publication checks are not general claim entailment; manual assessment of live drafts remains required.',
    'Coverage counts cited input horizons and priority identifiers; it does not establish judgment usefulness.',
    'Budget reserves UTF-8 input bytes plus overhead at standard $2/$10 rates; no concurrent attempts, automatic SDK retries, cache or premium tier.'],
  cases: rows });
function persist() {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'evaluation.json'), JSON.stringify(report(), null, 2) + '\n');
}
afterAll(persist);

async function execute(item, corrective = false) {
  currentCase = item; saved = null; calls = 0; acceptedAttempts = []; localRejections = []; metadata.clear();
  const client = { messages: { stream: async (params, options) => {
    if (live) {
      const ordinal = calls + localRejections.length + 1;
      const rejectLocally = reason => { localRejections.push({ attempt: ordinal, reason, providerCalled: false, costUsd: 0 }); throw Object.assign(new Error(reason), { code: 'E_EVAL_BUDGET' }); };
      if (params.model !== 'claude-sonnet-5' || params.max_tokens > 8000 || calls >= 2) rejectLocally('Evaluation attempt policy rejected the request.');
      // A UTF-8-byte bound is deliberately much larger than typical text token
      // counts. Keep the whole reservation even after receiving lower usage.
      const inputBound = Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages }), 'utf8') + 4096;
      const reserve = inputBound * 2 / 1e6 + params.max_tokens * 10 / 1e6;
      if (reservedUsd + reserve > budget) rejectLocally('Evaluation budget exhausted before provider request.');
      reservedUsd += reserve; calls++; acceptedAttempts.push(ordinal);
      persist();
      return actualClient.messages.stream(params, options);
    }
    calls++; acceptedAttempts.push(calls);
    let draft = referenceBrief(item);
    if (corrective && calls === 1) draft = draft.replace('## BLUF', '## MISSING OPENING');
    return { controller: { abort() {} }, async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { model: params.model, usage: { input_tokens: 100, output_tokens: 0 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: draft } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } };
    } };
  } } };
  const app = express(); app.use(express.json());
  app.use('/api', createBriefRouter({ getAnthropic: () => client, historyDir: '/synthetic-no-archive', cooldown: { check: () => true } }));
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
  const checked = text ? validateBrief(text, EVAL_DATE, { publication: true, groundingManifest: buildGroundingManifest({ headlines: item.headlines }), kevSet: new Set() }) : null;
  const citedIds = new Set(checked?.judgmentEvidence?.flatMap(j => j.sourceIds) || []);
  const grounding = buildGroundingManifest({ headlines: item.headlines });
  const citedHorizons = [...new Set(grounding.members.filter(m => citedIds.has(m.id)).map(m => item.headlines[m.index]?.horizon).filter(Boolean))].sort();
  const ledger = JSON.parse(metadata.get('brief_generation_jobs_v1') || '{"jobs":[]}').jobs.at(-1);
  const providerRecords = (ledger?.attempts || []).filter(attempt => acceptedAttempts.includes(attempt.attempt));
  const knownAttemptSubtotalUsd = providerRecords.filter(attempt => attempt.usageComplete && Number.isFinite(attempt.costUsd)).reduce((sum, attempt) => sum + attempt.costUsd, 0);
  const usageComplete = !calls || Boolean(providerRecords.length === calls && providerRecords.every(attempt => attempt.usageComplete && Number.isFinite(attempt.costUsd)));
  const row = { id: item.id + (corrective ? '-corrective' : ''), description: item.description,
    published: Boolean(completion), code: failure?.code || null, providerAttempts: calls,
    recordedAttempts: ledger?.attempts?.length || 0, resets: events.filter(event => event.reset).length,
    providerRecords, localPolicyRejections: [...localRejections],
    usageComplete, knownAttemptSubtotalUsd, costUsd: usageComplete ? knownAttemptSubtotalUsd : null,
    issues: checked?.issues || [], citedHorizons,
    priorityCoverage: item.expected.priorityCves.map(cve => ({ cve, mentioned: text.includes(cve) })),
    sourceCoverage: (item.expected.requiredSourceUrls || []).map(url => ({ url, cited: grounding.members.some(m => m.url === url && citedIds.has(m.id)) })),
    expected: item.expected, receipt: saved?.manifest || null,
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
  expect(row.receipt.costEstimate.usd).toBeCloseTo(0.0044, 8);
});

// Small bounded A/B runner. Synthetic sources only; no application routes, DB,
// archive, settings mutations or webhooks. Production's OpenAI adapter is used.
import { createOpenAiClient } from '../../lib/ai-provider.js';
import { sha256 } from '../../lib/generation-manifest.js';

export const FORMAT_MODEL = 'gpt-6.1-sol';
export const FORMAT_OUTPUT_TOKENS = 8000;
export const FORMAT_RATES = Object.freeze({ input: 2, cachedInput: 0.1, inputReservation: 2.5, output: 10,
  perTokens: 1_000_000, source: 'https://developers.openai.com/api/docs/pricing', verifiedDate: '2026-10-30' });

export function reserveFormatRequest(params, spentReservation, budget) {
  if (params.model !== FORMAT_MODEL || params.max_tokens !== FORMAT_OUTPUT_TOKENS
    || !Number.isFinite(budget) || budget <= 0 || budget > 2) throw new Error('Evaluation model, output allowance or budget is outside the approved bounds.');
  const inputBound = Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages }), 'utf8') + 4096;
  if (inputBound > 200_000) throw new Error('Evaluation exceeds its short-context reservation bound.');
  const reservation = (inputBound * FORMAT_RATES.inputReservation + params.max_tokens * FORMAT_RATES.output) / FORMAT_RATES.perTokens;
  if (spentReservation + reservation > budget) throw new Error('Evaluation budget exhausted before another request.');
  return reservation;
}

export function usageCost(usage) {
  if (!Number.isSafeInteger(usage?.input_tokens) || !Number.isSafeInteger(usage?.output_tokens)) return null;
  const cached = Math.min(usage.input_tokens, usage.input_tokens_details?.cached_tokens || 0);
  const written = Math.min(usage.input_tokens - cached, usage.input_tokens_details?.cache_write_tokens || 0);
  return ((usage.input_tokens - cached - written) * FORMAT_RATES.input + cached * FORMAT_RATES.cachedInput
    + written * FORMAT_RATES.inputReservation + usage.output_tokens * FORMAT_RATES.output) / FORMAT_RATES.perTokens;
}

export async function runFormatLive({ key, prompts, userPrompt, budget, onUpdate = () => {}, fetchImpl = fetch, timeoutMs = 300_000 }) {
  if (!key) throw new Error('An existing OpenAI key is required.');
  const report = { schemaVersion: 1, mode: 'live-synthetic-format-ab', model: FORMAT_MODEL, budgetUsd: budget,
    pricing: FORMAT_RATES, conservativeReservationUsd: 0, attempts: [],
    design: { order: ['current', 'proposed', 'proposed', 'current'], repetitionsPerArm: 2, reasoningEffort: 'low',
      maxOutputTokens: FORMAT_OUTPUT_TOKENS, repairs: 0, tools: false, storage: false, serviceTier: 'default',
      note: 'Same evidence and controls; first attempts only. Four outputs cannot establish production success rates.' } };
  const client = createOpenAiClient(key, FORMAT_MODEL, (url, options) => {
    if (url !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected provider endpoint.');
    const body = JSON.parse(options.body);
    return fetchImpl(url, { ...options, body: JSON.stringify({ ...body, service_tier: 'default' }) });
  });
  for (const arm of report.design.order) {
    const params = { model: FORMAT_MODEL, system: prompts[arm], messages: [{ role: 'user', content: userPrompt }], max_tokens: FORMAT_OUTPUT_TOKENS };
    client.configureRequest(params, { effort: 'low' });
    const reservation = reserveFormatRequest(params, report.conservativeReservationUsd, budget);
    report.conservativeReservationUsd += reservation;
    const row = { attempt: report.attempts.length + 1, arm, promptSha256: sha256(params.system), userPromptSha256: sha256(userPrompt),
      reservationUsd: reservation, status: 'reserved', content: '', usage: null, estimatedCostUsd: null };
    report.attempts.push(row);
    await onUpdate(report);
    const started = performance.now();
    try {
      const stream = client.stream(params, { signal: AbortSignal.timeout(timeoutMs) });
      for await (const event of stream) {
        if (event.type === 'content_block_delta') row.content += event.delta?.text || '';
        if (event.type === 'message_start') {
          if (event.message?.model) row.responseModel = event.message.model;
          if (event.message?.usage) row.usage = event.message.usage;
        }
        if (event.type === 'message_delta') row.stopReason = event.delta?.stop_reason;
        if (event.type === 'message_stop') row.terminal = true;
      }
      row.status = row.terminal && row.stopReason === 'end_turn' ? 'complete' : 'incomplete';
      row.estimatedCostUsd = usageCost(row.usage);
    } catch (error) {
      // Do not retain arbitrary remote error text or credential-bearing objects.
      row.status = 'failed'; row.error = { name: String(error?.name || 'Error'), httpStatus: error?.status || null };
    }
    row.durationMs = Math.round(performance.now() - started);
    row.contentSha256 = sha256(row.content);
    await onUpdate(report);
    if (row.status !== 'complete' || row.estimatedCostUsd === null) break;
  }
  report.estimatedCostUsd = report.attempts.every(row => row.estimatedCostUsd !== null)
    ? report.attempts.reduce((sum, row) => sum + row.estimatedCostUsd, 0) : null;
  report.finished = report.attempts.length === 4 && report.attempts.every(row => row.status === 'complete');
  await onUpdate(report);
  return report;
}

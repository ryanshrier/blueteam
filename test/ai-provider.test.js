import { describe, expect, jest, test } from '@jest/globals';
import { createAiProvider, createOpenAiClient, DEFAULT_OPENAI_MODEL } from '../lib/ai-provider.js';

const openaiKey = ['sk', 'proj', 'fixture-openai-credential'].join('-');
const anthropicKey = ['sk', 'ant', 'fixture-anthropic-credential'].join('-');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const streamResponse = events => new Response(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const params = { model: DEFAULT_OPENAI_MODEL, system: 'Use supplied evidence.', messages: [{ role: 'user', content: 'Brief the team.' }], max_tokens: 16000, reasoning: { effort: 'low' } };
const terminal = (type = 'response.completed', reason) => ({ type, response: { model: DEFAULT_OPENAI_MODEL, status: type.split('.')[1], ...(reason ? { incomplete_details: { reason } } : {}), usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 15 } } } });

describe('live AI provider configuration', () => {
  test('uses environment keys, saved provider/model choices, and switches clients on refresh', () => {
    let settings = { aiProvider: 'openai', openaiKey: 'saved-openai', anthropicKey: 'saved-anthropic', openaiModel: 'gpt-5.3-codex' };
    const factory = jest.fn(key => ({ key }));
    const manager = createAiProvider({ getSettings: () => settings, env: { AI_PROVIDER: 'anthropic', OPENAI_API_KEY: openaiKey, ANTHROPIC_API_KEY: anthropicKey, OPENAI_MODEL: 'env-model' }, anthropicFactory: factory });
    const originalClient = manager.getClient();
    expect(originalClient).toMatchObject({ provider: 'openai', model: DEFAULT_OPENAI_MODEL });
    expect(manager.getStatus()).toMatchObject({ provider: 'openai', enabled: true, source: 'env', providers: { anthropic: { enabled: true }, openai: { enabled: true } } });
    expect(JSON.stringify(manager.getStatus())).not.toContain(openaiKey);
    settings = { ...settings, aiProvider: 'anthropic' };
    manager.refresh();
    expect(manager.getClient()).not.toBe(originalClient);
    expect(factory).toHaveBeenCalledWith(anthropicKey);
    expect(manager.getStatus().provider).toBe('anthropic');
  });

  test.each([
    [{}, 'anthropic', false],
    [{ OPENAI_API_KEY: openaiKey }, 'openai', true],
    [{ OPENAI_API_KEY: openaiKey, ANTHROPIC_API_KEY: anthropicKey }, 'anthropic', true],
    [{ AI_PROVIDER: 'anthropic', OPENAI_API_KEY: openaiKey }, 'anthropic', false],
  ])('selects a default without overriding explicit provider choice: %j', (env, provider, enabled) => {
    const manager = createAiProvider({ getSettings: () => ({}), env, anthropicFactory: () => ({}) });
    expect(manager.getStatus()).toMatchObject({ provider, enabled });
  });

  test('removing a settings key disables the selected provider and preserves the other key', () => {
    let settings = { aiProvider: 'openai', openaiKey, anthropicKey };
    const manager = createAiProvider({ getSettings: () => settings, env: {} });
    settings = { aiProvider: 'openai', anthropicKey };
    manager.refresh();
    expect(manager.getClient()).toBeNull();
    expect(manager.getStatus()).toMatchObject({ provider: 'openai', enabled: false, providers: { anthropic: { enabled: true } } });
  });

  test('never rotates an OpenAI failure onto an Anthropic secondary key', () => {
    let settings = { aiProvider: 'openai', openaiKey, anthropicKey };
    const manager = createAiProvider({ getSettings: () => settings, env: { ANTHROPIC_API_KEY_SECONDARY: 'secondary' }, anthropicFactory: key => ({ key }) });
    expect(manager.rotateKey('openai')).toBeNull();
    settings = { ...settings, aiProvider: 'anthropic' };
    manager.refresh();
    expect(manager.rotateKey('anthropic')).toEqual({ key: 'secondary' });
    expect(manager.rotateKey('anthropic')).toBeNull();
    expect(manager.getStatus()).toMatchObject({ source: 'env:secondary', rotated: true });
  });
});

describe('provider verification', () => {
  test('checks an unsaved OpenAI key and model with a minimal Responses request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const manager = createAiProvider({ getSettings: () => ({}), env: {}, fetchImpl });
    await expect(manager.verifyKey(openaiKey, 'openai', 'gpt-5.3-codex')).resolves.toEqual({ valid: true });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${openaiKey}` }, signal: expect.any(AbortSignal) });
    expect(JSON.parse(options.body)).toMatchObject({ model: DEFAULT_OPENAI_MODEL, store: false, stream: false, max_output_tokens: 16 });
    expect(manager.getStatus().enabled).toBe(false);
  });

  test.each([
    [401, 'invalid_api_key', false, /rejected/],
    [403, 'permission_denied', false, /permissions/],
    [429, 'insufficient_quota', null, /quota/],
    [429, 'rate_limit_exceeded', null, /rate-limiting/],
    [404, 'model_not_found', null, /model/],
    [400, 'invalid_request_error', null, /model/],
    [503, 'server_error', null, /Could not verify/],
  ])('does not report a failed API request as working (%i %s)', async (status, code, valid, message) => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: { code, message: `Key ${openaiKey}` } }, status));
    const manager = createAiProvider({ getSettings: () => ({ openaiKey }), env: {}, fetchImpl });
    const result = await manager.verifyKey(undefined, 'openai');
    expect(result).toEqual({ valid, error: expect.stringMatching(message) });
    expect(JSON.stringify(result)).not.toContain(openaiKey);
  });

  test('rejects provider-mismatched keys before sending a request', async () => {
    const fetchImpl = jest.fn();
    const manager = createAiProvider({ getSettings: () => ({}), env: {}, fetchImpl });
    expect((await manager.verifyKey(anthropicKey, 'openai')).valid).toBe(false);
    expect((await manager.verifyKey(openaiKey, 'anthropic')).valid).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('OpenAI Responses streaming', () => {
  test('preserves UTF-8 and split SSE frames, ignores reasoning text, and records final usage', async () => {
    const events = [{ type: 'response.reasoning_summary_text.delta', delta: 'Private reasoning' }, { type: 'response.output_text.delta', delta: 'Threat — résumé' }, terminal()];
    const encoded = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    let cursor = 0;
    const response = new Response(new ReadableStream({ pull(controller) { if (cursor === encoded.length) controller.close(); else controller.enqueue(encoded.slice(cursor, ++cursor)); } }));
    const fetchImpl = jest.fn().mockResolvedValue(response);
    const client = createOpenAiClient(openaiKey, DEFAULT_OPENAI_MODEL, fetchImpl);
    const result = await Array.fromAsync(client.stream(params, {}));
    expect(result.filter(event => event.delta?.text).map(event => event.delta.text).join('')).toBe('Threat — résumé');
    expect(result.find(event => event.message?.usage).message.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 } });
    expect(result.at(-1).delta.stop_reason).toBe('end_turn');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ model: DEFAULT_OPENAI_MODEL, instructions: params.system, input: params.messages, max_output_tokens: 16000, reasoning: { effort: 'low' }, store: false, stream: true });
  });

  test.each([['max_output_tokens', 'max_tokens'], ['content_filter', 'refusal']])('maps incomplete %s to the publication gate', async (reason, expected) => {
    const client = createOpenAiClient(openaiKey, DEFAULT_OPENAI_MODEL, async () => streamResponse([terminal('response.incomplete', reason)]));
    expect((await Array.fromAsync(client.stream(params, {}))).at(-1).delta.stop_reason).toBe(expected);
  });

  test('captures refusals in a completed response', async () => {
    const client = createOpenAiClient(openaiKey, DEFAULT_OPENAI_MODEL, async () => streamResponse([{ type: 'response.refusal.delta', delta: 'Cannot assist.' }, terminal()]));
    expect((await Array.fromAsync(client.stream(params, {}))).at(-1).delta.stop_reason).toBe('refusal');
  });

  test.each([
    [[{ type: 'response.output_text.delta', delta: 'Partial draft' }], /ended before completion/],
    [[terminal('response.incomplete', 'unknown_reason')], /incomplete/],
    [[{ type: 'response.failed', response: { error: { message: 'Model failed' } } }], /Model failed/],
    [[{ type: 'error', message: 'API error', code: 'server_error' }], /API error/],
  ])('propagates unfinished and failed streams', async (events, message) => {
    const client = createOpenAiClient(openaiKey, DEFAULT_OPENAI_MODEL, async () => streamResponse(events));
    await expect(Array.fromAsync(client.stream(params, {}))).rejects.toThrow(message);
  });
});

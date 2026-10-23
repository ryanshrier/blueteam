import { describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiProvider, createAnthropicClient, createOpenAiClient, configureAnthropicRequest,
  providerCapabilities, PROVIDER_CONTRACT_VERSION, DEFAULT_OPENAI_MODEL, loadProviderModule } from '../lib/ai-provider.js';

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
    expect(manager.rotateKey('anthropic')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', stream: expect.any(Function) });
    expect(manager.rotateKey('anthropic')).toBeNull();
    expect(manager.getStatus()).toMatchObject({ source: 'env:secondary', rotated: true });
  });
});

describe('explicit provider controls', () => {
  test('native Anthropic preserves the complete request and normalized SDK events', async () => {
    const events = [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Final report <!-- briefing-metadata {} -->' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
      { type: 'message_stop' },
    ];
    const stream = jest.fn(async function* () { yield* events; });
    const client = createAnthropicClient({ messages: { stream } });
    const request = { model: client.model, system: 'Authoritative system instructions.', max_tokens: 1234,
      messages: [{ role: 'user', content: 'Captured facts.' }, { role: 'assistant', content: 'Previous draft.' }, { role: 'user', content: 'Repair the identified citation.' }] };
    client.configureRequest(request, { effort: 'low' });
    const options = { signal: new AbortController().signal, timeout: 30000, maxRetries: 0 };
    expect(await Array.fromAsync(client.stream(request, options))).toEqual(events);
    expect(stream).toHaveBeenCalledWith(request, options);
    expect(request).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(client.contractVersion).toBe(PROVIDER_CONTRACT_VERSION);
    expect(providerCapabilities(client)).toEqual({ systemPrompt: true, conversation: true,
      outputTokenLimit: true, reasoningEffort: true, cancellation: true, externalTools: false });
  });

  test('Anthropic recovery and fallback configure supported fields through the same hook', () => {
    const request = { model: 'claude-sonnet-5', reasoning: { effort: 'high' } };
    configureAnthropicRequest(request, { effort: 'high' });
    expect(request).toEqual({ model: 'claude-sonnet-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    configureAnthropicRequest(request, { effort: 'off' });
    expect(request).toEqual({ model: 'claude-sonnet-5', thinking: { type: 'disabled' } });
    request.model = 'claude-haiku-4-5';
    configureAnthropicRequest(request, { effort: 'low' });
    expect(request).toEqual({ model: 'claude-haiku-4-5' });
  });

  test('manager carries native model selection and one-shot key rotation into explicit adapters', () => {
    const factory = jest.fn(key => ({ messages: { stream: jest.fn(() => key) } }));
    const manager = createAiProvider({ getSettings: () => ({ aiProvider: 'anthropic' }),
      getAnalysisSettings: () => ({ preferredModel: 'claude-opus-4-7', model: 'claude-haiku-4-5' }),
      env: { ANTHROPIC_API_KEY: anthropicKey, ANTHROPIC_API_KEY_SECONDARY: 'secondary' }, anthropicFactory: factory });
    const first = manager.getClient();
    expect(first).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-7', fallbackModel: 'claude-haiku-4-5' });
    expect(first.stream({}, {})).toBe(anthropicKey);
    const second = first.rotateKey();
    expect(second.stream({}, {})).toBe('secondary');
    expect(second.rotateKey()).toBeNull();
    expect(manager.getClient()).toBe(second);
  });

  test('native model choices follow hot-reloaded analysis settings without resetting the SDK or key rotation', () => {
    let analysis = { preferredModel: 'claude-sonnet-5', model: 'claude-haiku-4-5' };
    const factory = jest.fn(() => ({ messages: { stream: jest.fn() } }));
    const manager = createAiProvider({ getSettings: () => ({ aiProvider: 'anthropic' }), getAnalysisSettings: () => analysis,
      env: { ANTHROPIC_API_KEY: anthropicKey, ANTHROPIC_API_KEY_SECONDARY: 'secondary' }, anthropicFactory: factory });
    const client = manager.getClient().rotateKey();
    analysis = { preferredModel: 'claude-haiku-4-5', model: 'claude-opus-4-7' };
    expect(client).toMatchObject({ model: 'claude-haiku-4-5', fallbackModel: 'claude-opus-4-7' });
    expect(providerCapabilities(client).reasoningEffort).toBe(false);
    expect(manager.getClient()).toBe(client);
    expect(client.rotateKey()).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('undeclared custom capabilities remain unknown and unrecognized fields are not retained', () => {
    expect(Object.values(providerCapabilities({}))).toEqual(Array(6).fill(null));
    expect(providerCapabilities({ capabilities: { conversation: true, reasoningEffort: false,
      cancellation: 'yes', secret: 'private' } })).toEqual({ systemPrompt: null, conversation: true,
      outputTokenLimit: null, reasoningEffort: false, cancellation: null, externalTools: null });
    expect(providerCapabilities(createOpenAiClient(openaiKey, 'gpt-4.1')).reasoningEffort).toBe(false);
    expect(providerCapabilities(createAnthropicClient({}), 'claude-haiku-4-5').reasoningEffort).toBe(false);
    expect(providerCapabilities(createOpenAiClient(openaiKey), 'gpt-4.1').reasoningEffort).toBe(false);
  });
});

describe('provider verification', () => {
  test.each(['gpt-5.3-codex', 'gpt-6.1-sol'])('checks an unsaved OpenAI key with model %s', async model => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const manager = createAiProvider({ getSettings: () => ({}), env: {}, fetchImpl });
    await expect(manager.verifyKey(openaiKey, 'openai', model)).resolves.toEqual({ valid: true });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${openaiKey}` }, signal: expect.any(AbortSignal) });
    expect(JSON.parse(options.body)).toMatchObject({ model, store: false, stream: false, max_output_tokens: 16, reasoning: { effort: 'low' } });
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

describe('local provider module', () => {
  test('loads a module relative to the application directory and requires its factory export', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'blueteam-provider-'));
    try {
      writeFileSync(join(directory, 'provider.mjs'), 'export function createClient(env) { return { provider: "local-example", model: env.LOCAL_MODEL, stream: async function* () {} }; }');
      writeFileSync(join(directory, 'invalid.mjs'), 'export const version = "1.0";');
      const env = { AI_PROVIDER_MODULE: './provider.mjs', LOCAL_MODEL: 'fixture-model' };
      const providerModule = await loadProviderModule(env, directory);
      const manager = createAiProvider({ getSettings: () => ({}), env, providerModule });
      expect(manager.getClient()).toMatchObject({ provider: 'local-example', model: 'fixture-model' });
      expect(manager.getStatus()).toMatchObject({ provider: 'custom', enabled: true, source: 'env', masked: null });
      await expect(loadProviderModule({ AI_PROVIDER_MODULE: './invalid.mjs' }, directory)).rejects.toThrow('export createClient(env)');
      await expect(loadProviderModule({}, directory)).resolves.toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('passes only environment credentials and checks health without streaming', async () => {
    const env = { AI_PROVIDER: 'custom', LOCAL_TOKEN: 'private-fixture-token' };
    const custom = { provider: 'example', model: 'example-model', version: '2.0', stream: jest.fn(),
      health: jest.fn(function({ signal }) { expect(signal).toBeInstanceOf(AbortSignal); return { valid: true, version: this.version, note: 'Ready', unexpected: env.LOCAL_TOKEN }; }) };
    const createClient = jest.fn(() => custom);
    const manager = createAiProvider({ getSettings: () => ({ openaiKey, anthropicKey }), env, providerModule: { createClient } });
    expect(createClient).toHaveBeenCalledWith(env);
    expect(manager.getStatus()).toMatchObject({ provider: 'custom', enabled: true, version: '2.0' });
    await expect(manager.verifyKey('ignored-candidate', 'custom')).resolves.toEqual({ valid: true, version: '2.0', note: 'Ready' });
    expect(custom.stream).not.toHaveBeenCalled();
    expect(manager.rotateKey('example')).toBeNull();
  });

  test('retains safe health failure reasons and redacts environment credentials', async () => {
    const env = { AI_PROVIDER: 'custom', LOCAL_TOKEN: 'private-fixture-token' };
    const manager = createAiProvider({ getSettings: () => ({}), env, providerModule: { createClient: () => ({
      provider: 'example', model: 'fixture-model', stream: jest.fn(), health: () => { throw { reason: `gateway timeout (524); ${env.LOCAL_TOKEN}` }; },
    }) } });
    await expect(manager.verifyKey('', 'custom')).resolves.toEqual({ valid: null, error: 'gateway timeout (524); [REDACTED]' });
  });

  test('does not claim verified health without a hook and disables malformed clients', async () => {
    const env = { AI_PROVIDER: 'custom' };
    const noHook = createAiProvider({ getSettings: () => ({}), env, providerModule: { createClient: () => ({ provider: 'example', model: 'fixture-model', version: '1.0', stream: jest.fn() }) } });
    await expect(noHook.verifyKey('', 'custom')).resolves.toEqual({ valid: null, note: 'Local module loaded (1.0); no health hook is available.' });
    const malformed = createAiProvider({ getSettings: () => ({}), env, providerModule: { createClient: () => ({ provider: 'example' }) } });
    expect(malformed.getClient()).toBeNull();
    await expect(malformed.verifyKey('', 'custom')).resolves.toEqual({ valid: false, error: 'createClient(env) must return { provider, model, stream }.' });
    const missing = createAiProvider({ getSettings: () => ({}), env });
    await expect(missing.verifyKey('', 'custom')).resolves.toMatchObject({ valid: false, error: expect.stringContaining('AI_PROVIDER_MODULE') });
  });

  test('bounds a health hook that ignores cancellation', async () => {
    jest.useFakeTimers();
    try {
      const health = jest.fn(() => new Promise(() => {}));
      const manager = createAiProvider({ getSettings: () => ({}), env: { AI_PROVIDER: 'custom' }, providerModule: { createClient: () => ({ provider: 'example', model: 'fixture-model', stream: jest.fn(), health }) } });
      const verification = manager.verifyKey('', 'custom');
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(verification).resolves.toEqual({ valid: null, error: 'Provider health check timed out.' });
      expect(health.mock.calls[0][0].signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

describe('CLI provider selection', () => {
  const makeClient = () => ({ provider: 'cli', model: 'fixture-model', version: '1.0', contractVersion: 1,
    profileIdentity: { id: 'fixture', version: '1', sha256: 'a'.repeat(64) }, stream: jest.fn(),
    health: jest.fn(async () => ({ valid: null, note: 'CLI installed; authentication and generation readiness are unverified.' })) });

  test('loads the trusted profile once, selects CLI without native keys, and preserves saved selection precedence', async () => {
    let settings = {};
    const env = { AI_CLI_PROFILE: './trusted.json', ASSISTANT_API_KEY: 'fixture-private-key' };
    const cli = makeClient();
    const cliFactory = jest.fn(() => cli);
    const manager = createAiProvider({ getSettings: () => settings, env, cliFactory, cwd: '/application' });
    expect(cliFactory).toHaveBeenCalledWith(env, '/application');
    expect(manager.getClient()).toBe(cli);
    expect(manager.getStatus()).toMatchObject({ provider: 'cli', enabled: true, source: 'env', masked: null,
      profileIdentity: cli.profileIdentity });
    expect(JSON.stringify(manager.getStatus())).not.toContain(env.ASSISTANT_API_KEY);
    settings = { aiProvider: 'anthropic', anthropicKey };
    manager.refresh();
    expect(manager.getStatus().provider).toBe('anthropic');
    env.AI_CLI_PROFILE = './changed.json';
    settings = { aiProvider: 'cli' };
    manager.refresh();
    expect(manager.getClient()).toBe(cli);
    expect(cliFactory).toHaveBeenCalledTimes(1);
    await expect(manager.verifyKey('ignored-key', 'cli')).resolves.toMatchObject({ valid: null, note: expect.stringContaining('unverified') });
    expect(cli.stream).not.toHaveBeenCalled();
    expect(manager.rotateKey('cli')).toBeNull();
  });

  test('explicit CLI without a configured profile stays disabled and explains restart setup', async () => {
    const manager = createAiProvider({ getSettings: () => ({}), env: { AI_PROVIDER: 'cli' }, cliFactory: () => null });
    expect(manager.getClient()).toBeNull();
    expect(manager.getStatus()).toMatchObject({ provider: 'cli', enabled: false, source: null, masked: null });
    await expect(manager.verifyKey('', 'cli')).resolves.toEqual({ valid: false, error: 'Set AI_CLI_PROFILE and restart to load a CLI profile.' });
  });

  test('profile failures remain disabled, redact environment credentials, and do not reload through Settings', async () => {
    const env = { AI_PROVIDER: 'cli', AI_CLI_PROFILE: './invalid.json', ASSISTANT_TOKEN: 'fixture-private-token' };
    const cliFactory = jest.fn(() => { throw new Error(`Invalid profile: ${env.ASSISTANT_TOKEN}`); });
    const manager = createAiProvider({ getSettings: () => ({}), env, cliFactory });
    manager.refresh();
    expect(cliFactory).toHaveBeenCalledTimes(1);
    expect(manager.getClient()).toBeNull();
    expect(manager.getStatus()).toMatchObject({ provider: 'cli', source: 'env', error: 'Invalid profile: [REDACTED]' });
    await expect(manager.verifyKey('', 'cli')).resolves.toEqual({ valid: false, error: 'Invalid profile: [REDACTED]' });
  });

  test('an installation check never asserts authenticated readiness', async () => {
    const cli = makeClient();
    cli.health.mockResolvedValue({ valid: true, version: '2.0' });
    const manager = createAiProvider({ getSettings: () => ({ aiProvider: 'cli' }), env: {}, cliFactory: () => cli });
    await expect(manager.verifyKey('', 'cli')).resolves.toEqual({ valid: null, version: '2.0' });
  });
});

describe('OpenAI Responses streaming', () => {
  test.each(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('configures GPT-6.1 Sol reasoning effort %s', effort => {
    const client = createOpenAiClient(openaiKey, 'gpt-6.1-sol');
    const request = { model: 'gpt-6.1-sol', thinking: {}, output_config: {} };
    client.configureRequest(request, { effort });
    expect(request).toEqual({ model: 'gpt-6.1-sol', reasoning: { effort: ['off', 'none', 'minimal'].includes(effort) ? 'low' : effort } });
  });
  test('configures its own reasoning parameters without generator provider checks', () => {
    const client = createOpenAiClient(openaiKey);
    const request = { model: DEFAULT_OPENAI_MODEL, thinking: {}, output_config: {} };
    client.configureRequest(request, { effort: 'off' });
    expect(request).toEqual({ model: DEFAULT_OPENAI_MODEL, reasoning: { effort: 'low' } });
    client.configureRequest(request, { effort: 'none' });
    expect(request.reasoning).toEqual({ effort: 'none' });
    request.model = 'gpt-4.1';
    client.configureRequest(request, { effort: 'high' });
    expect(request).toEqual({ model: 'gpt-4.1' });
  });
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
    expect(result.at(-2).delta.stop_reason).toBe('end_turn');
    expect(result.at(-1)).toEqual({ type: 'message_stop' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ model: DEFAULT_OPENAI_MODEL, instructions: params.system, input: params.messages, max_output_tokens: 16000, reasoning: { effort: 'low' }, store: false, stream: true });
  });

  test.each([['max_output_tokens', 'max_tokens'], ['content_filter', 'refusal']])('maps incomplete %s to the publication gate', async (reason, expected) => {
    const client = createOpenAiClient(openaiKey, DEFAULT_OPENAI_MODEL, async () => streamResponse([terminal('response.incomplete', reason)]));
    expect((await Array.fromAsync(client.stream(params, {}))).at(-2).delta.stop_reason).toBe(expected);
  });

  test('captures refusals in a completed response', async () => {
    const client = createOpenAiClient(openaiKey, DEFAULT_OPENAI_MODEL, async () => streamResponse([{ type: 'response.refusal.delta', delta: 'Cannot assist.' }, terminal()]));
    expect((await Array.fromAsync(client.stream(params, {}))).at(-2).delta.stop_reason).toBe('refusal');
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

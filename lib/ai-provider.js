import Anthropic from '@anthropic-ai/sdk';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.3-codex';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const supportsReasoning = model => /^gpt-5(?:\.|-)|^gpt-6\.1-sol(?:$|-)/.test(model || '');

// Only the operator's environment chooses executable code; Settings never does.
export async function loadProviderModule(env = process.env, cwd = process.cwd()) {
  if (!env.AI_PROVIDER_MODULE) return null;
  const module = await import(pathToFileURL(resolve(cwd, env.AI_PROVIDER_MODULE)).href);
  if (typeof module.createClient !== 'function') throw new Error('AI_PROVIDER_MODULE must export createClient(env).');
  return module;
}

function maskKey(key) {
  return key ? (key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : 'sk-…') : null;
}

function providerError(error, status) {
  const code = error?.code;
  const message = code === 'insufficient_quota'
    ? 'OpenAI API quota is exhausted. Check API billing and project limits.'
    : `OpenAI API request failed${status ? ` (HTTP ${status})` : ''}. ${String(error?.message || 'Try again shortly.').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300)}`;
  return Object.assign(new Error(message), { status, code });
}

function responseParams(params, stream) {
  return {
    model: params.model,
    instructions: params.system,
    input: params.messages,
    max_output_tokens: params.max_tokens,
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    store: false,
    stream,
  };
}

async function requestOpenAi(key, params, { signal, fetchImpl, stream }) {
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(responseParams(params, stream)),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw providerError(body?.error, response.status);
  }
  return response;
}

// Translate Responses events into the brief generator's existing text/usage
// contract. A missing terminal event is an interrupted draft, never success.
async function* openAiStream(key, params, { signal, fetchImpl }) {
  const response = await requestOpenAi(key, params, { signal, fetchImpl, stream: true });
  if (!response.body) throw new Error('OpenAI returned no response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let refused = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw new Error('OpenAI stream event exceeded the size limit');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); }
        catch { throw new Error('OpenAI returned an invalid stream event'); }
        if (event.response?.model || event.response?.usage) {
          yield { type: 'message_start', message: { model: event.response.model, usage: event.response.usage } };
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          yield { type: 'content_block_delta', delta: { text: event.delta } };
        }
        if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') refused = true;
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          refused ||= event.response?.output?.some(item => item.content?.some(part => part.type === 'refusal')) === true;
          const reason = event.response?.incomplete_details?.reason;
          const stopReason = refused || reason === 'content_filter' ? 'refusal'
            : reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
          if (event.type === 'response.incomplete' && stopReason === 'end_turn') {
            throw new Error('OpenAI returned an incomplete response');
          }
          yield { type: 'message_delta', delta: { stop_reason: stopReason } };
          yield { type: 'message_stop' };
          return;
        }
        if (event.type === 'error' || event.type === 'response.failed') {
          throw providerError(event.response?.error || event.error || event, event.status);
        }
      }
      if (done) throw new Error('OpenAI stream ended before completion');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createOpenAiClient(key, model = DEFAULT_OPENAI_MODEL, fetchImpl = (...args) => fetch(...args)) {
  return { provider: 'openai', model,
    configureRequest(params, { effort }) {
      delete params.thinking;
      delete params.output_config;
      if (supportsReasoning(params.model)) params.reasoning = { effort: effort === 'off'
        || (/^gpt-6\.1-sol(?:$|-)/.test(params.model || '') && ['none', 'minimal'].includes(effort)) ? 'low' : (effort || 'low') };
      else delete params.reasoning;
    },
    stream: (params, options) => openAiStream(key, params, { ...options, fetchImpl }) };
}

// Keys retain environment precedence. Provider/model settings override their
// environment defaults so an operator can switch the active provider live.
export function createAiProvider({ getSettings, getAnalysisSettings = () => ({}), env = process.env,
  providerModule = null, anthropicFactory = key => new Anthropic({ apiKey: key }), fetchImpl = (...args) => fetch(...args) }) {
  let client = null;
  let customClient = null;
  let providers = {};
  let provider = 'anthropic';
  function publicDetail(value) {
    let detail = String(value || '').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
    for (const [name, secret] of Object.entries(env)) {
      if (/key|token|secret|password/i.test(name) && typeof secret === 'string' && secret.length >= 4) detail = detail.split(secret).join('[REDACTED]');
    }
    return detail.slice(0, 300);
  }
  function configuration() {
    const settings = getSettings();
    const anthropicEnv = env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_PRIMARY;
    const keys = { anthropic: anthropicEnv || settings.anthropicKey || null, openai: env.OPENAI_API_KEY || settings.openaiKey || null };
    const selected = settings.aiProvider || env.AI_PROVIDER;
    return { keys, provider: ['anthropic', 'openai', 'custom'].includes(selected) ? selected : (env.AI_PROVIDER_MODULE ? 'custom' : keys.openai && !keys.anthropic ? 'openai' : 'anthropic'),
      models: { anthropic: getAnalysisSettings().preferredModel || 'claude-sonnet-5', openai: settings.openaiModel || env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL },
      sources: { anthropic: anthropicEnv ? 'env' : keys.anthropic ? 'settings' : null, openai: env.OPENAI_API_KEY ? 'env' : keys.openai ? 'settings' : null } };
  }
  function refresh() {
    const config = configuration();
    provider = config.provider;
    providers = Object.fromEntries(['anthropic', 'openai'].map(name => [name, {
      enabled: Boolean(config.keys[name]), source: config.sources[name], masked: maskKey(config.keys[name]), rotated: false, model: config.models[name],
    }]));
    customClient = null;
    providers.custom = { enabled: false, source: providerModule ? 'env' : null, masked: null, rotated: false };
    if (providerModule) {
      try {
        const custom = providerModule.createClient(env);
        if (!custom || typeof custom.provider !== 'string' || !custom.provider.trim() || typeof custom.model !== 'string' || !custom.model.trim() || typeof custom.stream !== 'function') {
          throw new Error('createClient(env) must return { provider, model, stream }.');
        }
        customClient = custom;
        Object.assign(providers.custom, { enabled: true, model: custom.model, version: publicDetail(custom.version) || undefined });
      } catch (err) { providers.custom.error = publicDetail(err?.reason || err?.message) || 'Local provider initialization failed.'; }
    }
    client = provider === 'custom' ? customClient : !config.keys[provider] ? null : provider === 'openai'
      ? createOpenAiClient(config.keys.openai, config.models.openai, fetchImpl)
      : anthropicFactory(config.keys.anthropic);
    return client;
  }
  function rotateKey(expectedProvider = provider) {
    if (expectedProvider !== 'anthropic' || provider !== 'anthropic' || !env.ANTHROPIC_API_KEY_SECONDARY || providers.anthropic.rotated) return null;
    client = anthropicFactory(env.ANTHROPIC_API_KEY_SECONDARY);
    providers.anthropic = { ...providers.anthropic, enabled: true, source: 'env:secondary', masked: maskKey(env.ANTHROPIC_API_KEY_SECONDARY), rotated: true };
    return client;
  }
  async function verifyKey(candidate, selectedProvider = provider, selectedModel) {
    if (selectedProvider === 'custom') {
      if (!customClient) return { valid: false, error: providers.custom.error || 'Set AI_PROVIDER_MODULE and restart to load a local provider.' };
      if (typeof customClient.health !== 'function') return { valid: null, note: `Local module loaded${providers.custom.version ? ` (${providers.custom.version})` : ''}; no health hook is available.` };
      const controller = new AbortController();
      let timeout;
      try {
        const result = await Promise.race([Promise.resolve().then(() => customClient.health({ signal: controller.signal })), new Promise((_, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error('Provider health check timed out.')); }, 15_000);
        })]);
        return { valid: result?.valid === true ? true : result?.valid === false ? false : null,
          ...Object.fromEntries(['error', 'note', 'version'].filter(key => typeof result?.[key] === 'string').map(key => [key, publicDetail(result[key])])) };
      } catch (err) { return { valid: null, error: publicDetail(err?.reason || err?.message) || 'Local provider health check failed.' }; }
      finally { clearTimeout(timeout); }
    }
    if (!['anthropic', 'openai'].includes(selectedProvider)) return { valid: false, error: 'Choose Anthropic, OpenAI, or Custom (local module).' };
    const config = configuration();
    const key = (typeof candidate === 'string' && candidate.trim()) || config.keys[selectedProvider];
    if (!key) return { valid: false, error: 'No key to verify — paste one first.' };
    const isOpenAi = selectedProvider === 'openai';
    if (isOpenAi ? (!key.startsWith('sk-') || key.startsWith('sk-ant-')) : !key.startsWith('sk-ant-')) {
      return { valid: false, error: `That does not look like an ${isOpenAi ? 'OpenAI' : 'Anthropic'} API key.` };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      if (isOpenAi) {
        const model = selectedModel || config.models.openai;
        const response = await requestOpenAi(key, {
          model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }],
          ...(supportsReasoning(model) ? { reasoning: { effort: 'low' } } : {}),
        }, { signal: controller.signal, fetchImpl, stream: false });
        const body = await response.json();
        if (!['completed', 'incomplete'].includes(body.status)) throw providerError(body.error);
      } else {
        await anthropicFactory(key).messages.create(
          { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
          { signal: controller.signal, timeout: 15_000, maxRetries: 0 },
        );
      }
      return { valid: true };
    } catch (err) {
      const name = isOpenAi ? 'OpenAI' : 'Anthropic';
      if (err?.status === 401 || err?.status === 403) return { valid: false, error: `${name} rejected the key or its permissions.` };
      if (isOpenAi && err?.code === 'insufficient_quota') return { valid: null, error: 'OpenAI API quota is exhausted. Add API credit or check project limits.' };
      if (err?.status === 429) return { valid: null, error: `${name} is rate-limiting requests. Try verification again shortly.` };
      if (err?.status === 400 || err?.status === 404) return { valid: null, error: `${name} could not run the selected model. Check the model ID and your key's model access.` };
      return { valid: null, error: `Could not verify with ${name} — try again shortly.` };
    } finally { clearTimeout(timeout); }
  }
  refresh();
  return { refresh, rotateKey, verifyKey, getClient: () => client,
    getStatus: () => ({ ...providers[provider], provider, providers }) };
}

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.3-codex';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

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
  return { provider: 'openai', model, stream: (params, options) => openAiStream(key, params, { ...options, fetchImpl }) };
}

// Keys retain environment precedence. Provider/model settings override their
// environment defaults so an operator can switch the active provider live.
export function createAiProvider({ getSettings, getAnalysisSettings = () => ({}), env = process.env,
  anthropicFactory = key => new Anthropic({ apiKey: key }), fetchImpl = (...args) => fetch(...args) }) {
  let client = null;
  let providers = {};
  let provider = 'anthropic';
  function configuration() {
    const settings = getSettings();
    const anthropicEnv = env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_PRIMARY;
    const keys = { anthropic: anthropicEnv || settings.anthropicKey || null, openai: env.OPENAI_API_KEY || settings.openaiKey || null };
    const selected = settings.aiProvider || env.AI_PROVIDER;
    return { keys, provider: ['anthropic', 'openai'].includes(selected) ? selected : (keys.openai && !keys.anthropic ? 'openai' : 'anthropic'),
      models: { anthropic: getAnalysisSettings().preferredModel || 'claude-sonnet-5', openai: settings.openaiModel || env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL },
      sources: { anthropic: anthropicEnv ? 'env' : keys.anthropic ? 'settings' : null, openai: env.OPENAI_API_KEY ? 'env' : keys.openai ? 'settings' : null } };
  }
  function refresh() {
    const config = configuration();
    provider = config.provider;
    providers = Object.fromEntries(['anthropic', 'openai'].map(name => [name, {
      enabled: Boolean(config.keys[name]), source: config.sources[name], masked: maskKey(config.keys[name]), rotated: false, model: config.models[name],
    }]));
    client = !config.keys[provider] ? null : provider === 'openai'
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
    if (!['anthropic', 'openai'].includes(selectedProvider)) return { valid: false, error: 'Choose Anthropic or OpenAI.' };
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
          ...(/^gpt-5(?:\.|-)/.test(model) ? { reasoning: { effort: 'low' } } : {}),
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

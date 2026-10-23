import { expect, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { createCliClient } from '../lib/cli-provider.js';
import { applyThinking, safeErrorMsg, streamWithRecovery } from '../routes/brief.js';

const fixture = fileURLToPath(new URL('./fixtures/cli-assistant.mjs', import.meta.url));
const clientFor = (reasoningEffort, scenario = 'conversation') => createCliClient({
  version: 1, id: 'fixture-request', model: 'fixture-model', command: process.execPath,
  args: [fixture, scenario, '{reasoning_effort}'],
  input: { transport: 'stdin', format: 'json' }, env_allow: [],
  ...(reasoningEffort === undefined ? {} : { capabilities: { reasoningEffort } }),
  output: {
    format: 'ndjson', text: { path: 'text', mode: 'final', when: [{ path: 'type', equals: 'result' }] },
    done: [{ when: [{ path: 'type', equals: 'result' }, { path: 'status', equals: 'success' }], reason: 'end_turn' }],
  },
}, { env: {} });

const request = () => ({
  model: 'fixture-model', system: 'Use only the captured evidence.', max_tokens: 1200,
  messages: [
    { role: 'user', content: 'The original captured evidence.' },
    { role: 'assistant', content: 'A rejected draft.' },
    { role: 'user', content: 'Correct the unsupported claim.' },
  ],
});

async function productionRequest(client, params, effort) {
  // Use the route's request configuration and stream consumption, rather than
  // supplying reasoning directly to the runner as a standalone caller would.
  applyThinking(params, params.model, effort, client);
  const result = await streamWithRecovery(client, params);
  expect(result).toMatchObject({ error: null, stopReason: 'end_turn', terminalReceived: true });
  return JSON.parse(result.text);
}

test.each(['high', 'low', 'off'])('configured CLI reasoning effort reaches JSON input: %s', async effort => {
  const params = request();
  const transmitted = await productionRequest(clientFor(true), params, effort);
  expect(transmitted).toEqual({ model: params.model, system: params.system,
    messages: params.messages, max_tokens: params.max_tokens, reasoning_effort: effort });
  expect(transmitted.messages).toEqual(params.messages);
  expect(params.reasoning).toEqual({ effort });
});

test('configured CLI reasoning effort reaches a declared launch argument', async () => {
  const transmitted = await productionRequest(clientFor(true, 'environment'), request(), 'high');
  expect(transmitted.args).toEqual(['high']);
});

test.each([false, undefined])('unsupported or undeclared CLI reasoning drops stale effort: %s', async capability => {
  const params = { ...request(), reasoning: { effort: 'high' } };
  const transmitted = await productionRequest(clientFor(capability), params, 'low');
  expect(params).not.toHaveProperty('reasoning');
  expect(transmitted).not.toHaveProperty('reasoning_effort');
  expect(transmitted.messages).toEqual(params.messages);
});

test.each([
  ['license', 'license agreement acceptance'],
  ['gateway524', 'gateway timeout (524)'],
])('CLI %s diagnosis survives the generation route and public error filter', async (kind, diagnosis) => {
  const client = createCliClient({
    version: 1, id: 'fixture-diagnostic', model: 'fixture-model', command: process.execPath,
    args: [fixture, 'diagnostic-stderr', kind], input: { transport: 'stdin', format: 'json' }, env_allow: [],
    output: { format: 'json', text: { path: 'text', mode: 'final' },
      done: [{ when: [{ path: 'status', equals: 'success' }], reason: 'end_turn' }] },
  }, { env: {} });
  const result = await streamWithRecovery(client, request());
  expect(result.terminalReceived).toBe(false);
  expect(result.error).toMatchObject({ code: 'E_CLI_EXIT', completionUncertain: true });
  expect(safeErrorMsg(result.error)).toContain(diagnosis);
  expect(safeErrorMsg(result.error)).not.toContain('raw-cli-diagnostic');
});

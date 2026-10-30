import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliClient } from '../lib/cli-provider.js';

jest.setTimeout(15_000);
const fixture = fileURLToPath(new URL('./fixtures/bob-cli.mjs', import.meta.url));
const profilePath = new URL('../config/cli-profiles/bob.json', import.meta.url);
const bundledProfile = () => JSON.parse(readFileSync(profilePath, 'utf8'));
const profileFor = scenario => {
  const profile = bundledProfile();
  // Exercise the shipped arguments and output selectors with a local executable.
  profile.command = process.execPath;
  profile.args.unshift(fixture, scenario);
  return profile;
};
const environment = extra => ({ ...process.env, BOB_API_KEY: 'synthetic-bob-key-never-sent-to-a-provider', ...extra });
const request = {
  model: 'cli-default', system: 'Use only the supplied captured evidence.', max_tokens: 1_000,
  messages: [{ role: 'user', content: 'Summarize captured fact A.' }],
};
const run = async (profile, env = environment(), options = {}) => {
  const events = [];
  let error;
  try {
    for await (const event of createCliClient(profile, { env }).stream(request, options)) events.push(event);
  } catch (caught) { error = caught; }
  return { events, error };
};
const textOf = events => events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('');
const usageOf = events => Object.assign({}, ...events.map(event => event.message?.usage || event.usage || {}));
const directories = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'cybe-bob-test-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('bundled Bob CLI profile', () => {
  test('accepts the license and trusts each fresh workspace without relying on inherited consent', async () => {
    const inheritedHome = scratch();
    const { events, error } = await run(profileFor('inspect'), environment({
      HOME: inheritedHome, USERPROFILE: inheritedHome, XDG_CONFIG_HOME: inheritedHome,
    }));
    expect(error).toBeUndefined();
    const invocation = JSON.parse(textOf(events));
    expect(invocation.args).toEqual(expect.arrayContaining(['--accept-license', '--trust']));
    expect(invocation.initialHomeEntries).toEqual([]);
    expect(invocation.home).not.toBe(inheritedHome);
    expect(invocation.config).not.toBe(inheritedHome);
    expect(invocation.userprofile).toBe(invocation.home);
    expect(isAbsolute(invocation.cwd)).toBe(true);
    expect(invocation.args[invocation.args.indexOf('--workspace') + 1]).toBe(invocation.cwd);
    expect(invocation.transcript).toContain(request.system);
    expect(invocation.transcript).toContain(request.messages[0].content);
    expect(existsSync(invocation.home)).toBe(false);
    expect(existsSync(invocation.cwd)).toBe(false);
  });

  test('joins streamed assistant chunks in order and preserves completion and Bobcoin usage', async () => {
    const { events, error } = await run(profileFor('success'));
    expect(error).toBeUndefined();
    expect(textOf(events)).toBe('The captured evidence supports this completed briefing.');
    expect(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text)).toEqual([
      'The captured evidence ', 'supports this ', 'completed briefing.',
    ]);
    expect(events.some(event => event.delta?.stop_reason === 'end_turn')).toBe(true);
    expect(events.at(-1).type).toBe('message_stop');
    expect(usageOf(events)).toMatchObject({ input_tokens: 321, output_tokens: 87,
      input_tokens_details: { cached_tokens: 64 }, provider_cost: { amount: 0.75, unit: 'Bobcoins' } });
    expect(usageOf(events).cost_usd).toBeUndefined();
  });

  test('passes every tool group exclusion to Bob, including browser access in ask mode', async () => {
    const { events, error } = await run(profileFor('inspect'));
    expect(error).toBeUndefined();
    const { args } = JSON.parse(textOf(events));
    expect(args).toEqual(expect.arrayContaining(['--disable-mcp', '--disable-subagents']));
    const disabled = args[args.indexOf('--disable-tool-groups') + 1].split(',');
    expect(disabled).toEqual(expect.arrayContaining([
      'read', 'edit', 'execute', 'mcp', 'skill', 'todo', 'subagent', 'mode',
      'browser', 'command', 'subtask', 'workflow', 'artifact', 'plan',
    ]));
  });

  test('resets the silence deadline for slow chunks across a longer generation', async () => {
    const profile = profileFor('slow-chunks');
    expect(profile.limits).toMatchObject({ silence_timeout_ms: 240_000, total_timeout_ms: 580_000 });
    // Three 700ms gaps each fit the silence limit; together they exceed it.
    profile.limits = { ...profile.limits, silence_timeout_ms: 1_500, total_timeout_ms: 7_000 };
    const started = performance.now();
    const { events, error } = await run(profile);
    expect(performance.now() - started).toBeGreaterThan(profile.limits.silence_timeout_ms);
    expect(error).toBeUndefined();
    expect(textOf(events)).toBe('The captured evidence supports this completed briefing.');
    expect(events.at(-1).type).toBe('message_stop');
  });

  test('excludes user and reasoning text even when there is no assistant answer', async () => {
    const { events, error } = await run(profileFor('reasoning-only'));
    expect(error).toMatchObject({ code: 'E_CLI_INCOMPLETE', completionUncertain: true });
    expect(textOf(events)).toBe('');
    expect(events.some(event => event.type === 'message_stop')).toBe(false);
  });

  test.each(['error-result', 'error-event', 'tool-use', 'tool-result', 'tool-count'])(
    'rejects %s without certifying completion and keeps streamed text and reported usage', async scenario => {
      const { events, error } = await run(profileFor(scenario));
      expect(error).toMatchObject({ code: 'E_CLI_OUTPUT', completionUncertain: true });
      expect(textOf(events)).toBe('The captured evidence supports this completed briefing.');
      expect(events.some(event => event.type === 'message_stop')).toBe(false);
      expect(usageOf(events)).toMatchObject({ input_tokens: 321, output_tokens: 87,
        provider_cost: { amount: 0.75, unit: 'Bobcoins' } });
    });

  test.each([['nonzero', 'E_CLI_EXIT'], ['empty-answer', 'E_CLI_INCOMPLETE']])(
    'never certifies completion for %s', async (scenario, code) => {
      const { events, error } = await run(profileFor(scenario));
      expect(error).toMatchObject({ code, completionUncertain: true });
      expect(events.some(event => event.type === 'message_stop')).toBe(false);
    });

  test('fails one silent attempt without restarting even when the caller requests retries', async () => {
    const profile = profileFor('silent');
    expect(profile.restarts).toBe(0);
    const countPath = join(scratch(), 'launches.txt');
    profile.env_allow.push('BOB_FIXTURE_COUNT_PATH');
    profile.limits = { ...profile.limits, silence_timeout_ms: 1_500, total_timeout_ms: 8_000, kill_grace_ms: 100 };
    const { events, error } = await run(profile, environment({ BOB_FIXTURE_COUNT_PATH: countPath }), { maxRetries: 2 });
    expect(error).toMatchObject({ code: 'E_CLI_TIMEOUT', completionUncertain: true });
    expect(error.message).toContain('silence deadline');
    expect(events.some(event => event.type === 'message_stop')).toBe(false);
    expect(readFileSync(countPath, 'utf8')).toBe('spawn\n');
  });

  test('reports an immediate budget failure safely without assuming account scope or restarting', async () => {
    const profile = profileFor('budget-exceeded');
    const countPath = join(scratch(), 'launches.txt');
    profile.env_allow.push('BOB_FIXTURE_COUNT_PATH');
    const { events, error } = await run(profile, environment({ BOB_FIXTURE_COUNT_PATH: countPath }), { maxRetries: 2 });
    expect(error).toMatchObject({ code: 'E_CLI_EXIT', completionUncertain: true, reason: error.message });
    expect(error.reason).toContain('provider budget or allowance was exceeded');
    expect(error.reason).toContain('Check the provider account usage and limits');
    expect(error.reason).not.toMatch(/100|Bobcoins|monthly|per.key|per.team|synthetic-bob-key|Private provider|\x1b/);
    expect(events).toEqual([]);
    expect(readFileSync(countPath, 'utf8')).toBe('spawn\n');
  });
});

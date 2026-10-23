import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import * as operatingSystem from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeFilesystem = { ...filesystem };
const nativeOperatingSystem = { ...operatingSystem };
let temporaryParent;
let failCanonicalization = false;
jest.unstable_mockModule('node:os', () => ({ ...nativeOperatingSystem, tmpdir: () => temporaryParent }));
jest.unstable_mockModule('node:fs/promises', () => ({
  ...nativeFilesystem,
  realpath: async path => {
    if (failCanonicalization) throw Object.assign(new Error('Synthetic realpath failure'), { code: 'EACCES' });
    return nativeFilesystem.realpath(path);
  },
}));
const { createCliClient } = await import('../lib/cli-provider.js');
const fixture = fileURLToPath(new URL('./fixtures/cli-assistant.mjs', import.meta.url));
let directory, target, countPath;
beforeEach(() => {
  directory = mkdtempSync(join(nativeOperatingSystem.tmpdir(), 'cybe-cli-workspace-test-'));
  target = join(directory, 'physical-temp');
  mkdirSync(target);
  temporaryParent = join(directory, 'temp-alias');
  symlinkSync(realpathSync(target), temporaryParent, process.platform === 'win32' ? 'junction' : 'dir');
  countPath = join(directory, 'launches.txt');
  failCanonicalization = false;
});
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const client = (extra = {}) => createCliClient({
  version: 1, id: 'workspace-fixture', model: 'fixture-model', command: process.execPath,
  args: [fixture, 'environment', '{workspace}', '{home}'], input: { transport: 'stdin', format: 'json' },
  env_allow: ['FIXTURE_COUNT_PATH'],
  output: { format: 'ndjson', text: { path: 'text', mode: 'final' },
    done: [{ when: [{ path: 'type', equals: 'result' }, { path: 'status', equals: 'success' }], reason: 'end_turn' }] },
  ...extra,
}, { env: { FIXTURE_COUNT_PATH: countPath } });
const run = async value => {
  let text = '';
  for await (const event of value.stream({ model: 'fixture-model', system: 'Use only this local fixture.', messages: [] })) {
    if (event.type === 'content_block_delta') text += event.delta.text;
  }
  return JSON.parse(text);
};

test('uses the physical temp path for cwd, placeholders, and isolated directories, then removes only its workspace', async () => {
  const result = await run(client());
  expect(result.cwd).toBe(result.args[0]);
  expect(dirname(dirname(result.cwd))).toBe(realpathSync(target));
  expect(result.env.HOME).toBe(result.args[1]);
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    expect(dirname(result.env[name])).toBe(dirname(result.cwd));
  }
  expect(existsSync(countPath)).toBe(true);
  expect(existsSync(result.cwd)).toBe(false);
  expect(realpathSync(temporaryParent)).toBe(realpathSync(target));
  expect(readdirSync(target)).toEqual([]);
});

test('removes the allocated root if path canonicalization fails without launching a child', async () => {
  failCanonicalization = true;
  await expect(run(client())).rejects.toMatchObject({ code: 'E_CLI_SETUP', completionUncertain: false });
  expect(existsSync(countPath)).toBe(false);
  expect(readdirSync(target)).toEqual([]);
  expect(realpathSync(temporaryParent)).toBe(realpathSync(target));
});

test('removes the canonical workspace after later setup failure without launching a child', async () => {
  await expect(run(client({ env_allow: ['FIXTURE_COUNT_PATH', 'MISSING_CREDENTIAL'], env_required: ['MISSING_CREDENTIAL'] })))
    .rejects.toMatchObject({ code: 'E_CLI_SETUP', completionUncertain: false });
  expect(existsSync(countPath)).toBe(false);
  expect(readdirSync(target)).toEqual([]);
  expect(realpathSync(temporaryParent)).toBe(realpathSync(target));
});

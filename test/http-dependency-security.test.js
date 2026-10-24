import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/http-dependency-security.mjs', import.meta.url));

// These regressions previously terminated the Node process after an apparently
// handled request. Isolate each probe: an uncaught error must fail the test,
// without killing Jest or being hidden by an uncaughtException listener.
describe('HTTP dependency process-survival regressions', () => {
  test.each([
    ['compressed-request', 'a compressed JSON request with late trailing bytes'],
    ['excessive-encodings', 'an upstream response with excessive content encodings'],
  ])('survives %s (%s)', (scenario) => {
    const result = spawnSync(process.execPath, [fixture, scenario], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
    });
    const diagnostics = `${result.error?.message || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
    expect({ status: result.status, signal: result.signal, diagnostics }).toEqual({
      status: 0,
      signal: null,
      diagnostics: expect.stringContaining(`PASS ${scenario}`),
    });
  }, 15_000);
});

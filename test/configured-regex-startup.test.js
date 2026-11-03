import { expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.each([
  ['slow', 'slow startup accepts valid rules and reuses the ready worker'],
  ['hostile', 'slow startup grants no extra time to catastrophic matching'],
  ['hang', 'a worker that never becomes ready is terminated before any evaluation'],
  ['crash', 'a startup crash fails closed and allows recovery after termination'],
])('%s: %s', (mode) => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/configured-regex-startup.mjs', import.meta.url)), mode], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|path|temp|tmp)$/i.test(key))),
  });
  expect({ status: child.status, error: child.error?.code, stderr: child.stderr })
    .toEqual({ status: 0, error: undefined, stderr: '' });
  expect(JSON.parse(child.stdout)).toEqual({ mode, passed: true });
}, 15_000);

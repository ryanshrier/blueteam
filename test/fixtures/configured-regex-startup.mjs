// Run in a separate Node process: delay/fail a real worker before importing its
// unchanged production entry point. No test hooks enter application code.
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';

const mode = process.argv[2];
assert(['slow', 'hostile', 'hang', 'crash'].includes(mode));
const threads = createRequire(import.meta.url)('node:worker_threads');
const ActualWorker = threads.Worker;
const workers = [], terminations = [], waits = [];
let posted = 0;
threads.Worker = class extends ActualWorker {
  constructor(url, options) {
    assert(url.href.endsWith('/configured-regex-worker.js'));
    assert.equal(options.workerData.request, undefined, 'Startup receives no regex request');
    assert.deepEqual(options.env, {});
    assert.deepEqual(options.execArgv, []);
    super(`const { workerData } = require('node:worker_threads');
      const gate = new Int32Array(new SharedArrayBuffer(4));
      if (workerData.testMode === 'hang') Atomics.wait(gate, 0, 0);
      if (workerData.testMode === 'crash') throw new Error('Synthetic worker startup failure');
      if (['slow', 'hostile'].includes(workerData.testMode)) Atomics.wait(gate, 0, 0, 700);
      import(workerData.moduleUrl);`, {
      ...options, eval: true,
      workerData: { ...options.workerData, moduleUrl: url.href, testMode: workers.length ? 'normal' : mode },
    });
    this.ready = new Int32Array(options.workerData.ready);
    workers.push(this);
  }
  postMessage(message) {
    assert.equal(Atomics.load(this.ready, 0), 1, 'No evaluation before the real worker is ready');
    posted++;
    return super.postMessage(message);
  }
  terminate() {
    const result = super.terminate();
    terminations.push(result);
    return result;
  }
};
syncBuiltinESMExports();
const wait = Atomics.wait;
Atomics.wait = (...args) => {
  const result = wait(...args);
  waits.push({ timeoutMs: args[3], result });
  return result;
};

const { evaluateConfiguredRegexSync: evaluate, closeConfiguredRegexWorker: close, CONFIGURED_REGEX_LIMITS: limits }
  = await import('../../lib/configured-regex.js');
const { alertRules } = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8'));
const request = { operation: 'validate', patterns: alertRules.map(rule => ({ source: rule.pattern, flags: 'i' })) };
try {
  assert.equal(limits.syncTimeoutMs, 500);
  assert.equal(limits.timeoutMs, 2_000);
  assert.equal(limits.syncStartupTimeoutMs, 2_000);
  if (mode === 'slow') {
    assert.equal(evaluate(request), true, 'Valid shipped rules survive a startup longer than 500 ms');
    assert.equal(evaluate({ operation: 'match', source: 'C\\+\\+', text: 'C++ update' })[0], 'C++');
    assert.equal(workers.length, 1, 'Ready worker is reused');
    assert.deepEqual(waits.map(entry => entry.timeoutMs), [2_000, 500, 500]);
    assert.equal(posted, 2);
    assert.equal(terminations.length, 0);
  } else {
    const hostile = mode === 'hostile';
    assert.throws(() => evaluate(hostile
      ? { operation: 'match', source: '(a+)+$', text: 'a'.repeat(60) + 'z' } : request),
    { code: hostile ? 'E_CONFIGURED_REGEX_TIMEOUT' : 'E_CONFIGURED_REGEX_STARTUP_TIMEOUT' });
    assert.deepEqual(waits.map(entry => entry.timeoutMs), hostile ? [2_000, 500] : [2_000]);
    assert.equal(waits.at(-1).result, 'timed-out');
    assert.equal(posted, hostile ? 1 : 0);
    assert.equal(terminations.length, 1);
    assert.throws(() => evaluate(request), /still stopping/);
    assert.equal(workers.length, 1, 'Retiring worker keeps its capacity slot');
    await terminations[0];
    assert.equal(evaluate(request), true, 'A fresh worker recovers after the failed worker exits');
    assert.equal(workers.length, 2);
  }
  console.log(JSON.stringify({ mode, passed: true }));
} finally {
  Atomics.wait = wait;
  await close();
}

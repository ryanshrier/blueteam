import { parentPort, workerData } from 'node:worker_threads';
import { evaluateRegexRequest } from './configured-regex-engine.js';

function run({ request, shared }) {
  let reply;
  try { reply = { ok: true, value: evaluateRegexRequest(request) }; }
  catch { reply = { ok: false }; }
  if (!shared) { parentPort.postMessage(reply); return; }
  const status = new Int32Array(shared, 0, 2);
  const bytes = new TextEncoder().encode(JSON.stringify(reply));
  if (bytes.length <= shared.byteLength - 8) {
    new Uint8Array(shared, 8, bytes.length).set(bytes);
    Atomics.store(status, 1, bytes.length);
    Atomics.store(status, 0, 1);
  } else Atomics.store(status, 0, 2);
  Atomics.notify(status, 0);
}
if (workerData.persistentSync) parentPort.on('message', run);
else run(workerData);

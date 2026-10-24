// Select the application's runtime before importing application/native modules.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { assertSupportedNode, supportedNode } from '../lib/runtime-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export function selectNodeRuntime({ version = process.versions.node, executable = process.execPath,
  projectRoot = root, platform = process.platform, arch = process.arch,
  exists = existsSync, inspect = path => execFileSync(path, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 1024 }).trim() } = {}) {
  // CI and explicit supported installations retain their selected major.
  if (supportedNode(version)) return executable;
  const pinned = readFileSync(join(projectRoot, '.node-version'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinned) || !supportedNode(pinned)) throw new Error('Invalid pinned Node runtime.');
  const directory = `node-v${pinned}-${platform === 'win32' ? 'win' : platform}-${arch}`;
  const managed = join(projectRoot, '.runtime', directory, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  if (!exists(managed)) throw new Error(`Node ${version} is unsupported and the pinned LTS runtime is missing. Run scripts/setup-lts.ps1 on Windows or select Node ${pinned} with your version manager.`);
  const actual = inspect(managed).replace(/^v/, '');
  assertSupportedNode(actual);
  if (actual !== pinned) throw new Error('The managed Node runtime does not match .node-version. Re-run setup-lts.ps1.');
  return managed;
}

const SHUTDOWN_SIGNALS = new Set(['SIGINT', 'SIGTERM']);

export function forwardRuntimeSignal(child, signal, { platform = process.platform, application = false } = {}) {
  if (!SHUTDOWN_SIGNALS.has(signal) || child.exitCode !== null || child.signalCode != null) return false;
  if (platform === 'win32') {
    // Windows kill() terminates without invoking the child's JS handlers.
    // Application IPC enters its existing graceful shutdown coordinator.
    // Other console scripts receive Ctrl+C directly from the shared console.
    if (!application || !child.connected) return false;
    child.send({ type: 'blueteam:shutdown', signal }, error => {
      if (error && child.exitCode === null) console.error('Could not request application shutdown over IPC.');
    });
  } else child.kill(signal);
  return true;
}

export function run(args = process.argv.slice(2)) {
  if (!args.length) throw new Error('A Node script or option is required.');
  const executable = selectNodeRuntime();
  const env = { ...process.env, npm_node_execpath: executable, NODE: executable };
  const applicationIpc = process.platform === 'win32' && resolve(args[0]) === join(root, 'server.js');
  delete env.BLUETEAM_LAUNCHER_IPC;
  if (applicationIpc) env.BLUETEAM_LAUNCHER_IPC = '1';
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = dirname(executable) + delimiter + (env[pathKey] || '');
  const child = spawn(executable, args, { env, stdio: applicationIpc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true });
  let ready = !applicationIpc, pendingSignal = null;
  const handlers = new Map([...SHUTDOWN_SIGNALS].map(signal => [signal, () => {
    // A request made during asynchronous startup waits for the server to
    // install its handlers. Never drop it or force-kill accepted work.
    if (!ready) { pendingSignal = signal; return; }
    forwardRuntimeSignal(child, signal, { application: applicationIpc });
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  if (applicationIpc) child.on('message', message => {
    if (message?.type !== 'blueteam:shutdown-ready') return;
    ready = true;
    if (pendingSignal) { const signal = pendingSignal; pendingSignal = null; forwardRuntimeSignal(child, signal, { application: true }); }
  });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

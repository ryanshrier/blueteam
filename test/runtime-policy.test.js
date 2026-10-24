import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { supportedNode, assertSupportedNode, SUPPORTED_NODE_FLOORS } from '../lib/runtime-policy.js';
import { selectNodeRuntime, forwardRuntimeSignal } from '../scripts/run-node.mjs';
import { spawn } from 'node:child_process';

describe('application runtime selection', () => {
  test.each(['22.23.4', '24.22.1', '26.12.1', '24.23.0'])('accepts supported Node%s', version => expect(supportedNode(version)).toBe(true));
  test.each(['22.23.3', '24.22.0', '26.12.0', '25.8.2', '27.0.0', '24.22.1-preview'])('rejects unsupported Node%s', version => {
    expect(supportedNode(version)).toBe(false);
    expect(() => assertSupportedNode(version)).toThrow('Unsupported Node');
  });
  test('runtime guard and version-manager pins match the declared policy', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.entries(SUPPORTED_NODE_FLOORS).map(([major, floor]) => `>=${major}.${floor.join('.')} <${Number(major) + 1}`).join(' || ')).toBe(packageJson.engines.node);
    const pin = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
    expect(pin).toBe('24.22.1');
    expect(readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim()).toBe(pin);
  });
  test('uses verified managed LTS when the invoking shell uses unsupported Node', () => {
    let inspected;
    const selected = selectNodeRuntime({ version: '25.8.2', executable: 'unsupported', platform: 'win32', arch: 'x64',
      exists: () => true, inspect: path => { inspected = path; return 'v24.22.1'; } });
    expect(selected).toBe(inspected);
    expect(selected.replaceAll('\\', '/')).toContain('/.runtime/node-v24.22.1-win-x64/node.exe');
  });
  test('keeps an explicitly selected supported runtime for the CI matrix', () => {
    expect(selectNodeRuntime({ version: '22.23.4', executable: 'selected-node', exists: () => { throw new Error('Must not inspect local fallback'); } })).toBe('selected-node');
  });
  test('fails closed when fallback is missing or is a mislabeled unsupported executable', () => {
    expect(() => selectNodeRuntime({ version: '25.8.2', exists: () => false })).toThrow('pinned LTS runtime is missing');
    expect(() => selectNodeRuntime({ version: '25.8.2', exists: () => true, inspect: () => 'v25.8.2' })).toThrow('Unsupported Node');
    expect(() => selectNodeRuntime({ version: '25.8.2', exists: () => true, inspect: () => 'v24.23.0' })).toThrow('does not match');
  });

  test('Windows application shutdown uses IPC while unrelated console tools are not force-killed', () => {
    const child = { exitCode: null, signalCode: null, connected: true, send: jest.fn(), kill: jest.fn() };
    expect(forwardRuntimeSignal(child, 'SIGINT', { platform: 'win32', application: true })).toBe(true);
    expect(child.send).toHaveBeenCalledWith({ type: 'blueteam:shutdown', signal: 'SIGINT' }, expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
    expect(forwardRuntimeSignal(child, 'SIGINT', { platform: 'win32', application: false })).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(forwardRuntimeSignal(child, 'SIGTERM', { platform: 'linux', application: true })).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(forwardRuntimeSignal(child, 'SIGKILL', { platform: 'win32', application: true })).toBe(false);
  });

  test.each(['SIGINT', 'SIGTERM'])('IPC %s permits accepted work to drain before the child exits', async signal => {
    const program = `let accepted = true;process.on('message', message => {
      if(message?.type!=='blueteam:shutdown'||!['SIGINT','SIGTERM'].includes(message.signal))return;
      console.log('handler:'+message.signal);
      setTimeout(()=>{accepted=false;console.log('drained');process.channel.unref();},75);
    });process.send({type:'ready'});`;
    const child = spawn(process.execPath, ['-e', program], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|path|temp|tmp)$/i.test(key))) });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errors += value; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })); });
    const guard = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
      expect(forwardRuntimeSignal(child, signal, { platform: 'win32', application: true })).toBe(true);
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(errors).toBe('');
      expect(output).toBe(`handler:${signal}\ndrained\n`);
    } finally { clearTimeout(guard); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});

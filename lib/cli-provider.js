import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const PROFILE_BYTES = 64 * 1024;
const DEFAULT_LIMITS = Object.freeze({ silence_timeout_ms: 60_000, total_timeout_ms: 180_000,
  max_output_bytes: 8 * 1024 * 1024, max_line_bytes: 1024 * 1024, max_input_bytes: 8 * 1024 * 1024,
  kill_grace_ms: 500 });
const LIMIT_MAX = { silence_timeout_ms: 3_600_000, total_timeout_ms: 3_600_000,
  max_output_bytes: 32 * 1024 * 1024, max_line_bytes: 4 * 1024 * 1024,
  max_input_bytes: 32 * 1024 * 1024, kill_grace_ms: 5_000 };
const ISOLATED_ENV = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP']);
const PLACEHOLDERS = new Set(['workspace', 'home', 'model', 'max_tokens', 'reasoning_effort']);
const CAPABILITIES = ['systemPrompt', 'conversation', 'outputTokenLimit', 'reasoningEffort', 'externalTools'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw Object.assign(new Error(`Invalid CLI profile: ${message}`), { code: 'E_CLI_PROFILE' }); };
const string = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} contains unsupported fields.`);
}
function fieldPath(value) {
  if (!string(value, 256) || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/.test(value)
    || value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) invalid('field paths must be plain dotted JSON keys.');
}
function argumentList(value, label) {
  if (!Array.isArray(value) || value.length > 128 || value.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) invalid(`${label} must be an array of arguments.`);
  for (const arg of value) for (const match of arg.matchAll(/\{([a-z_]+)\}/g)) {
    if (!PLACEHOLDERS.has(match[1])) invalid(`${label} contains an unsupported placeholder.`);
  }
}
function conditions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) invalid('when must contain 1–16 comparisons.');
  for (const rule of value) {
    keys(rule, ['path', 'equals', 'not_equals', 'exists'], 'comparison');
    fieldPath(rule.path);
    const operators = ['equals', 'not_equals', 'exists'].filter(key => Object.hasOwn(rule, key));
    if (operators.length !== 1) invalid('each comparison needs exactly one operator.');
    const op = operators[0], item = rule[op];
    if (op === 'exists' ? typeof item !== 'boolean' : !(item === null || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 1024))) invalid('comparisons must use primitive values.');
  }
}

/** Profiles are trusted launch configuration, never executable expressions. */
export function validateCliProfile(value) {
  keys(value, ['version', 'id', 'model', 'command', 'args', 'input', 'env_allow', 'env_required',
    'capabilities', 'tools', 'output', 'limits', 'restarts', 'health_args'], 'profile');
  if (value.version !== 1) invalid('version must be 1.');
  if (!string(value.id, 64) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id)) invalid('id must be a short identifier.');
  if (!string(value.model, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.model)) invalid('model must be a short model identifier.');
  if (!string(value.command)) invalid('command must name one executable.');
  if (/\.(?:cmd|bat|ps1)$/i.test(value.command)) invalid('use an executable or an explicit runtime, not a shell script.');
  argumentList(value.args, 'args');
  keys(value.input, ['transport', 'format'], 'input');
  if (value.input.transport !== 'stdin' || !['json', 'transcript'].includes(value.input.format)) invalid('input must use stdin with json or transcript format.');
  if (!Array.isArray(value.env_allow) || value.env_allow.length > 64
    || value.env_allow.some(name => !string(name, 128) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) invalid('env_allow must contain environment variable names.');
  if (value.env_allow.some(name => ISOLATED_ENV.has(name.toUpperCase()))) invalid('home, config, and temporary directories are managed by the runner.');
  if (value.env_required !== undefined && (!Array.isArray(value.env_required) || value.env_required.length > 64
    || value.env_required.some(name => !value.env_allow.includes(name)))) invalid('env_required must be a subset of env_allow.');
  if (value.restarts !== undefined && value.restarts !== 0) invalid('v1 supports zero automatic restarts only.');
  if (value.health_args !== undefined) argumentList(value.health_args, 'health_args');
  if (value.capabilities !== undefined) {
    keys(value.capabilities, CAPABILITIES, 'capabilities');
    if (Object.values(value.capabilities).some(item => typeof item !== 'boolean')) invalid('capabilities must be boolean declarations.');
    if (value.input.format === 'transcript' && (value.capabilities.systemPrompt || value.capabilities.conversation)) invalid('transcript input cannot declare native system or conversation support.');
  }
  if (value.tools !== undefined) {
    keys(value.tools, ['disabled_args'], 'tools');
    argumentList(value.tools.disabled_args, 'tools.disabled_args');
    if (!value.tools.disabled_args.length) invalid('tools.disabled_args must not be empty.');
  }
  if (value.capabilities?.externalTools === false && !value.tools?.disabled_args?.length) invalid('externalTools false requires explicit tool-disabling launch arguments.');
  keys(value.output, ['format', 'text', 'fail_on', 'done', 'model', 'usage'], 'output');
  if (!['json', 'ndjson'].includes(value.output.format)) invalid('output format must be json or ndjson.');
  keys(value.output.text, ['path', 'when', 'mode'], 'output.text');
  fieldPath(value.output.text.path);
  if (value.output.text.when !== undefined) conditions(value.output.text.when);
  if (!['final', 'delta'].includes(value.output.text.mode) || (value.output.format === 'json' && value.output.text.mode !== 'final')) invalid('text mode must be final, or delta for ndjson.');
  for (const key of ['fail_on', 'done']) {
    const rules = value.output[key];
    if (key === 'fail_on' && rules === undefined) continue;
    if (!Array.isArray(rules) || rules.length > 32 || (key === 'done' && !rules.length)) invalid(`${key} must contain bounded terminal rules.`);
    for (const rule of rules) {
      keys(rule, ['when', 'reason'], key);
      conditions(rule.when);
      if (key === 'done' ? !['end_turn', 'max_tokens', 'refusal'].includes(rule.reason)
        : rule.reason !== undefined && !string(rule.reason, 300)) invalid(`${key} has an invalid reason.`);
    }
  }
  if (value.output.model !== undefined) fieldPath(value.output.model);
  if (value.output.usage !== undefined) {
    keys(value.output.usage, ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cost'], 'usage');
    for (const name of ['input_tokens', 'output_tokens', 'cached_input_tokens']) if (value.output.usage[name] !== undefined) fieldPath(value.output.usage[name]);
    if (value.output.usage.cost !== undefined) {
      keys(value.output.usage.cost, ['path', 'unit'], 'usage.cost');
      fieldPath(value.output.usage.cost.path);
      if (!string(value.output.usage.cost.unit, 32) || !/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(value.output.usage.cost.unit)) invalid('cost unit must be explicit.');
    }
  }
  if (value.limits !== undefined) {
    keys(value.limits, Object.keys(DEFAULT_LIMITS), 'limits');
    for (const [name, amount] of Object.entries(value.limits)) if (!Number.isSafeInteger(amount) || amount < 1 || amount > LIMIT_MAX[name]) invalid(`${name} is outside its supported range.`);
  }
  return value;
}

function at(event, path) {
  let item = event;
  for (const name of path.split('.')) {
    if (item === null || typeof item !== 'object' || !Object.hasOwn(item, name)) return undefined;
    item = item[name];
  }
  return item;
}
function matches(event, rules) {
  return !rules || rules.every(rule => {
    const value = at(event, rule.path);
    return Object.hasOwn(rule, 'equals') ? value === rule.equals
      : Object.hasOwn(rule, 'not_equals') ? value !== rule.not_equals
        : (value !== undefined) === rule.exists;
  });
}
function redactWith(env) {
  const values = [...new Set(Object.values(env).filter(value => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length);
  return input => {
    let result = String(input || '');
    for (const value of values) result = result.split(value).join('[REDACTED]');
    return result.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/\bBearer\s+[A-Za-z\d_.~+/-]+/gi, 'Bearer [REDACTED]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  };
}

// Only fixed diagnoses can leave this matcher. Raw stderr may contain partial,
// encoded, or unknown credentials that ordinary string redaction cannot cover.
function stderrDiagnostics() {
  const decoder = new StringDecoder('utf8');
  const gateway = '\\bgateway[ _-]*(?:time[ _-]?out|timed[ _-]*out)\\b';
  const httpCode = code => new RegExp(`\\b(?:https?(?:/\\d(?:\\.\\d)?)?|status(?:Code|[ _-]code)?|(?:error[ _-])?code)["'\\s:=]+${code}\\b|${gateway}[^\\r\\n]{0,80}\\b${code}\\b`, 'i');
  const rules = [
    { pattern: httpCode(524), reason: 'CLI reported a gateway timeout (524).' },
    { pattern: httpCode(504), reason: 'CLI reported a gateway timeout (504).' },
    { pattern: new RegExp(gateway, 'i'), reason: 'CLI reported a gateway timeout.' },
    { pattern: /\blicen[cs]e(?:\s+agreement)?\s+(?:is\s+)?required\b|\bmust\s+(?:first\s+)?accept\s+(?:the\s+)?licen[cs]e\b/i,
      reason: 'CLI requires license agreement acceptance. Check its license-acceptance flag.' },
    { pattern: /\b(?:authentication|authorization)\s+(?:failed|required)\b|\b(?:invalid|missing|expired)\s+(?:api[ _-]?key|credentials?|(?:access[ _-]?)?token)\b|\bapi[ _-]?key\s+(?:is\s+)?(?:required|missing|invalid|not\s+(?:set|configured)|validation\s+failed)\b|\b[A-Z][A-Z0-9_]*_API_KEY\b[^\r\n]{0,64}\b(?:required|missing|not\s+(?:set|configured))\b/i,
      reason: 'CLI reported an API key or authentication error. Check its configured credentials.' },
  ];
  let tail = '', matched = rules.length;
  const scan = complete => {
    // A chunk ending at "status code 524" may still continue as "5240".
    // Wait for a token delimiter or EOF before retaining a diagnosis.
    const candidate = complete ? tail : tail.replace(/\w+$/, '');
    const index = rules.findIndex(rule => rule.pattern.test(candidate));
    if (index !== -1) matched = Math.min(matched, index);
  };
  const accept = text => {
    // Bound both retained text and matching work, including a very large chunk.
    for (let offset = 0; offset < text.length; offset += 1024) {
      tail = (tail + text.slice(offset, offset + 1024)).slice(-2048);
      scan(false);
    }
  };
  return {
    write: chunk => accept(decoder.write(chunk)),
    end: () => { accept(decoder.end()); scan(true); tail = ''; },
    reason: () => rules[matched]?.reason,
  };
}
function inputFor(params, format) {
  if (typeof params.system !== 'string' || !Array.isArray(params.messages)
    || params.messages.some(message => !object(message) || !['user', 'assistant', 'system'].includes(message.role)
      || !(typeof message.content === 'string' || Array.isArray(message.content)))) throw new Error('CLI input requires a system string and ordered role/content messages.');
  const request = { model: params.model, system: params.system, messages: params.messages,
    max_tokens: params.max_tokens, reasoning_effort: params.reasoning?.effort };
  return format === 'json' ? `${JSON.stringify(request)}\n`
    : `Follow the application instructions and continue the conversation as the assistant. Respond to the latest user message, including any corrections to a previous draft.\n\nAPPLICATION SYSTEM INSTRUCTIONS:\n${params.system}\n\nORDERED CONVERSATION (JSON; preserve roles and message order):\n${JSON.stringify(params.messages)}\n`;
}

async function workspaceEnvironment(profile, env) {
  const root = await mkdtemp(join(tmpdir(), 'blueteam-cli-'));
  try {
    // Match the child's physical cwd even when the system temp path is an
    // alias, such as /var -> /private/var on macOS.
    const canonicalRoot = await realpath(root);
    const locations = Object.fromEntries(['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp'].map(name => [name, join(canonicalRoot, name)]));
    await Promise.all(Object.values(locations).map(path => mkdir(path, { mode: 0o700 })));
    const childEnv = {};
    for (const name of profile.env_allow) {
      const actual = process.platform === 'win32' ? Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase()) : name;
      if (actual && typeof env[actual] === 'string') childEnv[name] = env[actual];
    }
    for (const name of profile.env_required || []) if (!childEnv[name]) throw new Error('A required CLI environment variable is missing.');
    Object.assign(childEnv, { HOME: locations.home, USERPROFILE: locations.home,
      APPDATA: locations.config, LOCALAPPDATA: locations.data, XDG_CONFIG_HOME: locations.config,
      XDG_CACHE_HOME: locations.cache, XDG_DATA_HOME: locations.data, XDG_STATE_HOME: locations.state,
      TMPDIR: locations.temp, TMP: locations.temp, TEMP: locations.temp });
    return { root: canonicalRoot, ...locations, env: childEnv };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

// A termination request targets the local process tree, never a new paid attempt.
function stopTree(child, graceMs, hostEnv) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === 'win32') return new Promise(resolveStop => {
    const systemRoot = hostEnv.SystemRoot || hostEnv.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows';
    const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore', env: { SystemRoot: systemRoot },
    });
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* already exited */ } resolveStop(); };
    const timer = setTimeout(() => { try { killer.kill(); } catch { /* already exited */ } finish(); }, 3_000);
    killer.once('error', finish); killer.once('close', finish);
  });
  return new Promise(resolveStop => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already exited */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ } resolveStop(); }, graceMs);
  });
}

/** Each call starts exactly one process. No output event can trigger a restart. */
async function* runCli(profile, hostEnv, params, options, health = false) {
  const limits = { ...DEFAULT_LIMITS, ...profile.limits };
  const input = health ? '' : inputFor(params, profile.input.format);
  if (Buffer.byteLength(input) > limits.max_input_bytes) throw Object.assign(new Error('CLI request exceeds the input size limit.'), { code: 'E_CLI_LIMIT', completionUncertain: false });
  if (options.signal?.aborted) throw Object.assign(new Error('CLI request cancelled before launch.'), { code: 'ABORT_ERR', completionUncertain: false });
  let directories;
  try { directories = await workspaceEnvironment(profile, hostEnv); }
  catch { throw Object.assign(new Error('CLI workspace setup failed or a required environment variable is missing.'), {
    code: 'E_CLI_SETUP', completionUncertain: false,
  }); }
  const redact = redactWith({ ...Object.fromEntries(Object.entries(hostEnv).filter(([name]) => /key|token|secret|password/i.test(name))), ...directories.env });
  const replace = arg => arg.replace(/\{([a-z_]+)\}/g, (_, name) => String({ workspace: directories.workspace,
    home: directories.home, model: params.model || profile.model, max_tokens: params.max_tokens || '',
    reasoning_effort: params.reasoning?.effort || 'off' }[name]));
  const args = (health ? profile.health_args : [...profile.args, ...(profile.tools?.disabled_args || [])]).map(replace);
  const command = profile.command;
  let child, stopping, silenceTimer, totalTimer, closeTimer;
  let closed = false, launched = false, failure = null, code = null, signal = null;
  let totalBytes = 0, buffer = '', terminal = null, finalText = null, healthOutput = '', answerBytes = 0;
  let responseModel = null;
  const usage = {};
  const diagnostics = stderrDiagnostics();
  const queue = [];
  let wake;
  const notify = () => { if (wake) { const resolveWake = wake; wake = null; resolveWake(); } };
  const push = event => { queue.push(event); notify(); };
  const error = (message, errorCode = 'E_CLI_OUTPUT') => Object.assign(new Error(redact(message).slice(0, 500)), {
    code: errorCode, completionUncertain: launched,
  });
  const stop = () => {
    if (!stopping) {
      stopping = stopTree(child, limits.kill_grace_ms, hostEnv);
      // Never wait indefinitely for a descendant that inherited a pipe handle.
      closeTimer = setTimeout(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); closed = true; notify(); }, 4_000);
    }
    return stopping;
  };
  const fail = (message, errorCode) => { if (failure) return; failure = error(message, errorCode); stop(); notify(); };
  const abort = () => fail('CLI request cancelled; remote completion is unknown.', 'ABORT_ERR');
  const activity = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => fail('CLI produced no output before the silence deadline; completion is unknown.', 'E_CLI_TIMEOUT'), limits.silence_timeout_ms);
  };
  const consume = event => {
    if (!object(event)) throw error('CLI output must contain JSON objects.');
    const fatal = (profile.output.fail_on || []).find(rule => matches(event, rule.when));
    if (profile.output.model) {
      const reported = at(event, profile.output.model);
      if (reported !== undefined && (!string(reported, 128) || /[\r\n]/.test(reported))) throw error('CLI reported an invalid model identifier.');
      if (reported !== undefined) responseModel = reported;
    }
    const fields = profile.output.usage || {};
    for (const name of ['input_tokens', 'output_tokens', 'cached_input_tokens']) if (fields[name]) {
      const amount = at(event, fields[name]);
      if (amount !== undefined) {
        if (!Number.isSafeInteger(amount) || amount < 0) throw error('CLI reported invalid token usage.');
        if (name === 'cached_input_tokens') usage.input_tokens_details = { cached_tokens: amount };
        else usage[name] = amount;
      }
    }
    if (fields.cost) {
      const amount = at(event, fields.cost.path);
      if (amount !== undefined) {
        if (!Number.isFinite(amount) || amount < 0) throw error('CLI reported an invalid cost.');
        usage.provider_cost = { amount, unit: fields.cost.unit };
        if (fields.cost.unit === 'USD') usage.cost_usd = amount;
      }
    }
    if (responseModel || Object.keys(usage).length) push({ type: 'message_start', message: {
      ...(responseModel ? { model: responseModel } : {}), usage: structuredClone(usage) } });
    // A failed terminal result can still report billable usage. Preserve that
    // checkpoint before rejecting its answer and completion fields.
    if (fatal) throw error(fatal.reason || 'CLI reported a forbidden or failed event.');
    const done = profile.output.done.filter(rule => matches(event, rule.when));
    if (done.length > 1 || (done.length && terminal)) throw error('CLI emitted conflicting or repeated terminal results.');
    const textRule = profile.output.text;
    if (matches(event, textRule.when)) {
      const text = at(event, textRule.path);
      if (text !== undefined && typeof text !== 'string') throw error('CLI answer text must be a string.');
      if (typeof text === 'string') {
        if (terminal) throw error('CLI emitted answer text after its terminal result.');
        answerBytes = textRule.mode === 'delta' ? answerBytes + Buffer.byteLength(text) : Buffer.byteLength(text);
        if (textRule.mode === 'delta') push({ type: 'content_block_delta', delta: { text } });
        else finalText = text;
      }
    }
    if (done.length) terminal = done[0].reason;
  };
  const decoder = new StringDecoder('utf8');
  const parseLine = line => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > limits.max_line_bytes) throw error('CLI output line exceeds the size limit.', 'E_CLI_LIMIT');
    let event;
    try { event = JSON.parse(line); } catch { throw error('CLI returned invalid JSON.'); }
    consume(event);
  };
  const acceptStdout = text => {
    if (health) { healthOutput += text; return; }
    buffer += text;
    if (profile.output.format === 'ndjson') {
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); parseLine(line);
      }
      if (Buffer.byteLength(buffer) > limits.max_line_bytes) throw error('CLI output line exceeds the size limit.', 'E_CLI_LIMIT');
    }
  };
  try {
    // Cancellation may arrive while the asynchronous workspace is being made.
    // Check again before starting any configured executable.
    if (options.signal?.aborted) throw error('CLI request cancelled before launch.', 'ABORT_ERR');
    child = spawn(command, args, { cwd: directories.workspace, env: directories.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    launched = Boolean(child.pid);
    child.once('spawn', () => { launched = true; });
    child.once('error', () => { fail('CLI executable could not be started.', 'E_CLI_SPAWN'); });
    child.once('close', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; closed = true; notify(); });
    child.stdin.on('error', () => { if (!closed) fail('CLI closed its input before accepting the request.', 'E_CLI_INPUT'); });
    child.stdout.on('data', chunk => {
      if (failure) return;
      totalBytes += chunk.length;
      if (totalBytes > limits.max_output_bytes) { fail('CLI output exceeds the size limit.', 'E_CLI_LIMIT'); return; }
      activity();
      try { acceptStdout(decoder.write(chunk)); } catch (err) { fail(err.message, err.code); }
    });
    child.stderr.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > limits.max_output_bytes) { fail('CLI output exceeds the size limit.', 'E_CLI_LIMIT'); return; }
      // A final diagnostic can arrive after a stdout/input failure. It must not
      // reset a deadline or replace that failure, but can still explain it.
      diagnostics.write(chunk);
      if (!failure) activity();
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    activity();
    const requestedTimeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : limits.total_timeout_ms;
    totalTimer = setTimeout(() => fail('CLI exceeded the overall deadline; completion is unknown.', 'E_CLI_TIMEOUT'),
      Math.min(health ? 15_000 : limits.total_timeout_ms, requestedTimeout));
    if (options.signal?.aborted) abort();
    else child.stdin.end(input);
    while (!closed) {
      while (queue.length) { const batch = queue.splice(0); for (const event of batch) yield event; }
      if (!closed) await new Promise(resolveWake => { wake = resolveWake; });
    }
    clearTimeout(silenceTimer); clearTimeout(totalTimer);
    diagnostics.end();
    if (!failure) {
      try {
        acceptStdout(decoder.end());
        if (!health && buffer.trim()) {
          if (profile.output.format === 'json') {
            let event;
            try { event = JSON.parse(buffer); } catch { throw error('CLI returned invalid JSON.'); }
            consume(event);
          } else parseLine(buffer);
        }
      } catch (err) { failure = error(err.message, err.code); }
    }
    while (queue.length) { const batch = queue.splice(0); for (const event of batch) yield event; }
    // Retain available final text as an interrupted draft, but never emit a
    // terminal success before all output and the process exit are checked.
    if (finalText !== null) yield { type: 'content_block_delta', delta: { text: finalText } };
    if (failure) throw failure;
    if (code !== 0 || signal) throw error(`CLI exited unsuccessfully${code !== null ? ` (exit ${code})` : ''}.`, 'E_CLI_EXIT');
    if (health) {
      yield { type: 'health', result: { valid: null, note: 'CLI executable responded. Authentication and generation readiness have not been verified.',
        ...(healthOutput.trim() ? { version: redact(healthOutput.trim()).slice(0, 200) } : {}) } };
      return;
    }
    if (!terminal) throw error('CLI exited without a verified terminal result.', 'E_CLI_INCOMPLETE');
    if (terminal === 'end_turn' && answerBytes === 0) throw error('CLI reported success without answer text.', 'E_CLI_INCOMPLETE');
    yield { type: 'message_delta', delta: { stop_reason: terminal }, usage: structuredClone(usage) };
    yield { type: 'message_stop' };
  } catch (err) {
    const diagnostic = diagnostics.reason();
    if (diagnostic && ['E_CLI_EXIT', 'E_CLI_OUTPUT', 'E_CLI_INPUT', 'E_CLI_TIMEOUT', 'E_CLI_INCOMPLETE'].includes(err?.code)) {
      // Preserve failure codes, accounting, and the uncertain completion state.
      // reason is the existing operator-safe contract used by the generation UI.
      err.message = redact(`${err.message} ${diagnostic}`).slice(0, 500);
      err.reason = err.message;
    }
    if (err?.code?.startsWith('E_CLI_') || err?.code === 'ABORT_ERR') throw err;
    throw error('CLI process failed.', 'E_CLI_PROCESS');
  } finally {
    options.signal?.removeEventListener('abort', abort);
    clearTimeout(silenceTimer); clearTimeout(totalTimer);
    if (!closed || stopping) await stop();
    clearTimeout(closeTimer);
    child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
    await rm(directories.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
  }
}

export function createCliClient(value, { env = process.env } = {}) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > PROFILE_BYTES) invalid('profile exceeds 64 KiB.');
  const profile = validateCliProfile(JSON.parse(encoded));
  // Snapshot trusted configuration and credentials at startup; Settings only
  // selects the existing client and cannot replace a command or profile.
  const hostEnv = { ...env };
  const profileIdentity = Object.freeze({ id: profile.id, version: profile.version,
    sha256: createHash('sha256').update(encoded).digest('hex') });
  const capabilities = Object.freeze({ systemPrompt: null, conversation: null, outputTokenLimit: null,
    reasoningEffort: null, externalTools: null, ...profile.capabilities, cancellation: true });
  return { provider: 'cli', model: profile.model, contractVersion: 1,
    version: `profile-v1:${profileIdentity.sha256.slice(0, 16)}`, profileIdentity, capabilities,
    configureRequest(params, { effort } = {}) {
      // The generation route delegates reasoning configuration to the adapter.
      // Forward it only when the loaded profile declares a native control.
      if (capabilities.reasoningEffort === true && typeof effort === 'string' && effort) params.reasoning = { effort };
      else delete params.reasoning;
    },
    stream: (params, options = {}) => runCli(profile, hostEnv, params, options),
    async health(options = {}) {
      if (!profile.health_args) return { valid: null, note: 'CLI profile loaded; no installation check is configured.' };
      for await (const event of runCli(profile, hostEnv, {}, options, true)) if (event.type === 'health') return event.result;
      return { valid: null, note: 'CLI installation status is unknown.' };
    },
  };
}

export function createCliClientFromEnv(env = process.env, cwd = process.cwd()) {
  if (!env.AI_CLI_PROFILE) return null;
  let profile;
  try {
    const path = resolve(cwd, env.AI_CLI_PROFILE);
    if (statSync(path).size > PROFILE_BYTES) invalid('profile exceeds 64 KiB.');
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source) > PROFILE_BYTES) invalid('profile exceeds 64 KiB.');
    profile = JSON.parse(source);
  } catch (err) {
    if (err.code === 'E_CLI_PROFILE') throw err;
    throw Object.assign(new Error('AI_CLI_PROFILE must reference a readable JSON profile.'), { code: 'E_CLI_PROFILE' });
  }
  // Relative paths containing a separator are resolved before changing cwd.
  if (typeof profile?.command === 'string' && !isAbsolute(profile.command) && /[/\\]/.test(profile.command)) {
    profile.command = resolve(cwd, profile.command);
  }
  return createCliClient(profile, { env });
}

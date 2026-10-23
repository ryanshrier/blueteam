// A local subprocess fixture: no network, provider SDK, or real credentials.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [scenario = 'success', ...args] = process.argv.slice(2);
if (process.env.FIXTURE_COUNT_PATH) appendFileSync(process.env.FIXTURE_COUNT_PATH, 'spawn\n');
if (scenario === 'version') {
  process.stdout.write('fixture-assistant 1.0.0\n');
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const result = (text = 'A complete briefing from the captured evidence.', extra = {}) => ({
  type: 'result', status: 'success', text, model: 'fixture-response-model',
  usage: { input: 123, output: 45, cached: 12, cost: 2.5 }, ...extra,
});
const hold = () => setInterval(() => {}, 1_000);

switch (scenario) {
  case 'success':
    emit({ type: 'progress', text: 'This progress message is not briefing text.' });
    emit(result());
    break;
  case 'json':
    process.stdout.write(JSON.stringify(result()));
    break;
  case 'conversation':
    emit(result(input));
    break;
  case 'environment':
    emit(result(JSON.stringify({ cwd: process.cwd(), env: process.env, args })));
    break;
  case 'final-replacement':
    emit({ type: 'assistant', text: 'An intermediate candidate draft.' });
    emit(result('The authoritative final briefing.'));
    break;
  case 'delta':
    emit({ type: 'text', text: 'First captured fact. ' });
    emit({ type: 'progress', text: 'Do not include progress.' });
    emit({ type: 'text', text: 'Second captured fact.' });
    emit(result(undefined, { text: undefined }));
    break;
  case 'split-lines': {
    const bytes = Buffer.from(`${JSON.stringify(result('Evidence: café, 東京, and 🚦.'))}\r\n`);
    for (let offset = 0; offset < bytes.length; offset += 3) {
      process.stdout.write(bytes.subarray(offset, offset + 3));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    break;
  }
  case 'missing-done':
    emit({ type: 'text', text: 'An unfinished briefing.' });
    break;
  case 'failed-done':
    emit(result('Failed briefing.', { status: 'error' }));
    break;
  case 'duplicate-done':
    emit(result());
    emit(result());
    break;
  case 'late-text':
    emit({ type: 'text', text: 'Candidate briefing.' });
    emit(result(undefined, { text: undefined }));
    emit({ type: 'text', text: 'Unexpected late addition.' });
    break;
  case 'trailing-error':
    emit(result());
    emit({ type: 'error', message: 'An error after the nominal final result.' });
    break;
  case 'nonzero':
    emit(result());
    process.exitCode = 7;
    break;
  case 'tool':
    emit({ type: 'tool_use', name: 'fixture-tool' });
    emit(result());
    break;
  case 'malformed':
    process.stdout.write('{ this is not JSON }\n');
    break;
  case 'large-line':
    emit(result('x'.repeat(16_384)));
    break;
  case 'large-output':
    for (let i = 0; i < 300; i++) emit({ type: 'progress', text: 'x'.repeat(100) });
    emit(result());
    break;
  case 'silent':
    hold();
    break;
  case 'active-forever':
    emit({ type: 'text', text: 'A partial briefing.' });
    setInterval(() => emit({ type: 'progress', count: Date.now() }), 40);
    break;
  case 'partial-silent':
    emit({ type: 'text', text: 'Keep this partial briefing.' });
    hold();
    break;
  case 'tree': {
    appendFileSync(process.env.FIXTURE_PID_PATH, `${process.pid}\n`);
    const depth = Number(args[0] || 0);
    if (depth < 2) spawn(process.execPath, [process.argv[1], 'tree', String(depth + 1)], {
      windowsHide: true, stdio: 'ignore', env: process.env,
    });
    emit({ type: 'text', text: 'Local process tree started.' });
    hold();
    break;
  }
  case 'secret-error':
    process.stderr.write(`Authentication failed: ${process.env.FIXTURE_CREDENTIAL}\n`);
    emit({ type: 'error', message: `Failure for ${process.env.FIXTURE_CREDENTIAL}` });
    process.exitCode = 1;
    break;
  case 'split-secret-stderr': {
    const bytes = Buffer.from(`raw-cli-diagnostic: ${process.env.FIXTURE_CREDENTIAL}\n`);
    for (const byte of bytes) {
      process.stderr.write(Buffer.from([byte]));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    process.exitCode = 7;
    break;
  }
  case 'diagnostic-stderr': {
    const messages = {
      license: 'A license agreement is required.',
      authentication: 'Invalid API key.',
      'missing-key': 'BOB_API_KEY environment variable is required.',
      gateway524: 'Request failed with status code 524.',
      gateway504: 'HTTP/1.1 504 Gateway Timeout.',
      gateway: 'The upstream gateway timed out.',
      unknown: 'Unclassified diagnostic with a private endpoint.',
      'status-prefix': 'Request failed with status code 5240.',
      'key-prefix': 'Invalid API keyboard layout.',
    };
    const bytes = Buffer.from(args[1] === 'no-newline' ? messages[args[0]].replace(/\.$/, '')
      : `raw-cli-diagnostic: ${messages[args[0]]} ${process.env.FIXTURE_CREDENTIAL}\n`);
    for (const byte of bytes) {
      process.stderr.write(Buffer.from([byte]));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    if (args[1] === 'success' || args[1] === 'nonzero-result') emit(result());
    if (args[1] === 'failed-result') emit(result('Rejected answer.', { status: 'error' }));
    if (args[1] === 'malformed') process.stdout.write('{ malformed diagnostic result }');
    if (args[1] !== 'success') process.exitCode = 1;
    break;
  }
  case 'empty-answer':
    emit(result('', { status: args[0] || 'success' }));
    break;
  case 'stop-reason':
    emit(result('A candidate briefing.', { status: args[0] }));
    break;
  default:
    throw new Error(`Unknown fixture scenario: ${scenario}`);
}

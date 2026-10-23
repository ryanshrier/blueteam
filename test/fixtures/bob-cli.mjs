// Synthetic Bob wire contract. No network access or real provider credentials.
import { appendFileSync, readdirSync } from 'node:fs';

const [scenario, ...args] = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (process.env.BOB_FIXTURE_COUNT_PATH) appendFileSync(process.env.BOB_FIXTURE_COUNT_PATH, 'spawn\n');
let transcript = '';
for await (const chunk of process.stdin) transcript += chunk;

// Each subprocess starts with a fresh HOME, so no prior interactive consent or
// workspace trust can satisfy a non-interactive invocation.
const initialHomeEntries = readdirSync(process.env.HOME);
if (!args.includes('--accept-license')) {
  process.stderr.write('A license agreement is required.\n');
  process.exit(1);
}
if (!args.includes('--trust')) {
  process.stderr.write('Workspace trust is required.\n');
  process.exit(1);
}
if (args[0] !== 'run' || option('--mode') !== 'ask' || !process.env.BOB_API_KEY) {
  process.stderr.write('Invalid non-interactive invocation.\n');
  process.exit(1);
}

const result = {
  type: 'result', status: 'success',
  stats: { input_tokens: 321, output_tokens: 87, cache_read_tokens: 64, session_costs: 0.75, tool_calls: 0 },
};
let answer = 'The captured evidence supports this completed briefing.';
switch (scenario) {
  case 'inspect':
    answer = JSON.stringify({ args, transcript, cwd: process.cwd(), home: process.env.HOME,
      userprofile: process.env.USERPROFILE, config: process.env.XDG_CONFIG_HOME, initialHomeEntries });
    break;
  case 'success':
    break;
  case 'delayed-json':
    await new Promise(resolve => setTimeout(resolve, 1_000));
    break;
  case 'error-result':
    result.status = 'error';
    break;
  case 'error-event':
    result.type = 'error';
    break;
  case 'tool-use':
    result.type = 'tool_use';
    result.name = 'browser';
    break;
  case 'tool-result':
    result.type = 'tool_result';
    break;
  case 'tool-count':
    result.stats.tool_calls = 1;
    break;
  case 'nonzero':
    process.exitCode = 1;
    break;
  case 'empty-answer':
    answer = '';
    break;
  case 'silent':
    setInterval(() => {}, 1_000);
    break;
  default:
    throw new Error(`Unknown Bob fixture scenario: ${scenario}`);
}

if (scenario !== 'silent') {
  if (option('--format') === 'json') {
    // Bob's complete JSON result includes last_message. Pretty printing also
    // ensures the runner cannot accidentally treat this as NDJSON.
    process.stdout.write(`${JSON.stringify({ ...result, last_message: answer }, null, 2)}\n`);
  } else if (option('--format') === 'stream-json') {
    process.stdout.write(`${JSON.stringify({ type: 'assistant', content: answer })}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write('Unsupported output format.\n');
    process.exitCode = 1;
  }
}

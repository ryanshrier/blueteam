# CLI provider profiles

The experimental built-in **CLI (JSON profile)** provider runs one non-interactive assistant process per application attempt. Its version 1 profiles support stdin input and JSON or newline-delimited JSON output. All executable names, arguments, event mappings, tool-disabling flags, credential variable names, and cost units belong in the JSON profile.

Install the assistant CLI separately, inspect a profile in `config/cli-profiles/`, and copy it to an operator-managed location if you need changes. Set:

```dotenv
AI_PROVIDER=cli
AI_CLI_PROFILE=./local/assistant-profile.json
```

Supply the environment variables named in that profile's `env_required` before starting the server. The profile contains variable names, never credential values. BlueTeam does not save CLI credentials through Settings. An operator-managed `.env` file is still a file on disk; environment forwarding cannot guarantee that a third-party CLI never stores a credential.

Restart after changing the profile, executable, or environment. Relative profile paths and command paths containing a separator resolve from the application directory. A bare executable name is resolved using the child's allowlisted `PATH`. On Windows, name an `.exe` or an explicit runtime such as `node.exe` with a script path in `args`; `.cmd`, `.bat`, and `.ps1` launch targets are rejected. No shell is inserted to make an unsupported launcher work.

A previously saved provider selection takes precedence: choose **CLI (JSON profile)** in Settings and save. **Check status** runs only the configured `health_args`; configure those as a version/help operation that does not generate or charge. A successful installation check returns `valid: null`, because it does not establish authentication or generation readiness. The runner cannot prove that an arbitrary command is free of charges.

## Bob Shell profile

The bundled `config/cli-profiles/bob.json` runs `bob run --accept-license --trust --mode ask --format stream-json --workspace {workspace}` with the transcript on stdin. The runner creates a fresh private home for each attempt, so Bob cannot reuse a user's saved `licenseConsent`. The explicit license flag accepts IBM's license for that invocation, and `--trust` trusts the fresh workspace. `BOB_API_KEY` is still required; an interactive Bob login does not authenticate `bob run`. These flags and stdin support are documented in IBM's [non-interactive session guide](https://bob.ibm.com/docs/shell/getting-started/start-bobshell-non-interactive).

The `bob-shell-v2` profile parses newline-delimited JSON and joins `content` chunks in order from events with `type: "message"`, `role: "assistant"`, and `isReasoning` other than `true`. User messages and reasoning content never enter the answer. The terminal result supplies completion status and usage; success still requires `type: "result"`, `status: "success"`, and a zero exit code. Streamed output resets the silence timer as it arrives. The bundled profile allows 120 seconds of silence and 300 seconds total per invocation. The application's remaining generation time can shorten that deadline: its default 300-second budget is shared by the initial call and any corrective retry. An explicit `analysisSettings.generationTimeoutSec` remains authoritative. `restarts` stays `0`; a timeout fails the attempt and does not launch another potentially billable run. Receipts record the profile identity and configured generation budget.

Copied operator profiles retain their own limits. Merge these values into the active copy and restart to adopt them. A longer finite deadline gives a slow invocation more time; it does not establish why an earlier run stalled. A completed initial draft may need one separately recorded corrective call, so account allowance must cover both. A reported budget-exhaustion error does not identify whether that allowance belongs to a key, user, team, or billing period; check the applicable provider account before requesting more work.

Bob pre-approves tools in non-interactive runs, so Ask mode alone is insufficient for this provider. The profile passes `--disable-mcp`, `--disable-subagents`, and an expanded group denylist including `browser`, `command`, `subtask`, `workflow`, `artifact`, and `plan`. IBM's [Shell tool guide](https://bob.ibm.com/docs/shell/core-concepts/tools), [Shell custom modes](https://bob.ibm.com/docs/shell/configuration/custom-modes-bobshell), and [IDE custom modes](https://bob.ibm.com/docs/ide/configuration/custom-modes) list differing group sets. The additional names cover reported installed-version groups; verify the launch controls against the installed Bob version. The result's `stats.tool_calls` also rejects reported tool activity.

## Trust and isolation

A profile is trusted execution configuration. It selects a program that receives credentials and runs with the server's OS permissions. Review the executable and its version as well as the JSON. Profiles cannot be created, replaced, or uploaded through Settings. The provider loads the profile once at startup, enforces a 64 KiB limit, rejects unknown fields, and accepts fixed selectors and comparisons rather than code or regular expressions.

Each invocation receives a new empty working directory, private home/config/cache/data/state directories, and private temporary directories. The runner overwrites `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `TMPDIR`, `TMP`, and `TEMP`; these cannot appear in `env_allow`. Other variables are passed only when explicitly allowlisted. On Windows, allowlist `SystemRoot` if the CLI needs it. Credentials, proxy settings, runtime injection variables, and existing agent sessions are not inherited implicitly.

This is process hygiene, not an OS sandbox: the executable retains filesystem and network access available to the server account. Tool-use event detection is a violation check, not a way to prevent a tool from executing. Disable tools using verified launch controls for the installed CLI version. `externalTools: false` requires a separate nonempty `tools.disabled_args` list, which the runner always appends, but remains an operator declaration about those controls. Unknown capabilities remain `null`.

## Profile fields

| Field | Meaning |
| --- | --- |
| `version`, `id`, `model` | Required schema version `1`, stable profile identifier, and configured model identifier. Use `cli-default` when the CLI chooses a model that cannot be selected explicitly. |
| `command`, `args` | One executable and an argument array; no shell command string. |
| `input` | `{ "transport": "stdin", "format": "json" }` or `transcript`. |
| `env_allow`, `env_required` | Allowed environment variable names and an optional required subset. Missing required values stop the request before launch. |
| `capabilities` | Optional boolean declarations: `systemPrompt`, `conversation`, `outputTokenLimit`, `reasoningEffort`, `externalTools`. Cancellation is supplied by the runner. |
| `tools.disabled_args` | Optional arguments that disable tools before the process starts. Required to declare `externalTools: false`. |
| `output.format` | `json` for one complete object, or `ndjson` for one object per line. Blank lines are ignored; malformed JSON fails the attempt. |
| `output.text` | `{ "path": "answer", "mode": "final", "when": [...] }`. `final` retains the last matching answer; `delta` appends matching fragments for NDJSON. Select only answer content, excluding reasoning and intermediate drafts. |
| `output.fail_on` | Optional array of `{ "when": [...], "reason": "Safe fixed error message" }`. Checked before answer/completion selectors. |
| `output.done` | Required array of `{ "when": [...], "reason": "end_turn" }`, mapping explicit terminal statuses to `end_turn`, `max_tokens`, or `refusal`. |
| `output.model` | Optional field path for the actual returned model. Missing actual model stays unknown. |
| `output.usage` | Optional field paths `input_tokens`, `output_tokens`, `cached_input_tokens`, and `cost: { "path": "stats.cost", "unit": "credits" }`. Counts and costs are cumulative for this process, not increments. |
| `limits` | Optional bounded limits listed below. |
| `restarts` | Omit or set to `0`. Other values are rejected in v1. |
| `health_args` | Optional argument array used instead of generation arguments for an installation check, with an additional 15-second maximum. |

Arguments support only `{workspace}`, `{home}`, `{model}`, `{max_tokens}`, and `{reasoning_effort}` substitutions. No prompt or credential interpolation is supported. `max_tokens` and reasoning controls are effective only when the CLI actually honors the corresponding argument or JSON input field; do not declare these controls based on a transcript instruction.

JSON stdin contains `{ "model", "system", "messages", "max_tokens", "reasoning_effort" }`; optional undefined fields are omitted. All messages, including rejected assistant drafts and later corrective user messages, are retained in order. Transcript stdin contains the system instructions followed by the entire ordered message array serialized as JSON. This preserves the content but does not create native system/conversation roles; transcript profiles cannot declare those native capabilities as true.

Paths use dotted object keys and numeric array indices, such as `stats.output_tokens` or `content.0.text`. Each `when` is an AND of comparisons. Rules within `fail_on` are alternatives. A comparison has a `path` and exactly one of `equals`, `not_equals`, or `exists`:

```json
[
  { "path": "type", "equals": "message" },
  { "path": "role", "equals": "assistant" },
  { "path": "isReasoning", "not_equals": true }
]
```

Equality uses JSON primitive values with their exact types. A missing field differs from every literal (including `null`); add `exists: true` as a separate comparison when missing fields should fail a rule. No JSONPath filters, expression evaluation, globbing, or regex truncation detection are supported.

## Completion, cancellation, and accounting

BlueTeam accepts completion only after exactly one terminal rule matches, the process exits with code zero, and all output has been parsed without a fatal event. A success result followed by an error, nonzero exit, another terminal result, or more answer text fails the attempt. EOF and exit zero alone never mean completion. A final answer is emitted once; delta mode never appends a second copy from a result summary. Available partial text is retained for the application's interrupted-draft handling.

Use structured status fields for `max_tokens` and `refusal`. If the CLI only reports a prose truncation warning, v1 cannot certify it as a completed result: choose conservative terminal/failure rules for that CLI version. The runner does not strip text or infer completion from phrases in the answer.

Silence, overall deadline, abort, parse failure, or size-limit failure stops the local process tree. Windows uses `taskkill /T /F`; Unix uses a dedicated process group with termination followed by a bounded forced kill. Temporary directories are removed on cleanup. Local cancellation cannot prove a remote request stopped charging. Errors after process launch retain an uncertain outcome and prevent automatic scheduled repurchase; a new manual generation is an explicit new attempt.

The runner never restarts, even if a caller supplies a nonzero retry count. BlueTeam's separately recorded corrective attempts after a verified result still apply. Every invocation receives a fresh workspace and complete conversation, without resuming an unrelated session.

Generation receipts record the profile ID, schema version, and SHA-256 identity of the loaded configuration, plus actual model and usage when reported. Non-USD `providerCost` remains an amount/unit pair. Only explicit `USD` populates `costUsd`; CLI model names never trigger API-list-rate estimates. Missing USD cost stays unknown. BlueTeam redacts forwarded environment values from errors and installation output and does not save raw diagnostic logs.

On failure, the runner recognizes a small set of stderr signatures for provider budget/allowance exhaustion, required license acceptance, API-key/authentication errors, and gateway timeouts (including HTTP 504 and 524). It appends a fixed, actionable diagnosis to the original error; arbitrary stderr text, endpoints, and credentials are withheld. Matching uses a bounded in-memory window and never changes success criteria, failure codes, or restart behavior. A budget error during the corrective call keeps the original rejected draft and its source findings available. Unknown or absent stderr diagnostics still produce the generic failure, and failures available only in Bob's private log files are not inspected.

| Limit | Default | Maximum |
| --- | --- | --- |
| `silence_timeout_ms` | 60,000 | 3,600,000 |
| `total_timeout_ms` | 180,000 | 3,600,000 |
| `max_input_bytes` | 8 MiB | 32 MiB |
| `max_output_bytes` | 8 MiB, stdout and stderr combined | 32 MiB |
| `max_line_bytes` | 1 MiB per NDJSON line | 4 MiB |
| `kill_grace_ms` | 500 on Unix | 5,000 |

All values are positive integers. The application's remaining generation deadline also bounds each invocation. Output on either stream resets the silence timer but never extends the overall deadline. Tests use a local synthetic assistant process and do not certify the installed third-party CLI, its billing behavior, or its tool controls.

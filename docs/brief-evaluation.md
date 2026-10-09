# Briefing evaluation

[Development guide](development.md)

Run `npm run check:brief-eval` for the offline evaluation. It exercises the real
generation route, prompt construction, validation, corrective retry, receipt,
and attempt accounting against six authored collections. Provider responses are
scripted; no API key or provider network request is needed. The suite also runs in
CI and exercises both the Anthropic event contract and the real OpenAI Responses
stream adapter with scripted HTTP responses.

The collections cover tactical, operational, and strategic evidence, conflicting
reports about two CVEs, a promotional article opening with a useful feed excerpt,
and title-only inputs. The last case must stop before contacting the provider.
A separate case requires a malformed first draft to receive one corrective retry
and accounts for both attempts.

## Optional live evaluation

The optional live evaluation supports Anthropic (the default) and OpenAI. It
sends synthetic collections to the explicitly selected provider. It does not read
the operator collection, publish to the application archive, update settings, or
send webhooks. It requires an explicit cost reservation and output directory:

```bash
npm run check:brief-eval -- --live --budget-usd 2 --output .internal/evaluation
```

For OpenAI, use `--provider openai`. Its default model is the application's
`gpt-5.3-codex`; `--model` can select an OpenAI model with a known price in the
application's cost estimator, including `gpt-6.1-sol`. Unknown model prices stop the evaluation before
any provider call. Model access still depends on the API account.

These PowerShell commands prompt for the key without putting it in command
history, use a unique private output directory, and restore any prior process
key afterward:

```powershell
# Run from the repository root.
npm run check:brief-eval -- --provider openai --model gpt-6.1-sol

$evaluationOutput = Join-Path '.internal' ('evaluation-openai-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$previousOpenAiKey = $env:OPENAI_API_KEY
$evaluationKey = Read-Host 'OpenAI API key' -AsSecureString
try {
    $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $evaluationKey).Password
    npm run check:brief-eval -- --live --provider openai --model gpt-6.1-sol --budget-usd 2 --output $evaluationOutput
} finally {
    $env:OPENAI_API_KEY = $previousOpenAiKey
    $evaluationKey.Dispose()
    Remove-Variable previousOpenAiKey, evaluationKey
}

$evaluation = Get-Content -LiteralPath (Join-Path $evaluationOutput 'evaluation.json') -Raw | ConvertFrom-Json
$evaluation.cases | Select-Object id, published, code, providerAttempts, costUsd | Format-Table -AutoSize
$evaluation.cases | ForEach-Object {
    $caseId = $_.id
    $_.issues | Select-Object @{Name='case'; Expression={$caseId}}, code, severity, message
} | Format-List
```

Provide `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the process environment, or add
`--key-file data/settings.local.json` to read the selected provider's key from an
existing protected local key file (`openaiKey` or `anthropicKey`). Application
provider/model settings and `.env` are not loaded by this harness.
Do not put the key itself in a command, fixture, report, or issue. The key-file
option is read only in explicit live mode. Treat the output directory as private.

This harness fixes the selected model and an 8,000-token output limit, runs sequentially, disables SDK
retries, and allows at most two provider attempts per collection. Before each
attempt it reserves a conservative input-byte allowance and the full output
limit against the same model-specific standard token rates used by the application.
OpenAI reasoning tokens share the output allowance. Reservations use uncached
input prices plus applicable cache-write and long-context premiums; usage estimates apply known cached-input discounts without adding
reasoning tokens a second time. Reservations are never refunded during a
run; the maximum accepted CLI budget is $5. This is a local reservation policy,
not a provider billing limit. The final report separates actual returned token
usage estimates, incomplete usage, and requests rejected locally before spend.
Review the configured model and documented pricing before a future live run.

The report preserves provider/model selection, accepted provider attempts, final
generated drafts, publication outcomes, receipts for published and rejected drafts,
citation coverage across horizons,
priority CVEs, and required conflicting-source citations. The command fails on
unexpected publication outcomes, authored coverage gaps, incomplete usage, or
local policy rejections. A failed run is evidence to inspect; do not repeat paid
generation simply to obtain a passing result.

## What the checks establish

Publication requires useful retained publisher text or structured NVD evidence.
An unusable article opening can fall back to that publisher's feed excerpt.
Title-only, promotional, interstitial, and fragmentary passages receive explicit
quality diagnostics. Mixed useful and weak citations require review.

Bounded checks catch specific unsupported CVEs, scores, versions, KEV claims,
retrospective numeric durations, selected comparisons, and contradictory closed
list counts. They intentionally abstain on ambiguous subsets and open lists.
Historical editions are preserved; replaying a validator does not rewrite them.

These checks do not establish that every narrative claim follows from its source.
A matching phrase can have different meaning or polarity, and a useful passage
does not prove every mechanism, scope, chronology, consequence, or forecast in
the generated judgment. Review the draft against retained evidence, including
executive summaries and convergence sections. Citation coverage does not measure
decision usefulness. This small authored stress set cannot estimate reliability
on production collections.

## Editorial review: one assessment at different depths

Review Overview and Full report together against the retained evidence. A saved
content hash prevents an old summary from being applied to a changed report; it
does not establish that the summary is faithful. The offline checks likewise
cannot judge whether a reader understands the priority.

Use these questions for an editorial pass. Record the passage that needs work
and a concrete correction, rather than assigning an unsupported accuracy score.

| Reader | Question the brief should answer |
| --- | --- |
| Analyst | What happened, under which affected conditions, and what evidence or investigation step follows? |
| Director | Which response leads, who owns it, what must happen first, and what demonstrates completion? |
| VP | What operational consequence or unresolved exception needs coordination? |
| CISO | What materially changes the risk picture, what remains unknown, and what would warrant escalation? |

These are reading depths, not separate intelligence horizons. A tactical
vulnerability may matter to all four readers. Do not invent business impact,
local deployment, capacity limits, or a strategic trend to fill a role's row.
Where relevance is not established, the honest answer is the bounded
applicability check.

| Review | Acceptance question |
| --- | --- |
| Edition lead | Does it explain the consequential development, implication, and material uncertainty in a short paragraph? |
| Priority | Is there an evidence-based reason one response leads, with conditional ranking where local exposure is unknown? |
| Added value | Do evidence, impact, and actions add understanding beyond the Assessment instead of repeating it? |
| Faithful compression | Do Overview, BLUF, executive decisions, and the leadership line preserve the report's actor, source authority, affected conditions, material uncertainty, and paired response? |
| Owned response | Can the reader distinguish what starts now from what completes later, including prerequisites, recovery conditions, and completion evidence? |
| Currency | Is the assessment date distinct from current reporting and from each source's publication or event date? |
| Reader voice | Does the copy state the useful fact or limitation directly, without debating a rejected draft or the validator? |

The BLUF target of about 65 words and the Assessment target of 35–55 words are
editing aids. Keep a necessary condition rather than cutting to a number. A
word count is neither a factual evaluation nor a publication blocker. The
validator's BLUF length feedback is advisory; its existing structural and
grounding requirements still apply.

### Synthetic reference comparisons

The following invented cases are editorial reference examples, not real threat
reporting or a model benchmark. Use them when reviewing a generated draft or a
presentation change. The facts listed in each case are the entire evidence
available for that case; the examples do not authorize new controls or claims.

**Paired response with unknown deployment.** A vendor says an exposed gateway
build is affected, a fixed build is available, and exploitation preceded
disclosure. The vendor calls for both patching and a compromise review. Local
deployment is unknown, and the report gives no exploitation start date.

- Faithful Overview: “Affected, exposed gateways need patching and a separate
  compromise review because exploitation preceded disclosure. Confirm local
  deployment and exposure before treating the warning as applicable; the
  reporting does not establish when exploitation began.”
- Reject: “Patch our gateways to end the attack.” This assumes deployment and
  an ongoing local incident, promises an outcome, and loses compromise review.
- Full report should add the cited affected and fixed builds, separate owners
  for patching and review, a current-shift applicability check, prerequisites,
  and completion evidence. A proposed investigation period must explain its
  basis and retention limits; disclosure is not an assumed attack-start date.

**Incomplete guidance with a bounded next step.** One researcher reports active
exploitation of an application. The retained passage does not establish the
affected versions, mitigation, or a fixed release. Local deployment is unknown.

- Faithful developing summary: “A researcher reports exploitation, but version
  scope and response guidance remain unconfirmed. Establish whether the
  application is deployed and retrieve the vendor's guidance before prescribing
  a technical change.”
- Reject: “Disable the exposed feature while awaiting a patch.” No feature,
  safe workaround, local exposure, or patch status is established.
- Full report should attribute the report, expose the evidence limit, assign
  bounded inventory and source-retrieval tasks, and name the new evidence that
  would support promotion to a Key Judgment. A summary must not silently turn
  a source-acquisition task into an unsupported mitigation.

**Operational finding with limited scope.** A published exercise found that its
participants had no named owner for revoking remote-support sessions. It
recommends documenting escalation authority and testing revocation. It reports
no production intrusion and says nothing about the reader's organization.

- Faithful Overview: “An exercise exposed a gap between recognizing a
  compromised support session and authorizing its revocation. The finding
  supports checking local escalation ownership and testing revocation; it
  does not establish a local control failure or a wider trend.”
- Reject: “Leadership must fix our systemic remote-support weakness.” This
  converts another team's exercise into an established local and systemic fact.
- Full report should add the exercise's scope and source, the process dependency,
  and an owned check with observable completion evidence. Directors may need to
  resolve an authority gap if the local check finds one; a strategic section or
  quantified financial impact is not required to make the finding useful.

During layout review, start at 1440×900 and repeat at 1280×800. Read the first
screen without expanding details, then follow one story into its full
assessment. Confirm that the opening supports a sound priority decision and
that deeper reading exposes the facts, qualifications, full response, and
citations. Never hide a material limitation solely to make a card shorter.

# Briefing evaluation

[Development guide](development.md)

Run `npm run check:brief-eval` for the offline evaluation. It exercises the real
generation route, prompt construction, validation, corrective retry, receipt,
and attempt accounting against seven authored collections. Provider responses are
scripted; no API key or provider network request is needed. The suite also runs in
CI and exercises both the Anthropic event contract and the real OpenAI Responses
stream adapter with scripted HTTP responses.

The collections cover tactical, operational, and strategic evidence, conflicting
reports about two CVEs, a promotional article opening with a useful feed excerpt,
complementary feed/article details, and title-only inputs. The last case must stop
before contacting the provider. The complementary case requires preserving the
CVE, affected range, and fixed release through generation and frozen replay.
A separate case requires a malformed first draft to receive one corrective retry
and accounts for both attempts.

## Retained edition replay

Run `npm run check:brief-replay -- --output .tmp/retained-replay.json` to inspect
up to 100 local archived editions and 100 retained recovery artifacts against
their frozen inputs. Use `--archive` for another local archive and `--limit`
to change the bound (1–500). The report file must be new and outside the archive.
This command does not call a provider, initialize the application database,
rewrite editions, change review dispositions, or publish recovery drafts.

The report separates missing receipts and integrity failures from current
validation findings. It includes captured attempts, cost and phase timings when
available, selection diagnostics, judgment/action counts, and retained operator
saves. Action-condition and CVE counts are lexical review aids: they cannot
establish supported meaning, usefulness, recall, or an overall manual-edit rate.
Older receipts cannot reconstruct excluded candidates. Selection regression
fixtures separately exercise the bounded candidate pool and investigation budget.
Use the editorial rubric below to inspect decision-changing detail and paired
responses when comparing repaired drafts; fewer findings alone is not improvement.

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

## Recovery quality and evidence gaps

Corrective generation gets one bounded attempt. Its request prioritizes blocking
findings, includes captured source references, and asks for changes limited to
the affected passages and dependent summaries/actions. The replacement must
resolve material findings without introducing new ones. A complete draft cannot
be replaced by an incomplete response or one with fewer judgments. Output-limit
recovery can still request a shorter complete edition. Both attempts remain in
cost accounting; each evaluated candidate records its recovery decision in the
receipt's validation history.

These are regression checks, not a semantic quality score. Equal judgment counts
do not prove equal coverage, and passing factual checks does not establish that
priorities, conditions, or actions survived a rewrite. Use retained failures to
compare supported specificity, important coverage, action scope, and manual
intervention alongside publication outcomes. Do not improve acceptance rates by
automatically dropping signals or broadening affected-version guidance.

The October 9, 2026 local pipeline audit also addressed upstream capture losses:

- **Source capture:** retain the richest usable same-item RSS/Atom field while
  keeping the short Wire description. Preserve substantive feed and article
  passages as separate captures under one citation identity. Neither capture is
  independent corroboration of the other. Do not erase a feed's title-bound CVE
  association merely because an article repeats its text.
- **Provenance:** each capture carries its own observation metadata and passage
  digest. Article excerpts never inherit feed revision IDs or retrieval times.
  Missing article provenance stays explicitly unavailable. Stale or unusable
  article bodies cannot become current supporting evidence.
- **Enrichment:** article extraction precedes CVE and EPSS enrichment within the
  existing selection and request limits. Usable article-only identities can reach
  both providers. NVD applicability is supplied separately from publisher prose,
  preserving AND/OR, negation, vulnerable-product flags and inclusive/exclusive
  boundaries. A range endpoint does not establish a patched release or local
  exposure; complex applicability must not be flattened into an affected list.
  Version checks can recognize attributed, identity-bound reports of NVD bounds
  and conditional ranges with matching endpoint roles from the same CPE match.
  This is additive literal support, not general interpretation of applicability.
  Hidden, conflicting, rejected, environmental or negated conditions do not
  supply automatic positive version support. Vendor fix claims still require
  captured prose support.
- **Catalog freshness:** generation captures the catalog observation time, its
  freshness against the shared 12-hour refresh interval, and known refresh
  failure. Retained positive membership remains available. Stale or unknown
  freshness cannot establish current absence or a zero-addition count. Replaying
  a saved draft uses its captured status, not today's catalog or clock; older
  receipts retain their original verification contract.
- **Consumers:** CVSS and timeline checks keep each capture's identity scope.
  Precision and editorial checks inspect each usable passage, not just the
  preferred excerpt. Edition comparisons include complementary passage changes.

The provider still returns a complete replacement document. Evaluate localized,
evidence-backed repair before adding more retries. Manual editing remains a
fallback through Edition tools; refreshing collection does not silently replace
a saved draft's frozen evidence. Passage bounds and lookup budgets still limit
what the writer can know, and deterministic checks cannot prove arbitrary prose
entailment. Test useful retained detail and priority coverage alongside acceptance.

The code paths and capture losses were inspected or reproduced offline. Their
frequency in production and contribution to another installation's failures have
not been measured. Replay that installation's receipt before attributing an
incident to one of these gaps. No live-provider result is implied by scripted
evaluation.

The score-report smoke gate checks all 21 cross-band pairs in its eight authored
examples, in addition to band means and bounded component invariants. This
prevents a mean from hiding an individual ordering inversion, but it is still
a small synthetic regression fixture. A larger, independently adjudicated
retained-evidence corpus is required before claiming production ranking recall
or precision; neither these tests nor scripted provider outputs establish it.

The [local ranking benchmark](ranking-benchmark.md) now captures bounded complete
retained candidate pools, including selection exclusions, before and after
enrichment. It supports blinded human-review exports, independently attested
reviewers, third-person adjudication, incident/time leakage checks, and offline
metrics with explicit annotation coverage and denominators. It contains no expert
labels by default and does not measure upstream reports absent from collection.
The existing selected-only archive and authored scoring fixture remain separate
diagnostics; neither is silently relabeled as a production benchmark.

### Action consistency, priority coverage, and extraction regressions

Executive decisions reference canonical actions (`S1.A1` means the first action
of the first judgment). Checks compare the referenced response, assigned owner,
and target within its judgment; a different story's date cannot satisfy that
association. Different containment and recovery targets remain separate summary
decisions. Contradictory dates block publication. Where bounded prose checks
cannot establish an action association, the draft requires an explicit review;
a model-supplied reference is not proof of semantic equivalence.

An action that actually instructs multiple containment, investigation, or recovery
phases requires `ACTION_PHASE_BUNDLE_REVIEW`. Split those phases into separately
owned deliverables and achievable targets, naming dependencies when needed.
Scoped cross-functional work, log preservation, and mentions of a recovery plan
do not alone trigger this bounded prose check. Prompts target 1,200–1,800 words
for a full six-signal edition while retaining decision-changing qualifications.

New generations capture a bounded priority list from selected evidence and ask
for covered, duplicate, or deferred dispositions. Covered items must reference
real judgments or Watchlist entries with supporting exact citations and visible
event identity. Unexplained, unsupported, or deferred priority items require
review against the saved evidence. Ranking alone does not mandate inclusion.
Version 2 groups justified same-event reports before applying the eight-event
cap. Material overflow and unresolved important KEV leads require review;
bounded named overflow remains in the receipt. Version 1 receipts retain their
original diagnostics-only overflow policy, and older receipts without a coverage
contract are unevaluated. Federal remediation dates
retain their FCEB scope and never establish local exposure or a local deadline.

Article extraction excludes advertisement and related-story containers before
excerpting. Quality checks reject off-topic promotional text and unrelated
advisory teasers while preserving usable same-source feed evidence. Versioned
extraction caches prevent old extracts from returning through 304 responses or
failed-refresh fallbacks. Replay applies the current quality policy to immutable
captured parts, reports original/current classifications, and uses only accepted
passages for current claim support. It does not retrieve newer evidence or
rewrite historical receipts.

Article retrieval gives distinct events a first pass before additional publisher
copies consume capacity. Earlier captured passages may supply dated qualifications
only when the current source is thin and the publisher, URL, title, and publication
day match exactly. This context is bounded to five receipts, eight sources, and
72 hours, retains its original retrieval time, and cannot revive a stale or
title-only current source. It does not authorize new current facts, refresh
evidence age, or count as independent corroboration. Prior model prose remains
topic continuity only.

Regression fixtures include the October 9 Ahsay date mismatch, the omitted CISA
advisory, both rejected article passages, valid short advisories/training stories,
legitimate duplicate coverage, forged references, stale approvals, and repaired
metadata. These deterministic tests and receipt replays make no provider calls;
they do not establish general editorial recall or complete factual entailment.

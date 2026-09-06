# Briefing evaluation

[Development guide](development.md)

Run `npm run check:brief-eval` for the offline evaluation. It exercises the real
generation route, prompt construction, validation, corrective retry, receipt,
and attempt accounting against six authored collections. Provider responses are
scripted; no API key or network request is needed. The suite also runs in CI.

The collections cover tactical, operational, and strategic evidence, conflicting
reports about two CVEs, a promotional article opening with a useful feed excerpt,
and title-only inputs. The last case must stop before contacting the provider.
A separate case requires a malformed first draft to receive one corrective retry
and accounts for both attempts.

## Optional live evaluation

Live evaluation sends these synthetic collections to Anthropic. It does not read
the operator collection, publish to the application archive, update settings, or
send webhooks. It requires an explicit cost reservation and output directory:

```bash
npm run check:brief-eval -- --live --budget-usd 2 --output .internal/evaluation
```

Provide `ANTHROPIC_API_KEY` in the process environment, or add
`--key-file data/settings.local.json` to use an existing protected local key file.
Do not put the key itself in a command, fixture, report, or issue. The key-file
option is read only in explicit live mode. Treat the output directory as private.

This harness fixes the model and output limit, runs sequentially, disables SDK
retries, and allows at most two provider attempts per collection. Before each
attempt it reserves a conservative input-byte allowance and the full output
limit against standard token rates. Reservations are never refunded during a
run; the maximum accepted CLI budget is $5. This is a local reservation policy,
not a provider billing limit. The final report separates actual returned token
usage estimates, incomplete usage, and requests rejected locally before spend.
Review the configured model and documented pricing before a future live run.

The report preserves accepted provider attempts, final generated drafts,
publication outcomes, available receipts, citation coverage across horizons,
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

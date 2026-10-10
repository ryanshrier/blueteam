# Local ranking benchmark

This tooling records actual collection candidates and supports independent human
review. It does not create expert labels, replay external services, upload data,
or infer production quality from the existing synthetic scoring examples.

## Collection and retention

The server configures `lib/ranking-benchmark.js` with a directory under its local
state data. The next authorized collection is eligible for capture. Defaults are
at most one capture per hour, 48 captures, 14 days, 64 MiB total, 8 MiB per capture,
and 5,000 candidates/observations. Configured bounds may be lowered. Files use
mode 0600 and their directory uses 0700 on POSIX; Windows uses the state directory's
inherited access controls. Captured source passages and the effective team profile
are private operational data. Keep review copies private too.

Each complete capture contains:

- All observations returned by RSS/search collection, including the recurring
  editorial feature excluded before ranking.
- Every admitted deduplicated candidate before local enrichment, after the first
  scoring/selection pass, and after article/CVE enrichment and final scoring.
- Original retained passages, source-member evidence references, timestamps,
  source revisions, positive KEV facts when available, and bounded CVSS/EPSS data.
- Actual initial/final selection, investigation eligibility, enrichment-pool
  eligibility, final rank, score components, and stage reasons. Enrichment-pool
  eligibility does **not** mean a request occurred; budgets can still omit it.
- Frozen scoring clocks, collection start/end timestamps, allowlisted effective
  scoring configuration and watch profile, and hashes of implementation files
  and the dependency lockfile. Provider settings, webhook URLs and arbitrary
  configuration keys are excluded.

The pool begins **after upstream collection filters and scan limits**. It cannot
measure reports a feed never returned or items rejected before collection returned
them. Deduplicated candidates retain their source members; editorial exclusions
remain reviewable candidates for end-to-end retained-pool recall.

Bounds or storage failures reject the entire capture rather than silently dropping
candidates. Normal collection can still succeed. `getRankingBenchmarkStatus()`
and the pipeline's `stats.rankingBenchmark` distinguish captured, interval-skipped,
disabled and unavailable states. Failed collections have no complete capture.
These are sampled observations, not an exhaustive history of every refresh.

## Freeze a review window

Copy the desired `ranking-*.json` files into a new private review directory before
exporting. Keep whole captures; never remove candidates from their envelopes.
Use no more than 48 files/64 MiB in one dataset. Automatic retention continues in
the live capture directory and can otherwise remove a review's inputs.

Choose windows covering different reporting volumes, source types, threat classes
and declared profiles. A 100–200 incident pilot helps test the rubric; it is not
enough to claim broad production precision or recall. Avoid selecting only runs
where a known important incident appeared near the top.

The commands below are offline. All output paths must be new files. Parent output
directories must already exist. Re-running an export with a new name randomizes
item order and leaves the frozen evidence unchanged.

```sh
node scripts/ranking-benchmark.mjs export --captures PRIVATE_WINDOW --out reviewer-a.json
node scripts/ranking-benchmark.mjs export --captures PRIVATE_WINDOW --out reviewer-b.json
```

Give each reviewer a separate export. Exports omit scores, urgency assessments,
ranks, selection/investigation flags, and later outcomes. Reviewers see the team
profile, retained factual evidence and its end-of-collection cutoff. Article and
enrichment availability can differ because acquisition was selective. A nonpositive
ranking KEV flag becomes unknown in the review; it does not prove catalog absence.

## Independent annotation

Two people should review independently, without system scores, the other person's
labels, or later incident outcomes. Each fills `reviewer.id`, `name`, `reviewedAt`
(an ISO timestamp) and the independence attestation. The tool can require distinct
identities and attestations; it cannot prove reviewer independence or expertise.

For each item, complete only its `label`:

| Priority | Meaning at the captured evidence cutoff |
| --- | --- |
| `critical` | Supported issue this declared team should triage immediately |
| `relevant` | Useful monitoring or investigation for this team |
| `not-relevant` | Reviewed and outside the declared scope |
| `unknown` | Insufficient evidence to determine priority |
| `null` | Not yet judged; keep the other label fields empty |

Give known judgments a stable `incidentId`, a rationale and `evidenceRefs`
containing the item's provided `evidenceRef`. Use the same incident ID for repeated
reporting of the same event across runs, but do not collapse unrelated events about
one vendor. Explain conditional exposure rather than assuming the organization
deploys a mentioned product. Ties are valid; an exact total ordering is unnecessary.
Unknown and unjudged items never become negative labels.

```sh
node scripts/ranking-benchmark.mjs import --captures PRIVATE_WINDOW --review reviewer-a.json --out accepted-a.json
node scripts/ranking-benchmark.mjs import --captures PRIVATE_WINDOW --review reviewer-b.json --out accepted-b.json
node scripts/ranking-benchmark.mjs adjudication-template --captures PRIVATE_WINDOW --review accepted-a.json --review accepted-b.json --out adjudication.json
```

Import checks candidate coverage, evidence hashes and label structure. Every
candidate must remain in a review; leave its label null when unjudged. Equal
independent judgments resolve automatically. Conflicting priority **or incident
identity** requires a third independent adjudicator. That person fills the
adjudication identity and conflict labels using retained evidence. An unresolved
conflict remains missing coverage. Adjudication is tied to both exact review
hashes; editing either review invalidates it. Missing judgments are not resolved
through the adjudication template.

## Splits and metrics

```sh
node scripts/ranking-benchmark.mjs split-template --captures PRIVATE_WINDOW --out split.json
```

Assign each whole capture `train`, `validation`, or `test`. Dates must progress
strictly in that order. The evaluator rejects the same reviewed incident or retained
article URL across splits. Choose nonoverlapping windows before review, or create
a new frozen window and repeat export/import when a leakage check fails. Related
stories with unknown identities can still evade the check. An all-test pilot is
allowed and explicitly does not establish a held-out tuning result.

```sh
node scripts/ranking-benchmark.mjs evaluate --captures PRIVATE_WINDOW --review accepted-a.json --review accepted-b.json --adjudication adjudication.json --split split.json --out report.json
```

Omit `--adjudication` if none was completed. The report contains per-split and
per-profile counts and denominators:

- Critical-incident recall in the final selection and at rank 10, among judged
  critical incidents in the retained candidate pool.
- Top-10 precision among judged slots, with the number and fraction of selected
  slots still unknown or unjudged shown beside it.
- Duplicate top-10 slots and relevant-incident coverage at 10. These distinguish
  repeated reporting from coverage of separate events.
- Candidate annotation coverage, unknown labels, unjudged items, unresolved
  disagreements, editorial exclusions and candidates outside enrichment budgets.

Incident denominators count **incident-run pairs**. Repeated windows are correlated,
and incomplete annotation can bias every metric. Zero-denominator metrics are null,
not perfect or zero. Later KEV membership is a separate outcome study, not a universal
priority label. Do not tune weights against the test split or claim calibration from
this pilot. The current evaluator describes captured rankings; it does not rescore
candidates with hypothetical enrichment or today's evidence.

Keep `npm run check:scoring` as the small authored regression gate and `npm run
backtest` as selected-only first-observation diagnostics. Neither supplies the
missing denominator for this benchmark. Unit tests use explicitly synthetic
reviewers and labels only; no production expert annotation is bundled.

# Evidence and relevance

[Back to the README](../README.md)

BlueTeam.News connects a declared watch profile to retained source passages and the inputs of a saved Briefing. Wire and evidence inspection work without an AI key. Wire can save your assessment, owner, next review date, basis, and evidence reference in this browser and include them in exports. These local decision records are separate from source reporting; they do not provide a shared case workflow, verified exposure, or handoff acknowledgment.

## Try the workflow

1. Open **Settings → Watch profile**. Add technologies, sectors, regions, intelligence questions, lower-interest topics, and preferred horizons. List interests, not claims that an asset is deployed or exposed.
2. Save, then open **Wire**. The **Watch match** filter includes declared technology, sector, or region matches and separately labeled intelligence-question overlap. Open **Inspect evidence** to see the matching terms and supporting source text. Saved preferences affect ranking on the next collection refresh.
3. Choose a source from the group. The inspector opens the revision attached to the displayed feed snapshot, with its publication, source-update, retrieval, and observation times. Missing dates remain unknown.
4. When a later collection changes that source's retained title, passage, or capture metadata, **Retained source changed** draws attention to it. **More source context retained** identifies an expanded capture. Compare the retained passages before interpreting a difference as a publisher correction; a capture change alone does not establish increased threat or local exposure.
5. If AI generation is configured, create a Briefing from the latest collected signals. **Sources and saved inputs**, inside **Edition tools**, opens its readable evidence and configuration receipt, with JSON available in the advanced disclosure. Opening it makes no provider request.

Briefing generation uses the latest collection selection. Wire search, filters,
and hidden items change your view; they do not select the next Briefing's inputs.
Review the generated assessment and its citations before sharing it. The input
receipt records the supplied evidence; it does not prove every sentence follows
from that evidence or confirm exposure in your organization.

The inspector supports keyboard navigation, source selection, expandable revisions, and Escape to close. Grouping retains the original members and their attribution; a publisher count does not prove independent confirmation. Manual split/merge controls are not included.

## Wire decisions and read state

Read state follows the retained revisions attached to a signal. A later revision becomes unread even when its story URL is unchanged; signals without retained revisions use the story identity. Marking a signal read records reading state, not an assessment of its claims or your exposure.

Saved decisions and hidden/read preferences update across tabs using the same browser profile and application origin. They remain local to that browser. If browser storage is unavailable, the interface reports that a decision is retained only for the session.

**Export current results** includes the currently filtered signals, their evidence references, and any saved decisions. **Export all saved decisions (JSON)** exports the browser's decision records even when their signals are hidden, filtered out, or no longer in the current feed. This separate export contains decision records and links, not a copy of the underlying source evidence. Up to 2,000 decisions are retained in browser storage; server backups do not include them.

## What a watch match means

The profile unifies technologies, sectors, regions, intelligence questions, exclusions, preferred horizons, and team context. Existing watch terms and organization overrides remain compatible. Explicit empty lists clear an interest; omitted fields preserve the applicable saved/default value.

Technology, sector, and region matches are case-insensitive literal substrings within an original retained feed title, description, or passage. They do not use an unretained article body or join fragments from different sources to manufacture a term. These matches can contribute a bounded relevance signal, and preferred horizons influence relevance. Intelligence questions guide the Briefing and can also match retained text through literal matching or bounded term overlap across group members. Wire labels question relevance separately; overlap does not establish that the reporting answers the question. Exclusions describe lower interest and do not suppress urgent reporting.

The automatic applicability states are `declared-match` and `unknown`; exposure remains `unknown` in both. An operator's separate Decision record can state Investigating, Affected, Not affected, or Mitigated, but the application has no inventory check, affected-version confirmation, or mitigation verification. A new profile is reflected when Wire reloads its explanations, while the stored score remains from its collection. Generation receipts distinguish the collection profile from the profile used to write the Briefing.

Profile details and manifest reads use the local-or-authenticated Settings boundary. On a deployment with `API_SECRET`, supply the bearer token through a direct API client or the trusted reverse proxy. The browser does not store the shared secret. These are deployment-level protections for a single operator, not individual user identities or shared accountability.

## What is retained as evidence

Each source item has an opaque stable `sourceId`, resolved using canonical article URLs, feed-scoped source identifiers, and a conservative title fingerprint when neither is available. Canonicalization removes fragments and known tracking parameters while preserving meaningful URL differences. Identity matching cannot establish that different publishers independently verified an assertion.

Observations are recorded before grouping alters the display title, description, or date. Retained passages are bounded, normalized plain text from RSS/Atom reporting, with title-only fallback where no excerpt exists. Up to 8,192 characters are retained; parsing input is also bounded, so a clipped excerpt can be shorter after markup removal. **Exact passage** means the stored extraction, not original HTML, the full article, or a verified quotation of an entire advisory. Open the publisher link for additional context.

A source can have different representations in different feeds, including title-only discovery. Revisions compare the same feed and passage kind so an RSS excerpt and a search title do not alternate as false changes. A changed title, passage, or clipping state creates a revision; returning from A to B to A creates another revision. Changing a publication timestamp alone does not create a content revision. The displayed difference is a deterministic changed span, not a semantic assessment.

Publication and source-update times come from the source when supplied. Retrieval records collection timing; first/last observed times describe local observations. Reading a stale cache does not advance the publisher observation time. A successful conditional response can confirm an unchanged observation. Older cached text keeps its matching retained revision; if that revision was pruned, its reference is unavailable instead of pointing at newer text.

Evidence starts with collection after the upgrade. Prior source history and old edition inputs are not reconstructed. An attached revision can later fall outside retention; the inspector says so before showing any newer available observations.

## Saved generation inputs

Every newly completed edition writes `briefs/brief-YYYY-MM-DD-NN.manifest.json` beside its Markdown. Schema version 1 includes:

- Generation identity, edition date/timezone, application version, and implementation hashes.
- Selected prompt-visible passages, all grouped feed passages, source/revision references, source labels, scores, and deterministic enrichment.
- Structured NVD metrics with their CVE, CVSS version, source, assessment type, and provisional status, plus applicability configurations and version limits.
- Collection-time profile and scoring configuration, separately from the generation-time profile and allowed prompt settings.
- Deterministic fact text, grounding allowlists, validation results, and the validation KEV catalog fingerprint and matching selected CVEs.
- Each provider attempt's requested model, returned model when supplied, token usage, stop/failure state, and SHA-256 hashes of its exact system prompt and messages.
- The saved edition filename and SHA-256 of its Markdown.

The receipt is bounded to 4 MiB. Configuration and evidence fields are allowlisted; the application does not serialize provider clients, raw settings, keys, or local file paths into it. Credential-shaped text and sensitive URL query parameters receive defensive redaction. Treat the profile and retained passages as local working material when sharing a receipt.

NVD product labels retain the qualification that configuration conditions and version limits apply. They do not establish that every installation of that product is affected or that the operator has an exposed asset. Supported CVSS checks bind a score to the cited CVE and preserve its version and provisional status; ambiguous legacy prose cannot supply that binding.

The manifest is written and flushed before the Markdown completion marker. A receipt publication failure cannot announce a completed edition, index it, or dispatch its webhook. A later Markdown publication failure removes the receipt where possible; a crash can leave an orphan receipt that a retry replaces. Recovery of an existing scheduled edition verifies its receipt, completion flags, date, and timezone. Inconsistent artifacts return `E_SCHEDULE_INTEGRITY` without starting another provider call or overwriting the original.

The API checks the manifest version, filename, size, and Markdown hash. Editing the saved Markdown directly makes that receipt fail verification; preserve the original pair. An existing invalid receipt excludes the edition from default publication surfaces. Legacy editions without a receipt remain readable with an explicit unavailable status; a completely deleted receipt cannot be distinguished from a legacy absence. Exact prompts are represented by hashes rather than stored text; these hashes are not tamper-proof signatures and do not guarantee reproducible model output.

Ordinary generation publishes automatically when its findings are editorial notes. Optional field grammar, presentation, limited supplemental sources, and bounded editorial suggestions remain available for inspection. Concrete citation, core evidence, CVE/CVSS/version, KEV, and incomplete-content failures stop publication. Detected security-control changes require a specific operator review. Diagnostic severity and publication consequence are separate; an advisory note does not become a blocker merely because an older checker called it a trust or structure issue.

Rejected or interrupted output is retained separately when a draft is available to save. **Drafts** opens a readable preview with findings and captured evidence. **Save draft** preserves edits without publication, including when blockers remain. **Publish briefing** saves and rechecks the exact revision against its captured inputs and publishes it without another model call. A successful repair becomes available to the reader, archive, and other eligible surfaces. A pending draft leaves the current published briefing in place. Older repaired editions preserve their evidence date and original attempt time; they do not displace a newer day's briefing or a newer attempt from the same day. Not every intermediate retry draft is retained. Source-check results and editorial review remain separate: passing the supported checks is not approval of every narrative claim or action.

Editorial corrections and publication decisions are stored in `reviews/` and bound to the original edition's SHA-256. The interface preserves access to the original and its input receipt. An eligible editorial disposition approves the exact current reading copy. Later edits lose that approval: material findings require approval of the new copy, while a clean correction can remain automatically eligible without a reviewed label. Legacy approvals still apply to unchanged original text.

Detected recommendations to weaken named security controls or remove audit evidence receive a `SECURITY_CONTROL_CHANGE` review finding. Before approving that exact reading copy, verify the source, affected scope, authorization, and recovery plan. This bounded check covers selected wording and commands, not every harmful recommendation or prompt-injection technique. Source descriptions of attacker behavior do not by themselves authorize defenders to repeat those actions.

The reader, archive list, search, Latest, Wall, RSS, and generation continuity use the same current reading copy and its checks. Historical review-required and superseded editions remain inspectable in the archive but are excluded from Latest, Wall, RSS, and continuity. New generation with serious unresolved findings stays a draft. Approval cannot override publication blockers, unavailable checks for a corrected copy, or an invalid receipt. Publishing a repaired draft uses the configured Briefing notification behavior; retrying that publication does not create another edition or intentionally resend its notification. Notification or indexing failures are reported separately from an already committed publication. These review records do not supply individual user authentication, shared acknowledgment, or action-completion tracking.

## Reading and sharing an edition

Publication eligibility, reader qualifications, and the editorial record are separate. A published edition does not acquire a warning banner because it has routine editorial notes. Decision-changing conditions and uncertainty stay with the relevant assessment or action. Overview and Full report share the same material exception notice, including a replacement link for a superseded edition.

The optional **Edition record** separates current-copy findings from earlier generation and correction history. A corrected edition has a neutral correction reference; resolved historical findings do not become current warnings. Scoped control approvals are described as control-exception reviews, not whole-brief verification. Missing legacy inputs remain distinguishable from a saved receipt that fails verification.

Copied decisions retain the selected action, applicable qualifications, sources and edition identity. Print retains complete authored content, source references, necessary current qualifications and correction context. Routine checks do not trigger a distribution hold or repeated generic verification instructions. Supporting records remain accessible from the permanent edition. Authored historical text and immutable receipts are preserved; presentation cleanup does not rewrite them.

Future writing omits generic disclaimers and internal extraction commentary while retaining their decision-relevant consequences. For example, a rejected article body belongs in capture details; an unresolved affected-version range belongs beside the assessment. Wall uses the same current-copy record and updates diagnostics for unchanged held text without resetting its reading position.

## Retention, backups, and sharing

The evidence database prunes sources not observed within 30 days, keeps at most 5,000 sources, and retains at most eight revisions per source across all its feed representations. Pruning runs during collection. A source observed continuously can retain an older revision until the revision cap removes it. These bounds are code defaults, not operator-configurable retention policy controls.

Saved Briefings and their manifests do not expire automatically. Their copied excerpts survive pruning of the rolling evidence database. Back up `data/`, `briefs/`, `reviews/`, configuration, and the corresponding application version together using the stopped-process procedure in [Operations](operations.md#state-and-backups). Losing `reviews/` loses corrections, approvals, and publication exclusions. Backups can outlive live retention; manage their access and expiration separately.

Automatic draft recovery retains up to 20 untouched drafts for 30 days. Once an operator explicitly saves a draft, it is protected from that automatic expiry and pruning. Each artifact retains its original text plus the seven most recent changed revisions; revision numbers continue increasing as older repair revisions leave the retained window. Rechecking unchanged text does not add a revision. Publication preserves repair provenance in the permanent edition receipt. Wire decision records live in browser storage rather than the server backup; export them before clearing that storage or moving to another browser.

The project's software license does not label the reuse rights of collected reporting. Source licensing and handling markings are not yet modeled or enforced per passage. Retain attribution and source links, review the source's sharing conditions before redistributing extracts, and avoid treating a local manifest as a preapproved public evidence bundle. No external sharing or product telemetry is added by this workflow.

## Contributor boundaries and checks

`lib/watch-profile.js` owns pure profile normalization and literal applicability. `lib/evidence.js` owns source identity, observation revisions, retention, and passage differences; SQLite schema changes live in `lib/db.js`. Collection in `lib/feeds.js` records original members before grouping and freezes its profile/scoring context. `lib/generation-manifest.js` builds bounded receipts, and `lib/history.js` publishes them before the archive marker. Routes return JSON; the vanilla browser inspector renders source text as escaped content.

Preserve these distinctions in changes: source reporting versus deterministic enrichment; declared relevance versus confirmed exposure; a textual revision versus a reviewed change; and a generated edition versus an analyst-approved handoff. Use synthetic fixtures and temporary databases/directories; regression tests must not call paid providers or modify a running operator's data.

```bash
npm test -- --runInBand test/watch-profile.test.js test/evidence.test.js test/evidence-inspector.test.js test/generation-manifest.test.js test/history-manifest-publication.test.js test/brief.test.js
```

For an advisory updated the next day, BlueTeam.News can retain yesterday's excerpt, show today's passage change, explain a watched-technology match, keep automatic exposure unknown, and preserve a generated Briefing's inputs. It can also save a browser-local decision and present a separately reviewed edition. Persistent situation tracking across collections, explicit shortlist-based generation, shared handoff acknowledgment, and action-completion tracking remain proposed improvements. See the [roadmap](decision-desk-roadmap.md).

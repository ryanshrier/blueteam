# Evidence and relevance

[Back to the README](../README.md)

BlueTeam.News connects a declared watch profile to retained source passages and the inputs of a saved Briefing. Wire and evidence inspection work without an AI key. This is the evidence foundation for a daily handoff; it does not yet store an analyst's disposition, owner, applicability decision, or handoff acknowledgment.

## Try the workflow

1. Open **Settings → Watch profile**. Add technologies, sectors, regions, intelligence questions, lower-interest topics, and preferred horizons. List interests, not claims that an asset is deployed or exposed.
2. Save, then open **Wire**. A matching item shows **Watch profile match**. Open **Inspect evidence** to see which literal term matched and the supporting source text. Saved preferences affect ranking on the next collection refresh.
3. Choose a source from the group. The inspector opens the revision attached to the displayed feed snapshot, with its publication, source-update, retrieval, and observation times. Missing dates remain unknown.
4. When a later collection changes that source's retained title or excerpt, **Source text changed** draws attention to it. Expand the changed passage and previous excerpt to assess the difference. A text change alone does not establish increased threat or local exposure.
5. If AI generation is configured, create a Briefing from the latest collected signals. Its **Inspect saved generation inputs (JSON)** link opens the saved evidence and configuration receipt. Opening it makes no provider request.

Briefing generation uses the latest collection selection. Wire search, filters,
and hidden items change your view; they do not select the next Briefing's inputs.
Review the generated assessment and its citations before sharing it. The input
receipt records the supplied evidence; it does not prove every sentence follows
from that evidence or confirm exposure in your organization.

The inspector supports keyboard navigation, source selection, expandable revisions, and Escape to close. Grouping retains the original members and their attribution; a publisher count does not prove independent confirmation. Manual split/merge controls are not included.

## What a watch match means

The profile unifies technologies, sectors, regions, intelligence questions, exclusions, preferred horizons, and team context. Existing watch terms and organization overrides remain compatible. Explicit empty lists clear an interest; omitted fields preserve the applicable saved/default value.

Matches are case-insensitive literal substrings in original retained feed titles, descriptions, or passages. They do not use an unretained article body or join text across different sources to manufacture a match. Technology, sector, and region matches can contribute a bounded relevance signal. Preferred horizons influence relevance; intelligence questions guide the Briefing. Exclusions describe lower interest and do not suppress urgent reporting.

The current applicability states are `declared-match` and `unknown`; exposure remains `unknown` in both. The application has no inventory check, affected-version confirmation, or mitigation verification. A new profile is reflected when Wire reloads its explanations, while the stored score remains from its collection. Generation receipts distinguish the collection profile from the profile used to write the Briefing.

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
- Collection-time profile and scoring configuration, separately from the generation-time profile and allowed prompt settings.
- Deterministic fact text, grounding allowlists, validation results, and the validation KEV catalog fingerprint and matching selected CVEs.
- Each provider attempt's requested model, returned model when supplied, token usage, stop/failure state, and SHA-256 hashes of its exact system prompt and messages.
- The saved edition filename and SHA-256 of its Markdown.

The receipt is bounded to 4 MiB. Configuration and evidence fields are allowlisted; the application does not serialize provider clients, raw settings, keys, or local file paths into it. Credential-shaped text and sensitive URL query parameters receive defensive redaction. Treat the profile and retained passages as local working material when sharing a receipt.

The manifest is written and flushed before the Markdown completion marker. A receipt publication failure cannot announce a completed edition, index it, or dispatch its webhook. A later Markdown publication failure removes the receipt where possible; a crash can leave an orphan receipt that a retry replaces. Existing scheduled archive markers still prevent repurchasing an already completed daily edition.

The API checks the manifest version, filename, size, and Markdown hash. Editing the saved Markdown directly makes that receipt fail verification; preserve the original pair. Old editions return an explicit unavailable status. Hashes identify the inputs but do not retain exact prompts or discarded drafts, provide tamper-proof signatures, or guarantee reproducible model output. Full historical replay and analyst-reviewed versions remain later work.

## Retention, backups, and sharing

The evidence database prunes sources not observed within 30 days, keeps at most 5,000 sources, and retains at most eight revisions per source across all its feed representations. Pruning runs during collection. A source observed continuously can retain an older revision until the revision cap removes it. These bounds are code defaults, not operator-configurable retention policy controls.

Saved Briefings and their manifests do not expire automatically. Their copied excerpts survive pruning of the rolling evidence database. Back up `data/`, `briefs/`, configuration, and the corresponding application version together using the stopped-process procedure in [Operations](operations.md#state-and-backups). Backups can outlive live retention; manage their access and expiration separately.

The project's software license does not label the reuse rights of collected reporting. Source licensing and handling markings are not yet modeled or enforced per passage. Retain attribution and source links, review the source's sharing conditions before redistributing extracts, and avoid treating a local manifest as a preapproved public evidence bundle. No external sharing or product telemetry is added by this workflow.

## Contributor boundaries and checks

`lib/watch-profile.js` owns pure profile normalization and literal applicability. `lib/evidence.js` owns source identity, observation revisions, retention, and passage differences; SQLite schema changes live in `lib/db.js`. Collection in `lib/feeds.js` records original members before grouping and freezes its profile/scoring context. `lib/generation-manifest.js` builds bounded receipts, and `lib/history.js` publishes them before the archive marker. Routes return JSON; the vanilla browser inspector renders source text as escaped content.

Preserve these distinctions in changes: source reporting versus deterministic enrichment; declared relevance versus confirmed exposure; a textual revision versus a reviewed change; and a generated edition versus an analyst-approved handoff. Use synthetic fixtures and temporary databases/directories; regression tests must not call paid providers or modify a running operator's data.

```bash
npm test -- --runInBand test/watch-profile.test.js test/evidence.test.js test/evidence-inspector.test.js test/generation-manifest.test.js test/history-manifest-publication.test.js test/brief.test.js
```

For an advisory updated the next day, BlueTeam.News can retain yesterday's excerpt, show today's affected-version passage change, explain a watched-technology match, keep exposure unknown, and preserve a generated Briefing's inputs. It cannot yet retain yesterday's analyst decision, carry an unresolved applicability task, create a focused shortlist-based handoff, record review approval, or distinguish acknowledgment from completion. See the [roadmap](decision-desk-roadmap.md) for these proposed improvements.

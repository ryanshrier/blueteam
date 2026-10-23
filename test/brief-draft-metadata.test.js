import { beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRejectedBrief, readBriefDraft, revalidateBriefDraft, validationManifestForDraft,
  validationSourceFromManifest, draftValidation, recordDraftPublication } from '../lib/brief-drafts.js';
import { createPublicationLookup, publishDraftEdition, verifyPublicationReplay } from '../lib/brief-publication.js';
import { readGenerationManifest, sha256 } from '../lib/generation-manifest.js';
import { replayBriefArchive } from '../lib/brief-replay.js';
import { repairBriefFormatting, publicationDecision } from '../lib/validation.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'draft-metadata-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const prose = '## BLUF\nA retained report for metadata boundary testing.';
const record = (action = 'S1.A1') => ({ schemaVersion: 1,
  executiveActions: [{ decision: 1, actionIds: [action] }],
  coverage: [{ priorityId: 'P1', status: 'deferred', reason: 'The retained report needs an event-specific editorial decision.' }],
});
const envelope = metadata => `<!-- briefing-metadata\n${JSON.stringify(metadata)}\n-->`;
const checks = (content, manifest) => ({ valid: !(manifest.briefingMetadataIssues || []).length,
  warnings: (manifest.briefingMetadataIssues || []).map(issue => issue.message),
  issues: manifest.briefingMetadataIssues || [], briefingMetadata: manifest.briefingMetadata || null });
const save = (extra = {}, content = prose) => saveRejectedBrief(dir, { content,
  manifest: { schemaVersion: 1, edition: { date: '2026-10-09', timezone: 'America/Chicago' },
    grounding: { sources: [], urls: [], cves: [] }, selectedEvidence: [], ...extra },
  validation: { valid: false, warnings: ['Initial rejection'], issues: [] } });
const repair = (saved, content, validate = checks) => revalidateBriefDraft(dir, saved.id,
  { baseRevision: saved.revisions.at(-1).number, ...(content !== undefined ? { content } : {}) }, validate);

const mappedProse = `## BLUF
A retained report for the current shift.
## EXECUTIVE SUMMARY
- **Required decisions:** Infrastructure — verify Acme Gateway deployment — recommended target October 10, 2026.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Acme Gateway response
**What happened:** Acme Gateway received an update. [Vendor, October 9, 2026](https://vendor.example/acme)
**Recommended actions:**
- Infrastructure — verify Acme Gateway deployment — recommended target October 10, 2026.
**Decision window:** Current shift
## WATCHLIST
- Watch for updated vendor advice.
`;
const mappedRecord = { schemaVersion: 1, executiveActions: [{ decision: 1, actionIds: ['S1.A1'] }],
  coverage: [{ priorityId: 'P1', status: 'covered', section: 'judgment', index: 1, sourceIds: ['S1.1'] }] };

describe('draft generator-record normalization', () => {
  test.each(['\n', '\r\n'])('unchanged original prose preserves exact bytes and bound metadata across repeated rechecks (%j)', newline => {
    const original = [prose, '## CONVERGENCE', '',
      'No supported intersection is established by the current retained evidence.', '',
      '## WATCHLIST', '- First retained item', '- Second retained item', ''].join('\n').replaceAll('\n', newline);
    expect(repairBriefFormatting(original)).not.toBe(original);
    const saved = save({ briefingMetadata: record(), briefingMetadataIssues: [], briefingMetadataContentSha256: sha256(original) }, original);
    let rechecked = saved;
    for (const submitted of [original, undefined, original]) {
      rechecked = repair(readBriefDraft(dir, saved.id), submitted, (content, manifest) => {
        expect(content).toBe(original);
        expect(validationSourceFromManifest(manifest, content).briefingMetadata).toEqual(record());
        return checks(content, manifest);
      });
      expect(rechecked.revisions).toEqual(saved.revisions);
      expect(rechecked.lastCheck).toMatchObject({ revision: 1, contentSha256: sha256(original) });
      expect(rechecked.manifestSha256).toBe(saved.manifestSha256);
    }
    const edited = original.replace('First retained item', 'Corrected retained item');
    const repaired = repair(rechecked, edited, (content, manifest) => {
      expect(content).toBe(repairBriefFormatting(edited));
      expect(validationSourceFromManifest(manifest, content).briefingMetadata).toBeNull();
      return checks(content, manifest);
    });
    expect(repaired.revisions.at(-1)).toMatchObject({ number: 2, formattingRepaired: true, briefingMetadata: null });
    expect(repaired.revisions[0]).toEqual(saved.revisions[0]);
    expect(repair(repaired).revisions).toEqual(repaired.revisions);
    expect(() => repair(saved, original)).toThrow('newer repair');
  });

  test('strips the envelope before hashing/checking and retains metadata separately without changing captured inputs', () => {
    const saved = save();
    const captured = JSON.stringify(saved.manifest);
    let checked;
    const updated = repair(saved, `${prose}\n\n${envelope(record())}`, (content, manifest) => {
      checked = { content, manifest };
      return checks(content, manifest);
    });
    const current = updated.revisions.at(-1);
    expect(checked.content).toBe(prose);
    expect(current).toMatchObject({ number: 2, content: prose, sha256: sha256(prose), metadataExtracted: true,
      briefingMetadata: record(), briefingMetadataIssues: [], briefingMetadataContentSha256: sha256(prose) });
    expect(current.content).not.toContain('briefing-metadata');
    expect(checked.manifest.briefingMetadata).toEqual(record());
    expect(JSON.stringify(updated.manifest)).toBe(captured);
    expect(updated.manifestSha256).toBe(saved.manifestSha256);
    expect(updated.revisions[0]).toEqual(saved.revisions[0]);
    expect(validationManifestForDraft(readBriefDraft(dir, saved.id)).briefingMetadata).toEqual(record());
  });

  test('reloading and rechecking unchanged prose preserves revision metadata without inventing another revision', () => {
    const updated = repair(save(), `${prose}\n${envelope(record())}`);
    let metadata;
    const rechecked = repair(readBriefDraft(dir, updated.id), undefined, (content, manifest) => {
      metadata = validationSourceFromManifest(manifest, content).briefingMetadata;
      return checks(content, manifest);
    });
    expect(metadata).toEqual(record());
    expect(rechecked.revisions).toEqual(updated.revisions);
    expect(rechecked.lastCheck).toMatchObject({ revision: 2, contentSha256: sha256(prose),
      briefingMetadataSha256: updated.revisions.at(-1).briefingMetadataSha256 });
  });

  test('metadata-only changes create a new revision and invalidate the previous base revision', () => {
    const first = repair(save(), `${prose}\n${envelope(record())}`);
    const second = repair(first, `${prose}\n${envelope(record('S1.A2'))}`);
    expect(second.revisions.at(-1)).toMatchObject({ number: 3, content: prose, sha256: sha256(prose), briefingMetadata: record('S1.A2') });
    expect(second.revisions.at(-1).briefingMetadataSha256).not.toBe(first.revisions.at(-1).briefingMetadataSha256);
    expect(() => revalidateBriefDraft(dir, first.id, { content: prose, baseRevision: 2 }, checks)).toThrow('newer repair');
    expect(repair(second, `${prose}\n${envelope(record('S1.A2'))}`).revisions).toEqual(second.revisions);
  });

  test('changed prose clears stale action/coverage mappings while unchanged original prose can reuse its receipt', () => {
    const saved = save({ briefingMetadata: record(), briefingMetadataIssues: [], briefingMetadataContentSha256: sha256(prose) });
    let initial;
    repair(saved, undefined, (content, manifest) => { initial = validationSourceFromManifest(manifest, content).briefingMetadata; return checks(content, manifest); });
    expect(initial).toEqual(record());
    const changed = repair(saved, `${prose}\nAn edited clause.`);
    expect(validationManifestForDraft(changed)).toMatchObject({ briefingMetadata: null, briefingMetadataIssues: [],
      briefingMetadataContentSha256: sha256(`${prose}\nAn edited clause.`) });
    expect(changed.manifest.briefingMetadata).toEqual(record());
    expect(repair(changed).revisions).toEqual(changed.revisions);
  });

  test('formatting repairs cannot accidentally rebind positional metadata from an older prose hash', () => {
    const saved = save({ briefingMetadata: record(), briefingMetadataIssues: [], briefingMetadataContentSha256: sha256('Other content') });
    let metadata;
    repair(saved, undefined, (content, manifest) => { metadata = validationSourceFromManifest(manifest, content).briefingMetadata; return checks(content, manifest); });
    expect(metadata).toBeNull();
  });

  test('an unrelated prose edit preserves unchanged action and coverage bindings with a new exact hash', () => {
    const saved = save({ briefingMetadata: mappedRecord, briefingMetadataIssues: [], briefingMetadataContentSha256: sha256(mappedProse) }, mappedProse);
    const edited = mappedProse.replace('current shift', 'next shift');
    const updated = repair(saved, edited);
    const current = updated.revisions.at(-1);
    expect(current.briefingMetadata).toEqual(mappedRecord);
    expect(current.briefingMetadataContentSha256).toBe(sha256(current.content));
    expect(updated.manifest).toEqual(saved.manifest);
    expect(repair(updated).revisions).toEqual(updated.revisions);
  });

  test('editing a canonical action discards its affected action and entry bindings', () => {
    const original = mappedProse.replace('## WATCHLIST', `### Signal 2 — [Horizon 1] Other response
**Recommended actions:**
- Operations — verify another deployment — recommended target October 10, 2026.
**Decision window:** Current shift
## WATCHLIST`);
    const saved = save({ briefingMetadata: mappedRecord, briefingMetadataContentSha256: sha256(original) }, original);
    const edited = original.replace('- Infrastructure — verify Acme Gateway deployment', '- Infrastructure — inventory Acme Gateway deployment');
    const updated = repair(saved, edited);
    expect(updated.revisions.at(-1).briefingMetadata).toBeNull();
    expect(updated.manifest.briefingMetadata).toEqual(mappedRecord);
  });

  test('a changed decision invalidates only its mapping while keeping unchanged cited coverage', () => {
    const saved = save({ briefingMetadata: mappedRecord, briefingMetadataContentSha256: sha256(mappedProse) }, mappedProse);
    const edited = mappedProse.replace('**Required decisions:** Infrastructure — verify', '**Required decisions:** Infrastructure — inventory');
    const updated = repair(saved, edited);
    expect(updated.revisions.at(-1).briefingMetadata).toEqual({ ...mappedRecord, executiveActions: [] });
  });

  test('a new judgment at the same position cannot inherit old action and coverage references', () => {
    const saved = save({ briefingMetadata: mappedRecord, briefingMetadataContentSha256: sha256(mappedProse) }, mappedProse);
    const edited = mappedProse.replace('### Signal 1 — [Horizon 1] Acme Gateway response', '### Signal 1 — [Horizon 1] Different product response');
    const updated = repair(saved, edited);
    expect(updated.revisions.at(-1).briefingMetadata).toBeNull();
  });

  test('manual edits canonicalize known citation labels using captured sources without changing unchanged bytes', () => {
    const original = mappedProse.replace('[Vendor, October 9, 2026]', '[Vendor, 2026-10-08]');
    const saved = save({ grounding: { sources: [{ id: 'S1.1', label: 'Vendor Security', date: '2026-10-09',
      publishedAt: '2026-10-09', url: 'https://vendor.example/acme', passage: 'Acme Gateway received an update with documented release changes.',
      cves: [] }], urls: ['https://vendor.example/acme'], cves: [] } }, original);
    expect(repair(saved).revisions.at(-1).content).toBe(original);
    const updated = repair(saved, original.replace('current shift', 'next shift'));
    expect(updated.revisions.at(-1).content).toContain('[Vendor Security, 2026-10-09](https://vendor.example/acme)');
    expect(updated.manifest.grounding).toEqual(saved.manifest.grounding);
  });

  test('malformed envelopes are stripped but their findings survive reload, ordinary edits and rechecks', () => {
    const first = repair(save(), `${prose}\n<!-- briefing-metadata {broken} -->`);
    expect(first.revisions.at(-1).content).toBe(prose);
    expect(draftValidation(first).issues.map(issue => issue.code)).toEqual(['BRIEF_METADATA_INVALID']);
    expect(publicationDecision(draftValidation(first))).toMatchObject({ canPublish: true, requiresReview: false, blockers: [] });
    const changed = repair(readBriefDraft(dir, first.id), `${prose}\nAn unrelated editorial change.`);
    expect(validationManifestForDraft(changed).briefingMetadata).toBeNull();
    expect(draftValidation(changed).issues.map(issue => issue.code)).toEqual(['BRIEF_METADATA_INVALID']);
    const rechecked = repair(changed);
    expect(draftValidation(rechecked).issues.map(issue => issue.code)).toEqual(['BRIEF_METADATA_INVALID']);
    const corrected = repair(rechecked, `${changed.revisions.at(-1).content}\n${envelope(record())}`);
    expect(validationManifestForDraft(corrected).briefingMetadata).toEqual(record());
    expect(draftValidation(corrected).issues).toEqual([]);
  });

  test('a retained legacy malformed envelope becomes an advisory diagnostic on recheck', () => {
    const invalid = { code: 'BRIEF_METADATA_INVALID', severity: 'structure', message: 'The captured envelope was malformed.' };
    const saved = save({ briefingMetadata: null, briefingMetadataIssues: [invalid], briefingMetadataContentSha256: sha256(prose) });
    const updated = repair(saved, `${prose}\nAn unrelated correction.`);
    expect(draftValidation(updated).issues).toEqual([expect.objectContaining({ code: invalid.code, severity: 'note' })]);
    expect(publicationDecision(draftValidation(updated))).toMatchObject({ canPublish: true, requiresReview: false });
    expect(updated.manifest.briefingMetadataIssues).toEqual([invalid]);
  });

  test('replacing the bookkeeping with an explicitly empty valid record cannot restore the original mapping', () => {
    const saved = save({ briefingMetadata: record(), briefingMetadataIssues: [], briefingMetadataContentSha256: sha256(prose) });
    const empty = { schemaVersion: 1, executiveActions: [], coverage: [] };
    const updated = repair(saved, `${prose}\n${envelope(empty)}`);
    expect(validationManifestForDraft(updated).briefingMetadata).toEqual(empty);
    expect(validationManifestForDraft(readBriefDraft(dir, saved.id)).briefingMetadata).toEqual(empty);
  });

  test.each(['metadata', 'metadata-content-hash', 'last-check-digest'])('rejects tampering with %s', kind => {
    const updated = repair(save(), `${prose}\n${envelope(record())}`);
    const path = join(dir, '.rejected-drafts', `${updated.id}.json`);
    const changed = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'metadata') changed.revisions.at(-1).briefingMetadata.executiveActions[0].actionIds = ['S99.A1'];
    else if (kind === 'metadata-content-hash') changed.revisions.at(-1).briefingMetadataContentSha256 = '0'.repeat(64);
    else changed.lastCheck.briefingMetadataSha256 = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(changed));
    expect(() => readBriefDraft(dir, updated.id)).toThrow('integrity');
  });

  test('offline replay evaluates each repair revision against its own metadata', () => {
    const saved = save();
    const invalid = repair(saved, `${prose}\n<!-- briefing-metadata {broken} -->`);
    const corrected = repair(invalid, `${prose}\n${envelope({ schemaVersion: 1, executiveActions: [], coverage: [] })}`);
    const replay = replayBriefArchive(dir).drafts.find(item => item.id === saved.id);
    expect(replay.revisions.find(item => item.number === invalid.revisions.at(-1).number).currentChecks.issueCodes.BRIEF_METADATA_INVALID).toBe(1);
    expect(replay.revisions.find(item => item.number === corrected.revisions.at(-1).number).currentChecks.issueCodes.BRIEF_METADATA_INVALID).toBeUndefined();
  });

  test('legacy artifacts with no per-revision metadata fields remain readable and unchanged', () => {
    const saved = save();
    expect(validationManifestForDraft(saved)).toBe(saved.manifest);
    expect(repair(saved).revisions).toEqual(saved.revisions);
    expect(readBriefDraft(dir, saved.id).revisions).toEqual(saved.revisions);
  });

  test('publishes stripped prose and an exact metadata receipt, then recovers the same publication', () => {
    const saved = save();
    const raw = `${prose}\n${envelope(record())}`;
    const updated = repair(saved, raw);
    const manifest = validationManifestForDraft(updated);
    const validation = checks(prose, manifest);
    const request = { baseRevision: 1, inputSha256: saved.manifestSha256, content: raw };
    const published = publishDraftEdition({ historyDir: dir, artifact: updated, validation, request });
    expect(readFileSync(join(dir, published.filename), 'utf8')).toBe(prose);
    const receipt = readGenerationManifest(dir, published.filename);
    expect(receipt.briefingMetadata).toEqual(record());
    expect(receipt.briefingMetadataContentSha256).toBe(sha256(prose));
    expect(receipt.repairedDraft).toMatchObject({ revision: 2, baseRevision: 1, submittedSha256: sha256(raw), contentSha256: sha256(prose), inputSha256: saved.manifestSha256 });
    const closed = recordDraftPublication(dir, saved.id, published.publication);
    const found = createPublicationLookup(dir).findDraft(closed);
    expect(verifyPublicationReplay(found, closed, request).filename).toBe(published.filename);
    expect(verifyPublicationReplay(found, closed, { baseRevision: 2, inputSha256: saved.manifestSha256, content: prose }).filename).toBe(published.filename);
    expect(() => repair(closed, prose)).toThrow('already been published');
    expect(closed.manifest).toEqual(saved.manifest);
  });
});

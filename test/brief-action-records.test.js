import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBriefActionRecords, briefActionRecords } from '../lib/brief-composition.js';
import { briefPresentation, loadBriefReadingState, recheckReadingCopy } from '../lib/brief-reading-checks.js';
import { saveRejectedBrief, revalidateBriefDraft, validationManifestForDraft } from '../lib/brief-drafts.js';
import { publishDraftEdition } from '../lib/brief-publication.js';
import { readGenerationManifest, sha256 } from '../lib/generation-manifest.js';

const judgment = (number, task = `verify Gateway ${number} exposure before restricting access`) => `### Signal ${number} — [Horizon 1] Gateway ${number} response
**Recommended actions:**
- **Act now:** Operations — ${task}; Condition: act only if deployed; Dependencies: retain existing monitoring — recommended target October 24, 2026.
- Incident response — investigate signs of compromise
  **Recovery:** if compromise is confirmed, restore from a verified safe backup; retain isolation until validated
  **Target:** October 26, 2026.

**Decision window:** Current shift
`;
const content = `## EXECUTIVE SUMMARY
- **Threat:** Verify current exposure.
- **Required decisions:** An obsolete independently authored summary.

## KEY JUDGMENTS
${[1, 2, 3, 4].map(number => judgment(number)).join('\n')}
## WATCHLIST
- Updated vendor guidance.
`;
const passed = { validationPolicyVersion: 2, valid: true, warnings: [], issues: [] };
const fixtureManifest = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-06.json', import.meta.url), 'utf8')).manifest;
const directories = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('visible action records shared by every reading copy', () => {
  test('captures every complete action and its qualifications without reading the executive repetition', () => {
    const result = captureBriefActionRecords(content);
    expect(result.contentSha256).toBe(sha256(content));
    expect(result.actions).toHaveLength(8);
    expect(result.actions[0]).toMatchObject({ id: 'S1.A1', signal: 1, signalId: 'S1', actionIndex: 1,
      owner: 'Operations', imperative: 'verify Gateway 1 exposure before restricting access', actNow: true,
      response: 'verify Gateway 1 exposure before restricting access; Condition: act only if deployed; Dependencies: retain existing monitoring',
      target: 'October 24, 2026' });
    expect(result.actions[1]).toMatchObject({ id: 'S1.A2', owner: 'Incident response', actNow: false,
      response: 'investigate signs of compromise; Recovery: if compromise is confirmed, restore from a verified safe backup; retain isolation until validated',
      target: 'October 26, 2026' });
    expect(result.executiveGroups).toEqual([1, 2, 3].map(signal => ({ signal, signalId: `S${signal}`,
      title: `Gateway ${signal} response`, actionIds: [`S${signal}.A1`, `S${signal}.A2`] })));
    expect(JSON.stringify(result)).not.toContain('obsolete independently');
    const withoutExecutive = content.slice(content.indexOf('## KEY JUDGMENTS'));
    expect(captureBriefActionRecords(withoutExecutive).actions).toEqual(result.actions);
    expect(content).toContain('An obsolete independently authored summary.');
  });

  test('matching captured records are reusable; stale, forged and missing records use the visible copy', () => {
    const captured = captureBriefActionRecords(content);
    expect(briefActionRecords(content, captured)).toEqual({ ...captured, source: 'captured' });
    const tampered = structuredClone(captured);
    tampered.actions[0].response = 'Disable all monitoring without checking exposure';
    const forgedGroup = structuredClone(captured);
    forgedGroup.executiveGroups[0].title = 'Invented obligation';
    for (const candidate of [undefined, tampered, forgedGroup, { ...captured, schemaVersion: 99 }, { ...captured, contentSha256: 'wrong' }]) {
      expect(briefActionRecords(content, candidate)).toEqual({ ...captured, source: 'derived' });
    }
    const changed = content.replaceAll('October 24, 2026', 'October 25, 2026');
    const current = briefActionRecords(changed, captured);
    expect(current.source).toBe('derived');
    expect(current.contentSha256).toBe(sha256(changed));
    expect(current.actions[0].target).toBe('October 25, 2026');
    expect(current.actions[1].target).toBe('October 26, 2026');
  });

  test('ambiguous or hidden actions abstain instead of exposing a partial or fabricated queue', () => {
    for (const value of [
      `<!--\n${content}\n-->`, `\`\`\`markdown\n${content}\n\`\`\``,
      content.replace('Operations — verify Gateway 2 exposure before restricting access', 'Verify Gateway 2 exposure'),
      content.replace('**Recommended actions:**', '<div hidden>\n**Recommended actions:**'),
      content.replace('Gateway 1 response', '<em>Gateway 1 response</em>'),
    ]) expect(briefActionRecords(value, captureBriefActionRecords(content))).toBeNull();
  });

  test('legacy draft manifests stay unchanged unless a current action overlay is needed', () => {
    const legacy = { manifest: fixtureManifest, revisions: [{ content: 'Legacy prose without structured actions.' }] };
    expect(validationManifestForDraft(legacy)).toBe(legacy.manifest);
    const captured = captureBriefActionRecords(content);
    const stale = { ...legacy, manifest: { ...fixtureManifest, actionRecords: captured } };
    expect(validationManifestForDraft(stale)).toEqual({ ...stale.manifest, actionRecords: null });
    expect(stale.manifest.actionRecords).toBe(captured);
    const derivable = { ...legacy, revisions: [{ content }] };
    expect(validationManifestForDraft(derivable).actionRecords).toEqual(captured);
  });

  test('a repair and its published reader retain the current actions while preserving the captured original', () => {
    const directory = mkdtempSync(join(tmpdir(), 'brief-shared-action-records-'));
    directories.push(directory);
    const manifest = { ...fixtureManifest, generationSettings: { ...fixtureManifest.generationSettings, compositionVersion: 1 },
      actionRecords: captureBriefActionRecords(content) };
    const original = saveRejectedBrief(directory, { content, manifest, validation: passed });
    expect(original.revisions[0].actionRecords).toEqual(captureBriefActionRecords(content));
    const edited = content.replaceAll('October 24, 2026', 'October 25, 2026');
    const repaired = revalidateBriefDraft(directory, original.id, { baseRevision: 1, content: edited }, () => passed);
    const revision = repaired.revisions.at(-1);
    expect(revision.actionRecords).toEqual(captureBriefActionRecords(revision.content));
    expect(revision.actionRecords.actions[0].target).toBe('October 25, 2026');
    expect(repaired.revisions[0]).toEqual(original.revisions[0]);
    expect(repaired.manifest).toEqual(original.manifest);
    expect(validationManifestForDraft(repaired).actionRecords).toEqual(revision.actionRecords);
    const publication = publishDraftEdition({ historyDir: directory, reviewDir: join(directory, 'reviews'), artifact: repaired,
      validation: passed, request: { baseRevision: revision.number, inputSha256: repaired.manifestSha256 } });
    const receipt = readGenerationManifest(directory, publication.filename);
    expect(receipt.actionRecords).toEqual(revision.actionRecords);
    const reading = loadBriefReadingState(directory, publication.filename, { reviewDirectory: join(directory, 'reviews') });
    expect(reading.presentation.actionRecords).toEqual({ ...revision.actionRecords, source: 'captured' });
    expect(reading.presentation.copy.contentSha256).toBe(revision.actionRecords.contentSha256);
  });

  test('corrected-copy snapshots use their own actions and never adopt the original receipt record', () => {
    const corrected = content.replaceAll('October 24, 2026', 'October 25, 2026');
    const manifest = { ...fixtureManifest, outputSha256: sha256(content), publicationValidation: passed,
      actionRecords: captureBriefActionRecords(content) };
    const before = JSON.stringify(manifest);
    const reviewed = { reviewedContent: corrected, review: { status: 'editorially-corrected' } };
    const readingChecks = recheckReadingCopy(content, reviewed, manifest);
    expect(readingChecks.actionRecords).toEqual(captureBriefActionRecords(corrected));
    const reading = { original: content, content: corrected, manifest, reviewed, readingChecks,
      receipt: { integrity: 'verified' }, disposition: { eligibleForLatest: false } };
    expect(briefPresentation(reading).actionRecords).toEqual({ ...readingChecks.actionRecords, source: 'captured' });
    expect(briefPresentation({ ...reading, readingChecks: null }).actionRecords.source).toBe('derived');
    const stale = briefPresentation({ ...reading, readingChecks: { ...readingChecks, actionRecords: manifest.actionRecords } });
    expect(stale.actionRecords).toEqual({ ...readingChecks.actionRecords, source: 'derived' });
    expect(JSON.stringify(manifest)).toBe(before);
  });
});

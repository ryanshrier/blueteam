import { describe, test, expect } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGroundingManifest, isAllowedSourceUrl } from '../lib/grounding.js';
import { buildGenerationManifest, sha256 } from '../lib/generation-manifest.js';
import { validationSourceFromManifest, saveRejectedBrief, revalidateBriefDraft } from '../lib/brief-drafts.js';
import { validateBrief, normalizeBriefCitations } from '../lib/validation.js';
import { recheckReadingCopy } from '../lib/brief-reading-checks.js';
import { renderBriefCitations } from '../lib/brief-citations.js';
import { BRIEF_EVALUATION_CASES, referenceBrief, EVAL_DATE } from './fixtures/brief-evaluation.js';

function signedFixture() {
  const item = structuredClone(BRIEF_EVALUATION_CASES[0]);
  const url = item.headlines[0].link + '?signature=synthetic-valid-signature&id=42#details';
  item.headlines[0].link = url;
  const grounding = buildGroundingManifest({ headlines: item.headlines });
  const content = referenceBrief(item);
  const original = validateBrief(content, EVAL_DATE, { publication: true, editorialStandard: 2, groundingManifest: grounding });
  const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, groundingManifest: grounding,
    config: {}, editionContext: { date: EVAL_DATE, timezone: 'UTC' } });
  Object.assign(manifest, { editorialStandard: 2, outputSha256: sha256(content),
    publicationValidation: { ...original, partial: false, hardFail: false, trustFail: false } });
  return { url, grounding, content, original, manifest };
}

describe('private retained citation identities', () => {
  test('signed destinations replay exactly without storing their credential query values', () => {
    const { url, content, original, manifest } = signedFixture();
    const retained = JSON.parse(JSON.stringify(manifest));
    expect(JSON.stringify(retained)).not.toContain('synthetic-valid-signature');
    expect(retained.grounding.sources[0].url).toBe('');
    expect(retained.grounding.sources[0].urlDisplay).toContain('signature=%5BREDACTED%5D');
    expect(retained.grounding.sources[0].urlIdentity.redacted).toBe(true);
    const source = validationSourceFromManifest(retained);
    expect(isAllowedSourceUrl(url, source.groundingManifest)).toBe(true);
    const replay = validateBrief(content, EVAL_DATE, source);
    expect(replay.issues).toEqual(original.issues);
    expect(replay.warnings).toEqual(original.warnings);
    expect(JSON.stringify(retained)).not.toContain('synthetic-valid-signature');
  });

  test('changing any captured signed-query or fragment identity remains unsupported', () => {
    const { url, manifest } = signedFixture();
    const source = validationSourceFromManifest(manifest);
    for (const changed of [url.replace('valid-signature', 'different-signature'), url.replace('id=42', 'id=43'), url.replace('#details', '#different')]) {
      expect(isAllowedSourceUrl(changed, source.groundingManifest)).toBe(false);
    }
    const surrogate = manifest.grounding.sources[0].urlDisplay;
    expect(isAllowedSourceUrl(surrogate, source.groundingManifest)).toBe(false);
  });

  test('label normalization uses the exact retained destination without creating a redacted href', () => {
    const { manifest, url } = signedFixture();
    const grounding = validationSourceFromManifest(manifest).groundingManifest;
    const corrected = normalizeBriefCitations(`[Vendor, September 4, 2026](${url})`, grounding);
    expect(corrected).toContain('[Synthetic Vendor, 2026-09-04]');
    expect(corrected).toContain(url);
    expect(corrected).not.toContain('[REDACTED]');
  });

  test('an unrelated saved-draft edit and corrected-copy recheck retain the original citation support', () => {
    const { content, original, manifest, url } = signedFixture();
    const directory = mkdtempSync(join(tmpdir(), 'signed-receipt-repair-'));
    const changed = content.replace('## WATCHLIST', '## WATCHLIST — next review');
    try {
      const saved = saveRejectedBrief(directory, { content, manifest, validation: original });
      const repaired = revalidateBriefDraft(directory, saved.id, { baseRevision: 1, content: changed },
        (value, retained) => validateBrief(value, EVAL_DATE, validationSourceFromManifest(retained, value)));
      expect(repaired.revisions.at(-1).content).toContain(url);
      expect(repaired.lastCheck.validation.issues.map(issue => issue.code)).not.toContain('GROUNDING');
      expect(repaired.lastCheck.validation.issues.map(issue => issue.code)).not.toContain('CITATION_IDENTITY_INVALID');
      const corrected = recheckReadingCopy(content, { reviewedContent: changed, review: { status: 'editorially-corrected' } }, manifest);
      expect(corrected.status).toBe('checked');
      expect(corrected.issues).toEqual(original.issues);
      expect(JSON.stringify(repaired.manifest)).not.toContain('synthetic-valid-signature');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('source IDs without a recoverable destination render as non-live captured labels', () => {
    const { manifest } = signedFixture();
    const source = validationSourceFromManifest(manifest).groundingManifest;
    const rendered = renderBriefCitations('Captured reporting [S1.1].', source);
    expect(rendered.issues).toEqual([]);
    expect(rendered.content).toContain('[Synthetic Vendor, 2026-09-04]');
    expect(rendered.content).not.toContain('](');
    expect(rendered.content).not.toContain('[REDACTED]');
  });

  test('legacy redacted receipts never authorize a replacement or invent an exact identity', () => {
    const { manifest, url } = signedFixture();
    const legacy = structuredClone(manifest);
    const record = legacy.grounding.sources[0];
    record.url = record.urlDisplay;
    delete record.urlIdentity; delete record.urlDisplay; delete legacy.grounding.urlIdentities;
    legacy.grounding.urls.push(record.url);
    const source = validationSourceFromManifest(legacy, `[Vendor](<${url}>)`).groundingManifest;
    expect(source.members[0].url).toBe('');
    expect(isAllowedSourceUrl(url, source)).toBe(false);
    expect(isAllowedSourceUrl(record.url, source)).toBe(false);
    expect(renderBriefCitations('[S1.1]', source).content).not.toContain('](');
  });
});

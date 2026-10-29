import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { busyGenerationManifest } from './fixtures/busy-generation-manifest.js';
import { saveRejectedBrief, readBriefDraft, revalidateBriefDraft, DRAFT_RETENTION } from '../lib/brief-drafts.js';
import { createBriefValidator, BRIEF_VALIDATION_LIMITS } from '../lib/brief-validator.js';
import { MAX_GENERATION_MANIFEST_BYTES, sha256 } from '../lib/generation-manifest.js';

const failedChecks = { valid: false, warnings: [], issues: [{ code: 'VERSION_UNSUPPORTED', severity: 'error',
  message: 'Signal 1 version 99.1.2 is not present in its cited evidence' }] };

describe('large bounded generation receipts through draft recovery', () => {
  test('a busy-day receipt survives storage and worker revalidation with a full repair history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'brief-busy-receipt-'));
    const validator = createBriefValidator();
    try {
      const { manifest, headlines } = busyGenerationManifest();
      expect(Buffer.byteLength(JSON.stringify(manifest))).toBeGreaterThan(8 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(MAX_GENERATION_MANIFEST_BYTES);
      const content = `# Retained draft\n\nUnsupported version 99.1.2. [Captured source](${headlines[0].link})`;
      let saved = saveRejectedBrief(directory, { content, manifest, validation: failedChecks });
      const originalInputHash = saved.manifestSha256;
      const artifactPath = join(directory, '.rejected-drafts', `${saved.id}.json`);
      expect(statSync(artifactPath).size).toBeGreaterThan(8 * 1024 * 1024);
      expect(statSync(artifactPath).size).toBeLessThan(DRAFT_RETENTION.maxArtifactBytes);
      for (let revision = 2; revision <= DRAFT_RETENTION.maxRevisions; revision++) {
        saved = revalidateBriefDraft(directory, saved.id, { baseRevision: revision - 1, content: `${content}\nRevision ${revision}` },
          () => failedChecks);
      }
      const previous = readBriefDraft(directory, saved.id);
      expect(previous.revisions).toHaveLength(DRAFT_RETENTION.maxRevisions);
      let workerRevisionCount;
      const repaired = await revalidateBriefDraft(directory, saved.id, { baseRevision: DRAFT_RETENTION.maxRevisions,
        content: `${content}\nCurrent repair` }, {
        prepareDraft: async payload => {
          workerRevisionCount = payload.artifact.revisions.length;
          expect(Object.keys(payload.artifact).sort()).toEqual(['manifest', 'revisions']);
          expect(payload.artifact.revisions[0].number).toBe(DRAFT_RETENTION.maxRevisions);
          expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(BRIEF_VALIDATION_LIMITS.maxInputBytes);
          const prepared = await validator.prepareDraft(payload);
          expect(prepared).not.toHaveProperty('validationManifest');
          return prepared;
        },
      });
      expect(workerRevisionCount).toBe(1);
      expect(repaired.manifestSha256).toBe(originalInputHash);
      expect(repaired.manifest.grounding.sources).toEqual(previous.manifest.grounding.sources);
      expect(repaired.revisions).toHaveLength(DRAFT_RETENTION.maxRevisions);
      expect(repaired.revisions[0]).toEqual(previous.revisions[0]);
      expect(repaired.revisions.at(-1).number).toBe(DRAFT_RETENTION.maxRevisions + 1);
      expect(repaired.revisions.at(-1).content).toContain(headlines[0].link);
      expect(repaired.lastCheck.validation.valid).toBe(false);
      expect(JSON.stringify(repaired.manifest)).not.toContain('synthetic-private-');
      expect(sha256(JSON.stringify(repaired.manifest))).toBe(originalInputHash);
      expect(readBriefDraft(directory, saved.id)).toEqual(repaired);
      // Indented schema-1 artifacts remain readable after compact writes.
      writeFileSync(artifactPath, JSON.stringify(repaired, null, 2));
      expect(readBriefDraft(directory, saved.id).manifestSha256).toBe(originalInputHash);
      expect(readFileSync(artifactPath, 'utf8')).toContain('\n');
    } finally { await validator.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  test('an oversized private artifact is rejected before parsing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'brief-busy-envelope-'));
    try {
      const { manifest } = busyGenerationManifest({ count: 1, grouped: false });
      const saved = saveRejectedBrief(directory, { content: 'Retained draft', manifest, validation: failedChecks });
      const artifactPath = join(directory, '.rejected-drafts', `${saved.id}.json`);
      writeFileSync(artifactPath, ' '.repeat(DRAFT_RETENTION.maxArtifactBytes + 1));
      expect(() => readBriefDraft(directory, saved.id)).toThrow('Oversized draft artifact');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

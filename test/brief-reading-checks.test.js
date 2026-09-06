import { readingCopyChecks, readingDisposition } from '../lib/brief-reading-checks.js';
import { sha256 } from '../lib/generation-manifest.js';
import { wholeDocumentReliability } from '../lib/brief-reliability.js';
import { canonicalizeExecutiveActions } from '../lib/brief-editorial.js';

test('checks belong to the corrected digest and never replace the original receipt', () => {
  const original = '# Example\n## DEVELOPING SITUATIONS\n### Gateway report\n**Trajectory:** A vulnerability was reported.\n';
  const reviewedContent = original + '[Example, 2026-09-06](https://example.com/report)\n';
  const reviewed = { reviewedContent, review: { status: 'editorially-corrected' } };
  const manifest = { outputSha256: sha256(original), edition: { date: '2026-09-06' }, grounding: { sources: [], cves: [], urls: [] } };
  const before = JSON.stringify(manifest);
  expect(readingCopyChecks(original, reviewed, { ...manifest, outputSha256: 'wrong' }).status).toBe('unavailable');
  const result = readingCopyChecks(original, reviewed, manifest);
  expect(result.status).toBe('checked');
  expect(result.contentSha256).toBe(sha256(reviewedContent));
  expect(readingDisposition({ status: 'eligible' }, { status: 'unavailable' }).eligibleForLatest).toBe(false);
  expect(readingDisposition({ status: 'eligible' }, { status: 'checked', issues: [{ severity: 'trust' }] }).eligibleForLatest).toBe(false);
  expect(readingDisposition({ status: 'eligible' }, { status: 'checked', issues: [] }).status).toBe('eligible');
  expect(JSON.stringify(manifest)).toBe(before);
  expect(wholeDocumentReliability(original).issues.find(i => i.code === 'SUPPORTING_SECTION_PROVENANCE_REQUIRED').location.line).toBe(3);
  expect(wholeDocumentReliability(reviewedContent).issues.filter(i => i.code === 'SUPPORTING_SECTION_PROVENANCE_REQUIRED')).toHaveLength(0);
});

test('executive action derivation preserves a paired response from a selected judgment', () => {
  const source = '## EXECUTIVE SUMMARY\n- **Required decisions:** old\n## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Gateway\n**Recommended actions:**\n- **Act now:** Infrastructure — verify deployment — recommended target September 6, 2026.\n- Incident response — review compromise — recommended target September 7, 2026.\n';
  const summary = canonicalizeExecutiveActions(source).split('## KEY JUDGMENTS')[0];
  expect(summary).toContain('Infrastructure — verify deployment');
  expect(summary).toContain('Incident response — review compromise');
});

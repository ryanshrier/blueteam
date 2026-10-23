import { describe, expect, test } from '@jest/globals';
import { assembleBrief } from '../lib/brief-assembly.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { BRIEF_EVALUATION_CASES, referenceBrief, EVAL_DATE } from './fixtures/brief-evaluation.js';
import { sha256 } from '../lib/generation-manifest.js';

const item = BRIEF_EVALUATION_CASES[0];
const kevSet = new Set(['CVE-2026-12345']);
const groundingManifest = buildGroundingManifest({ headlines: item.headlines, kevSet });
const kevTiming = { 'CVE-2026-12345': { dueDate: '2026-09-19' } };
const source = { groundingManifest, kevTiming, kevSet, kevCatalogLoaded: true,
  publication: true, editorialStandard: 2, compositionVersion: 1 };
const raw = referenceBrief(item).replace(/^- \*\*Required decisions:\*\*[^\n]*\n/m, '')
  .replace('[Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor)', '[S1.1]');

describe('shared brief assembly', () => {
  test('citation, action and deadline passes compose idempotently into one validated saved copy', () => {
    const result = assembleBrief(raw, source);
    expect(result.content).toContain('[Synthetic Vendor, 2026-09-04](https://example.test/evaluation/vendor)');
    expect(result.content).toContain('**Required decisions:** Operations — document applicability');
    expect(result.content).toContain('CVE-2026-12345: FCEB remediation due 2026-09-19');
    expect(result.content).toContain('recommended target September 8, 2026');
    expect(result.content).not.toContain('[S1.1]');
    expect(result.actionRecords.contentSha256).toBe(sha256(result.content));
    expect(result.actionRecords.actions[0].owner).toBe('Operations');
    expect(assembleBrief(result.content, source).content).toBe(result.content);
    const checks = validateBrief(result.content, EVAL_DATE, source);
    expect(publicationDecision(checks).blockers).toEqual([]);
    expect(checks.issues.filter(issue => issue.code.startsWith('ACTION_SUMMARY'))).toEqual([]);
  });

  test('assembly leaves unsupported identities and contradictory authored deadlines for factual checks', () => {
    const authored = raw.replace('[S1.1]', '[S99.1]')
      .replace('Local deployment is unknown.', 'Local deployment is unknown. CVE-2026-12345: FCEB remediation due 2026-09-20.');
    const result = assembleBrief(authored, source);
    expect(result.content).toContain('[S99.1]');
    expect(result.content).toContain('FCEB remediation due 2026-09-20');
    expect(result.content).toContain('FCEB remediation due 2026-09-19');
    expect(publicationDecision(validateBrief(result.content, EVAL_DATE, source)).blockers.map(issue => issue.code))
      .toEqual(expect.arrayContaining(['CITATION_REFERENCE_INVALID', 'KEV_DEADLINE_MISMATCH']));
  });
});

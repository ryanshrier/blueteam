import { describe, expect, test } from '@jest/globals';
import { normalizeConvergenceOpening, parseConvergence } from '../lib/brief-schema.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';
import { buildGroundingManifest } from '../lib/grounding.js';

const opening = 'Unrelated administrative products share a reachable management interface that chains into control of the underlying system.';
const convergence = `## CONVERGENCE\n\n### Administrative interfaces share one exposure pattern\n\n${opening}\n\n**The cascade:** External reachability compounds an authentication weakness.\n\n**The move:** Act — verify management-plane access restrictions.\n`;

describe('narrow convergence label normalization', () => {
  test('adds only the omitted label and preserves the already-rendered meaning', () => {
    const normalized = normalizeConvergenceOpening(convergence);
    expect(normalized).toBe(convergence.replace(opening, `**The intersection:** ${opening}`));
    expect(parseConvergence(normalized)).toEqual(parseConvergence(convergence));
    expect(normalizeConvergenceOpening(normalized)).toBe(normalized);
    const issues = validateBrief(normalized, '2026-09-05', { publication: true }).issues;
    expect(issues.some(issue => issue.code === 'CONVERGENCE_FIELD_MISSING')).toBe(false);
  });

  test.each([
    convergence.replace(opening, ''),
    convergence.replace(opening, '- An unordered list item.'),
    convergence.replace(opening, '```\nA code example\n```'),
    convergence.replace(opening, 'First paragraph.\n\nSecond paragraph.'),
    convergence.replace('**The cascade:** External reachability compounds an authentication weakness.', ''),
    convergence.replace('**The move:** Act — verify management-plane access restrictions.', ''),
    convergence.replace('## CONVERGENCE', '## KEY JUDGMENTS'),
    '```markdown\n' + convergence + '\n```',
  ])('leaves ambiguous or incomplete content unchanged', value => {
    expect(normalizeConvergenceOpening(value)).toBe(value);
  });

  test('does not bypass citation or source checks elsewhere in the document', () => {
    const draft = `## KEY JUDGMENTS\n\n### Signal 1 — [Horizon 1] Verify a claim\n\n**What happened:** CVE-2026-1234 has CVSS 7.8.\n\n${convergence}`;
    const checked = validateBrief(normalizeConvergenceOpening(draft), '2026-09-05', {
      publication: true, groundingManifest: buildGroundingManifest({ headlines: [] }), kevSet: new Set(),
    });
    expect(hasTrustCriticalFailure(checked.issues)).toBe(true);
    expect(checked.issues.some(issue => issue.code === 'JUDGMENT_CITATION_MISSING')).toBe(true);
  });
});

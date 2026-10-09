import { describe, expect, test } from '@jest/globals';
import { repairBriefFormatting, validateBrief } from '../lib/validation.js';

const canonical = 'No supported intersection was found in the retained evidence.';
const convergenceIssues = text => validateBrief(`## CONVERGENCE\n\n${text}`, '', { publication: true }).issues
  .filter(issue => issue.code.startsWith('CONVERGENCE_'));

describe('provider-neutral convergence phrasing and safe formatting repair', () => {
  test.each([
    'No supported intersection is established by the available evidence.',
    'No supported convergence emerges between the retained developments.',
    'No supported intersection can be established for this edition.',
    'No sufficiently supported intersection was identified across the sources.',
    '**No supported convergence** is established in the retained evidence.',
  ])('accepts an explicit absence statement: %s', sentence => {
    expect(convergenceIssues(sentence)).toEqual([]);
  });

  test.each(['', 'The developments are unrelated.', 'No supported intersections are listed.'])(
    'gives actionable wording for an invalid convergence section: %s', text => {
      expect(convergenceIssues(text)).toEqual([expect.objectContaining({
        severity: 'structure', message: expect.stringContaining(`write exactly: "${canonical}"`),
      })]);
    },
  );

  test('repairs equivalent prose and adjacent list items without changing facts or citations', () => {
    const text = '## CONVERGENCE\n\nNo supported convergence is established in the retained evidence.\n\n'
      + '## WATCHLIST\n\n- CVE-2026-1111: FCEB remediation due 2026-09-05. [Source](https://example.test/a)\n'
      + '- CVE-2026-2222: FCEB remediation due 2026-09-09.\n';
    const expected = text.replace('No supported convergence is established in the retained evidence.', canonical)
      .replace('\n- CVE-2026-2222', '\n\n- CVE-2026-2222');
    expect(repairBriefFormatting(text)).toBe(expected);
    expect(repairBriefFormatting(expected)).toBe(expected);
    expect(repairBriefFormatting(text.replaceAll('\n', '\r\n'))).toBe(expected.replaceAll('\n', '\r\n'));
  });

  test('keeps qualified claims, cited absence statements, code, and other sections intact', () => {
    const text = '## BLUF\nNo supported convergence is established in the retained evidence.\n\n'
      + '## CONVERGENCE\nNo supported intersection is established between these vendors, but a shared exposure warrants review.\n\n'
      + 'No supported intersection was found in the evidence. [Source](https://example.test/a)\n\n'
      + '    No supported convergence is established in the retained evidence.\n\n'
      + '```markdown\nNo supported convergence is established in the retained evidence.\n- One\n- Two\n```\n'
      + '~~~markdown\n- Three\n- Four\n~~~';
    expect(repairBriefFormatting(text)).toBe(text);
  });

  test('reuses the existing safe convergence label repair', () => {
    const text = '## CONVERGENCE\n\n### Shared exposure\n\nA shared management interface links the threats.\n\n'
      + '**The cascade:** Reachability compounds the weakness.\n\n**The move:** Verify restrictions.';
    expect(repairBriefFormatting(text)).toContain('**The intersection:** A shared management interface links the threats.');
  });

  test.each([
    'No supported intersection was found\nbetween the retained developments.',
    'The sources were reviewed.\nNo supported intersection was found.',
  ])('leaves soft-wrapped paragraphs intact: %s', paragraph => {
    const text = `## CONVERGENCE\n\n${paragraph}\n\n## WATCHLIST\n`;
    expect(repairBriefFormatting(text)).toBe(text);
  });
});

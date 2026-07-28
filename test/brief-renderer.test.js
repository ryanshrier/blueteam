import { describe, expect, test } from '@jest/globals';
import {
  editionDateLabel,
  splitPackedBriefFieldHtml,
  tocLabel,
} from '../public/modules/briefing/brief-renderer.js';

describe('brief field normalization', () => {
  test('splits judgment, developing, and convergence fields with one shared grammar', () => {
    const packed = [
      '<strong>Assessment:</strong> Exploitation is active.',
      '<strong>What happened:</strong> CISA updated the catalog.',
      'This continuation belongs to the evidence field.',
      '<strong>Trajectory:</strong> Accelerating.',
      '<strong>Watch criteria:</strong> Escalate when a vendor confirms impact.',
      '<strong>The intersection:</strong> Identity meets edge access.',
      '<strong>The cascade:</strong> Access compounds impact.',
      '<strong>The move:</strong> Prepare — close the gap.',
    ].join('<br>');

    expect(splitPackedBriefFieldHtml(packed)).toEqual([
      '<strong>Assessment:</strong> Exploitation is active.',
      '<strong>What happened:</strong> CISA updated the catalog.<br>This continuation belongs to the evidence field.',
      '<strong>Trajectory:</strong> Accelerating.',
      '<strong>Watch criteria:</strong> Escalate when a vendor confirms impact.',
      '<strong>The intersection:</strong> Identity meets edge access.',
      '<strong>The cascade:</strong> Access compounds impact.',
      '<strong>The move:</strong> Prepare — close the gap.',
    ]);
  });

  test('does not split ordinary prose with an intentional line break', () => {
    const prose = '<strong>Context:</strong> First line.<br>Second line.';
    expect(splitPackedBriefFieldHtml(prose)).toEqual([prose]);
  });
});

describe('archived decision-window date labels', () => {
  test('accepts both ISO and reader-facing datelines', () => {
    expect(editionDateLabel('Threat Landscape Briefing · 2026-07-24 · Friday')).toBe('2026-07-24');
    expect(editionDateLabel('Threat Landscape Briefing · July 24, 2026 · Friday')).toBe('July 24, 2026');
    expect(editionDateLabel('Threat Landscape Briefing')).toBe('');
  });
});

describe('briefing section navigation labels', () => {
  test.each([
    ['EXECUTIVE SUMMARY — SHIFT DECISIONS', 'Shift decisions'],
    ['KEY JUDGMENTS', 'Key judgments'],
    ['DEVELOPING SITUATIONS', 'Developing'],
    ['CONVERGENCE', 'Convergence'],
    ['WATCHLIST — THROUGH JULY 27, 2026', 'Watchlist'],
    ['WEEK IN REVIEW', 'Week in review'],
    ['Sources', 'Sources'],
  ])('shortens %s for the narrow TOC', (source, expected) => {
    expect(tocLabel(source)).toBe(expected);
  });
});

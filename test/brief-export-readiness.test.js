import { describe, expect, test } from '@jest/globals';
import { isBriefReadyForExport } from '../public/modules/briefing/briefing-view.js';

function renderedBrief({ renderedText = '', draft = false, structured = true } = {}) {
  return {
    _validatedBriefContent: renderedText,
    querySelector(selector) {
      if (selector.startsWith('#streamDocument')) return draft ? {} : null;
      if (selector === '.bluf, .brief-judgment-card') return structured ? {} : null;
      return null;
    },
  };
}

describe('Edition export readiness', () => {
  test('accepts only a completed render that matches the current brief', () => {
    const text = '# BlueTeam.News\n\n## BLUF\n\nValidated content.';
    expect(isBriefReadyForExport(
      renderedBrief({ renderedText: text }),
      { filename: 'brief-2026-07-13-03.md', content: text },
    )).toBe(true);
  });

  test('rejects an in-flight semantic draft even when stale state has matching content', () => {
    const prior = '# Prior validated brief';
    expect(isBriefReadyForExport(
      renderedBrief({ renderedText: prior, draft: true }),
      { filename: 'brief-2026-07-12-01.md', content: prior },
    )).toBe(false);
  });

  test('rejects the prior completed render as soon as a new generation starts', () => {
    const prior = '# Prior validated brief';
    expect(isBriefReadyForExport(
      renderedBrief({ renderedText: prior }),
      { filename: 'brief-2026-07-12-01.md', content: prior },
      true,
    )).toBe(false);
  });

  test('rejects stale state, missing completed identity, and non-brief surfaces', () => {
    expect(isBriefReadyForExport(
      renderedBrief({ renderedText: '# Displayed brief' }),
      { content: '# Different state brief' },
    )).toBe(false);
    expect(isBriefReadyForExport(renderedBrief(), { content: '# State brief' })).toBe(false);
    expect(isBriefReadyForExport(
      renderedBrief({ renderedText: '# Search results', structured: false }),
      { content: '# Search results' },
    )).toBe(false);
  });
});

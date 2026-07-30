import { describe, expect, jest, test } from '@jest/globals';
import {
  activateTocLink,
  bindTocBreakpoint,
  findTocFragmentLink,
  generationFailureModel,
  isBriefReadyForExport,
} from '../public/modules/briefing/briefing-view.js';

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

describe('Briefing generation failure state', () => {
  test('prefers the server-selected recovery draft over concatenated stream text', () => {
    expect(generationFailureModel({
      message: 'Draft was not published.',
      code: 'E_PARTIAL_GENERATION',
      accumulatedText: 'attempt oneattempt two',
      recoverableDraft: '# Attempt two only',
    })).toEqual({
      message: 'Draft was not published.',
      aiDisabled: false,
      code: 'E_PARTIAL_GENERATION',
      streamLost: false,
      accumulatedText: 'attempt oneattempt two',
      recoverableDraft: '# Attempt two only',
    });
  });

  test('does not manufacture a recovery draft for legacy string errors', () => {
    expect(generationFailureModel('Generation failed.')).toMatchObject({
      message: 'Generation failed.',
      recoverableDraft: '',
      streamLost: false,
    });
  });
});

describe('Briefing TOC breakpoint behavior', () => {
  test('restores only hashes owned by the rendered Briefing', () => {
    const first = { dataset: { target: 'section-key-judgments' } };
    const second = { dataset: { target: 'section-sources' } };

    expect(findTocFragmentLink([first, second], '#section-sources')).toBe(second);
    expect(findTocFragmentLink([first, second], '#settings')).toBeNull();
    expect(findTocFragmentLink([first, second], '#%E0%A4%A')).toBeNull();
  });

  test('uses the same focus/scroll path for an asynchronously restored fragment', () => {
    const prior = {
      classList: { remove: jest.fn() },
      removeAttribute: jest.fn(),
    };
    const link = {
      classList: { add: jest.fn(), remove: jest.fn() },
      removeAttribute: jest.fn(),
      setAttribute: jest.fn(),
    };
    const toc = { querySelectorAll: () => [prior, link] };
    const target = {
      scrollIntoView: jest.fn(),
      setAttribute: jest.fn(),
      focus: jest.fn(),
    };
    const disclosure = { open: true };

    expect(activateTocLink({
      link,
      target,
      toc,
      disclosure,
      compact: true,
      behavior: 'auto',
    })).toBe(true);

    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    expect(target.setAttribute).toHaveBeenCalledWith('tabindex', '-1');
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(prior.classList.remove).toHaveBeenCalledWith('active');
    expect(prior.removeAttribute).toHaveBeenCalledWith('aria-current');
    expect(link.classList.add).toHaveBeenCalledWith('active');
    expect(link.setAttribute).toHaveBeenCalledWith('aria-current', 'location');
    expect(disclosure.open).toBe(false);
  });

  test('closes on compact view, reopens on wider view, and removes its listener', () => {
    let onChange;
    const mediaQuery = {
      matches: true,
      addEventListener(name, handler) {
        expect(name).toBe('change');
        onChange = handler;
      },
      removeEventListener(name, handler) {
        expect(name).toBe('change');
        expect(handler).toBe(onChange);
        onChange = null;
      },
    };
    const disclosure = { open: true };

    const cleanup = bindTocBreakpoint(mediaQuery, disclosure);
    expect(disclosure.open).toBe(false);

    onChange({ matches: false });
    expect(disclosure.open).toBe(true);

    onChange({ matches: true });
    expect(disclosure.open).toBe(false);

    cleanup();
    expect(onChange).toBeNull();
  });
});

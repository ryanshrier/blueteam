import { describe, expect, jest, test } from '@jest/globals';
import { hasActiveModal } from '../public/modules/core/shortcuts.js';

describe('global shortcut modal ownership', () => {
  test('recognizes native open dialogs as well as explicit ARIA modals', () => {
    const querySelector = jest.fn(selector => (
      selector === 'dialog[open], [aria-modal="true"]' ? { open: true } : null
    ));

    expect(hasActiveModal({ querySelector })).toBe(true);
    expect(querySelector).toHaveBeenCalledWith('dialog[open], [aria-modal="true"]');
    expect(hasActiveModal({ querySelector: () => null })).toBe(false);
  });
});


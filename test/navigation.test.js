import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const navigate = jest.fn();
const state = { mode: 'wire', isGenerating: false };
jest.unstable_mockModule('../public/modules/core/router.js', () => ({ navigate }));
jest.unstable_mockModule('../public/modules/core/store.js', () => ({ getState: () => state, on: jest.fn(), emit: jest.fn() }));
jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  fetchSettings: async () => ({ ai: { enabled: false } }), fetchEdition: async () => ({}),
}));

const { initHeader } = await import('../public/modules/layout/header.js');
const { initShortcuts } = await import('../public/modules/core/shortcuts.js');

class Element {
  constructor(mode) { this.dataset = { mode }; this.handlers = {}; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}

let previousDocument;
let previousElement;
let buttons;
let keydown;
beforeEach(() => {
  navigate.mockClear();
  previousDocument = globalThis.document;
  previousElement = globalThis.HTMLElement;
  buttons = ['briefing', 'wire', 'wall'].map(mode => new Element(mode));
  globalThis.HTMLElement = Element;
  globalThis.document = {
    getElementById: id => id === 'appHeader' ? { querySelectorAll: () => buttons } : null,
    querySelector: () => null,
    addEventListener: (type, handler) => { if (type === 'keydown') keydown = handler; },
  };
});
afterEach(() => {
  globalThis.document = previousDocument;
  globalThis.HTMLElement = previousElement;
});

describe('staffed Wall entry points', () => {
  test('the main Wall navigation opens operator controls', () => {
    initHeader();
    buttons.find(button => button.dataset.mode === 'wall').handlers.click();
    expect(navigate).toHaveBeenCalledWith('/wall?operator');
    buttons.find(button => button.dataset.mode === 'wire').handlers.click();
    expect(navigate).toHaveBeenLastCalledWith('/wire');
  });

  test('G then L opens the same operator route', () => {
    initShortcuts();
    const preventDefault = jest.fn();
    keydown({ key: 'g', code: 'KeyG', target: null, preventDefault });
    keydown({ key: 'l', code: 'KeyL', target: null, preventDefault });
    expect(navigate).toHaveBeenCalledWith('/wall?operator');
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

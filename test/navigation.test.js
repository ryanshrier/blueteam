import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const navigate = jest.fn();
const followInternalLink = jest.fn();
const requestWallFullscreen = jest.fn();
const state = { mode: 'wire', isGenerating: false };
jest.unstable_mockModule('../public/modules/core/router.js', () => ({ navigate, followInternalLink, setEditionTitle: jest.fn(), currentViewUrl: mode => `/${mode}`, getWallReturnUrl: () => '/wire' }));
jest.unstable_mockModule('../public/modules/core/store.js', () => ({ getState: () => state, on: jest.fn(), emit: jest.fn() }));
jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  fetchSettings: async () => ({ ai: { enabled: false } }), fetchEdition: async () => ({}),
}));
jest.unstable_mockModule('../public/modules/wall/wall-browser.js', () => ({ requestWallFullscreen }));

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
let header;
beforeEach(() => {
  navigate.mockClear();
  requestWallFullscreen.mockClear();
  previousDocument = globalThis.document;
  previousElement = globalThis.HTMLElement;
  buttons = ['briefing', 'wire', 'wall'].map(mode => new Element(mode));
  header = { querySelectorAll: () => buttons };
  globalThis.HTMLElement = Element;
  globalThis.document = {
    getElementById: id => id === 'appHeader' ? header : null,
    querySelector: () => null,
    addEventListener: (type, handler) => { if (type === 'keydown') keydown = handler; },
  };
});
afterEach(() => {
  globalThis.document = previousDocument;
  globalThis.HTMLElement = previousElement;
});

describe('unattended Wall entry points', () => {
  test('the main Wall navigation opens the direct TV route', () => {
    initHeader();
    expect(header.innerHTML).toContain('href="/wall" data-mode="wall"');
    expect(header.innerHTML).toContain('href="/wire" data-mode="wire"');
    expect(header.innerHTML).not.toMatch(/<button[^>]*data-mode=/);
    expect(buttons.find(button => button.dataset.mode === 'wall').handlers.click).toBe(followInternalLink);
  });

  test('G then L attempts the saved fullscreen preference synchronously and opens the TV route', () => {
    initShortcuts();
    const preventDefault = jest.fn();
    keydown({ key: 'g', code: 'KeyG', target: null, preventDefault });
    keydown({ key: 'l', code: 'KeyL', target: null, preventDefault });
    expect(navigate).toHaveBeenCalledWith('/wall');
    expect(requestWallFullscreen).toHaveBeenCalledTimes(1);
    expect(requestWallFullscreen.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test('Escape leaves the Wall for the remembered investigation', () => {
    state.mode = 'wall';
    initShortcuts();
    const preventDefault = jest.fn();
    try {
      keydown({ key: 'Escape', code: 'Escape', target: null, preventDefault });
      expect(navigate).toHaveBeenCalledWith('/wire');
      expect(requestWallFullscreen).not.toHaveBeenCalled();
    } finally { state.mode = 'wire'; }
  });
});

describe('active search shortcut', () => {
  test.each(['wireSearch', 'archiveQuery'])('slash focuses the mounted %s field', id => {
    const field = { focus: jest.fn() };
    document.getElementById = key => key === id ? field : null;
    initShortcuts();
    const preventDefault = jest.fn();
    keydown({ key: '/', code: 'Slash', target: null, preventDefault });
    expect(field.focus).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test('slash typed in an archive field remains ordinary input', () => {
    const field = new Element();
    field.tagName = 'INPUT';
    field.focus = jest.fn();
    document.getElementById = id => id === 'archiveQuery' ? field : null;
    initShortcuts();
    const preventDefault = jest.fn();
    keydown({ key: '/', code: 'Slash', target: field, preventDefault });
    expect(field.focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test('an open dialog keeps ownership of slash instead of focusing archive behind it', () => {
    const field = { focus: jest.fn() };
    document.getElementById = id => id === 'archiveQuery' ? field : null;
    document.querySelector = () => ({ open: true });
    initShortcuts();
    const preventDefault = jest.fn();
    keydown({ key: '/', code: 'Slash', target: null, preventDefault });
    expect(field.focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

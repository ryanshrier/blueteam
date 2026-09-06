import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import { parseBrief } from '../lib/brief-schema.js';
import { mountWallActions } from '../public/modules/wall/wall-actions.js';

const retained = { ...parseBrief(JSON.parse(fs.readFileSync(new URL('./fixtures/retained-briefing-2026-09-06.json', import.meta.url), 'utf8')).content), date: '2026-09-06' };
const originalDocument = globalThis.document;
let controller;
afterEach(() => { controller?.destroy(); if (originalDocument) globalThis.document = originalDocument; else delete globalThis.document; });

function node() {
  const handlers = new Map();
  return { innerHTML: '', setAttribute: jest.fn(), remove: jest.fn(), focus: jest.fn(), scrollIntoView: jest.fn(),
    addEventListener: (name, handler) => handlers.set(name, handler),
    dispatch: (name, event = {}) => handlers.get(name)?.(event),
  };
}

describe('All actions dialog lifecycle', () => {
  test('holds one exact publication, keeps topic navigation in the dialog, and returns focus on native close', () => {
    let current = retained;
    const dialog = node(), close = node(), topic = node(), opener = node(), hold = jest.fn();
    dialog.querySelector = selector => selector === '[data-close]' ? close : topic;
    dialog.showModal = jest.fn();
    dialog.close = () => dialog.dispatch('close');
    globalThis.document = { createElement: jest.fn(() => dialog), body: { appendChild: jest.fn() } };
    controller = mountWallActions({ getDocument: () => current, onOpen: hold });
    controller.open(opener);
    current = { stories: [] };
    controller.open(opener);
    expect(document.createElement).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(dialog.innerHTML).toContain(retained.actions[6].imperative);
    const event = { preventDefault: jest.fn(), target: { closest: () => ({ getAttribute: () => '#wall-action-topic-3' }) } };
    dialog.dispatch('click', event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(topic.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(topic.focus).toHaveBeenCalledWith({ preventScroll: true });
    close.dispatch('click');
    expect(dialog.remove).toHaveBeenCalledTimes(1);
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    controller.open(opener);
    expect(dialog.innerHTML).not.toContain(retained.actions[6].imperative);
    controller.destroy();
    expect(dialog.remove).toHaveBeenCalledTimes(2);
  });
});

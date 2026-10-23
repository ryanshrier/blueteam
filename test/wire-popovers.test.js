import { expect, jest, test } from '@jest/globals';
import { bindScoreDismissal, bindDisclosureDismissal } from '../public/modules/wire/wire-popovers.js';

function setup() {
  const listeners = new Map();
  const summary = { focus: jest.fn() };
  const content = {};
  const panel = { open: true, contains: target => target === summary || target === content,
    querySelector: () => summary };
  const doc = { activeElement: summary, querySelector: () => null,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); } };
  const cleanup = bindScoreDismissal({ querySelectorAll: () => panel.open ? [panel] : [] }, doc);
  const dispatch = (name, props = {}) => {
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn(), ...props };
    listeners.get(name)?.(event);
    return event;
  };
  return { panel, content, summary, doc, cleanup, dispatch };
}

test('Escape closes a focused score and restores its summary without scrolling', () => {
  const ui = setup();
  ui.doc.activeElement = ui.content;
  const event = ui.dispatch('keydown', { key: 'Escape' });
  expect(ui.panel.open).toBe(false);
  expect(ui.summary.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(event.preventDefault).toHaveBeenCalled();
});

test('outside clicks close the overlay without swallowing the requested action or moving focus', () => {
  const ui = setup();
  ui.dispatch('click', { target: ui.content });
  expect(ui.panel.open).toBe(true);
  const event = ui.dispatch('click', { target: { name: 'Inspect evidence' } });
  expect(ui.panel.open).toBe(false);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  expect(ui.summary.focus).not.toHaveBeenCalled();
});

test('tabbing to another control closes the old score', () => {
  const ui = setup();
  ui.dispatch('focusin', { target: {} });
  expect(ui.panel.open).toBe(false);
});

test('Escape is reserved for a foreground modal and cleanup removes document listeners', () => {
  const ui = setup();
  ui.doc.querySelector = () => ({ open: true });
  const event = ui.dispatch('keydown', { key: 'Escape' });
  expect(ui.panel.open).toBe(true);
  expect(event.preventDefault).not.toHaveBeenCalled();
  ui.cleanup();
  ui.dispatch('click', { target: {} });
  expect(ui.panel.open).toBe(true);
});

test('toolbar export and filters dismiss on outside focus and Escape while preserving trigger focus', () => {
  const handlers = new Map();
  const summary = { focus: jest.fn() };
  const inside = {};
  const panel = { open: true, contains: node => node === inside || node === summary, querySelector: () => summary };
  const doc = { activeElement: inside, querySelector: () => null,
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const cleanup = bindDisclosureDismissal([panel], doc);
  handlers.get('click')({ target: inside });
  expect(panel.open).toBe(true);
  handlers.get('keydown')({ key: 'Escape', preventDefault: jest.fn(), stopPropagation: jest.fn() });
  expect(panel.open).toBe(false);
  expect(summary.focus).toHaveBeenCalledWith({ preventScroll: true });
  panel.open = true;
  handlers.get('focusin')({ target: {} });
  expect(panel.open).toBe(false);
  cleanup();
  expect(handlers.size).toBe(0);
});

test.each(['focusin', 'click'])('toolbar disclosures preserve a dialog return target during outside %s', eventName => {
  const handlers = new Map();
  const opener = {};
  const summary = { focus: jest.fn() };
  const panel = { open: true, contains: node => node === opener, querySelector: () => summary };
  let modal = { open: true };
  const doc = { activeElement: opener, querySelector: () => modal,
    addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: name => handlers.delete(name) };
  const cleanup = bindDisclosureDismissal([panel], doc);
  handlers.get(eventName)({ target: { name: 'Dialog control' } });
  expect(panel.open).toBe(true);
  expect(summary.focus).not.toHaveBeenCalled();

  modal = null;
  handlers.get('focusin')({ target: opener });
  expect(panel.open).toBe(true);
  handlers.get(eventName)({ target: { name: 'Another page control' } });
  expect(panel.open).toBe(false);
  cleanup();
});

function toolbar() {
  const handlers = new Map();
  const opener = {};
  const outside = { name: 'Focusable main region' };
  const panel = { open: true, contains: node => node === opener, querySelector: () => ({ focus: jest.fn() }) };
  const doc = { activeElement: outside, querySelector: () => null,
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: (name, handler) => { if (handlers.get(name) === handler) handlers.delete(name); } };
  const cleanup = bindDisclosureDismissal([panel], doc);
  const dispatch = (name, props = {}) => {
    const event = { pointerId: 1, preventDefault: jest.fn(), stopPropagation: jest.fn(), ...props };
    handlers.get(name)?.(event);
    return event;
  };
  return { panel, opener, outside, doc, dispatch, handlers, cleanup };
}

test('toolbar pointer activation survives Safari focusing an ancestor before the button click', () => {
  const ui = toolbar();
  ui.dispatch('pointerdown', { target: ui.opener });
  const focus = ui.dispatch('focusin', { target: ui.outside });
  expect(ui.panel.open).toBe(true);
  expect(focus.preventDefault).not.toHaveBeenCalled();
  expect(focus.stopPropagation).not.toHaveBeenCalled();
  ui.dispatch('pointerup', { target: ui.opener });
  ui.dispatch('click', { target: ui.opener });
  // The control can now open its modal; its return target remains visible.
  ui.doc.querySelector = () => ({ open: true });
  ui.dispatch('focusin', { target: { name: 'Print dialog close button' } });
  expect(ui.panel.open).toBe(true);
  ui.doc.querySelector = () => null;
  ui.dispatch('focusin', { target: ui.opener });
  ui.dispatch('focusin', { target: ui.outside });
  expect(ui.panel.open).toBe(false);
  ui.cleanup();
  expect(ui.handlers.size).toBe(0);
});

test.each(['pointerup', 'pointercancel', 'click', 'keydown'])('%s ends toolbar pointer ownership before subsequent outside focus', eventName => {
  const ui = toolbar();
  ui.dispatch('pointerdown', { target: ui.opener });
  ui.dispatch(eventName, { target: ui.opener, key: 'Tab' });
  ui.dispatch('focusin', { target: ui.outside });
  expect(ui.panel.open).toBe(false);
  ui.cleanup();
});

test('outside pointer activation dismisses a toolbar without intercepting the requested control', () => {
  const ui = toolbar();
  ui.dispatch('pointerdown', { target: ui.opener });
  // A fresh pointer interaction supersedes an unfinished interaction.
  ui.dispatch('pointerdown', { target: ui.outside, pointerId: 2 });
  ui.dispatch('focusin', { target: ui.outside });
  expect(ui.panel.open).toBe(false);
  const click = ui.dispatch('click', { target: ui.outside });
  expect(click.preventDefault).not.toHaveBeenCalled();
  expect(click.stopPropagation).not.toHaveBeenCalled();
  ui.cleanup();
});

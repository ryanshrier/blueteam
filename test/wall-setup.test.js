import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mountDisplaySetup } from '../public/modules/wall/wall-setup.js';

function node() {
  const handlers = new Map();
  return { innerHTML: '', textContent: '', hidden: false, fields: {},
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
    dispatch: (name, event = {}) => handlers.get(name)?.(event),
    setAttribute: jest.fn(), remove: jest.fn(), focus: jest.fn(),
  };
}
describe('Wall display setup lifecycle', () => {
  let controller, dialog, form, notice, nodes, storage, lock;
  const original = {};
  beforeEach(() => {
    for (const key of ['document', 'window', 'navigator', 'localStorage', 'FormData']) original[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    nodes = new Map(); storage = new Map();
    const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
    notice = get('nbCapabilityStatus');
    lock = node(); lock.release = jest.fn().mockResolvedValue();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { wakeLock: { request: jest.fn().mockResolvedValue(lock) } } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
    globalThis.window = { location: { pathname: '/wall', search: '?operator' } };
    globalThis.document = { ...node(), visibilityState: 'visible', getElementById: get, body: { appendChild: jest.fn() },
      documentElement: { requestFullscreen: jest.fn().mockResolvedValue() }, exitFullscreen: jest.fn().mockResolvedValue(),
      createElement: () => {
        dialog = node(); form = node();
        dialog.querySelectorAll = () => [node(), node()];
        dialog.querySelector = () => form;
        dialog.showModal = jest.fn(); dialog.close = () => dialog.dispatch('close');
        return dialog;
      },
    };
    globalThis.FormData = class { constructor(value) { this.values = Object.entries(value.fields); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } };
  });
  afterEach(() => {
    window.location.pathname = '/wire'; controller?.destroy(); controller = null;
    for (const key of Object.keys(original)) { if (original[key]) Object.defineProperty(globalThis, key, original[key]); else delete globalThis[key]; }
  });
  test('cancel returns focus without applying settings; duplicate open and unmount are contained', () => {
    const apply = jest.fn(), open = jest.fn(), trigger = node();
    controller = mountDisplaySetup({ onApply: apply, onOpen: open, isPresentation: () => false });
    controller.open(trigger, true);
    const first = dialog;
    controller.open(trigger, true);
    expect(dialog).toBe(first);
    expect(dialog.innerHTML).toContain('wall-setup-body');
    expect(dialog.innerHTML).toContain('<summary>Playback and playlist</summary>');
    expect(dialog.innerHTML).not.toContain('Keep sensitive');
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    dialog.close();
    expect(trigger.focus).toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });
  test('requests fullscreen in the initiating action, persists only normalized preferences, and releases awake on exit', async () => {
    let presenting = false;
    const apply = jest.fn(() => { presenting = true; window.location.search = ''; });
    controller = mountDisplaySetup({ onApply: apply, onOpen: jest.fn(), isPresentation: () => presenting });
    controller.open(node(), true);
    form.fields = { size: 'large', fullscreen: 'on', awake: 'on', feedSeconds: '60', apiKey: 'must not persist' };
    form.dispatch('submit', { preventDefault: jest.fn(), currentTarget: form });
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ size: 'large', awake: true, feedSeconds: 60 }), true);
    expect(storage.get('bt-wall-display')).not.toContain('apiKey');
    await Promise.resolve(); await Promise.resolve();
    expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
    window.location.pathname = '/wire';
    controller.destroy();
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
  });
  test('declined capabilities leave visible fallback feedback after the setup closes', async () => {
    document.documentElement.requestFullscreen.mockRejectedValue(new Error('Denied'));
    navigator.wakeLock.request.mockRejectedValue(new Error('Denied'));
    controller = mountDisplaySetup({ onApply: jest.fn(), onOpen: jest.fn(), isPresentation: () => true });
    controller.open(node());
    form.fields = { fullscreen: 'on', awake: 'on' };
    form.dispatch('submit', { preventDefault: jest.fn(), currentTarget: form });
    await Promise.resolve(); await Promise.resolve();
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Fullscreen declined');
    expect(notice.textContent).toContain('Screen awake request declined');
  });
});

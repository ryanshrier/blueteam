import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let api;
let handlers;
let controllers;
let savedNavigator;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(async () => {
  jest.resetModules();
  handlers = new Map(); controllers = [];
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: { isActive: true }, wakeLock: { request: jest.fn() } } });
  globalThis.document = {
    visibilityState: 'visible', fullscreenEnabled: true, fullscreenElement: null,
    documentElement: { requestFullscreen: jest.fn(async () => { document.fullscreenElement = document.documentElement; }) },
    exitFullscreen: jest.fn(async () => { document.fullscreenElement = null; }),
    addEventListener: (name, fn) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener: (name, fn) => handlers.get(name)?.delete(fn),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{}' } });
  api = await import('../public/modules/wall/wall-browser.js');
});
afterEach(async () => {
  controllers.forEach(controller => controller.destroy());
  await flush();
  delete globalThis.document; delete globalThis.localStorage;
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator); else delete globalThis.navigator;
});
const mount = settings => { const result = api.mountWallBrowser({ settings: { awake: false, ...settings }, onExit: jest.fn() }); controllers.push(result); return result; };

test('fullscreen runs only on an allowed explicit gesture and a mount does not request it', async () => {
  mount();
  expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled();
  navigator.userActivation.isActive = false;
  expect(await api.requestWallFullscreen()).toBe(false);
  expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled();
  navigator.userActivation.isActive = true;
  expect(await api.requestWallFullscreen()).toBe(true);
  expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
});

test('explicit fullscreen-off and rejected browser requests leave presentation usable', async () => {
  localStorage.getItem = () => '{"fullscreen":false}';
  expect(await api.requestWallFullscreen()).toBe(false);
  localStorage.getItem = () => '{}';
  document.documentElement.requestFullscreen.mockRejectedValue(new Error('Browser policy'));
  expect(await api.requestWallFullscreen()).toBe(false);
  expect(() => mount()).not.toThrow();
});

test('does not call an exposed fullscreen method when document policy disables fullscreen', async () => {
  document.fullscreenEnabled = false;
  expect(await api.requestWallFullscreen()).toBe(false);
  expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled();
  mount();
  expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled();
  document.fullscreenEnabled = true;
  expect(await api.requestWallFullscreen()).toBe(true);
  expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
});

test('late fullscreen cleanup cannot exit a later Wall mount', async () => {
  let resolve;
  document.documentElement.requestFullscreen.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = api.requestWallFullscreen();
  const old = mount();
  old.destroy();
  const nextPending = api.requestWallFullscreen();
  const current = mount();
  document.fullscreenElement = document.documentElement;
  resolve(); await pending; await nextPending; await flush();
  expect(document.exitFullscreen).toHaveBeenCalledTimes(1); // old transition released before new entry
  expect(document.fullscreenElement).toBe(document.documentElement);
  current.destroy(); await flush();
  expect(document.exitFullscreen).toHaveBeenCalledTimes(2);
});

test('late native exit from the previous visit cannot exit a new visit waiting to enter', async () => {
  let finishExit;
  document.exitFullscreen.mockImplementationOnce(() => new Promise(resolve => { finishExit = resolve; }));
  await api.requestWallFullscreen();
  const old = mount();
  old.destroy();
  const pending = api.requestWallFullscreen();
  const onExit = jest.fn();
  const current = api.mountWallBrowser({ settings: { awake: false }, onExit }); controllers.push(current);
  document.fullscreenElement = null;
  for (const handler of handlers.get('fullscreenchange')) handler();
  expect(onExit).not.toHaveBeenCalled();
  finishExit(); await pending; await flush();
  expect(document.fullscreenElement).toBe(document.documentElement);
  expect(onExit).not.toHaveBeenCalled();
  document.fullscreenElement = null;
  for (const handler of handlers.get('fullscreenchange')) handler();
  expect(onExit).toHaveBeenCalledTimes(1);
});

test('leaving before a fullscreen request finishes still releases that departed session', async () => {
  let resolve;
  document.documentElement.requestFullscreen.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = api.requestWallFullscreen();
  mount().destroy();
  document.fullscreenElement = document.documentElement;
  resolve(); await pending; await flush();
  expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
});

test('native fullscreen Escape exits the Wall while ordinary cleanup cannot invoke onExit', async () => {
  const onExit = jest.fn();
  await api.requestWallFullscreen();
  const controller = api.mountWallBrowser({ settings: { awake: false }, onExit }); controllers.push(controller);
  document.fullscreenElement = null;
  for (const handler of handlers.get('fullscreenchange')) handler();
  expect(onExit).toHaveBeenCalledTimes(1);
  controller.destroy(); await flush();
  expect(onExit).toHaveBeenCalledTimes(1);
});

test('screen-awake requests release on exit, including late resolution, and recover on visibility return', async () => {
  let resolve, released;
  const first = { release: jest.fn(async () => {}), addEventListener: (name, fn) => { released = fn; } };
  navigator.wakeLock.request.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const controller = mount({ awake: true }); await flush();
  expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
  released();
  document.visibilityState = 'visible';
  for (const handler of handlers.get('visibilitychange')) handler();
  expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
  controller.destroy();
  const late = { release: jest.fn(async () => {}), addEventListener: jest.fn() };
  resolve(late); await flush();
  expect(late.release).toHaveBeenCalledTimes(1);
  expect(handlers.get('visibilitychange').size).toBe(0);
});

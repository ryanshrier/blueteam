import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { emit, setState } from '../public/modules/core/store.js';

const mount = jest.fn();
const unmount = jest.fn();
jest.unstable_mockModule('../public/modules/wall/wall-view.js', () => ({ mount, unmount }));
jest.unstable_mockModule('../public/modules/core/router.js', () => ({
  initRouter: () => { emit('mode-changed', 'wall'); emit('route-changed', { mode: 'wall' }); },
  navigate: jest.fn(),
}));
jest.unstable_mockModule('../public/modules/layout/header.js', () => ({ initHeader: jest.fn() }));
jest.unstable_mockModule('../public/modules/core/shortcuts.js', () => ({ initShortcuts: jest.fn() }));
jest.unstable_mockModule('../public/modules/core/infotip.js', () => ({ initInfotips: jest.fn() }));
jest.unstable_mockModule('../public/modules/core/api.js', () => ({ fetchLandscape: async () => ({}) }));
jest.unstable_mockModule('../public/modules/core/theme.js', () => ({ getThemePreference: () => 'dark', applyTheme: jest.fn() }));

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const region = {
  classList: { add: jest.fn(), remove: jest.fn() },
  querySelector: () => null, hasAttribute: () => true,
  setAttribute: jest.fn(), removeAttribute: jest.fn(), focus: jest.fn(),
};
globalThis.document = {
  getElementById: () => region,
  body: { classList: { add: jest.fn(), remove: jest.fn() } },
};
globalThis.window = { location: { pathname: '/wall', search: '' }, scrollTo: jest.fn(), addEventListener: jest.fn() };
jest.useFakeTimers();
setState({ mode: 'wall' });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
});

describe('Wall route presentation changes', () => {
  test('switches kiosk/operator on query changes, but keeps a held operator page on same-route navigation', async () => {
    await import('../public/app.js');
    await settle();
    expect(mount).toHaveBeenCalledTimes(1);

    window.location.search = '?operator';
    emit('route-changed', { mode: 'wall' });
    await settle();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(unmount).toHaveBeenCalledTimes(1);

    emit('route-changed', { mode: 'wall' });
    await settle();
    expect(mount).toHaveBeenCalledTimes(2);

    window.location.search = '?kiosk';
    emit('route-changed', { mode: 'wall' });
    await settle();
    expect(mount).toHaveBeenCalledTimes(3);
    expect(unmount).toHaveBeenCalledTimes(2);
  });
});

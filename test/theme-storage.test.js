import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let theme;
beforeEach(async () => {
  jest.resetModules();
  global.document = {
    documentElement: { dataset: {}, style: { setProperty: jest.fn(), removeProperty: jest.fn() } },
    querySelector: () => null,
  };
  global.matchMedia = () => ({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() });
  Object.defineProperty(global, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  theme = await import('../public/modules/core/theme.js');
});
afterEach(() => {
  delete global.document;
  delete global.matchMedia;
  delete global.localStorage;
});

test('blocked storage retains safe defaults and keeps interactive Settings choices usable', () => {
  expect(theme.getThemePreference()).toBe('system');
  expect(theme.getTheme()).toBe('light');
  expect(theme.getAccent()).toBe(theme.DEFAULT_ACCENT);
  expect(() => theme.applyTheme('dark')).not.toThrow();
  expect(theme.getThemePreference()).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(() => theme.applyAccent('#6d7cf0')).not.toThrow();
  expect(theme.getAccent()).toBe('#6d7cf0');
  expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--brand', '#6d7cf0');
  expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--brand-text', expect.any(String));
});

test('quota failures do not let an old saved choice override a newly painted preference', () => {
  Object.defineProperty(global, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'bt-theme' ? 'dark' : '#64748b',
    setItem: () => { throw new Error('Quota exceeded'); },
  } });
  expect(theme.getThemePreference()).toBe('dark');
  theme.applyTheme('light');
  theme.applyAccent('#14b8a6');
  expect(theme.getThemePreference()).toBe('light');
  expect(theme.getAccent()).toBe('#14b8a6');
});

test.each([true, false])('first paint follows the OS even when storage is blocked (light=%s)', light => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const boot = html.match(/<script id="theme-init">([\s\S]*?)<\/script>/)[1];
  const media = () => ({ matches: light });
  const context = { document, window: { matchMedia: media }, matchMedia: media };
  Object.defineProperty(context, 'localStorage', { get() { throw Error('Storage denied'); } });
  runInNewContext(boot, context);
  expect(document.documentElement.dataset.theme).toBe(light ? 'light' : 'dark');
});

test('system changes repaint while an explicit override removes the listener', () => {
  const media = { matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() };
  global.matchMedia = () => media;
  theme.applyTheme('system');
  expect(document.documentElement.dataset.theme).toBe('light');
  const listener = media.addEventListener.mock.calls[0][1];
  listener({ matches: false });
  expect(document.documentElement.dataset.theme).toBe('dark');
  theme.applyTheme('light');
  expect(media.removeEventListener).toHaveBeenCalledWith('change', listener);
  expect(document.documentElement.dataset.theme).toBe('light');
});

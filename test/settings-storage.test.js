import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const fetchSettings = jest.fn();
const saveSettings = jest.fn();
const verifyKey = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({ fetchSettings, saveSettings, verifyKey }));
jest.unstable_mockModule('../public/modules/settings/system-health.js', () => ({ mountSystemHealth: () => () => {} }));
const { render, unmount } = await import('../public/modules/settings/settings-view.js');

let main, nodes;
beforeEach(() => {
  const get = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', value: '', dataset: {}, disabled: false,
      querySelectorAll: () => [], addEventListener: jest.fn(), setAttribute: jest.fn(),
      classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: () => false },
    });
    return nodes.get(selector);
  };
  nodes = new Map();
  main = { innerHTML: '', querySelector: get };
  global.document = { documentElement: { dataset: {} }, getElementById: id => get(`#${id}`) };
  Object.defineProperty(global, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  fetchSettings.mockReset().mockResolvedValue({
    ai: { enabled: false }, alertRules: [], watchProfile: { technologies: ['Synthetic gateway'] },
    briefSchedule: { enabled: false }, storage: { status: 'ok' },
  });
});
afterEach(() => { unmount(); delete global.document; delete global.localStorage; });

test('denied browser storage cannot prevent server settings/profile controls from loading', async () => {
  expect(() => render(main)).not.toThrow();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(nodes.get('#profileTechnologies').value).toBe('Synthetic gateway');
  expect(nodes.get('#saveProfile').disabled).toBe(false);
  expect(nodes.get('#scheduleStatus').textContent).toContain('automatic generation is not armed');
  expect(nodes.get('#settingsStorageStatus').hidden).toBe(true);
  expect(saveSettings).not.toHaveBeenCalled();
  expect(verifyKey).not.toHaveBeenCalled();
});

test('hidden storage status does not render the empty error frame', () => {
  const css = readFileSync(new URL('../public/settings.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.settings-status\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('server settings recovery errors are visible as text, independently of browser storage', async () => {
  fetchSettings.mockResolvedValue({ ai: { enabled: false }, storage: {
    status: 'error', message: 'Saved settings are corrupt. Restore <settings.json> before saving.',
  } });
  render(main);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(nodes.get('#settingsStorageStatus').hidden).toBe(false);
  expect(nodes.get('#settingsStorageStatus').textContent).toContain('Restore <settings.json>');
  expect(nodes.get('#settingsStorageStatus').innerHTML).toBe('');
});

test.each(['resolve', 'reject'])('a delayed %s after leaving Settings cannot touch the next view', async outcome => {
  let finish, fail;
  fetchSettings.mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(main);
  unmount();
  main.querySelector = jest.fn(() => null);
  if (outcome === 'resolve') finish({ ai: { enabled: true }, alertRules: [] });
  else fail(new Error('delayed failure'));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(main.querySelector).not.toHaveBeenCalled();
});

test('an older Settings mount cannot overwrite the newly loaded profile', async () => {
  let finish;
  fetchSettings.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(main);
  unmount();
  fetchSettings.mockResolvedValue({ ai: { enabled: false }, alertRules: [],
    watchProfile: { technologies: ['New profile'] }, briefSchedule: { enabled: false } });
  render(main);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(nodes.get('#profileTechnologies').value).toBe('New profile');
  finish({ ai: { enabled: true }, alertRules: [], watchProfile: { technologies: ['Old profile'] } });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(nodes.get('#profileTechnologies').value).toBe('New profile');
});

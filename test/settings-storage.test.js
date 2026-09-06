import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { emit } from '../public/modules/core/store.js';

const fetchSettings = jest.fn();
const saveSettings = jest.fn();
const verifyKey = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({ fetchSettings, saveSettings, verifyKey }));
jest.unstable_mockModule('../public/modules/settings/system-health.js', () => ({ mountSystemHealth: () => () => {} }));
const { render, unmount } = await import('../public/modules/settings/settings-view.js');

let main, nodes;
beforeEach(() => {
  const get = selector => {
    if (!nodes.has(selector)) {
      const attributes = {};
      nodes.set(selector, {
      id: selector.startsWith('#') ? selector.slice(1) : '',
      innerHTML: '', textContent: '', value: '', dataset: {}, disabled: false,
      querySelector: get, querySelectorAll: () => [], addEventListener: jest.fn(), removeEventListener: jest.fn(),
      closest: () => get(`card-${selector}`),
      elements: { namedItem: name => get(`[name="${name}"]`) },
      setAttribute: jest.fn((key, value) => { attributes[key] = value; }),
      getAttribute: key => attributes[key] ?? null,
      removeAttribute: jest.fn(key => { delete attributes[key]; }),
      getBoundingClientRect: () => ({ height: 64, top: 0 }),
      focus() { document.activeElement = this; },
      insertAdjacentElement(_position, element) { nodes.set(`#${element.id}`, element); },
      remove() { nodes.delete(`#${this.id}`); },
      classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: () => false },
    }); }
    return nodes.get(selector);
  };
  nodes = new Map();
  main = { innerHTML: '', querySelector: get };
  global.document = { documentElement: { dataset: {}, scrollHeight: 3000 }, getElementById: id => get(`#${id}`), createElement: () => get(`created-${nodes.size}`) };
  global.window = { addEventListener: jest.fn(), removeEventListener: jest.fn(), scrollY: 0, innerHeight: 800,
    matchMedia: () => ({ matches: false }), requestAnimationFrame: jest.fn() };
  Object.defineProperty(global, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  fetchSettings.mockReset().mockResolvedValue({
    ai: { enabled: false }, alertRules: [], watchProfile: { technologies: ['Synthetic gateway'] },
    briefSchedule: { enabled: false }, storage: { status: 'ok' },
  });
  saveSettings.mockReset().mockImplementation(async patch => ({
    ai: { enabled: Boolean(patch.anthropicKey) }, ...patch,
  }));
  verifyKey.mockReset();
});
afterEach(() => { unmount(); delete global.document; delete global.window; delete global.localStorage; jest.useRealTimers(); });

test('denied browser storage cannot prevent server settings/profile controls from loading', async () => {
  expect(() => render(main)).not.toThrow();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(nodes.get('#profileTechnologies').value).toBe('Synthetic gateway');
  expect(nodes.get('#saveProfile').disabled).toBe(true); // no changes yet
  expect(nodes.get('#scheduleStatus').textContent).toBe('Automation · Disabled');
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

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const fire = (id, type = 'click') => nodes.get(`#${id}`).addEventListener.mock.calls.find(([event]) => event === type)?.[1]({ key: '', target: nodes.get(`#${id}`) });
const fill = (id, value) => { nodes.get(`#${id}`).value = value; fire(id, 'input'); };

function sectionIndexFixture(hash = '') {
  const ids = ['set-profile', 'set-ai', 'set-schedule', 'set-wall', 'set-theme', 'systemHealth'];
  const positions = [200, 1000, 1800, 2200, 2600, 3200];
  const links = ids.map(id => {
    const link = main.querySelector(`link-${id}`);
    link.setAttribute('href', `#${id}`);
    return link;
  });
  main.querySelector('.settings-index').querySelectorAll = () => links;
  main.querySelector('.settings-index').getBoundingClientRect = () => ({ height: 60 });
  main.querySelector('#appHeader').getBoundingClientRect = () => ({ height: 120 });
  ids.forEach((id, index) => {
    const target = main.querySelector(`#${id}`);
    target.getBoundingClientRect = () => ({ top: positions[index] - window.scrollY, height: 28 });
    target.scrollIntoView = jest.fn(() => { window.scrollY = positions[index] - 212; });
  });
  document.documentElement.scrollHeight = 4200;
  window.location = { pathname: '/settings', hash };
  window.history = { replaceState: jest.fn((_state, _title, value) => { window.location.hash = value; }) };
  window.matchMedia = () => ({ matches: true });
  window.getComputedStyle = target => target === document.documentElement ? { scrollPaddingTop: '136px' } : { scrollMarginTop: '76px' };
  const callbacks = new Map();
  let id = 0;
  window.requestAnimationFrame.mockImplementation(callback => { callbacks.set(++id, callback); return id; });
  window.cancelAnimationFrame = callback => callbacks.delete(callback);
  const runFrames = () => { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach(callback => callback()); };
  const scroll = y => {
    window.scrollY = y;
    window.addEventListener.mock.calls.find(([event]) => event === 'scroll')[1]();
    runFrames();
  };
  return { links, runFrames, scroll };
}

test('mobile section selection stays active at its CSS landing offset and follows manual scrolling', () => {
  const { links, scroll } = sectionIndexFixture();
  render(main);
  nodes.get('#settingsSection').value = 'set-schedule';
  fire('settingsSection', 'change');
  expect(window.location.hash).toBe('#set-schedule');
  expect(nodes.get('#set-schedule').getBoundingClientRect().top).toBe(212);
  expect(nodes.get('#settingsSection').value).toBe('set-schedule');
  expect(links[2].getAttribute('aria-current')).toBe('location');
  scroll(1591); // A genuine scroll clears the explicit-selection hold.
  expect(nodes.get('#settingsSection').value).toBe('set-schedule');
  scroll(1580); // Schedule moves below its landing threshold; AI is current again.
  expect(nodes.get('#settingsSection').value).toBe('set-ai');
  scroll(2388);
  expect(nodes.get('#settingsSection').value).toBe('set-theme');
});

test('Settings restores initial and same-view section fragments after rendering and cleans up on leave', () => {
  const { runFrames } = sectionIndexFixture('#systemHealth');
  render(main);
  expect(nodes.get('#systemHealth').scrollIntoView).not.toHaveBeenCalled();
  runFrames();
  expect(document.activeElement.id).toBe('systemHealth');
  expect(nodes.get('#settingsSection').value).toBe('systemHealth');
  window.location.hash = '#set-wall';
  emit('route-changed', { mode: 'settings' });
  runFrames();
  expect(document.activeElement.id).toBe('set-wall');
  expect(nodes.get('#settingsSection').value).toBe('set-wall');
  window.location.hash = '#set-schedule';
  emit('route-changed', { mode: 'settings' });
  runFrames();
  expect(document.activeElement.id).toBe('set-schedule');
  expect(nodes.get('#settingsSection').value).toBe('set-schedule');
  window.location.hash = '#set-ai';
  emit('route-changed', { mode: 'settings' });
  unmount();
  runFrames();
  expect(nodes.get('#set-ai').scrollIntoView).not.toHaveBeenCalled();
  emit('route-changed', { mode: 'settings' });
  runFrames();
  expect(nodes.get('#set-ai').scrollIntoView).not.toHaveBeenCalled();
});

test('profile, schedule, and secret drafts survive route changes without browser storage and can be discarded', async () => {
  render(main); await flush();
  fill('profileTechnologies', 'Draft gateway');
  fill('scheduleTime', '06:30');
  fill('apiKey', 'sk-ant-synthetic-fixture');
  unmount(); render(main); await flush();
  expect(nodes.get('#profileTechnologies').value).toBe('Draft gateway');
  expect(nodes.get('#scheduleTime').value).toBe('06:30');
  expect(nodes.get('#apiKey').value).toBe('sk-ant-synthetic-fixture');
  expect(nodes.get('#profileSaveState').textContent).toBe('Unsaved changes');
  expect(nodes.get('#scheduleSaveState').textContent).toBe('Unsaved changes');
  fire('discardProfile'); fire('discardSchedule'); fire('discardKey');
  expect(nodes.get('#profileTechnologies').value).toBe('Synthetic gateway');
  expect(nodes.get('#scheduleTime').value).toBe('05:00');
  expect(nodes.get('#apiKey').value).toBe('');
});

test('schedule save state distinguishes edits, freezes submitted fields, and clears after success', async () => {
  render(main); await flush();
  expect(nodes.get('#saveSchedule').disabled).toBe(true);
  fill('scheduleTime', '06:30');
  expect(nodes.get('#saveSchedule').disabled).toBe(false);
  expect(nodes.get('#schedulePreview').textContent).toMatch(/^Proposed change:/);
  let finish;
  saveSettings.mockImplementation(patch => new Promise(resolve => { finish = () => resolve(patch); }));
  const saving = fire('saveSchedule');
  expect(nodes.get('#scheduleTime').disabled).toBe(true);
  expect(saveSettings).toHaveBeenCalledWith({ briefSchedule: { enabled: false, time: '06:30', timezone: 'local', missedRun: 'skip', retryMinutes: 15, maxAttempts: 3 } });
  finish(); await saving;
  expect(nodes.get('#saveSchedule').disabled).toBe(true);
  expect(nodes.get('#scheduleTime').disabled).toBe(false);
  expect(nodes.get('#scheduleSaveState').textContent).toBe('Saved schedule');
  expect(nodes.get('#schedulePreview').textContent).not.toMatch(/Proposed|Save to apply/);
});

test('invalid profile and schedule values focus and describe the offending fields without submitting', async () => {
  render(main); await flush();
  fill('profileTechnologies', Array.from({ length: 26 }, (_, index) => `term ${index}`).join('\n'));
  await fire('saveProfile');
  expect(document.activeElement.id).toBe('profileTechnologies');
  expect(nodes.get('#profileTechnologies').getAttribute('aria-invalid')).toBe('true');
  expect(nodes.get('#profileTechnologies').getAttribute('aria-describedby')).toContain('profileTechnologies-error');
  fill('scheduleRetry', '0');
  await fire('saveSchedule');
  expect(document.activeElement.id).toBe('scheduleRetry');
  expect(nodes.get('#scheduleRetry').getAttribute('aria-invalid')).toBe('true');
  expect(saveSettings).not.toHaveBeenCalled();
  fire('discardProfile'); fire('discardSchedule');
});

test('service failures have a direct retry and are distinguished from missing operator access', async () => {
  fetchSettings.mockRejectedValueOnce(new Error('Request failed (/api/settings): 503'));
  render(main); await flush();
  expect(nodes.get('#settingsLoadNotice').hidden).toBe(false);
  expect(nodes.get('#settingsLoadMessage').textContent).toMatch(/server connection/);
  expect(nodes.get('#apiKey').disabled).toBe(true);
  await fire('retrySettings');
  expect(nodes.get('#settingsLoadNotice').hidden).toBe(true);
  expect(nodes.get('#profileTechnologies').disabled).toBe(false);
  unmount();
  fetchSettings.mockResolvedValue({ ai: { enabled: false } });
  render(main); await flush();
  expect(nodes.get('#settingsLoadMessage').textContent).toMatch(/Operator access required/);
  expect(nodes.get('#apiKey').disabled).toBe(true);
});

test('key removal has durable explicit confirmation and cancel never writes', async () => {
  fetchSettings.mockResolvedValue({ ai: { enabled: true, keySource: 'local' }, watchProfile: { technologies: [] }, briefSchedule: { enabled: false } });
  render(main); await flush();
  jest.useFakeTimers();
  fire('clearKey');
  jest.advanceTimersByTime(10000);
  expect(nodes.get('#keyRemoveConfirm').hidden).toBe(false);
  expect(document.activeElement.id).toBe('cancelRemoveKey');
  fire('cancelRemoveKey');
  expect(nodes.get('#keyRemoveConfirm').hidden).toBe(true);
  expect(saveSettings).not.toHaveBeenCalled();
  fire('clearKey'); fire('confirmRemoveKey'); await flush();
  expect(saveSettings).toHaveBeenCalledWith({ anthropicKey: '' });
});

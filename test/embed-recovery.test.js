import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/modules/embed.js', import.meta.url), 'utf8');

function mountEmbed() {
  const elements = new Map();
  const events = new Map();
  for (const id of ['embedSignals', 'embedSnapshot', 'embedRefresh', 'embedWatch', 'embedStatus']) {
    const handlers = new Map();
    elements.set(id, { innerHTML: 'Retained snapshot', textContent: '', disabled: false, checked: true,
      children: [], addEventListener: (name, handler) => handlers.set(name, handler),
      dispatch: (name, value) => handlers.get(name)?.(value) });
  }
  const fetch = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  vm.runInNewContext(source, { document: { getElementById: id => elements.get(id), hidden: false },
    window: { addEventListener: (name, handler) => events.set(name, handler) },
    location: { href: 'http://embed.test/embed' }, fetch, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval });
  return { elements, events, fetch };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('a hung request times out, retains the displayed snapshot and allows another refresh', async () => {
  const { elements, fetch } = mountEmbed();
  const button = elements.get('embedRefresh');
  button.dispatch('click');
  expect(button.disabled).toBe(true);
  await jest.advanceTimersByTimeAsync(15_000);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(button.disabled).toBe(false);
  expect(elements.get('embedSignals').innerHTML).toBe('Retained snapshot');
  expect(elements.get('embedStatus').textContent).toBe('Update unavailable. Current signals retained.');
  button.dispatch('click');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('leaving the page aborts the request and prevents late changes or future polling', async () => {
  const { elements, events, fetch } = mountEmbed();
  elements.get('embedRefresh').dispatch('click');
  events.get('pagehide')({ persisted: false });
  await jest.advanceTimersByTimeAsync(120_000);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(elements.get('embedStatus').textContent).toBe('');
});

test('returning from the back-forward cache restores polling after aborting the old request', async () => {
  const { elements, events, fetch } = mountEmbed();
  elements.get('embedRefresh').dispatch('click');
  events.get('pagehide')({ persisted: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(elements.get('embedRefresh').disabled).toBe(false);
  events.get('pageshow')({ persisted: true });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
});

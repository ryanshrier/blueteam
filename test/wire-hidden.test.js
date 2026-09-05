import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchHeadlines = jest.fn();
const fetchLandscape = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({ fetchHeadlines, fetchLandscape }));
const showToast = jest.fn();
jest.unstable_mockModule('../public/modules/core/toast.js', () => ({ showToast }));

const signals = [
  { title: 'Synthetic Alpha', link: 'https://example.test/alpha', source: 'Fixture', horizon: 1, score: 80 },
  { title: 'Synthetic Beta', link: 'https://example.test/beta', source: 'Fixture', horizon: 2, score: 70 },
  { title: 'Synthetic Gamma', link: 'https://example.test/gamma', source: 'Fixture', horizon: 2, score: 60 },
];

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', dataset: {}, style: {},
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { this[name] = value; },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    dispatch(name, event = {}) { listeners.get(name)?.(event); },
    querySelectorAll: () => [], querySelector: () => null,
    appendChild: () => {}, click: () => {}, remove: () => {}, focus: jest.fn(),
  };
}

describe('Wire Hidden recovery', () => {
  let wire;
  let storage;
  let elements;
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const click = (host, selector, dataset = {}) => {
    const button = { ...element(), dataset, closest: () => null };
    get(host).dispatch('click', { target: { closest: value => value === selector ? button : null } });
  };
  const toggleHidden = () => click('wireToggles', '.wire-toggle', { toggle: 'hidden' });
  const start = async () => {
    wire = await import('../public/modules/wire/wire-view.js');
    wire.render(get('main'));
    await jest.advanceTimersByTimeAsync(0);
  };
  const reload = async () => {
    wire.unmount();
    jest.resetModules();
    elements = new Map();
    await start();
  };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    elements = new Map();
    storage = new Map();
    global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    global.document = {
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
      body: element(), getElementById: get, querySelector: () => null, querySelectorAll: () => [],
      createElement: element,
    };
    global.window = {
      location: { href: 'http://localhost/wire', pathname: '/wire', search: '', origin: 'http://localhost' },
      scrollY: 0, scrollTo: jest.fn(),
    };
    global.location = window.location;
    global.history = { state: {}, replaceState: (_state, _title, url) => {
      window.location.search = new URL(url, window.location.origin).search;
    } };
    fetchHeadlines.mockReset().mockResolvedValue({ headlines: signals, generatedAt: new Date().toISOString() });
    fetchLandscape.mockReset().mockResolvedValue({ convergence: [] });
  });

  afterEach(() => {
    wire?.unmount();
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const key of ['document', 'window', 'location', 'history', 'localStorage']) delete global[key];
  });

  test('recovers an individually hidden signal after Undo expires and the page reloads', async () => {
    await start();
    click('wireList', '[data-dismiss]', { dismiss: signals[0].link });
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    expect(get('wireHidden').textContent).toBe('Hidden (1)');
    await jest.advanceTimersByTimeAsync(8001);
    expect(get('wireUndoRow').innerHTML).toBe('');
    await reload();
    toggleHidden();
    expect(window.location.search).toBe('?hidden=1');
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Beta');
    expect(get('wireShown').textContent).toBe('1 hidden signal');
    expect(get('wireAnnounce').textContent).toBe('1 of 1 hidden signal');
    click('wireList', '[data-restore]', { restore: signals[0].link });
    expect(JSON.parse(storage.get('wire.dismissedKeys'))).toEqual([]);
    expect(get('wireHidden').textContent).toBe('Hidden (0)');
    get('wireHidden').focus.mockClear();
    click('wireAboveList', '.wire-show-visible');
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    expect(get('wireShown').textContent).toBe('3 signals');
    expect(get('wireHidden').focus).toHaveBeenCalledTimes(1);
  });

  test('restores all available hidden records across filters without changing read state', async () => {
    storage.set('wire.dismissedKeys', JSON.stringify([signals[0].link, signals[1].link, 'archived-unavailable']));
    storage.set('wire.readKeys', JSON.stringify([signals[0].link]));
    window.location.search = '?hidden=1&h=2';
    await start();
    expect(get('wireHidden').textContent).toBe('Hidden (2)');
    expect(get('wireShown').textContent).toBe('1 of 2 hidden signals');
    expect(get('wireList').innerHTML).toContain('Synthetic Beta');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    click('wireHiddenNotice', '[data-restore-all]');
    expect(JSON.parse(storage.get('wire.dismissedKeys'))).toEqual(['archived-unavailable']);
    expect(JSON.parse(storage.get('wire.readKeys'))).toEqual([signals[0].link]);
    expect(get('wireHidden').textContent).toBe('Hidden (0)');
    click('wireAboveList', '.wire-show-visible');
    expect(get('wireShown').textContent).toBe('2 of 3 signals');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha'); // tier filter preserved
    expect(window.location.search).toBe('?h=2');
  });

  test('Hidden exports exactly the visible selection with unchanged read state', async () => {
    storage.set('wire.dismissedKeys', JSON.stringify([signals[0].link, signals[1].link]));
    storage.set('wire.readKeys', JSON.stringify([signals[0].link]));
    window.location.search = '?hidden=1&h=1';
    await start();
    const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
    jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    click('wireExport', '[data-export]', { export: 'json' });
    const payload = JSON.parse(await createObjectURL.mock.calls[0][0].text());
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ title: 'Synthetic Alpha', read: true });
    click('wireList', '[data-restore]', { restore: signals[0].link });
    expect(JSON.parse(storage.get('wire.readKeys'))).toEqual([signals[0].link]);
    await reload();
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    expect(get('wireShown').textContent).toBe('0 of 1 hidden signal');
  });

  test('keeps instant Undo available independently of the persistent Hidden view', async () => {
    await start();
    click('wireList', '[data-dismiss]', { dismiss: signals[0].link });
    expect(get('wireUndoRow').innerHTML).toContain('>Undo</span>');
    expect(get('wireUndoRow').innerHTML).not.toContain('aria-hidden');
    click('wireUndoRow', '.wire-undo-chip');
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    expect(get('wireHidden').textContent).toBe('Hidden (0)');
    expect(get('wireUndoRow').innerHTML).toBe('');
  });

  test('copy writes the URL payload and waits for clipboard confirmation before announcing success', async () => {
    await start();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let finish;
    const writeText = jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('clipboard denied'));
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } });
    showToast.mockClear();
    try {
      expect(get('wireList').innerHTML).toContain(`data-copy-link="${signals[0].link}"`);
      click('wireList', '[data-copy-link]', { copyLink: signals[0].link });
      expect(writeText).toHaveBeenCalledWith(signals[0].link);
      expect(showToast).not.toHaveBeenCalled();
      finish();
      await Promise.resolve();
      expect(showToast).toHaveBeenCalledWith('Link copied', 'success');
      showToast.mockClear();
      click('wireList', '[data-copy-cve]', { copyCve: 'CVE-2026-1234' });
      await Promise.resolve();
      expect(writeText).toHaveBeenLastCalledWith('CVE-2026-1234');
      expect(showToast).toHaveBeenCalledWith('Could not copy to clipboard', 'error');
      expect(showToast).not.toHaveBeenCalledWith('CVE copied', 'success');
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous);
      else delete globalThis.navigator;
    }
  });

  test('keeps loading and failed requests distinct from a loaded empty feed, then retries in place', async () => {
    let rejectRequest;
    fetchHeadlines.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    await start();
    expect(get('wireShown').textContent).toBe('Loading…');
    expect(get('wireList')['aria-busy']).toBe('true');
    expect(get('wireExport').classList.contains('is-disabled')).toBe(true);
    rejectRequest(new Error('offline'));
    await jest.advanceTimersByTimeAsync(0);
    expect(get('wireMeta').textContent).toBe('Feed unavailable');
    expect(get('wireShown').textContent).toBe('Unavailable');
    expect(get('wireColumns').hidden).toBe(true);
    expect(get('wireList')['aria-busy']).toBe('false');
    expect(get('wireAboveList').innerHTML).toContain('Retry feed');
    expect(get('wireExport').classList.contains('is-disabled')).toBe(true);
    click('wireAboveList', '[data-wire-retry]');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchHeadlines).toHaveBeenCalledTimes(2);
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    expect(get('wireColumns').hidden).toBe(false);
    expect(get('wireExport').classList.contains('is-disabled')).toBe(false);
  });

  test('loaded empty feeds hide table furniture and keep export unavailable', async () => {
    fetchHeadlines.mockResolvedValueOnce({ headlines: [], generatedAt: new Date().toISOString() });
    await start();
    expect(get('wireShown').textContent).toBe('0 signals');
    expect(get('wireList')['aria-busy']).toBe('false');
    expect(get('wireColumns').hidden).toBe(true);
    expect(get('wireAboveList').innerHTML).toContain('No signals yet');
    expect(get('wireAboveList').innerHTML).not.toContain('Retry feed');
    expect(get('wireExport').classList.contains('is-disabled')).toBe(true);
  });

  test('clears matching filters before zero results while preserving the Hidden mode', async () => {
    storage.set('wire.dismissedKeys', JSON.stringify([signals[0].link, signals[1].link]));
    window.location.search = '?hidden=1&h=1';
    await start();
    expect(get('wireClear').hidden).toBe(false);
    get('wireClear').dispatch('click');
    expect(window.location.search).toBe('?hidden=1');
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    expect(get('wireList').innerHTML).toContain('Synthetic Beta');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Gamma');
    expect(get('wireSearch').focus).toHaveBeenCalledTimes(1);
  });

  test('renders readable score axis data and excludes nonfinite component values', async () => {
    fetchHeadlines.mockResolvedValueOnce({ headlines: [{ ...signals[0], scoreComponents: { exploitation: .72, corroboration: .5, severity: Infinity, relevance: NaN } }], generatedAt: new Date().toISOString() });
    await start();
    const html = get('wireList').innerHTML;
    expect(html).toContain('Threat activity');
    expect(html).toContain('Cross-source reporting');
    expect(html).toContain('class="wsb-val">72');
    expect(html).toContain('Evidence axes · 0–100');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });
});

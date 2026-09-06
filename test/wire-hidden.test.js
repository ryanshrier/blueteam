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
    innerHTML: '', textContent: '', dataset: {}, style: { setProperty: jest.fn() },
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 60 }),
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
    get('main').querySelector = selector => selector === '.wire-view' ? get('wireSurface') : null;
    get('wireSurface').querySelector = selector => selector === '.wire-controls' ? get('wireControls') : null;
    wire = await import('../public/modules/wire/wire-view.js');
    wire.render(get('main'));
    await jest.advanceTimersByTimeAsync(0);
  };
  const reload = async () => {
    wire.unmount();
    jest.resetModules();
    elements = new Map();
    get('main').querySelector = selector => selector === '.wire-view' ? get('wireSurface') : null;
    get('wireSurface').querySelector = selector => selector === '.wire-controls' ? get('wireControls') : null;
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
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
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

  test('selected investigation survives a hidden row and a view round trip, with live read and restore controls', async () => {
    window.matchMedia = () => ({ matches: true });
    await start();
    const row = { ...element(), dataset: { key: signals[0].link } };
    row.closest = selector => selector === '.wire-item' ? row : null;
    get('wireList').dispatch('keydown', { key: 'Enter', target: row, preventDefault: jest.fn() });
    expect(get('wireInspector').innerHTML).toContain('Synthetic Alpha');
    click('wireInspector', '[data-mark-read]', { markRead: signals[0].link });
    expect(get('wireInspector').innerHTML).toContain('aria-label="Mark read"');
    click('wireInspector', '[data-dismiss]', { dismiss: signals[0].link });
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    expect(get('wireInspector').innerHTML).toContain('outside the current results');
    expect(get('wireInspector').innerHTML).toContain(`data-restore="${signals[0].link}"`);
    wire.unmount();
    elements = new Map();
    await start();
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    expect(get('wireInspector').innerHTML).toContain('Synthetic Alpha');
    click('wireInspector', '[data-restore]', { restore: signals[0].link });
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    expect(get('wireInspector').innerHTML).toContain(`data-dismiss="${signals[0].link}"`);
  });

  test.each([0, 150])('late-arriving groups preserve masthead or reading anchor at scrollY=%s', async scroll => {
    let resolveLandscape;
    fetchLandscape.mockImplementationOnce(() => new Promise(resolve => { resolveLandscape = resolve; }));
    await start();
    const row = { ...element(), dataset: { key: signals[0].link }, getBoundingClientRect: () => {
      const top = 250 + (get('wireAboveList').innerHTML.includes('wire-converge-head') ? 36 : 0);
      return { top, bottom: top + 90 };
    } };
    get('wireList').querySelectorAll = selector => selector === '.wire-item' ? [row] : [];
    window.scrollY = scroll;
    window.scrollTo.mockClear();
    resolveLandscape({ convergence: [{ id: 'vendor:Google', label: 'Google', type: 'vendor', count: 2, sourceCount: 2 }] });
    await jest.advanceTimersByTimeAsync(0);
    if (scroll) expect(window.scrollTo).toHaveBeenLastCalledWith(0, scroll + 36);
    else expect(window.scrollTo).not.toHaveBeenCalled();
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
      const link = `http://localhost/wire?signal=${encodeURIComponent(signals[0].link)}`;
      expect(get('wireList').innerHTML).toContain(`data-copy-link="${link}"`);
      expect(get('wireList').innerHTML).toContain(`data-copy-source="${signals[0].link}"`);
      click('wireList', '[data-copy-link]', { copyLink: link });
      expect(writeText).toHaveBeenCalledWith(link);
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

  test('the index omits CVSS placeholders for non-vulnerability news while the inspector keeps missing data explicit', async () => {
    await start();
    const html = get('wireList').innerHTML;
    const scanLines = [...html.matchAll(/<div class="wire-scan-identity">([\s\S]*?)<\/div>/g)];
    expect(scanLines).toHaveLength(3);
    expect(scanLines.every(([, line]) => !line.includes('CVSS'))).toBe(true);
    expect(html).toContain('CVSS severity');
    expect(html).toContain('Not available');
  });

  test('a linked signal expands details and route changes restore the selected or unfiltered feed', async () => {
    window.location.search = `?signal=${encodeURIComponent(signals[0].link)}`;
    await start();
    expect(get('wireList').innerHTML).toContain(`data-row-details="${signals[0].link}" open`);
    expect(get('wireList').innerHTML).not.toContain('Synthetic Beta');
    const { emit } = await import('../public/modules/core/store.js');
    window.location.search = `?signal=${encodeURIComponent(signals[1].link)}`;
    emit('route-changed', { mode: 'wire' });
    expect(get('wireList').innerHTML).toContain('Synthetic Beta');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    window.location.search = '';
    emit('route-changed', { mode: 'wire' });
    expect(get('wireShown').textContent).toBe('3 signals');
    window.location.search = '?signal=no-longer-in-feed';
    emit('route-changed', { mode: 'wire' });
    expect(get('wireAboveList').innerHTML).toContain('Signal outside current feed');
    expect(get('wireAboveList').innerHTML).toContain('current feed');
  });

  test('passive source inspection updates the visible read state without replacing the list', async () => {
    await start();
    const button = element();
    const row = { ...element(), dataset: { key: signals[0].link }, querySelector: () => button, querySelectorAll: () => [button] };
    document.querySelectorAll = selector => selector === '#wireList .wire-item' ? [row] : [];
    const html = get('wireList').innerHTML;
    get('wireList').dispatch('click', { target: { closest: selector => selector === '.wire-item-title' ? {} : selector === '.wire-item' ? row : null } });
    expect(row.classList.contains('is-read')).toBe(true);
    expect(button['aria-pressed']).toBe('true');
    expect(button['aria-label']).toBe('Mark unread');
    expect(button.innerHTML).toContain('>Read</span>');
    expect(get('wireList').innerHTML).toBe(html);
  });

  test('a newer snapshot waits for explicit application without replacing the reading set', async () => {
    await start();
    fetchHeadlines.mockResolvedValue({ headlines: [{ ...signals[0], title: 'Updated retained Alpha' }], generatedAt: '2026-09-04T12:05:00Z' });
    await jest.advanceTimersByTimeAsync(300001);
    expect(get('wireList').innerHTML).toContain('Synthetic Beta');
    expect(get('wireList').innerHTML).not.toContain('Updated retained Alpha');
    expect(get('wireApplyUpdates').hidden).toBe(false);
    get('wireApplyUpdates').dispatch('click');
    expect(get('wireList').innerHTML).toContain('Updated retained Alpha');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Beta');
    expect(get('wireApplyUpdates').hidden).toBe(true);
  });

  test('Unread inspection holds a reviewed row explicitly until the analyst removes reviewed rows', async () => {
    window.location.search = '?unread=1';
    await start();
    const row = { ...element(), dataset: { key: signals[0].link } };
    document.querySelectorAll = selector => selector === '#wireList .wire-item' ? [row] : [];
    get('wireList').dispatch('click', { target: { closest: selector => selector === '.wire-item-title' ? {} : selector === '.wire-item' ? row : null } });
    expect(get('wireClearReviewed').textContent).toContain('1 reviewed, held here');
    get('wireSort').value = 'newest';
    get('wireSort').dispatch('change');
    expect(get('wireList').innerHTML).toContain('Synthetic Alpha');
    get('wireClearReviewed').dispatch('click');
    expect(get('wireList').innerHTML).not.toContain('Synthetic Alpha');
    expect(get('wireShown').textContent).toBe('2 of 3 signals');
  });

  test('recent snapshot time does not conceal degraded source collection', async () => {
    fetchLandscape.mockResolvedValueOnce({ convergence: [], feeds: { ok: 0, total: 41 } });
    await start();
    expect(get('wireMeta').textContent).toBe('Snapshot processed just now');
    expect(get('wireCollectionHealth').textContent).toBe('0/41 sources reachable · collection needs attention');
    expect(get('wireCollectionHealth').classList.contains('is-degraded')).toBe(true);
  });

  test('compact rows keep supporting information in Details and do not offer an empty evidence modal', async () => {
    fetchHeadlines.mockResolvedValueOnce({ headlines: [{ ...signals[0], description: 'Supporting text', scoreComponents: { severity: 0 } }], generatedAt: new Date().toISOString() });
    await start();
    const html = get('wireList').innerHTML;
    expect(html.indexOf('Supporting text')).toBeGreaterThan(html.indexOf('<summary>Details'));
    expect(html).not.toContain('data-evidence=');
    expect(html).toContain('No retained excerpt');
    expect(html).toContain('Severity unavailable');
    expect(html).toContain('0 ranking contribution');
  });
});

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchSettings = jest.fn();
const searchBriefs = jest.fn();
const navigate = jest.fn();
const showToast = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  fetchSettings, fetchBriefs: jest.fn().mockResolvedValue([]), fetchBrief: jest.fn(), searchBriefs,
}));
jest.unstable_mockModule('../public/modules/core/router.js', () => ({ navigate, resolveLocation: () => ({ data: {} }) }));
jest.unstable_mockModule('../public/modules/core/toast.js', () => ({ showToast }));
const { render, unmount, handleCopyDecision, runSearch } = await import('../public/modules/briefing/briefing-view.js');
const { setState, on, off, emit } = await import('../public/modules/core/store.js');

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
let elements, restoreGlobals;
function element(textContent = '') {
  return { textContent, disabled: false, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
}
beforeEach(() => {
  jest.clearAllMocks();
  fetchSettings.mockReset().mockResolvedValue({ ai: { enabled: true } });
  searchBriefs.mockReset();
  elements = new Map([['briefGenerate', element()]]);
  const overrides = {
    document: { getElementById: id => elements.get(id) || null },
    window: { location: { pathname: '/briefing' }, addEventListener: jest.fn() },
    location: { origin: 'https://desk.example' },
    navigator: { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } },
  };
  const saved = Object.keys(overrides).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const [key, value] of Object.entries(overrides)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  restoreGlobals = () => saved.forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  setState({ isGenerating: false, currentBrief: null });
});

describe('archive search presentation', () => {
  function searchFixture() {
    const content = { innerHTML: '', _validatedBriefContent: 'previous edition', setAttribute: jest.fn(), removeAttribute: jest.fn(), querySelectorAll: () => [] };
    elements.set('briefContent', content);
    elements.set('briefToc', { innerHTML: 'Previous edition sections' });
    elements.set('briefMeta', element('Previous edition date'));
    elements.set('briefInputManifest', element('Previous edition inputs'));
    elements.set('briefExport', element());
    elements.set('briefCopyLink', element());
    return content;
  }
  test('clears stale document controls and navigation while showing an explicit search state', async () => {
    const content = searchFixture();
    let finish;
    searchBriefs.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = runSearch('gateway');
    expect(content.innerHTML).toContain('Searching archive');
    expect(content._validatedBriefContent).toBeNull();
    expect(elements.get('briefToc').innerHTML).toBe('');
    expect(elements.get('briefExport').disabled).toBe(true);
    expect(elements.get('briefCopyLink').disabled).toBe(true);
    finish([]);
    await pending;
    expect(content.innerHTML).toContain('No matches');
    expect(elements.get('briefMeta').textContent).toBe('0 results · gateway');
  });
  test('retains an inline retry path without allowing a stale error to replace newer results', async () => {
    const content = searchFixture();
    let fail;
    searchBriefs.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; })).mockResolvedValueOnce([]);
    const old = runSearch('old');
    await runSearch('new');
    fail(new Error('connection lost'));
    await old;
    expect(content.innerHTML).toContain('“new”');
    expect(content.innerHTML).not.toContain('could not finish');
    searchBriefs.mockRejectedValueOnce(new Error('connection lost'));
    await runSearch('retry me');
    expect(content.innerHTML).toContain('Retry search');
    expect(content.innerHTML).toContain('retry me');
    expect(content.innerHTML).toContain('Back to briefing');
  });
});
afterEach(() => {
  unmount();
  setState({ isGenerating: false, currentBrief: null });
  restoreGlobals();
});

describe('contextual Briefing generation', () => {
  test('waits for availability, routes a missing key to Settings, and reflects a saved key and running state', async () => {
    let completeSettings;
    fetchSettings.mockReturnValue(new Promise(resolve => { completeSettings = resolve; }));
    render({ innerHTML: '' });
    const button = elements.get('briefGenerate');
    expect(button).toMatchObject({ textContent: 'Checking AI availability…', disabled: true });
    completeSettings({ ai: { enabled: false } });
    await flush();
    expect(button).toMatchObject({ textContent: 'Enable AI in Settings', disabled: false });
    button.handlers.click();
    expect(navigate).toHaveBeenCalledWith('/settings');
    emit('ai-status-changed', { enabled: true });
    const generate = jest.fn();
    on('generate-brief', generate);
    try {
      button.handlers.click();
      expect(generate).toHaveBeenCalledTimes(1);
      setState({ isGenerating: true });
      expect(button).toMatchObject({ textContent: 'Generating…', disabled: true });
      button.handlers.click();
      expect(generate).toHaveBeenCalledTimes(1);
      setState({ isGenerating: false });
      expect(button).toMatchObject({ textContent: 'Generate briefing', disabled: false });
    } finally { off('generate-brief', generate); }
  });

  test('does not claim AI is disabled when availability cannot be checked', async () => {
    fetchSettings.mockRejectedValue(new Error('network unavailable'));
    render({ innerHTML: '' });
    await flush();
    const button = elements.get('briefGenerate');
    expect(button).toMatchObject({ textContent: 'Check AI settings', disabled: false });
    button.handlers.click();
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  test('a newly saved key wins over an earlier delayed settings response', async () => {
    let completeSettings;
    fetchSettings.mockReturnValue(new Promise(resolve => { completeSettings = resolve; }));
    render({ innerHTML: '' });
    emit('ai-status-changed', { enabled: true });
    completeSettings({ ai: { enabled: false } });
    await flush();
    expect(elements.get('briefGenerate')).toMatchObject({ textContent: 'Generate briefing', disabled: false });
  });
});

function copyFixture({ saved = true, generating = false, matched = true } = {}) {
  const text = 'Saved authored Markdown';
  const textNode = value => ({ cloneNode: () => ({ textContent: value, querySelectorAll: () => [] }) });
  const heading = { ...textNode('Synthetic exposure'), id: 'judgment-2' };
  const card = {
    querySelector: selector => ({
      h3: heading,
      '.c-action-text': textNode('Infrastructure — verify exposure — recommended target Sep 5, 2026.'),
      '.brief-certainty': textNode('Likelihood: Likely (55–80%) — first-party confirmation pending.'),
    })[selector] || null,
    querySelectorAll: selector => selector === '.brief-cite-link'
      ? [{ getAttribute: () => 'https://example.test/basis', dataset: { sourceLabel: 'Authored basis' } }]
      : [],
  };
  const content = {
    _validatedBriefContent: matched ? text : 'different document',
    contains: candidate => candidate === card,
    querySelector: selector => selector === '.bluf, .brief-judgment-card' ? card : null,
  };
  elements.set('briefContent', content);
  const button = { disabled: false, closest: () => card };
  const event = { target: { closest: () => button } };
  setState({ isGenerating: generating, currentBrief: { filename: saved ? 'brief-2026-09-04.md' : null, content: text } });
  return { event, button };
}

describe('saved decision clipboard', () => {
  test('copies authored ownership, target, cited evidence and judgment permalink', async () => {
    const { event, button } = copyFixture();
    await handleCopyDecision(event);
    const text = navigator.clipboard.writeText.mock.calls[0][0];
    expect(text).toContain('Infrastructure — verify exposure — recommended target Sep 5, 2026.');
    expect(text).toContain('Authored basis: https://example.test/basis');
    expect(text).toContain('https://desk.example/briefing/brief-2026-09-04.md#judgment-2');
    expect(showToast).toHaveBeenCalledWith('Decision copied with its edition link', 'success');
    expect(button.disabled).toBe(false);
  });

  test.each([{ saved: false }, { generating: true }, { matched: false }])('rejects an unsaved, generating or replaced document (%j)', async scenario => {
    await handleCopyDecision(copyFixture(scenario).event);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Open a saved briefing before copying a decision', 'error');
  });

  test('reports a denied clipboard honestly and restores the copy control', async () => {
    navigator.clipboard.writeText.mockRejectedValue(new Error('permission denied'));
    const { event, button } = copyFixture();
    await handleCopyDecision(event);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Could not copy decision.'), 'error');
    expect(button.disabled).toBe(false);
  });
});

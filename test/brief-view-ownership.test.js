import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { parseDocument, DomUtils } from 'htmlparser2';

const fetchBrief = jest.fn();
const fetchBriefs = jest.fn();
const searchBriefs = jest.fn();
const navigate = jest.fn();
const showToast = jest.fn();
const exportBriefNewspaper = jest.fn();
const originalFetch = globalThis.fetch;
const fetchStatus = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  fetchBrief, fetchBriefs, searchBriefs, fetchSettings: async () => ({ ai: { enabled: true } }),
}));
jest.unstable_mockModule('../public/modules/core/router.js', () => ({
  navigate, setPageTitle: jest.fn(),
  resolveLocation: path => ({ data: path.endsWith('/new') ? { action: 'generate' }
    : path === '/briefing' ? {} : { filename: decodeURIComponent(path.split('/').pop()) } }),
}));
jest.unstable_mockModule('../public/modules/core/toast.js', () => ({ showToast }));
jest.unstable_mockModule('../public/modules/core/markdown.js', () => ({
  renderMarkdown: text => `<section class="bluf">${text}</section>`,
  renderDraftMarkdown: text => `<section>${text}</section>`,
}));
jest.unstable_mockModule('../public/modules/briefing/brief-renderer.js', () => ({
  applySemanticStyling: jest.fn(), extractSections: () => [],
  decisionCardContent: () => ({}), decisionCopyText: () => '',
}));
jest.unstable_mockModule('../public/modules/briefing/brief-export.js', () => ({ exportBriefNewspaper }));
const { render, unmount, runSearch } = await import('../public/modules/briefing/briefing-view.js');
const { emit, getState, setState } = await import('../public/modules/core/store.js');

function element() {
  let html = '';
  const children = new Map();
  return {
    get innerHTML() { return html + [...children.values()].map(child => child.innerHTML).join(''); },
    set innerHTML(value) { html = value; children.clear(); },
    textContent: '', value: '', options: [], dataset: {}, style: {},
    classList: { toggle: jest.fn() },
    setAttribute: jest.fn(), removeAttribute: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(),
    prepend(node) { this.innerHTML = node.innerHTML + this.innerHTML; },
    querySelector(selector) {
      if (selector.startsWith('#') && html.includes(`id="${selector.slice(1)}"`)) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      }
      if ((selector === '.bluf' || selector === '.bluf, .brief-judgment-card') && this.innerHTML.includes('class="bluf"')) return {};
      return null;
    },
    querySelectorAll: selector => selector === 'h2' ? [{ textContent: 'Key Judgments' }] : [],
  };
}
let elements;
const oldBrief = () => ({ filename: 'brief-2026-09-03.md', content: 'SAVED OLDER ASSESSMENT',
  generatedAt: '2026-09-03T10:00:00Z', warnings: ['Check this vendor claim.'] });
const completed = () => ({ filename: 'brief-2026-09-05.md', content: 'SAVED NEW ASSESSMENT',
  timestamp: '2026-09-05T10:00:00Z', generatedAt: '2026-09-05T10:00:00Z', warnings: ['New review note.'] });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function route(path, data) {
  window.location.pathname = path;
  emit('route-changed', { mode: 'briefing', ...data });
}
function complete() {
  const brief = completed();
  setState({ isGenerating: false });
  emit('brief-generated', { brief, ...brief, text: brief.content, validation: { warnings: brief.warnings } });
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  exportBriefNewspaper.mockReset();
  fetchBrief.mockReset().mockImplementation(async filename => filename === oldBrief().filename
    ? { content: oldBrief().content, meta: { warnings: oldBrief().warnings } }
    : { content: 'SAVED LOADED ARCHIVE', meta: { warnings: ['Archive note.'] } });
  fetchBriefs.mockReset().mockResolvedValue([]);
  searchBriefs.mockReset().mockResolvedValue([]);
  fetchStatus.mockReset().mockResolvedValue({ ok: true, json: async () => ({ persistence: 'ok', latest: null }) });
  globalThis.fetch = fetchStatus;
  elements = new Map(['briefContent', 'briefMeta', 'briefInputManifest', 'briefToc', 'briefGenerate',
    'briefGenerateInput', 'briefCopyLink', 'briefExport', 'briefHistory', 'briefSearch', 'genStatus', 'briefSrLive', 'briefAttemptStatus']
    .map(id => [id, element()]));
  global.document = { getElementById: id => elements.get(id) || elements.get('briefContent')?.querySelector(`#${id}`) || null, createElement: element, querySelectorAll: () => [] };
  global.window = { location: { pathname: '/briefing' }, addEventListener: jest.fn(), scrollTo: jest.fn() };
  global.location = { hash: '', origin: 'https://desk.example' };
  global.history = { state: {}, replaceState: jest.fn((_state, _title, path) => { window.location.pathname = path; }) };
  setState({ mode: 'briefing', isGenerating: false, currentBrief: oldBrief(), lastGeneratedBrief: null });
});
afterEach(() => {
  unmount();
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
  delete global.document; delete global.window; delete global.location; delete global.history;
});

test('bare Briefing route restores persisted review notes with the selected saved document', async () => {
  render(element());
  await flush();
  expect(elements.get('briefContent').innerHTML).toContain('Check this vendor claim.');
  expect(elements.get('briefContent').innerHTML).toContain('1 automated check');
  expect(elements.get('briefContent')._validatedBriefContent).toBe(oldBrief().content);
});

function readingUi() {
  for (const id of ['briefOverview', 'briefOverviewMode', 'briefReadingMode', 'briefSummaryMode']) elements.set(id, element());
  const layout = element();
  document.querySelector = selector => selector === '.briefing-layout' ? layout : null;
  return { overview: elements.get('briefOverview'), layout };
}

function listener(id, type = 'click') {
  return elements.get(id).addEventListener.mock.calls.find(([name]) => name === type)?.[1];
}

test('report query opens the selected saved edition in Full report and Overview clears that override', async () => {
  const { overview, layout } = readingUi();
  window.location.search = '?view=report';
  render(element());
  await flush();
  expect(fetchBrief).toHaveBeenCalledWith(oldBrief().filename);
  expect(overview.hidden).toBe(true);
  expect(layout.hidden).toBe(false);
  expect(elements.get('briefReadingMode').setAttribute).toHaveBeenCalledWith('aria-pressed', 'true');
  listener('briefOverviewMode')();
  expect(overview.hidden).toBe(false);
  expect(history.replaceState).toHaveBeenLastCalledWith(history.state, '', '/briefing');
});

test('ordinary overview links retain edition identity and focus their fragment; modified clicks remain native', async () => {
  const { overview } = readingUi();
  const target = { setAttribute: jest.fn(), focus: jest.fn(), scrollIntoView: jest.fn() };
  elements.set('judgment-1', target);
  render(element());
  await flush();
  listener('briefOverviewMode')();
  const link = { getAttribute: () => '/briefing/brief-2026-09-03.md#judgment-1' };
  const event = overrides => ({ target: { closest: () => link }, button: 0,
    preventDefault: jest.fn(), ...overrides });
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    const modified = event(modifiers);
    listener('briefOverview')(modified);
    expect(modified.preventDefault).not.toHaveBeenCalled();
    expect(overview.hidden).toBe(false);
  }
  const ordinary = event();
  listener('briefOverview')(ordinary);
  expect(ordinary.preventDefault).toHaveBeenCalled();
  expect(overview.hidden).toBe(true);
  expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  expect(history.replaceState).toHaveBeenLastCalledWith(history.state, '', '/briefing/brief-2026-09-03.md#judgment-1');
});

test('legacy structural warnings appear once in both views without changing persisted warning provenance', async () => {
  const { overview } = readingUi();
  elements.get('briefContent').querySelectorAll = () => [];
  fetchBrief.mockResolvedValueOnce({ content: 'Legacy report without key judgments', meta: {} });
  render(element());
  await flush();
  listener('briefOverviewMode')();
  expect(overview.hidden).toBe(false);
  expect(overview.innerHTML.match(/Missing the Key Judgments section\./g)).toHaveLength(1);
  expect(elements.get('briefContent').innerHTML.match(/Missing the Key Judgments section\./g)).toHaveLength(1);
  expect(getState().currentBrief.warnings).toBeNull();
});

test('closing Edition tools after Decision summary restores focus only when its active control becomes hidden', async () => {
  readingUi();
  const summary = { focus: jest.fn() };
  const summaryButton = elements.get('briefSummaryMode');
  const tools = { open: true, querySelector: () => summary, contains: node => node === summaryButton,
    addEventListener: jest.fn() };
  elements.set('briefEditionTools', tools);
  render(element());
  await flush();
  document.activeElement = summaryButton;
  listener('briefSummaryMode')();
  expect(tools.open).toBe(false);
  expect(summary.focus).toHaveBeenCalledTimes(1);
  summary.focus.mockClear();
  tools.open = true;
  document.activeElement = elements.get('briefReadingMode');
  listener('briefReadingMode')();
  expect(summary.focus).not.toHaveBeenCalled();
});

test('resuming a selected edition refreshes review status and avoids a newly excluded default', async () => {
  fetchBrief.mockResolvedValueOnce({ content: oldBrief().content,
    disposition: { status: 'review-required', eligibleForLatest: false } });
  fetchBriefs.mockResolvedValue([{ filename: oldBrief().filename,
    disposition: { status: 'review-required', eligibleForLatest: false } },
    { filename: 'brief-2026-09-02.md', disposition: { status: 'eligible', eligibleForLatest: true } }]);
  render(element());
  await flush();
  expect(fetchBrief).toHaveBeenCalledWith(oldBrief().filename);
  expect(navigate).toHaveBeenCalledWith('/briefing/brief-2026-09-02.md');
  expect(elements.get('briefContent')._validatedBriefContent).not.toBe(oldBrief().content);
});

test('Print Edition retains its invoking button when a pointer click leaves focus elsewhere', async () => {
  render(element());
  await flush();
  const button = elements.get('briefExport');
  document.activeElement = { tagName: 'BODY' };
  const handleClick = button.addEventListener.mock.calls.find(([name]) => name === 'click')[1];
  handleClick({ currentTarget: button, target: { tagName: 'svg' } });
  expect(exportBriefNewspaper).toHaveBeenCalledWith(expect.objectContaining({ opener: button, contentEl: elements.get('briefContent') }));
  expect(document.activeElement).not.toBe(button);
});

test.each(['unmount', 'edition', 'archive', 'archive search', 'document search'])('releases the print preview before %s replaces its document', async destination => {
  const dispose = jest.fn();
  exportBriefNewspaper.mockReturnValue(dispose);
  render(element());
  await flush();
  const button = elements.get('briefExport');
  const handleClick = button.addEventListener.mock.calls.find(([name]) => name === 'click')[1];
  handleClick({ currentTarget: button });
  expect(exportBriefNewspaper).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();

  if (destination === 'unmount') unmount();
  else if (destination === 'edition') {
    fetchBrief.mockReturnValue(new Promise(() => {}));
    route('/briefing/brief-2026-09-01.md', { filename: 'brief-2026-09-01.md' });
  } else if (destination === 'document search') {
    void runSearch('router');
  } else {
    window.location.search = destination === 'archive search' ? '?archive=1&q=router' : '?archive=1';
    route('/briefing', {});
  }
  // Ownership ends synchronously, before the next document's fetch completes.
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledWith({ restoreFocus: false });
  unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
  await flush();
});

test('opening another print preview releases the previous one and retains only the latest disposer', async () => {
  const first = jest.fn(); const second = jest.fn();
  exportBriefNewspaper.mockReturnValueOnce(first).mockReturnValueOnce(second);
  render(element());
  await flush();
  const button = elements.get('briefExport');
  const handleClick = button.addEventListener.mock.calls.find(([name]) => name === 'click')[1];
  handleClick({ currentTarget: button });
  handleClick({ currentTarget: button });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  unmount();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test('the explicit Latest link resolves the newest eligible edition instead of resuming an older selection', async () => {
  const latest = { filename: 'brief-2026-09-06-02.md', disposition: { status: 'eligible', eligibleForLatest: true } };
  fetchBriefs.mockResolvedValue([latest, oldBrief()]);
  render(element());
  await flush();
  fetchBrief.mockClear();
  navigate.mockClear();

  window.location.search = '?latest=1';
  route('/briefing', {});
  await flush();

  expect(fetchBrief).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith(`/briefing/${latest.filename}`);
});

test('returning after an off-view failure shows durable outcome and cost beside the unchanged saved edition', async () => {
  render(element());
  await flush();
  unmount();
  emit('generation-error', { code: 'E006', message: 'Publication checks failed' });
  fetchStatus.mockResolvedValue({ ok: true, json: async () => ({ persistence: 'ok', active: false,
    latest: { status: 'failed', code: 'E006', costUsd: 0.377646, billing: 'provider-usage-recorded' } }) });
  render(element());
  await flush();
  expect(elements.get('briefAttemptStatus').innerHTML).toContain('No edition was published');
  expect(elements.get('briefAttemptStatus').innerHTML).toContain('$0.3776');
  expect(elements.get('briefContent').innerHTML).toContain(oldBrief().content);
  expect(getState().currentBrief.filename).toBe(oldBrief().filename);
  route('/briefing/new', { action: 'generate' });
  await flush();
  expect(navigate).toHaveBeenCalledWith('/briefing');
  expect(elements.get('briefAttemptStatus').innerHTML).toContain('$0.3776');
});

test('retry discards both the displayed draft and any delayed paint without replacing an archive view', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  const content = elements.get('briefContent');
  emit('brief-streaming', { accumulated: 'Discarded draft', chunk: 'Discarded draft' });
  expect(content._streamTimer).not.toBeNull();
  emit('brief-stream-reset');
  expect(content._streamTimer).toBeNull();
  expect(content._streamPending).toBe('');
  expect(content.innerHTML).toContain('Starting replacement draft');
  await jest.advanceTimersByTimeAsync(350);
  expect(content.innerHTML).not.toContain('Discarded draft');
  emit('brief-streaming', { accumulated: 'Replacement draft', chunk: 'Replacement draft' });
  expect(content._streamPending).toBe('Replacement draft');
  route('/briefing/brief-2026-09-03.md', { filename: oldBrief().filename });
  await flush();
  const archive = content.innerHTML;
  emit('brief-stream-reset');
  expect(content.innerHTML).toBe(archive);
});

test('a publication failure replaces the stale generating screen-reader announcement', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  emit('brief-streaming', { accumulated: 'Unvalidated draft', chunk: 'Unvalidated draft' });
  expect(elements.get('briefSrLive').textContent).toBe('Briefing generating');
  setState({ isGenerating: false });
  const message = 'Draft was not published because source verification still failed after one corrective retry. Refresh the landscape data or correct the source input, then generate again.';
  emit('generation-error', { code: 'E006', message, recoverableDraft: 'Unvalidated final draft' });
  expect(elements.get('briefSrLive').textContent).toBe('Draft not published');
  const tree = parseDocument(elements.get('briefContent').innerHTML);
  const notice = DomUtils.findOne(node => /\brecoverable-draft-notice\b/.test(node.attribs?.class || ''), tree.children);
  const paragraphs = DomUtils.findAll(node => node.name === 'p', notice.children).map(DomUtils.textContent);
  expect(paragraphs).toEqual([message, 'Unvalidated draft · review only. No edition was published.']);
  expect(getState().currentBrief.filename).toBe(oldBrief().filename);
  expect(elements.get('genStatus').textContent).toBe('');
});

test('stream, progress, completion and failure cannot repaint a selected historical edition', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  emit('brief-streaming', { accumulated: 'Draft', chunk: 'Draft' });
  route('/briefing/brief-2026-09-03.md', { filename: oldBrief().filename });
  await flush();
  const savedHtml = elements.get('briefContent').innerHTML;
  emit('brief-streaming', { accumulated: 'Draft plus text', chunk: ' plus text' });
  emit('generation-progress', { progressMsg: 'Still generating elsewhere' });
  complete();
  emit('generation-error', { message: 'Background error' });
  await jest.advanceTimersByTimeAsync(400);
  expect(elements.get('briefContent').innerHTML).toBe(savedHtml);
  expect(elements.get('genStatus').textContent).toBe('');
  expect(window.location.pathname).toBe('/briefing/brief-2026-09-03.md');
  expect(getState().currentBrief.filename).toBe(oldBrief().filename);
  expect(getState().lastGeneratedBrief.filename).toBe(completed().filename);
  expect(elements.get('briefCopyLink').disabled).toBe(false);
  expect(showToast).toHaveBeenCalledWith('Briefing saved', 'success');
});

test('completion in the generation route selects the result and fixes its durable URL', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  emit('brief-streaming', { accumulated: 'Draft', chunk: 'Draft' });
  complete();
  await jest.advanceTimersByTimeAsync(400);
  expect(getState().currentBrief.filename).toBe(completed().filename);
  expect(window.location.pathname).toBe('/briefing/brief-2026-09-05.md');
  expect(elements.get('briefContent').innerHTML).toContain(completed().content);
  expect(elements.get('briefContent').innerHTML).toContain('New review note.');
  expect(elements.get('briefContent')._validatedBriefContent).toBe(completed().content);
  expect(fetchBriefs).toHaveBeenCalledWith({ fresh: true });
});

test('off-view completion refreshes archive history without replacing the last selected edition', async () => {
  render(element());
  await flush();
  unmount();
  elements.delete('briefContent');
  elements.delete('briefHistory');
  fetchBriefs.mockClear();
  complete();
  await flush();
  expect(fetchBriefs).toHaveBeenCalledWith({ fresh: true });
  expect(getState().currentBrief.filename).toBe(oldBrief().filename);
  expect(getState().lastGeneratedBrief.filename).toBe(completed().filename);
});

test('background completion does not cancel or overwrite an in-flight archive navigation', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  let finish;
  fetchBrief.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  route('/briefing/brief-2026-09-01.md', { filename: 'brief-2026-09-01.md' });
  complete();
  expect(elements.get('briefContent').innerHTML).toContain('Loading briefing');
  finish({ content: 'SAVED REQUESTED ARCHIVE', meta: { warnings: ['Requested archive note.'] } });
  await flush();
  expect(getState().currentBrief.filename).toBe('brief-2026-09-01.md');
  expect(elements.get('briefContent').innerHTML).toContain('SAVED REQUESTED ARCHIVE');
  expect(elements.get('briefContent').innerHTML).toContain('Requested archive note.');
});

test('archive search takes ownership even while the URL is still the generation action', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  await runSearch('gateway');
  const searchHtml = elements.get('briefContent').innerHTML;
  complete();
  expect(elements.get('briefContent').innerHTML).toBe(searchHtml);
  expect(history.replaceState).not.toHaveBeenCalled();
});

test('a delayed recovery baseline cannot schedule a redirect after leaving generation', async () => {
  render(element());
  await flush();
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  let baseline;
  fetchBriefs.mockReturnValueOnce(new Promise(resolve => { baseline = resolve; }));
  setState({ isGenerating: false });
  emit('generation-error', { message: 'Connection lost', streamLost: true });
  route('/briefing/brief-2026-09-03.md', { filename: oldBrief().filename });
  baseline([]);
  await jest.advanceTimersByTimeAsync(31_000);
  expect(navigate).not.toHaveBeenCalled();
  expect(elements.get('briefContent').innerHTML).toContain(oldBrief().content);
});

test('an out-of-range archive address resolves to the displayed last page', async () => {
  window.location.search = '?archive=1&page=999';
  fetchStatus.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/briefs?')
    ? { items: [{ filename: 'brief-2026-09-01.md', bluf: 'Last saved assessment' }], total: 13, page: 2, pageSize: 12 }
    : { persistence: 'ok', latest: null } }));
  render(element());
  await flush();
  expect(elements.get('briefContent').innerHTML).toContain('Last saved assessment');
  expect(elements.get('briefContent').innerHTML).toContain('Page 2 of 2');
  expect(history.replaceState).toHaveBeenCalledWith(history.state, '', '/briefing?archive=1&page=2');
});

test('returning from archive results clears their screen-reader count', async () => {
  render(element());
  await flush();
  await runSearch('SonicWall');
  expect(elements.get('briefSrLive').textContent).toBe('0 matches for SonicWall');
  route('/briefing/brief-2026-09-03.md', { filename: oldBrief().filename });
  await flush();
  expect(elements.get('briefContent').innerHTML).toContain(oldBrief().content);
  expect(elements.get('briefSrLive').textContent).toBe('');
});

test('a delayed archive response cannot rewrite a newer edition address', async () => {
  window.location.search = '?archive=1&page=999';
  let finish;
  fetchStatus.mockImplementation(url => String(url).startsWith('/api/briefs?')
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ persistence: 'ok', latest: null }) }));
  render(element());
  await flush();
  window.location.search = '';
  route('/briefing/brief-2026-09-03.md', { filename: oldBrief().filename });
  await flush();
  history.replaceState.mockClear();
  finish({ ok: true, json: async () => ({ items: [], total: 13, page: 2, pageSize: 12 }) });
  await flush();
  expect(window.location.pathname).toBe('/briefing/brief-2026-09-03.md');
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(elements.get('briefContent').innerHTML).toContain(oldBrief().content);
});

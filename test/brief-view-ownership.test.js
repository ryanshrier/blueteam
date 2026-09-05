import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const fetchBrief = jest.fn();
const fetchBriefs = jest.fn();
const searchBriefs = jest.fn();
const navigate = jest.fn();
const showToast = jest.fn();
const originalFetch = globalThis.fetch;
const fetchStatus = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  fetchBrief, fetchBriefs, searchBriefs, fetchSettings: async () => ({ ai: { enabled: true } }),
}));
jest.unstable_mockModule('../public/modules/core/router.js', () => ({
  navigate,
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
jest.unstable_mockModule('../public/modules/briefing/brief-export.js', () => ({ exportBriefNewspaper: jest.fn() }));
const { render, unmount, runSearch } = await import('../public/modules/briefing/briefing-view.js');
const { emit, getState, setState } = await import('../public/modules/core/store.js');

function element() {
  return {
    innerHTML: '', textContent: '', value: '', options: [], dataset: {}, style: {},
    classList: { toggle: jest.fn() },
    setAttribute: jest.fn(), removeAttribute: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(),
    prepend(node) { this.innerHTML = node.innerHTML + this.innerHTML; },
    querySelector(selector) {
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
  fetchBrief.mockReset().mockResolvedValue({ content: 'SAVED LOADED ARCHIVE', meta: { warnings: ['Archive note.'] } });
  fetchBriefs.mockReset().mockResolvedValue([]);
  searchBriefs.mockReset().mockResolvedValue([]);
  fetchStatus.mockReset().mockResolvedValue({ ok: true, json: async () => ({ persistence: 'ok', latest: null }) });
  globalThis.fetch = fetchStatus;
  elements = new Map(['briefContent', 'briefMeta', 'briefInputManifest', 'briefToc', 'briefGenerate',
    'briefGenerateInput', 'briefCopyLink', 'briefExport', 'briefHistory', 'briefSearch', 'genStatus', 'briefSrLive', 'briefAttemptStatus']
    .map(id => [id, element()]));
  global.document = { getElementById: id => elements.get(id) || null, createElement: element };
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
  expect(elements.get('briefContent').innerHTML).toContain('1 automated check needs review');
  expect(elements.get('briefContent')._validatedBriefContent).toBe(oldBrief().content);
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
  emit('generation-error', { code: 'E006', message: 'Publication checks failed', recoverableDraft: 'Unvalidated final draft' });
  expect(elements.get('briefSrLive').textContent).toBe('Draft not published');
});

test('stream, progress, completion and failure cannot repaint a selected historical edition', async () => {
  render(element());
  setState({ isGenerating: true });
  route('/briefing/new', { action: 'generate' });
  emit('brief-streaming', { accumulated: 'Draft', chunk: 'Draft' });
  route('/briefing/brief-2026-09-03.md', { filename: oldBrief().filename });
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

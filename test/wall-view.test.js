import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchLandscape = jest.fn();
const fetchBrief = jest.fn();
const fetchHealth = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  fetchLandscape, fetchBrief,
  fetchHeadlines: jest.fn().mockResolvedValue({ headlines: [] }),
  fetchEdition: jest.fn().mockResolvedValue({}),
  fetchHealth,
}));
const { judgmentHtml, judgmentSources, claimKioskMaintenanceReload, wallScaleForWidth, wirePageHtml, mount, unmount } = await import('../public/modules/wall/wall-view.js');

function judgment(overrides = {}) {
  return {
    horizon: 1,
    title: 'Synthetic ransomware judgment',
    line: 'A fictional incident demonstrates the decision model.',
    assessment: 'The example requires a bounded internal response.',
    decision: '7 days.',
    confidence: 'Likely (55-80%)',
    actionShift: null,
    isKEV: false,
    kevCVE: '',
    ...overrides,
  };
}

describe('Wall Key Judgment timing', () => {
  test('uses only saved citation hosts and supports judgments without a CVE', () => {
    const story = judgment({ citations: [
      { label: 'Vendor advisory', url: 'https://www.vendor.example/advisory' },
      { label: 'Second page', url: 'https://vendor.example/update' },
      { label: 'News', url: 'https://news.example/story' },
      { label: 'Bad', url: 'javascript:alert(1)' },
      { label: 'Bad', url: 'https://user:password@wrong.example/' },
    ] });
    expect(judgmentSources(story)).toEqual(['vendor.example', 'news.example']);
    expect(judgmentHtml(story)).toContain('<b>Cited sources</b> vendor.example · news.example');
    expect(judgmentSources(judgment({ title: 'CVE-2026-1234', kevCVE: 'CVE-2026-1234' }))).toEqual([]);
  });
  test('scheduled reload claims persist in tab storage and fail closed without storage', () => {
    const storage = new Map();
    global.sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
    try {
      expect(claimKioskMaintenanceReload('Sep 4, 2026')).toBe(true);
      expect(claimKioskMaintenanceReload('Sep 4, 2026')).toBe(false);
      expect(claimKioskMaintenanceReload('Sep 5, 2026')).toBe(true);
      sessionStorage.setItem = () => { throw new Error('Denied'); };
      expect(claimKioskMaintenanceReload('Sep 6, 2026')).toBe(false);
    } finally { delete global.sessionStorage; }
  });
  test('native 4K scaling is a valid dimensionless factor with normal viewport fallback', () => {
    expect(wallScaleForWidth(3840)).toBe(2);
    expect(wallScaleForWidth(2560)).toBeCloseTo(4 / 3);
    expect(wallScaleForWidth(1920)).toBe(1);
    expect(wallScaleForWidth(undefined)).toBe(1);
  });
  test('keeps KEV and its intact identity separate from readable source counts', () => {
    const html = wirePageHtml([{ title: 'Synthetic signal', horizon: 2,
      isKEV: true, kevCVE: 'CVE-2026-123456', source: 'Vendor <advisory>', corroboration: 3 }]);
    expect(html).toContain('<span class="nb-badge kev">KEV</span>');
    expect(html).toContain('<span class="nb-badge nb-cve kev">CVE-2026-123456</span>');
    expect(html).toContain('3 sources</span>');
    expect(html).toContain('Source: Vendor &lt;advisory&gt;</span>');
    expect(html).toContain('nb-rail h2');
  });
  test('renders Horizon, Decision, and calibrated Likelihood as separate analytic axes', () => {
    const html = judgmentHtml(judgment(), '2026-07-28');

    expect(html).toContain('class="nb-jfacts"');
    expect(html).toContain('<dt>Horizon</dt>');
    expect(html).toContain('TACTICAL</dd>');
    expect(html).toContain('<dt>Decision</dt>');
    expect(html).toContain('<dd>Within 7 days<small class="nb-decision-anchor">From July 28, 2026 Briefing</small></dd>');
    expect(html).toContain('<dt>Likelihood</dt><dd>Likely (55-80%)</dd>');
    expect(html).toContain(
      'aria-label="Decision window: within 7 days, measured from the July 28, 2026 Briefing"'
    );
    expect(html).not.toContain('7 DAYS.');
    expect(html).not.toContain('ACT NOW');
  });

  test('preserves the authored likelihood basis and legacy confidence without conflating them', () => {
    const html = judgmentHtml(judgment({ confidence: 'Likely (55–80%) — two sources agree but deployment evidence is unavailable.' }));
    expect(html).toContain('<dt>Likelihood</dt><dd>Likely (55–80%)</dd>');
    expect(html).toContain('<strong>Likelihood basis:</strong> two sources agree but deployment evidence is unavailable.');
    const legacy = judgmentHtml(judgment({ confidence: 'Moderate — vendor confirmation is pending.' }));
    expect(legacy).toContain('<dt>Confidence</dt><dd>Moderate</dd>');
    expect(legacy).toContain('<strong>Confidence basis:</strong> vendor confirmation is pending.');
  });

  test('uses Act now only when the Briefing carries an explicit this-shift action', () => {
    const html = judgmentHtml(judgment({
      decision: 'Current shift.',
      actionShift: { owner: null, imperative: 'Verify the synthetic exposure now.' },
    }));

    expect(html).toContain('<dd>This shift</dd>');
    expect(html).toContain('Verify the synthetic exposure now.');
  });

  test('keeps action owner and recommended target outside the clamped imperative', () => {
    const html = judgmentHtml(judgment({
      decision: 'Current shift.',
      actionShift: {
        owner: null,
        imperative: 'Infrastructure — verify every synthetic server and isolate any unpatched instance — recommended target July 29, 2026.',
      },
    }));

    expect(html).toContain('class="nb-act-owner">Infrastructure</span>');
    expect(html).toContain('class="nb-act-text nb-clamp nb-clamp-3">verify every synthetic server and isolate any unpatched instance</span>');
    expect(html).toContain('<small>Recommended target</small><strong>July 29, 2026</strong>');
  });

  test('moves KEV provenance beside the assessment rather than into the fact rail', () => {
    const html = judgmentHtml(judgment({
      isKEV: true,
      kevCVE: 'CVE-2026-50522',
    }));

    expect(html).toContain('class="nb-jevidence"');
    expect(html).toContain('class="nb-evidence-kev">KEV · CVE-2026-50522</span>');
    const rail = html.slice(html.indexOf('class="nb-jhead-aside"'), html.indexOf('</div>', html.indexOf('class="nb-jhead-aside"')));
    expect(rail).not.toContain('CVE-2026-50522');
  });

  test('preserves an archived absolute deadline without making it look sourced', () => {
    const html = judgmentHtml(judgment({ decision: 'July 17, close of business.' }));

    expect(html).toContain('nb-jdecision is-legacy');
    expect(html).toContain('<dd>By July 17, close of business</dd>');
    expect(html).not.toContain('CISA');
    expect(html).not.toContain('SOURCE');
  });

  test('omits an empty Decision block and escapes unknown archived text', () => {
    expect(judgmentHtml(judgment({ decision: '' }))).not.toContain('nb-jdecision');

    const html = judgmentHtml(judgment({ decision: '<script>alert(1)</script>.' }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('falls back to a generic Decision label when no valid Briefing date is available', () => {
    const html = judgmentHtml(judgment(), 'not-a-date');
    expect(html).toContain('aria-label="Decision window: Within 7 days"');
    expect(html).not.toContain('measured from');
  });
});

// Minimal event/element harness for actual mounted-view transitions. Rendering
// geometry is verified in the browser fixtures; these tests exercise timers and
// requests without a browser dependency or any live API access.
function element() {
  const classes = new Set();
  const listeners = new Map();
  return {
    innerHTML: '', textContent: '', dataset: {}, style: {},
    clientHeight: 600, scrollHeight: 600, scrollTop: 0,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    setAttribute(name, value) { this[name] = value; },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    dispatch(name, event = {}) { listeners.get(name)?.(event); },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

describe('Wall mounted playback and recovery', () => {
  let elements;
  let listeners;
  let modal;
  const snapshot = overrides => ({
    generatedAt: new Date().toISOString(), feeds: { ok: 8, total: 8 },
    signals: [{ title: 'Synthetic wire reporting', description: 'Complete test evidence.', horizon: 1 }],
    ...overrides,
  });
  const key = (value, target = {}) => {
    const event = { key: value, target, preventDefault: jest.fn() };
    listeners.get('keydown')?.(event);
    return event;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    elements = new Map();
    listeners = new Map();
    modal = false;
    const get = id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    };
    global.document = {
      body: element(),
      getElementById: get,
      querySelector: selector => selector.includes('dialog[') ? (modal ? {} : null) : get('news-mode'),
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: name => listeners.delete(name),
    };
    global.window = {
      location: { pathname: '/wall', search: '?operator' },
      matchMedia: () => ({ matches: false }),
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
    };
    fetchLandscape.mockReset().mockImplementation(async () => snapshot());
    fetchBrief.mockReset().mockResolvedValue({ content: '## BLUF\n\nA synthetic complete briefing claim.' });
    fetchHealth.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.document;
    delete global.window;
    delete global.location;
    delete global.sessionStorage;
  });

  test('quiet-hour reload happens once across document remounts in the same tab', async () => {
    jest.setSystemTime(new Date(2026, 8, 4, 4, 0, 0));
    window.location.search = '';
    global.location = { reload: jest.fn() };
    const storage = new Map();
    global.sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(location.reload).toHaveBeenCalledTimes(1);
    unmount();
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(location.reload).toHaveBeenCalledTimes(1);
    unmount();
    jest.setSystemTime(new Date(2026, 8, 5, 4, 0, 0));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(location.reload).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])('saved citations render with only receipt-verified KEV badges (receipt=%s)', async verified => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValue({
      content: '## BLUF\n\nA saved assessment.\n\n## KEY JUDGMENTS\n\n### Signal 1 — [Horizon 1] Synthetic vulnerability\n**What happened:** CISA KEV lists CVE-2026-11111 after confirmed exploitation. [Saved advisory](https://saved.example/advisory)\n**Assessment:** Verify the local affected version.\n**The line:** Review the saved evidence.\n**Decision window:** 7 days.',
      inputManifest: verified ? { status: 'available', verification: { selectedKevCves: ['CVE-2026-11111'] } } : null,
    });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    key('ArrowRight');
    const html = document.getElementById('nbBody').innerHTML;
    expect(html).toContain('<b>Cited source</b> saved.example');
    expect(html.includes('class="nb-evidence-kev"')).toBe(verified);
  });

  test('disables unavailable playback controls and ignores hold commands until content loads', async () => {
    let resolveSnapshot;
    fetchLandscape.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    mount(document.getElementById('wallLayer'));
    for (const id of ['nbPrev', 'nbNext', 'nbPause']) expect(document.getElementById(id).disabled).toBe(true);
    key(' ');
    resolveSnapshot(snapshot());
    await jest.advanceTimersByTimeAsync(0);
    for (const id of ['nbPrev', 'nbNext', 'nbPause']) expect(document.getElementById(id).disabled).toBe(false);
    expect(document.getElementById('nbPause').textContent).toBe('Pause');
    expect(document.getElementById('nbPager').textContent).toBe('Page 1 / 1');
  });

  test('keeps empty-state controls subdued while showing an explicitly zoned local clock', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ signals: [] }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    for (const id of ['nbPrev', 'nbNext', 'nbPause']) expect(document.getElementById(id).disabled).toBe(true);
    key('ArrowRight');
    key(' ');
    expect(document.getElementById('nbPause').textContent).toBe('Pause');
    expect(document.getElementById('nbClock').textContent).toBe(new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }));
  });

  test('keeps source failure truthful across status ticks and recovers on retry', async () => {
    fetchLandscape.mockRejectedValueOnce(new Error('synthetic outage'));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(3000);
    expect(document.getElementById('nbBody').innerHTML).toContain('Source refresh unavailable');
    expect(document.getElementById('nbIntegrity').textContent).toMatch(/unavailable/i);
    await jest.advanceTimersByTimeAsync(57_000);
    expect(document.getElementById('nbBody').innerHTML).toContain('Synthetic wire reporting');
    expect(document.getElementById('nbIntegrity').textContent).not.toMatch(/unavailable/i);
  });

  test('resumes changed page order with matching body, section, date, and pager', async () => {
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    key(' ');
    const held = document.getElementById('nbBody').innerHTML;
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById('nbBody').innerHTML).toBe(held);
    expect(document.getElementById('nbSlug').textContent).toContain('THE WIRE');
    key(' ');
    expect(document.getElementById('nbBody').innerHTML).toContain('A synthetic complete briefing claim.');
    expect(document.getElementById('nbSlug').textContent).toContain('BLUF');
    expect(document.getElementById('nbPager').textContent).toContain('1 / 2');
    expect(document.getElementById('nbBriefStamp').textContent).toContain('Sep 4, 2026');
  });

  test('retains held publication metadata while feed freshness continues updating', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-08-30.md', date: '2026-08-30' } }));
    fetchBrief.mockResolvedValueOnce({ content: '## BLUF\n\nThe saved older claim.', meta: { generated_at: '2026-08-30T09:00:00Z', warnings: ['Verify vendor attribution.'] } });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    key(' ');
    const stamp = document.getElementById('nbBriefStamp').textContent;
    expect(stamp).toContain('Aug 30, 2026, 09:00 UTC');
    expect(stamp).toContain('Older edition');
    expect(stamp).toContain('AI-generated · Verify before acting');
    expect(stamp).toContain('1 automated check needs review');
    expect(document.getElementById('nbBriefStamp').title).toBe('Verify vendor attribution.');
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValueOnce({ content: '## BLUF\n\nThe newer claim.', meta: { generated_at: '2026-09-04T11:00:00Z' } });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById('nbBriefStamp').textContent).toBe(stamp);
    expect(document.getElementById('nbBriefStamp').title).toBe('Verify vendor attribution.');
    expect(document.getElementById('nbBody').innerHTML).toContain('The saved older claim.');
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS CURRENT');
    expect(document.getElementById('nbPlayback').textContent).toBe('Paused');
    key(' ');
    expect(document.getElementById('nbBriefStamp').textContent).toContain('Sep 4, 2026, 11:00 UTC');
    expect(document.getElementById('nbBriefStamp').title).toBe('');
    expect(document.getElementById('nbBody').innerHTML).toContain('The newer claim.');
  });

  test('keeps last-good content through a refresh outage and clears failure on recovery', async () => {
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    fetchLandscape.mockRejectedValueOnce(new Error('synthetic transient failure'));
    await jest.advanceTimersByTimeAsync(63_000);
    expect(document.getElementById('nbBody').innerHTML).toContain('Synthetic wire reporting');
    expect(document.getElementById('nbIntegrity').textContent).toContain('Source refresh unavailable');
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS UNAVAILABLE');
    await jest.advanceTimersByTimeAsync(57_000);
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS CURRENT');
  });

  test('recovers a failed Briefing request without mislabeling healthy feeds', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockRejectedValueOnce(new Error('synthetic brief failure'));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(document.getElementById('nbBriefStamp').textContent).toMatch(/Briefing unavailable/);
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS CURRENT');
    await jest.advanceTimersByTimeAsync(59_000);
    expect(fetchBrief).toHaveBeenCalledTimes(2);
    expect(document.getElementById('nbBriefStamp').textContent).not.toMatch(/unavailable/);
    expect(document.getElementById('nbBody').innerHTML).toContain('A synthetic complete briefing claim.');
  });

  test('manual continuation holds rotation, respects dialogs and button focus, and resumes in place', async () => {
    const body = document.getElementById('nbBody');
    body.scrollHeight = 1500;
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    modal = true;
    expect(key('ArrowRight').preventDefault).not.toHaveBeenCalled();
    modal = false;
    expect(key(' ', { closest: () => ({ tagName: 'BUTTON' }) }).preventDefault).not.toHaveBeenCalled();
    const focusedControl = { closest: selector => ['button, a, [role="button"]', '.nb-controls'].includes(selector) ? {} : null };
    expect(key('ArrowRight', focusedControl).preventDefault).toHaveBeenCalled();
    const heldPosition = body.scrollTop;
    expect(heldPosition).toBeGreaterThan(0);
    expect(document.getElementById('nbPager').textContent).toContain('Part 2 / 3');
    expect(document.getElementById('nbPause').textContent).toBe('Resume');
    expect(document.getElementById('nbPlayback').textContent).toBe('Paused');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(body.scrollTop).toBe(heldPosition);
    document.getElementById('nbPause').dispatch('click');
    expect(body.scrollTop).toBe(heldPosition);
    await jest.advanceTimersByTimeAsync(18_000);
    expect(body.scrollTop).toBeGreaterThan(heldPosition);
    expect(document.getElementById('nbPager').textContent).toContain('Part 3 / 3');
  });

  test('finishes long automatic continuations without restarting on data polls', async () => {
    const body = document.getElementById('nbBody');
    body.scrollHeight = 3000;
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    const html = body.innerHTML;
    fetchLandscape.mockImplementation(async () => snapshot({ signals: [{ title: 'Next refresh content', horizon: 1 }] }));
    await jest.advanceTimersByTimeAsync(90_000);
    expect(body.scrollTop).toBe(2400);
    expect(body.innerHTML).toBe(html);
    await jest.advanceTimersByTimeAsync(18_000);
    expect(body.innerHTML).toContain('Next refresh content');
    expect(body.scrollTop).toBe(0);
  });

  test('shows stale feeds separately from playback and starts compact reading paused', async () => {
    window.matchMedia = query => ({ matches: query.includes('portrait') });
    fetchLandscape.mockImplementation(async () => snapshot({ generatedAt: '2026-09-04T09:00:00Z' }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(document.getElementById('nbBody').innerHTML).toContain('Synthetic wire reporting');
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS STALE');
    expect(document.getElementById('nbPlayback').textContent).toBe('Paused');
    expect(document.getElementById('nbPause').textContent).toBe('Resume');
  });

  test('preserves the unattended /wall entry without operator controls', async () => {
    window.location.search = '';
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(document.body.classList.contains('kiosk')).toBe(true);
    expect(document.getElementById('wallLayer').innerHTML).not.toContain('id="nbPause"');
    expect(listeners.has('keydown')).toBe(false);
  });

  test('ignores a rejected Briefing request from an earlier mount', async () => {
    let rejectOld;
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockReturnValueOnce(new Promise((resolve, reject) => { rejectOld = reject; }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    unmount();
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    rejectOld(new Error('late response from old mount'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(document.getElementById('nbBody').innerHTML).toContain('A synthetic complete briefing claim.');
    expect(document.getElementById('nbBriefStamp').textContent).not.toMatch(/unavailable/i);
  });

  test('does not reload an operator after an old kiosk health request resolves', async () => {
    jest.setSystemTime(new Date(2026, 8, 4, 4, 0, 0));
    let resolveHealth;
    fetchHealth.mockReturnValueOnce(new Promise(resolve => { resolveHealth = resolve; }));
    global.location = { reload: jest.fn() };
    window.location.search = '';
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    unmount();
    window.location.search = '?operator';
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    resolveHealth({ uptime: 5 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(location.reload).not.toHaveBeenCalled();
    expect(document.body.classList.contains('kiosk')).toBe(false);
  });

  test('does not present a copied legacy file modification time as fresh publication', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-08-30.md', date: '2026-08-30' } }));
    fetchBrief.mockResolvedValueOnce({
      content: '## BLUF\n\nAn older saved assessment.',
      generatedAt: new Date().toISOString(), // archive fallback: file copied today
      meta: null,
    });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    const stamp = document.getElementById('nbBriefStamp').textContent;
    expect(stamp).toBe('Briefing · Aug 30, 2026 · Older edition · AI-generated · Verify before acting');
    expect(stamp).not.toContain('published');
    expect(document.getElementById('nbSlug').dataset.status).toBe('live');
    expect(document.getElementById('nbBriefStamp').dataset.status).toBe('warn');
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS CURRENT');
  });

  test('retries a paused display failure on refresh without calling healthy feeds unavailable', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    window.matchMedia = query => ({ matches: query.includes('portrait') });
    fetchLandscape.mockResolvedValueOnce(snapshot({ signals: [{
      title: 'Synthetic poisoned display item', horizon: 1,
      get description() { throw new Error('synthetic renderer failure'); },
    }] }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(document.getElementById('nbBody').innerHTML).toContain('Display error');
    expect(document.getElementById('nbPlayback').textContent).toBe('Display error · Paused · Retrying on refresh');
    expect(document.getElementById('nbLiveWord').textContent).toBe('FEEDS CURRENT');
    await jest.advanceTimersByTimeAsync(59_000);
    expect(document.getElementById('nbBody').innerHTML).toContain('Synthetic wire reporting');
    expect(document.getElementById('nbPlayback').textContent).toBe('Paused');
  });
});

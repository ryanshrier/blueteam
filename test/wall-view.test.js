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
const { judgmentHtml, judgmentSources, presentationHtml, claimKioskMaintenanceReload, wallScaleForWidth, wirePageHtml, mount, unmount } = await import('../public/modules/wall/wall-view.js');

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
  test('long openings retain every authored word as readable copy without changing the topic', () => {
    const text = Array.from({ length: 100 }, (_, index) => `authored-${index}`).join(' ');
    const html = presentationHtml({ kind: 'bluf', topic: 'Shift assessment', block: { text } });
    expect(html).toContain('class="nb-cover-title"');
    expect(html).toContain(`<p class="nb-display-text nb-display-opening-copy">${text}</p>`);
    expect(html).not.toContain(`class="nb-display-bluf">${text}`);
    const short = presentationHtml({ kind: 'bluf', block: { text: 'Verify the exposed gateway.' } });
    expect(short).toContain('class="nb-display-text nb-display-opening-copy">Verify the exposed gateway.</p>');
  });
  test('executive presentation distinguishes advisory targets from legacy due dates', () => {
    const page = { kind: 'execsummary', topic: 'Decision · Infrastructure', block: { text: 'Verify deployment.' } };
    const advisory = presentationHtml({ ...page, timing: 'recommended target September 8, 2026' });
    expect(advisory).toContain('Recommended target · September 8, 2026');
    expect(advisory).not.toContain('Due ·');
    const legacy = presentationHtml({ ...page, timing: '2026-09-08' });
    expect(legacy).toContain('Due · 2026-09-08');
    expect(legacy).not.toContain('Recommended target');
  });
  test('presentation separates the dated decision window from the local recommended target', () => {
    const html = presentationHtml({ kind: 'judgment', topic: 'Chrome deployment verification', block: { text: 'Verify deployment and patch affected endpoints.' }, decision: 'Current shift.', editionDate: '2026-09-05', target: 'September 8, 2026', certainty: 'High — vendor and catalog evidence.' });
    expect(html).toContain('Decision · This shift');
    expect(html).toContain('from September 5, 2026 Briefing');
    expect(html).toContain('Recommended target · September 8, 2026');
    expect(html).toContain('Confidence · High');
    expect(html).not.toContain('Current shift. · September 8');
  });
  test('uses only saved citation hosts and supports judgments without a CVE', () => {
    const story = judgment({ citations: [
      { label: 'Vendor advisory', url: 'https://www.vendor.example/advisory' },
      { label: 'Second page', url: 'https://vendor.example/update' },
      { label: 'News', url: 'https://news.example/story' },
      { label: 'Bad', url: 'javascript:alert(1)' },
      { label: 'Bad', url: 'https://user:password@wrong.example/' },
    ] });
    expect(judgmentSources(story)).toEqual(['vendor.example', 'news.example']);
    const html = judgmentHtml(story);
    expect(html).toContain('href="https://www.vendor.example/advisory"');
    expect(html).toContain('href="https://news.example/story"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('user:password');
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
    expect(judgmentHtml(judgment({ confidence: 'Moderate — retained evidence only.', forecast: 'Likely that the stated condition will occur within 7 days.' }))).toContain('<strong>Forecast:</strong> Likely that the stated condition will occur within 7 days.');
  });

  test('uses Act now only when the Briefing carries an explicit this-shift action', () => {
    const html = judgmentHtml(judgment({
      decision: 'Current shift.',
      actionShift: { owner: null, imperative: 'Verify the synthetic exposure now.' },
    }));

    expect(html).toContain('<dd>This shift</dd>');
    expect(html).toContain('Verify the synthetic exposure now.');
  });

  test('keeps action owner and recommended target separate from the complete imperative', () => {
    const html = judgmentHtml(judgment({
      decision: 'Current shift.',
      actionShift: {
        owner: null,
        imperative: 'Infrastructure — verify every synthetic server and isolate any unpatched instance — recommended target July 29, 2026.',
      },
    }));

    expect(html).toContain('class="nb-response-owner">Infrastructure</strong>');
    expect(html).toContain('class="nb-response-imperative">verify every synthetic server and isolate any unpatched instance</p>');
    expect(html).toContain('Recommended target · July 29, 2026');
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
      toggle: (name, enabled = !classes.has(name)) => { if (enabled) classes.add(name); else classes.delete(name); return enabled; },
    },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name] ?? null; },
    hasAttribute(name) { return this[name] !== undefined; },
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
      location: { pathname: '/wall', search: '?read=1' },
      history: { pushState: jest.fn((_state, _title, path) => {
        const url = new URL(path, 'http://wall.test');
        Object.assign(window.location, { pathname: url.pathname, search: url.search, hash: url.hash });
      }) },
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
    delete global.localStorage;
  });

  test('quiet-hour reload happens once across document remounts in the same tab', async () => {
    jest.setSystemTime(new Date(2026, 8, 4, 4, 0, 0));
    window.location.search = '';
    global.location = { reload: jest.fn() };
    const storage = new Map();
    Object.defineProperty(global, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ maintenance: true }) } });
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
    document.getElementById('nbLoadReady').dispatch('click');
    key('ArrowRight');
    const html = document.getElementById('nbBody').innerHTML;
    expect(html).toContain('href="https://saved.example/advisory"');
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
    expect(document.getElementById('nbPause').textContent).toBe('Resume');
    expect(document.getElementById('nbPager').textContent).toBe('Section 1 of 1');
  });

  test('keeps empty-state controls subdued while showing an explicitly zoned local clock', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ signals: [] }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    for (const id of ['nbPrev', 'nbNext', 'nbPause']) expect(document.getElementById(id).disabled).toBe(true);
    key('ArrowRight');
    key(' ');
    expect(document.getElementById('nbPause').textContent).toBe('Resume');
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
    const held = document.getElementById('nbBody').innerHTML;
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById('nbBody').innerHTML).toBe(held);
    expect(document.getElementById('nbSlug').textContent).toContain('THE WIRE');
    expect(document.getElementById('nbReady').hidden).toBe(false);
    expect(document.getElementById('nbSections').innerHTML).toContain('BLUF');
    key(' ');
    expect(document.getElementById('nbBody').innerHTML).toContain('A synthetic complete briefing claim.');
    expect(document.getElementById('nbSlug').textContent).toContain('BLUF');
    expect(document.getElementById('nbPager').textContent).toContain('Section 1 of 2');
    expect(document.getElementById('nbBriefStamp').textContent).toContain('Sep 4, 2026');
  });

  test('retains held publication metadata while feed freshness continues updating', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-08-30.md', date: '2026-08-30' } }));
    fetchBrief.mockResolvedValueOnce({ content: '## BLUF\n\nThe saved older claim.', meta: { generated_at: '2026-08-30T09:00:00Z', warnings: ['Verify vendor attribution.'] } });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    document.getElementById('nbLoadReady').dispatch('click');
    const stamp = document.getElementById('nbBriefStamp').textContent;
    expect(stamp).toContain('Aug 30, 2026, 09:00 UTC');
    expect(stamp).toContain('Older edition');
    expect(stamp).toContain('AI-generated · Verify before acting');
    expect(stamp).toContain('1 review note');
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

  test('uses a reviewed reading copy while retaining explicit original provenance and canonical section links', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValue({ content: '## BLUF\n\nOriginal generated claim.', reviewedContent: '## BLUF\n\nCorrected bounded claim.\n\n## EXECUTIVE SUMMARY — SHIFT DECISIONS\n\n- **Threat:** Retained reporting.\n\n## KEY JUDGMENTS\n\n## DEVELOPING SITUATIONS\n\n### Situation\n**Trajectory:** Steady — monitoring retained reporting.\n**Escalation tripwire:** Named confirmation.',
      meta: { warnings: ['Original supporting-section provenance needs review.'] },
      disposition: { status: 'eligible', eligibleForLatest: true, editorialReviewStatus: 'reviewed' },
      review: { status: 'editorially-corrected', reviewer: 'Authorized editorial review', reviewedAt: '2026-09-04T12:00:00Z', scope: 'Retained sources only.', notes: [] } });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    document.getElementById('nbLoadReady').dispatch('click');
    expect(document.getElementById('nbBody').innerHTML).toContain('Corrected bounded claim.');
    expect(document.getElementById('nbBody').innerHTML).not.toContain('Original generated claim.');
    expect(document.getElementById('nbReview').innerHTML).toContain('editorial-review');
    expect(document.getElementById('nbReview').innerHTML).toContain('Retained sources only.');
    expect(document.getElementById('nbReview').innerHTML).toContain('Original generation source-check notes (1)');
    expect(document.getElementById('nbReview').innerHTML).toContain('Original supporting-section provenance needs review.');
    expect(document.getElementById('nbReview').hidden).toBe(false);
    expect(document.getElementById('nbBriefStamp').textContent).toContain('AI-generated · Editorially reviewed');
    expect(document.getElementById('nbBriefStamp').textContent).not.toContain('1 review note');
    expect(document.getElementById('nbBriefStamp').dataset.status).toBe('live');
    const picker = document.getElementById('nbSections');
    picker.value = '1'; picker.dispatch('change', { target: picker });
    expect(document.getElementById('nbOpen').href).toBe('/briefing/brief-2026-09-04.md#section-0-executive-summary-shift-decisions');
    picker.value = '2'; picker.dispatch('change', { target: picker });
    expect(document.getElementById('nbOpen').href).toBe('/briefing/brief-2026-09-04.md#section-2-developing-situations');
  });

  test('revalidates an editorial overlay for the same filename without replacing the held reading copy', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValueOnce({ content: '## BLUF\n\nOriginal saved claim.' });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    document.getElementById('nbLoadReady').dispatch('click');
    fetchBrief.mockResolvedValue({ content: '## BLUF\n\nOriginal saved claim.', reviewedContent: '## BLUF\n\nCorrected bounded claim.', review: { id: 'review-1', status: 'editorially-corrected', reviewer: 'Editorial reviewer', notes: [] } });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchBrief).toHaveBeenCalledTimes(2);
    expect(document.getElementById('nbBody').innerHTML).toContain('Original saved claim.');
    expect(document.getElementById('nbReady').hidden).toBe(false);
    document.getElementById('nbLoadReady').dispatch('click');
    expect(document.getElementById('nbBody').innerHTML).toContain('Corrected bounded claim.');
    expect(document.getElementById('nbReady').hidden).toBe(true);
  });

  test('remaps a held section choice when a newer publication has fewer judgments', async () => {
    const brief = titles => `## BLUF\n\nSaved publication cover.\n\n## KEY JUDGMENTS\n\n${titles.map((title, i) =>
      `### Signal ${i + 1} — [Horizon 1] ${title}\n**What happened:** Synthetic saved evidence.\n**Assessment:** Verify the local impact.\n**The line:** ${title}.\n**Decision window:** 7 days.`
    ).join('\n\n')}`;
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-08-30.md', date: '2026-08-30' } }));
    fetchBrief.mockResolvedValueOnce({ content: brief(['Older first judgment', 'Older second judgment', 'Older third judgment']) });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    const picker = document.getElementById('nbSections');
    picker.value = '3';
    picker.dispatch('change', { target: picker });
    expect(document.getElementById('nbBody').innerHTML).toContain('Older third judgment');
    expect(document.getElementById('nbOpen').href).toBe('/briefing/brief-2026-08-30.md#judgment-3');

    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValueOnce({ content: brief(['Newer only judgment']) });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById('nbBody').innerHTML).toContain('Older third judgment');
    expect(document.getElementById('nbOpen').href).toBe('/briefing/brief-2026-08-30.md#judgment-3');
    expect(picker.innerHTML).toContain('Newer only judgment');
    expect(picker.innerHTML).not.toContain('Older third judgment');
    expect(document.getElementById('nbReady').hidden).toBe(false);

    picker.value = '1'; // Navigation is current; held body/publication remain intact until this choice.
    picker.dispatch('change', { target: picker });
    expect(document.getElementById('nbBody').innerHTML).toContain('Newer only judgment');
    expect(document.getElementById('nbBody').innerHTML).not.toContain('Older second judgment');
    expect(document.getElementById('nbOpen').href).toBe('/briefing/brief-2026-09-04.md#judgment-1');
    expect(document.getElementById('nbBriefStamp').textContent).toContain('Sep 4, 2026');
    expect(document.getElementById('nbPager').textContent).toBe('Section 2 of 3');
    expect(document.getElementById('nbPageAnnounce').textContent).toContain('Sections refreshed');
    expect(picker.value).toBe('1');
    expect(picker.innerHTML).not.toContain('Older second judgment');
    expect(document.getElementById('nbPlayback').textContent).toBe('Paused');
  });

  test('delegates current and replaced Wall links through SPA history while preserving native browsing', async () => {
    const layer = document.getElementById('wallLayer');
    mount(layer);
    await jest.advanceTimersByTimeAsync(0);
    const click = (href, fields = {}) => {
      const link = element();
      link.href = href;
      const event = { button: 0, target: { closest: () => link }, preventDefault: jest.fn(), ...fields };
      layer.dispatch('click', event);
      return { event, link };
    };
    for (const path of ['/wire', '/wall?operator', '/wall', '/briefing/brief-2026-09-04.md#judgment-1']) {
      expect(click(path).event.preventDefault).toHaveBeenCalledTimes(1);
      expect(window.history.pushState).toHaveBeenLastCalledWith(null, '', path);
    }
    await jest.advanceTimersByTimeAsync(18_000); // Delegation survives the next body replacement.
    expect(click('/wire?signal=https%3A%2F%2Fsource.example%2Fstory').event.preventDefault).toHaveBeenCalledTimes(1);
    for (const fields of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      expect(click('/settings', fields).event.preventDefault).not.toHaveBeenCalled();
    }
    expect(click('https://source.example/story').event.preventDefault).not.toHaveBeenCalled();
    const externalTab = element();
    externalTab.href = '/wire'; externalTab.target = '_blank';
    const nativeClick = { button: 0, target: { closest: () => externalTab }, preventDefault: jest.fn() };
    layer.dispatch('click', nativeClick);
    expect(nativeClick.preventDefault).not.toHaveBeenCalled();
    unmount();
    window.history.pushState.mockClear();
    click('/settings');
    expect(window.history.pushState).not.toHaveBeenCalled();
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
    expect(document.getElementById('nbReady').hidden).toBe(false);
    document.getElementById('nbLoadReady').dispatch('click');
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
    expect(document.getElementById('nbPager').textContent).toContain('Screen 2 of 3');
    expect(document.getElementById('nbNext').textContent).toBe('Continue →');
    expect(document.getElementById('nbPause').textContent).toBe('Resume');
    expect(document.getElementById('nbPlayback').textContent).toBe('Paused');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(body.scrollTop).toBe(heldPosition);
    document.getElementById('nbPause').dispatch('click');
    expect(body.scrollTop).toBe(heldPosition);
    await jest.advanceTimersByTimeAsync(18_000);
    expect(body.scrollTop).toBeGreaterThan(heldPosition);
    expect(document.getElementById('nbPager').textContent).toContain('Screen 3 of 3');
    expect(document.getElementById('nbNext').textContent).toBe('Next section →');
  });

  test('finishes long automatic continuations without restarting on data polls', async () => {
    const body = document.getElementById('nbBody');
    body.scrollHeight = 3000;
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    key(' '); // Operator mode starts paused; playback is an explicit choice.
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

  test.each(['', '?operator'])('starts directly and reveals only Exit without pausing (%s)', async query => {
    window.location.search = query;
    fetchLandscape.mockImplementation(async () => snapshot({ signals: [{ title: 'First retained report', horizon: 1 }, { title: 'Second retained report', horizon: 1 }] }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(document.body.classList.contains('kiosk')).toBe(true);
    const markup = document.getElementById('wallLayer').innerHTML;
    for (const id of ['nbReveal', 'nbControls', 'nbPause', 'nbSetup', 'nbReady']) expect(markup).not.toContain(`id="${id}"`);
    expect(markup).toContain('id="nbExit"');
    expect(document.body.classList.contains('wall-exit-visible')).toBe(false);
    document.getElementById('wallLayer').dispatch('pointermove');
    expect(document.body.classList.contains('wall-exit-visible')).toBe(true);
    expect(document.getElementById('nbPlayback').textContent).toMatch(/^Playing/);
    await jest.advanceTimersByTimeAsync(13_000);
    expect(document.body.classList.contains('wall-exit-visible')).toBe(false);
    expect(document.getElementById('nbBody').innerHTML).toContain('Second retained report');
    key('ArrowLeft');
    expect(document.getElementById('nbBody').innerHTML).toContain('First retained report');
    expect(document.getElementById('nbPause').textContent).toBe('Pause');
  });

  test('removes a held edition from rotation when revalidation flags a material issue', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    document.getElementById('nbLoadReady').dispatch('click');
    const before = document.getElementById('nbBody').innerHTML;
    expect(before).toContain('A synthetic complete briefing claim.');
    fetchBrief.mockResolvedValue({ content: 'A synthetic complete briefing claim.', disposition: { status: 'review-required', eligibleForLatest: false } });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById('nbBody').innerHTML).toContain('This edition is excluded from Wall rotation.');
    expect(document.getElementById('nbBody').innerHTML).not.toContain('A synthetic complete briefing claim.');
    expect(document.getElementById('nbSections').innerHTML).not.toContain('BLUF');
    expect(document.getElementById('nbAllActions').disabled).toBe(true);
  });

  test('states when saved editions exist but none are eligible without fetching one', async () => {
    fetchLandscape.mockImplementation(async () => snapshot({ brief: null, briefAvailability: { status: 'no-eligible-edition', excludedCount: 1 } }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(document.getElementById('nbBody').innerHTML).toContain('excluded from Wall rotation');
    expect(document.getElementById('nbBody').innerHTML).toContain('/briefing?archive=1');
    expect(fetchBrief).not.toHaveBeenCalled();
  });

  test('does not repeat an unchanged readiness announcement on every refresh', async () => {
    const live = document.getElementById('nbPageAnnounce');
    let current = '', writes = 0;
    Object.defineProperty(live, 'textContent', { get: () => current, set: value => { current = value; writes++; } });
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(current).toContain('Latest Briefing ready');
    const initialWrites = writes;
    await jest.advanceTimersByTimeAsync(180_000);
    expect(writes).toBe(initialWrites);
  });

  test.each([null, { key: 'wire:0:0', briefFile: 'brief-2026-09-04.md' }])('does not announce held content when presentation adopts its initial edition (restore=%j)', async restore => {
    window.location.search = '';
    const storage = new Map(restore ? [['bt-wall-topic', JSON.stringify(restore)]] : []);
    global.sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(document.getElementById('nbReady').hidden).toBe(true);
    expect(document.getElementById('nbPageAnnounce').textContent).not.toContain('current screen remains held');
    if (restore) expect(document.getElementById('nbSlug').textContent).toBe('THE WIRE');
    expect(document.getElementById('nbPlayback').textContent).toMatch(/^Playing · Next in/);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById('nbReady').hidden).toBe(true);
  });

  test.each(['editorially-corrected', 'unavailable'])('presentation removes only the redundant eligible reviewed disclosure (%s)', async status => {
    window.location.search = '';
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValue({ content: '## BLUF\n\nRetained edition.', reviewedContent: status === 'editorially-corrected' ? '## BLUF\n\nReviewed edition.' : undefined,
      review: { status, reviewer: 'AI-assisted editorial review', scope: 'Captured sources only.', message: 'Review could not be verified.' },
      disposition: { status: 'eligible', eligibleForLatest: true } });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(document.getElementById('nbReview').hidden).toBe(status === 'editorially-corrected');
    if (status === 'unavailable') expect(document.getElementById('nbReview').innerHTML).toContain('role="alert"');
  });

  test('allows a complete long topic its reading time before a preferred feed insertion', async () => {
    window.location.search = '';
    Object.defineProperty(global, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ feedSeconds: 60 }) } });
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValue({ content: `## BLUF\n\n${'A retained evidence statement requiring review. '.repeat(40)}` });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    const startedAt = Date.now();
    let wasFeed = false;
    let count = 0;
    const assessmentScreens = new Set();
    let firstFeedAt;
    for (let elapsed = 0; elapsed < 240_000; elapsed += 1000) {
      await jest.advanceTimersByTimeAsync(1000);
      const feed = document.getElementById('nbSlug').textContent === 'THE WIRE';
      if (!feed) {
        const html = document.getElementById('nbBody').innerHTML;
        if (html.includes('data-kind="bluf"')) assessmentScreens.add(html);
      }
      if (feed && !wasFeed) { firstFeedAt ??= Date.now(); count++; }
      wasFeed = feed;
    }
    expect(count).toBeGreaterThanOrEqual(2);
    expect(firstFeedAt - startedAt).toBeGreaterThan(60_000);
    expect(assessmentScreens.size).toBe(1);
    expect([...assessmentScreens][0]).toContain('A retained evidence statement requiring review. '.repeat(40).trim());
    expect(firstFeedAt - startedAt).toBeGreaterThanOrEqual(82_000);
  });

  test('keeps measured owner responses consecutive across timer advances and refreshes', async () => {
    window.location.search = '';
    fetchLandscape.mockImplementation(async () => snapshot({ brief: { filename: 'brief-2026-09-04.md', date: '2026-09-04' } }));
    fetchBrief.mockResolvedValue({ content: '## KEY JUDGMENTS\n\n### Signal 1 — [Horizon 1] Appliance response\n**The line:** Remediate and investigate together.\n**Recommended actions:**\n- Infrastructure — apply the fixed release — September 4, 2026\n- Incident response — assess compromise and record recovery — September 5, 2026\n\n### Signal 2 — [Horizon 1] Following topic\n**The line:** Review the next event.' });
    const body = document.getElementById('nbBody');
    Object.defineProperty(body, 'scrollHeight', { configurable:true, get: () => (body.innerHTML.match(/data-action-id=/g) || []).length > 1 ? 800 : 600 });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    expect(body.innerHTML).toContain('Part 1 of 2');
    expect(body.innerHTML).toContain('apply the fixed release');
    expect(body.innerHTML).not.toContain('assess compromise and record recovery');
    await jest.advanceTimersByTimeAsync(13_000);
    expect(body.innerHTML).toContain('Part 2 of 2');
    expect(body.innerHTML).toContain('assess compromise and record recovery');
    await jest.advanceTimersByTimeAsync(13_000);
    expect(body.innerHTML).toContain('Following topic');
    await jest.advanceTimersByTimeAsync(40_000);
    expect(body.innerHTML).not.toContain('Display error');
  });

  test('ignores legacy hold preferences and reading input during automatic presentation', async () => {
    window.location.search = '';
    Object.defineProperty(global, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ holdSeconds: 60 }) } });
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    const body = document.getElementById('nbBody');
    body.dispatch('wheel');
    body.contains = target => target === body;
    document.activeElement = body;
    body.dispatch('focusin');
    body.dispatch('touchstart');
    key(' ');
    expect(document.getElementById('nbPlayback').textContent).not.toMatch(/hold|Paused/i);
    fetchLandscape.mockImplementation(async () => snapshot({ signals: [{ title: 'New retained collection', horizon: 1 }] }));
    await jest.advanceTimersByTimeAsync(61_000);
    expect(body.innerHTML).toContain('New retained collection');
    expect(document.getElementById('nbPlayback').textContent).not.toMatch(/hold|Paused/i);
  });

  test('configured overnight maintenance runs unattended and preserves topic identity', async () => {
    jest.setSystemTime(new Date(2026, 8, 4, 4, 0, 0));
    window.location.search = '';
    Object.defineProperty(global, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ maintenance: true, dim: true }) } });
    const storage = new Map();
    global.sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
    global.location = { reload: jest.fn() };
    mount(document.getElementById('wallLayer'));
    document.getElementById('nbBody').dispatch('focusin');
    await jest.advanceTimersByTimeAsync(0);
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.news-mode').classList.contains('nb-quiet-dim')).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get('bt-wall-topic')).key).toContain('wire:');
  });

  test('keyboard activity exposes Exit without interrupting fresh-data adoption', async () => {
    window.location.search = '';
    mount(document.getElementById('wallLayer'));
    await jest.advanceTimersByTimeAsync(0);
    const body = document.getElementById('nbBody');
    body.dispatch('focusin', { target: { tagName: 'A' } });
    key('Tab');
    expect(document.body.classList.contains('wall-exit-visible')).toBe(true);
    fetchLandscape.mockImplementation(async () => snapshot({ signals: [{ title: 'Later reporting', horizon: 1 }] }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(body.innerHTML).toContain('Later reporting');
    expect(document.getElementById('nbPause').textContent).toBe('Pause');
  });

  test('focus during initial loading does not create a paused boot state', async () => {
    window.location.search = '';
    let finish;
    fetchLandscape.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mount(document.getElementById('wallLayer'));
    document.getElementById('nbBody').dispatch('focusin');
    finish(snapshot());
    await jest.advanceTimersByTimeAsync(0);
    expect(document.body.classList.contains('wall-controls-visible')).toBe(false);
    expect(document.getElementById('nbPlayback').textContent).not.toBe('Paused');
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
    document.getElementById('nbLoadReady').dispatch('click');
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
    window.location.search = '?read=1';
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
    document.getElementById('nbLoadReady').dispatch('click');
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

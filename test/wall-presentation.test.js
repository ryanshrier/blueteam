import { describe, expect, test } from '@jest/globals';
import { buildPresentationPages, buildGlanceModel, splitDisplayText, displayDwellMs, normalizeDisplaySettings, inDimWindow, readerFragment, topicLabel, pageKey, splitResponsePage, presentationReadingText, splitDevelopingSourceTail } from '../public/modules/wall/wall-presentation.js';
import { briefSectionAnchors, parseBrief, TRAJECTORY_VALUES } from '../lib/brief-schema.js';

describe('Wall display composition', () => {
  test('later publication or a changed retained capture can re-enter at an already-cited URL', () => {
    const link = 'https://vendor.test/advisory';
    const doc = { generatedAt: '2026-09-06T12:00:00Z', stories: [{ title: 'Prior assessment', line: 'Review exposure.', citations: [{ url: link }] }] };
    const signal = { title: 'Updated advisory', link, date: '2026-09-05T12:00:00Z' };
    expect(buildPresentationPages(doc, { signals: [signal] }).some(page => page.kind === 'wire')).toBe(false);
    expect(buildPresentationPages(doc, { signals: [{ ...signal, date: '2026-09-07T12:00:00Z' }] }).some(page => page.kind === 'wire')).toBe(true);
    expect(buildPresentationPages(doc, { signals: [{ ...signal, evidence: [{ changed: true, retrievedAt: '2026-09-07T12:00:00Z' }] }] }).some(page => page.kind === 'wire')).toBe(true);
    expect(buildPresentationPages(doc, { signals: [{ ...signal, evidence: [{ changed: true, retrievedAt: '2026-09-05T12:00:00Z' }] }] }).some(page => page.kind === 'wire')).toBe(false);
  });
  test('response records retain every action field without charging hidden procedures to glance dwell', () => {
    const actions = [{ id:'patch', owner:'Infrastructure', imperative:'Apply the fix.' }, { id:'recover', owner:'Incident response', imperative:'Assess compromise.', completionCriterion:'Record findings.', recoverySteps:'Recovery '.repeat(150) }];
    const page = buildPresentationPages({ stories:[{ title:'Appliance', line:'Patch and investigate together.', actions }] }, {})[0];
    expect(page.actions).toEqual(actions);
    expect(page.block.label).toBe('Recommended response');
    const parts = splitResponsePage(page);
    expect(parts.flatMap(part => part.actions)).toEqual(actions);
    expect(parts.map(part => part.part)).toEqual([0, 1]);
    expect(parts.every(part => part.block.text === page.block.text && part.parts === 2)).toBe(true);
    expect(parts.every(part => part.block.label === 'Recommended response')).toBe(true);
    expect(presentationReadingText(parts[1])).not.toContain(actions[1].recoverySteps);
    expect(presentationReadingText(parts[1])).not.toContain(actions[1].imperative);
    expect(displayDwellMs(presentationReadingText(parts[1]))).toBeLessThan(20_000);
  });
  test('suppresses covered events using complete topic identity while allowing later reporting and distinct query articles', () => {
    const cve = 'CVE-2026-12345';
    const doc = { generatedAt:'2026-09-06T12:00:00Z', stories:[{ title:'Appliance response', line:'Act on exposure.', whatHappened:`Exploitation of ${cve}.`, citations:[{url:'https://vendor.test/article?id=1'}] }] };
    const pages = buildPresentationPages(doc, { kev:{recent:[{cve, product:'Appliance', dateAdded:'2026-09-05'}]}, signals:[
      { title:'Original announcement', link:'https://www.vendor.test/article?id=1&utm_source=feed' },
      { title:'Repeated CVE announcement', description:cve, date:'2026-09-05T12:00:00Z' },
      { title:'Later reporting', description:cve, date:'2026-09-06T13:00:00Z', link:'https://news.test/followup' },
      { title:'Duplicate followup', description:cve, date:'2026-09-06T13:00:00Z', link:'https://other.test/followup' },
      { title:'Separate article', link:'https://vendor.test/article?id=2' },
    ] });
    expect(pages.filter(page => page.kind === 'kev')).toHaveLength(0);
    expect(pages[0].catalogEntries.map(item => item.cve)).toEqual([cve]);
    expect(pages.filter(page => page.kind === 'wire').map(page => page.topic)).toEqual(['Later reporting', 'Separate article']);
  });
  test('uses reviewed display copy only for the exact corresponding title and preserves actions', () => {
    const action = { owner:'SOC', imperative:'Verify the original condition.' };
    const doc = { stories:[{ title:'Original', line:'Authored assessment.', actions:[action] }], review:{presentation:{status:'reviewed',judgments:[{index:0,originalTitle:'Original',title:'Display title',summary:'Reviewed summary.'}]}} };
    expect(buildPresentationPages(doc, {})[0]).toMatchObject({topic:'Display title',block:{text:'Reviewed summary.'},actions:[action]});
    doc.stories[0].title = 'Different topic';
    expect(buildPresentationPages(doc, {})[0]).toMatchObject({topic:'Different topic',block:{text:'Authored assessment.'}});
  });
  test('an editorial report match suppresses only its exact publication, not an updated version', () => {
    const report = {url:'https://report.test/without-cve', publishedAt:'2026-09-04T12:00:00Z'};
    const doc = { stories:[{title:'Covered topic',line:'Assessment.'}], review:{presentation:{status:'reviewed',judgments:[{index:0,originalTitle:'Covered topic',title:'Display topic',summary:'Reviewed.',coveredReports:[report]}]}} };
    const signal = {title:'No identifier in excerpt',link:report.url,date:report.publishedAt};
    expect(buildPresentationPages(doc,{signals:[signal]}).some(page=>page.kind==='wire')).toBe(false);
    expect(buildPresentationPages(doc,{signals:[{...signal,date:'2026-09-05T12:00:00Z'}]}).some(page=>page.kind==='wire')).toBe(true);
  });
  test('long authored passages survive ordered complete sentences at every text size', () => {
    const prose = Array.from({ length: 210 }, (_, n) => `Word${n}${n % 17 === 0 ? '.' : ''}`).join(' ');
    for (const size of ['standard', 'large', 'largest']) {
      const pages = buildPresentationPages({ bluf: prose }, {}, normalizeDisplaySettings({ size }));
      expect(pages.map(page => page.block.text).join(' ')).toBe(prose);
      expect(pages.slice(0, -1).every(page => page.block.text.endsWith('.'))).toBe(true);
      expect(pages.every(page => page.block.text.split(/\s+/).length >= 12)).toBe(true);
      expect(new Set(pages.map(pageKey)).size).toBe(pages.length);
      expect(pages).toHaveLength(1);
      expect(pages.every(page => page.topic === 'Shift assessment')).toBe(true);
      expect(pages.at(-1).part + 1).toBe(pages.length);
    }
    expect(splitDisplayText('')).toEqual([]);
  });
  test('separates each developing topic, tripwire, KEV identity and feed story', () => {
    const pages = buildPresentationPages({ developing: [{ name: 'Situation A', trajectory: 'Tracking', trajectoryDetail: 'Source is investigating.', watch: 'Escalate on vendor confirmation.' }, { name: 'Situation B', watch: 'Observe new reporting.' }], watchlist: ['Review disclosure.'] }, {
      kev: { recent: [{ cve: 'CVE-2026-85046', vendor: 'Google', product: 'Chromium V8', name: 'Type confusion', dateAdded: '2026-09-04' }] },
      signals: [{ title: 'Chrome release', description: 'Vendor published a fixed stable release.', link: 'https://chromereleases.googleblog.com/', source: 'Google' }, { title: 'Other event', description: 'Separate evidence.' }],
    });
    expect(pages.filter(page => page.kind === 'developing').map(page => page.topic)).toEqual(['Situation A', 'Situation B']);
    expect(pages.find(page => page.kind === 'developing')).toMatchObject({ block: { text: 'Source is investigating.' }, condition: 'Escalate on vendor confirmation.' });
    expect(pages.filter(page => page.kind === 'wire')).toHaveLength(2);
    expect(pages.find(page => page.kind === 'kev')).toMatchObject({ cve: 'CVE-2026-85046', vendor: 'Google', added: '2026-09-04' });
    expect(pages.some(page => page.kind === 'watchlist')).toBe(false);
  });
  test.each(TRAJECTORY_VALUES)('labels Developing independently of its authored %s trajectory', trajectory => {
    const detail = `${trajectory} — A working exploit is reported; deployment and observed attack direction remain unverified.`;
    const doc = parseBrief(`## DEVELOPING SITUATIONS\n### Example disclosure\n**Trajectory:** ${detail}\n**Watch criteria:** Verify the affected deployment.`);
    const page = buildPresentationPages(doc, {})[0];
    expect(page).toMatchObject({ kind: 'developing', trajectory,
      block: { label: 'Developing situation', text: 'A working exploit is reported; deployment and observed attack direction remain unverified.' },
      condition: 'Verify the affected deployment.' });
    if (trajectory === 'Uncertain') expect(presentationReadingText(page)).not.toContain(trajectory);
    else expect(presentationReadingText(page)).toContain(trajectory);
    expect(doc.developing[0].trajectoryDetail).toBe(detail);
  });
  test('missing or unrecognized trajectories do not invent a state or remove explanatory words', () => {
    for (const detail of ['', 'Unclear — conflicting reports need verification.', 'Uncertain whether exploitation is increasing.']) {
      const doc = parseBrief(`## DEVELOPING SITUATIONS\n### Example disclosure\n**Trajectory:** ${detail}\n**Watch criteria:** Retrieve the advisory.`);
      const page = buildPresentationPages(doc, {})[0];
      expect(page.block).toEqual({ label: 'Developing situation', text: detail || 'Retrieve the advisory.' });
      expect(page.trajectory).toBe(detail.startsWith('Uncertain') ? 'Uncertain' : '');
    }
  });
  test('an approved Developing summary remains verbatim when trajectory moves into metadata', () => {
    const summary = 'Uncertain — the reviewed summary keeps its explicit qualification. [Reviewed publisher, 2026-10-09]';
    const doc = { developing: [{ name: 'Original topic', trajectory: 'Uncertain', trajectoryDetail: 'Uncertain — Original explanation.', watch: 'Verify applicability.' }],
      review: { presentation: { status: 'reviewed', developing: [{ index: 0, originalTitle: 'Original topic', title: 'Reviewed topic', summary }] } } };
    expect(buildPresentationPages(doc, {})[0]).toMatchObject({ topic: 'Reviewed topic', trajectory: 'Uncertain', block: { label: 'Developing situation', text: summary } });
    expect(buildPresentationPages(doc, {})[0].citations).toEqual([]);
  });
  test.each([
    ['a title-only lead needs verification.', 'A title-only lead needs verification.'],
    ['an advisory is still unavailable.', 'An advisory is still unavailable.'],
    ['the vendor has not published technical scope.', 'The vendor has not published technical scope.'],
    ['iOS remains in scope.', 'iOS remains in scope.'],
  ])('only capitalizes a leading article after removing the repeated trajectory from %s', (explanation, expected) => {
    const detail = `Uncertain — ${explanation}`;
    const doc = { developing: [{ name: 'Scope check', trajectory: 'Uncertain', trajectoryDetail: detail }] };
    expect(buildPresentationPages(doc, {})[0].block.text).toBe(expected);
    expect(doc.developing[0].trajectoryDetail).toBe(detail);
    doc.developing[0].trajectoryDetail = explanation;
    expect(buildPresentationPages(doc, {})[0].block.text).toBe(explanation);
    doc.review = { presentation: { status: 'reviewed', developing: [{ index: 0, originalTitle: 'Scope check', summary: explanation }] } };
    doc.developing[0].trajectoryDetail = detail;
    expect(buildPresentationPages(doc, {})[0].block.text).toBe(explanation);
  });
  test.each([
    {
      body: 'These are separate leads, not an established shared campaign.',
      tail: '[SOC Prime, 2026-10-05] · [CISA KEV catalog, date unavailable](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) · [CyberScoop, 2026-10-06](https://cyberscoop.com/fortibleed-fortinet-vpn-ransomware-fbi-warning/)',
      sources: [
        { label: 'SOC Prime, 2026-10-05', url: '' },
        { label: 'CISA KEV catalog, date unavailable', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' },
        { label: 'CyberScoop, 2026-10-06', url: 'https://cyberscoop.com/fortibleed-fortinet-vpn-ransomware-fbi-warning/' },
      ],
    },
    {
      body: 'It cannot establish that CVE-2026-107406 is exploited.',
      tail: '[CyberScoop, 2026-10-06]', sources: [{ label: 'CyberScoop, 2026-10-06', url: '' }],
    },
    {
      body: 'The retained passage does not establish exploitation in the wild.',
      tail: '[The Hacker News, 2026-10-09](https://thehackernews.com/2026/10/researchers-publish-working-exploit-for.html)',
      sources: [{ label: 'The Hacker News, 2026-10-09', url: 'https://thehackernews.com/2026/10/researchers-publish-working-exploit-for.html' }],
    },
  ])('moves complete live Developing source grammar to dated attribution: $body', ({ body, tail, sources }) => {
    const doc = parseBrief(`## DEVELOPING SITUATIONS\n### Example disclosure\n**Trajectory:** Uncertain — ${body} ${tail}\n**Watch criteria:** Verify authoritative scope.`);
    const originalDetail = doc.developing[0].trajectoryDetail;
    const originalCitations = [...doc.developing[0].citations];
    const page = buildPresentationPages(doc, {})[0];
    expect(page.block.text).toBe(body);
    expect(page.citations).toEqual(sources);
    for (const source of sources) expect(presentationReadingText(page)).not.toContain(source.label);
    expect(doc.developing[0].trajectoryDetail).toBe(originalDetail);
    expect(doc.developing[0].citations).toEqual(originalCitations);
  });
  test.each([
    'Scope remains unverified. [SOC Prime, 2026-13-01]',
    'Scope remains unverified. [SOC Prime, 2026-02-30]',
    'Scope remains unverified. [SOC Prime, 2026-10-05] · unidentified update',
    'Scope remains unverified. Unresolved publisher, 2026-10-05 · CyberScoop, 2026-10-06',
    'Scope remains unverified. [SOC Prime, 2026-10-05] · [broken] · CyberScoop, 2026-10-06',
    'Scope remains unverified. [SOC Prime, 2026-10-05] plus ongoing uncertainty.',
    'The passage mentions CyberScoop, 2026-10-06',
    'The passage mentions [SOC Prime, 2026-10-05] in its explanation.',
    'Scope remains unverified. [SOC Prime, 2026-10-05',
  ])('preserves malformed, mixed, and narrative source mentions: %s', text => {
    const citations = [{ label: 'CyberScoop, 2026-10-06', url: 'https://cyberscoop.com/saved-report/' }];
    expect(splitDevelopingSourceTail(text, citations)).toEqual({ text, citations });
  });
  test('plain attribution never borrows a link from another same-publisher dated citation', () => {
    const saved = [{ label: 'CyberScoop, 2026-10-06', url: 'https://cyberscoop.com/different-report/' }];
    expect(splitDevelopingSourceTail('The identifier remains unresolved. [CyberScoop, 2026-10-06]', saved)).toEqual({
      text: 'The identifier remains unresolved.', citations: [{ label: 'CyberScoop, 2026-10-06', url: '' }, ...saved],
    });
  });
  test('playlists select content without suppressing the feed or losing all judgments', () => {
    const doc = { bluf: 'Overview.', stories: Array.from({ length: 7 }, (_, n) => ({ title: `Topic ${n}`, line: 'Assessment.' })), developing: [{ name: 'Situation', watch: 'Tripwire.' }] };
    const landscape = { signals: [{ title: 'Feed', description: 'Reporting.' }] };
    const all = buildPresentationPages(doc, landscape);
    expect(all.filter(page => page.kind === 'judgment')).toHaveLength(7);
    const updates = buildPresentationPages(doc, landscape, normalizeDisplaySettings({ playlist: 'updates' }));
    expect(updates.map(page => page.kind)).toEqual(['developing', 'wire']);
    const assessment = buildPresentationPages(doc, landscape, normalizeDisplaySettings({ playlist: 'assessment' }));
    expect(assessment.some(page => page.kind === 'developing')).toBe(false);
    expect(assessment.some(page => page.kind === 'wire')).toBe(true);
  });
  test('updates preserve each authored Watchlist condition and its corresponding citations', () => {
    const doc = parseBrief('## WATCHLIST — THROUGH October 12, 2026\n- Escalate if the vendor confirms exposure. [Vendor](https://vendor.test/advisory)\n- Verify an unresolved inventory result.');
    const pages = buildPresentationPages(doc, {}, normalizeDisplaySettings({ playlist: 'updates' }));
    expect(pages.map(page => page.block.text)).toEqual(doc.watchlistEntries.map(item => item.text));
    expect(pages.map(page => page.citations)).toEqual(doc.watchlistEntries.map(item => item.citations));
    expect(pages[0].citations).toHaveLength(1);
    expect(pages[1].citations).toEqual([]);
    expect(pages.every(page => page.validity === 'Through October 12, 2026')).toBe(true);
    const legacy = buildPresentationPages({ watchlist: ['Preserve the legacy condition.'] }, {}, normalizeDisplaySettings({ playlist: 'updates' }));
    expect(legacy[0]).toMatchObject({ block: { text: 'Preserve the legacy condition.' }, citations: [] });
  });
  test.each([
    ['ONLYOFFICE', 'Docs', 'ONLYOFFICE Docs'],
    ['Apache', 'Struts', 'Apache Struts'],
    ['Strapi', 'strapi', 'strapi'],
    ['Apache', 'Apache Struts', 'Apache Struts'],
    ['', 'Example Server', 'Example Server'],
  ])('catalog identity includes %s and %s without repeating the vendor', (vendor, product, identity) => {
    const [page] = buildPresentationPages(null, { kev: { recent: [{ vendor, product, cve: 'CVE-2026-12345', dateAdded: '2026-10-09' }] } });
    expect(page.topic).toBe(`${identity}: known exploitation`);
    expect(page.block.text).toBe(identity);
  });
  test('reading time increases with text and respects selected speed and bounds', () => {
    const long = 'word '.repeat(70);
    expect(displayDwellMs(long)).toBeGreaterThan(displayDwellMs('Short statement.'));
    expect(displayDwellMs(long, 'slow')).toBeGreaterThan(displayDwellMs(long, 'fast'));
    expect(displayDwellMs('word '.repeat(1000), 'slow')).toBeGreaterThan(400_000);
    expect(displayDwellMs('')).toBe(12000);
  });
  test('normalizes stored values and handles dim ranges crossing midnight', () => {
    expect(normalizeDisplaySettings({ size: '<script>', feedSeconds: 1, holdSeconds: -1, dimStart: 45 })).toMatchObject({ size: 'standard', feedSeconds: 90, holdSeconds: 0, dimStart: 1, dim: false, maintenance: false });
    expect(inDimWindow(23, 22, 5)).toBe(true);
    expect(inDimWindow(2, 22, 5)).toBe(true);
    expect(inDimWindow(12, 22, 5)).toBe(false);
    expect(inDimWindow(2, 2, 2)).toBe(false);
  });
  test('uses reader section anchors and descriptive topic names', () => {
    const anchors = briefSectionAnchors('## BLUF\n\nCover\n\n## EXECUTIVE SUMMARY\n\n## KEY JUDGMENTS\n\n## DEVELOPING SITUATIONS\n\n## CONVERGENCE\n\n## WATCHLIST — THROUGH SEPTEMBER 8, 2026');
    expect(readerFragment({ kind: 'developing' }, anchors)).toBe('#section-2-developing-situations');
    expect(readerFragment({ kind: 'convergence' }, anchors)).toBe('#section-3-convergence');
    expect(readerFragment({ kind: 'judgment', idx: 5 }, anchors)).toBe('#judgment-6');
    expect(readerFragment({ kind: 'watchlist' }, anchors)).toBe('#section-4-watchlist-through-september-8-2026');
    expect(topicLabel({ kind: 'judgment', idx: 0 }, { stories: [{ title: 'Vendor update needs review' }] })).toContain('Vendor update needs review');
  });
});

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { renderKevSection, renderKevRecent } from '../public/modules/wall/wall-kev.js';
import { validateBrief } from '../lib/validation.js';
import { FIXTURE_CASES, buildFixtureData } from './visual/fixture-cases.js';
import { MARKETING_BRIEF, MARKETING_SOURCES } from './visual/marketing-brief.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { sha256 } from '../lib/generation-manifest.js';
import { APP_SCENARIOS, WALL_KINDS, buildAppFixture } from './visual/app-fixtures.js';
import { parseBrief } from '../lib/brief-schema.js';
import { buildPages, executiveSummaryModel } from '../public/modules/wall/wall-format.js';
import { createFixtureApp } from '../scripts/serve-visual-fixtures.mjs';

describe('visual fixture manifest', () => {
  test('covers sparse KEV plus loading, error, empty, and stale states', () => {
    const ids = FIXTURE_CASES.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'kev-one', 'kev-six', 'kev-missing', 'wall-loading', 'wall-stale',
      'wall-judgment', 'wall-wire-four',
      'wire-loading', 'brief-edition-capture', 'brief-showcase',
      'brief-full', 'brief-error', 'brief-empty',
    ]));
    expect(FIXTURE_CASES.find(item => item.id === 'brief-edition-capture')).toMatchObject({
      surface: 'edition',
    });
  });

  test('keeps the public showcase synthetic and valid under the Briefing contract', () => {
    const result = validateBrief(MARKETING_BRIEF, '2026-07-24', {
      publication: true, groundingManifest: buildGroundingManifest({ headlines: MARKETING_SOURCES }), kevSet: new Set(),
    });
    expect(result.warnings).toEqual([]);
    expect(result.judgmentEvidence).toHaveLength(3);
    expect(parseBrief(MARKETING_BRIEF).stories.map(story => story.horizon)).toEqual([1, 2, 3]);
    expect(MARKETING_BRIEF).toMatch(/synthetic|fictional/i);
    expect(MARKETING_BRIEF).not.toMatch(/SharePoint|Fortinet|Ivanti|Minnesota|CVE-\d/i);
  });
});

describe('production-shell synthetic fixtures', () => {
  const now = new Date('2026-09-04T15:00:00Z');

  test('source revision fixture uses production identities and a distinct saved-input edition', () => {
    const data = buildAppFixture('source-revision', now);
    const reference = data.headlines.headlines[0].evidence[0];
    expect(reference.sourceId).toMatch(/^src_[a-f0-9]{64}$/);
    expect(reference.revisionId).toMatch(/^rev_[a-f0-9]{64}$/);
    expect(data.evidence.revisions[0].revisionId).toBe(reference.revisionId);
    expect(data.brief.inputManifest.status).toBe('available');
    expect(data.briefs[0].filename).not.toBe(buildAppFixture('normal', now).briefs[0].filename);
  });

  test.each(['normal', 'long', 'sparse'])('%s covers every existing Wall content type through the real Briefing parser', scenario => {
    const data = buildAppFixture(scenario, now);
    const brief = parseBrief(data.brief.content);
    const kinds = new Set(buildPages(brief, data.landscape).map(page => page.kind));
    expect([...kinds]).toEqual(WALL_KINDS);
  });

  test('long fixture retains complete action and escalation endings after parsing', () => {
    const data = buildAppFixture('long', now);
    const brief = parseBrief(data.brief.content);
    expect(brief.bluf.length).toBeGreaterThan(800);
    expect(brief.bluf).toContain('before releasing the service for the next shift.');
    const summary = executiveSummaryModel(brief.execSummary);
    expect(summary.decisions).toHaveLength(7);
    expect(summary.decisions[6].action).toContain('retain the decision record for workstream 7');
    expect(summary.decisions[6].deadline).toBe('recommended target July 30, 2026');
    expect(brief.stories[0].actionShift.imperative).toContain('before releasing the service for the next shift');
    expect(brief.stories[0].actionShift.imperative).toContain('recommended target July 24, 2026');
    expect(brief.developing[0].watch).toMatch(/notify the incident commander before the next handoff\.$/);
    expect(brief.convergence[0].move).toMatch(/confirm the documented escalation trigger with incident command\.$/);
    expect(data.landscape.kev.recent.every(record => record.name.endsWith('validating the final remediation evidence.'))).toBe(true);
    expect(data.landscape.signals.every(signal => signal.description.endsWith('before releasing the service for the next shift.'))).toBe(true);
  });

  test('sparse and empty data include unusable entries without fabricating replacement analysis', () => {
    const sparse = buildAppFixture('sparse', now);
    expect(sparse.landscape.kev.recent).toContainEqual({});
    expect(sparse.landscape.signals.some(signal => !signal.title)).toBe(true);
    const empty = buildAppFixture('empty', now);
    expect(empty.landscape).toMatchObject({ generatedAt: null, brief: null, signals: [], kev: { recent: [] } });
    expect(empty.briefs).toEqual([]);
    expect(buildPages(null, empty.landscape)).toEqual([{ kind: 'empty' }]);
  });

  test('stale feed timing stays separate from the saved Briefing date and changed edition changes rotation shape', () => {
    const old = buildAppFixture('stale', now);
    const revised = buildAppFixture('changed', now);
    expect(Date.parse(old.landscape.generatedAt)).toBe(now.getTime() - 7_200_000);
    expect(old.landscape.brief.date).toBe('2026-07-24');
    expect(revised.landscape.brief.date).toBe('2026-07-25');
    expect(revised.landscape.brief.filename).not.toBe(old.landscape.brief.filename);
    expect(buildPages(parseBrief(revised.brief.content), revised.landscape).map(page => page.kind))
      .toEqual(['bluf', 'developing', 'kev', 'wire']);
    expect(APP_SCENARIOS).toEqual(expect.arrayContaining(['loading', 'sourceerror', 'brieferror', 'changed']));
  });
});

describe('isolated production-shell fixture server', () => {
  let server;
  let origin;
  beforeAll(async () => {
    server = createFixtureApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  test('serves actual app routes plus existing visual fixtures', async () => {
    for (const route of ['/wall', '/wire', '/briefing', '/settings']) {
      const response = await fetch(origin + route);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('/fixtures/app-fixture-controls.js');
      expect(html).toContain('/app.js?v=fixture');
    }
    const existing = await (await fetch(origin + '/?state=kev-one')).text();
    expect(existing).toContain('fixtureRoot');
  });

  test('returns synthetic failures and recovery without touching live state', async () => {
    const failure = await fetch(origin + '/api/landscape?scenario=sourceerror');
    expect(failure.status).toBe(503);
    const recovered = await fetch(origin + '/api/landscape?scenario=normal');
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).signals[0].id).toBe('synthetic-0');
    const briefFailure = await fetch(origin + '/api/brief/example?scenario=brieferror');
    expect(briefFailure.status).toBe(503);
    const briefList = await (await fetch(origin + '/api/briefs')).json();
    expect(Array.isArray(briefList)).toBe(true); // production fetchBriefs contract
    expect(briefList[0].filename).toBe('brief-2026-07-24-demo.md');
  });

  test('serves a complete synthetic sample and matching saved receipt with no provider attempt', async () => {
    const data = buildAppFixture('sample');
    expect(data.brief.inputManifest.status).toBe('available');
    expect(data.briefs[0].filename).toBe('brief-2026-07-24-01.md');
    const response = await fetch(origin + data.brief.inputManifest.url);
    expect(response.status).toBe(200);
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      synthetic: true, filename: data.briefs[0].filename, outputSha256: sha256(MARKETING_BRIEF),
      providerAttempts: [], modelUsed: 'synthetic-fixture',
      publicationValidation: { valid: true, hardFail: false, trustFail: false, partial: false },
    });
    expect(manifest.judgmentEvidence).toHaveLength(3);
    expect(manifest.grounding.sources).toHaveLength(3);
    expect(data.headlines.headlines[0].evidence[0].sourceId).toMatch(/^src_[a-f0-9]{64}$/);
    expect(data.ready.version).toBe('1.1.0');
  });

  test('reports an empty read-only generation status without implying a model run', async () => {
    const response = await fetch(origin + '/api/brief/status?scenario=sample');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ persistence: 'ok', active: false, latest: null, synthetic: true });
  });

  test('serves complete degraded readiness with HTTP 503 and permits recovery', async () => {
    const degraded = await fetch(origin + '/api/ready?scenario=health-degraded');
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toMatchObject({ status: 'degraded', pipeline: { stale: true }, database: { status: 'growing' } });
    expect((await fetch(origin + '/api/ready?scenario=health-unavailable')).status).toBe(502);
    const recovered = await fetch(origin + '/api/ready?scenario=health-healthy');
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'ok', pipeline: { stale: false }, configReloadError: null });
  });

  test('rejects every write including generation, key verification, and settings', async () => {
    for (const route of ['/api/brief', '/api/settings', '/api/settings/verify']) {
      const response = await fetch(origin + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(405);
      expect((await response.json()).error).toContain('no writes or provider calls');
    }
  });
});

describe('KEV visual renderer', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-12T12:00:00-05:00'));
  });

  afterAll(() => jest.useRealTimers());

  test('renders the deterministic one-row composition with worst-case content', () => {
    const fixture = buildFixtureData(new Date('2026-07-12T12:00:00-05:00'))['kev-one'];
    const html = renderKevSection(fixture);
    expect(html).toContain('row-count-1');
    expect((html.match(/class="nb-led-row"/g) || [])).toHaveLength(1);
    expect(html).toContain('CVE-2026-123456');
    expect(html).toContain('Remote Operations Management');
    expect(html).toContain('today (UTC)');
    expect(html).toContain('<small>Added</small>2026-07-12 (UTC)');
    expect(html).not.toContain('Known exploited');
  });

  test('KEV fixtures and absolute row dates use the same UTC day across local midnight boundaries', () => {
    const lateChicago = new Date('2026-07-12T23:30:00-05:00');
    const fixtures = buildFixtureData(lateChicago);
    const recent = fixtures['kev-six'].recent;
    expect(recent[0].dateAdded).toBe('2026-07-13');
    expect(recent[2].dateAdded).toBe('2026-07-12');
    const html = renderKevSection(fixtures['kev-one']);
    expect(html).toContain('today (UTC)');
    expect(html).toContain('<small>Added</small>2026-07-13 (UTC)');
    expect(html).not.toContain('yesterday');
  });

  test('KEV rows reject invalid calendar dates instead of printing a normalized future date', () => {
    const html = renderKevRecent({ cve: 'CVE-2026-123456', dateAdded: '2026-02-31' });
    expect(html).toContain('Date not listed');
    expect(html).not.toContain('2026-03-03');
  });

  test('suppresses unusable KEV records and keeps an identifiable partial record readable', () => {
    const fixture = buildFixtureData(new Date('2026-07-12T12:00:00-05:00'))['kev-missing'];
    const html = renderKevSection(fixture);
    expect(html).toContain('No identifiable KEV additions are available.');
    expect(html).not.toContain('Check whether');
    expect(html).not.toContain('added today');
    const partial = renderKevSection({ recent: [{ cve: 'CVE-2026-123456' }] });
    expect(partial).toContain('CVE-2026-123456');
    expect(partial).toContain('Date not listed');
    expect(partial).not.toContain('Vendor not listed');
  });

  test('escapes untrusted KEV fields and caps the live page at six rows', () => {
    const unsafe = { cve: '<script>x</script>', vendor: '<b>V</b>', product: '<img>', name: '<em>N</em>' };
    const row = renderKevRecent(unsafe);
    expect(row).not.toContain('<script>');
    expect(row).not.toContain('<img>');
    expect(row).toContain('&lt;script&gt;');

    const html = renderKevSection({ recent: Array.from({ length: 7 }, (_, i) => ({ cve: `CVE-2026-${1000 + i}` })) });
    expect((html.match(/class="nb-led-row"/g) || [])).toHaveLength(6);
    expect(html).toContain('row-count-6');
  });

  test('distinguishes a full catalog weekly count from the capped snapshot preview', () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({ cve: `CVE-2026-${1000 + i}` }));
    const html = renderKevSection({ added7d: 10, recent });
    expect(html).toContain('Catalog total · 10 additions in the past 7 days');
    expect(html).toContain('Preview · 6 of the 8 newest catalog entries in this snapshot');
    expect(renderKevSection({ recent })).not.toContain('in the past 7 days');
    expect(renderKevSection({ added7d: 0, recent })).toContain('Catalog total · 0 additions in the past 7 days');
  });

  test('includes a deterministic six-row density fixture for 720p QA', () => {
    const fixture = buildFixtureData(new Date('2026-07-12T12:00:00-05:00'))['kev-six'];
    const html = renderKevSection(fixture);
    expect((html.match(/class="nb-led-row"/g) || [])).toHaveLength(6);
    expect(html).toContain('row-count-6');
  });
});

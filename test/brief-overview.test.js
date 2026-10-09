import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  overviewModel, renderOverview, recentDevelopmentsModel,
  renderRecentDevelopments, mountRecentDevelopments,
} from '../public/modules/briefing/brief-overview.js';

const SAVED_BRIEF = {
  filename: 'brief-2026-09-04-02.md', generatedAt: '2026-09-04T12:15:00Z',
  content: `# BlueTeam.News
### Threat Landscape Briefing · 2026-09-04

**Synthetic exercise.** The exposure and ownership questions remain unresolved.

## BLUF
The saved edition concerns the fictional gateway, not today's newest report.

## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Gateway exposure requires verification
**Assessment:** A corrected build is available, but deployment breadth remains unknown.
**Confidence:** Likely (55–80%) — the vendor confirms the build; independent deployment evidence remains unavailable.
**What happened:** The [Saved vendor advisory](https://saved.example/gateway) describes the corrected build.
**Recommended actions:**
- **Act now:** Infrastructure — verify installed versions — recommended target September 5, 2026.
**Decision window:** Current shift.
**The line:** Verify the build before approving service return.

### Signal 2 — [Horizon 2] Ownership needs an evidence trail
**Assessment:** Fragmented records may slow response.
**Confidence:** High for the existence of separate records; Moderate for response impact — impact has not been measured.
**What happened:** The [Saved exercise report](https://saved.example/exercise) records separate ownership systems.
**The line:** Establish one evidence owner.

## DEVELOPING SITUATIONS
### Fictional recovery check
**Trajectory:** Uncertain — no completed recovery evidence.
**Watch criteria:** Escalate if the signed recovery record is still unavailable at handoff.
`,
};

function reporting(overrides = {}) {
  return {
    generatedAt: '2026-09-06T12:00:00Z', refreshMinutes: 5,
    headlines: [{ title: 'New report from the live source', source: 'Live publisher',
      link: 'https://live.example/new-report', date: '2026-09-06T11:55:00Z' }],
    ...overrides,
  };
}

const assessmentCards = html => [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(match => match[1]);

describe('saved overview identity and authored meaning', () => {
  test('uses only verified presentation entries that match the current authored heading, retaining the full qualification', () => {
    const originalTitle = overviewModel(SAVED_BRIEF).judgments[0].title;
    const presentation = { status: 'reviewed', judgments: [{ index: 0, originalTitle, title: 'Reviewed display title', summary: 'Reviewed short summary.', condition: 'Only if this build is deployed.' }] };
    const brief = { ...SAVED_BRIEF, review: { presentation } };
    const html = renderOverview(brief);
    expect(html).toContain('Reviewed display title');
    expect(html).toContain('Reviewed short summary.');
    expect(html).toContain('Only if this build is deployed.');
    expect(html).toContain('Full assessment and qualifications');
    expect(html).toContain('A corrected build is available, but deployment breadth remains unknown.');
    expect(renderOverview({ ...brief, review: { presentation: { ...presentation, status: 'unavailable' } } })).not.toContain('Reviewed short summary.');
    expect(renderOverview({ ...brief, content: brief.content.replace(originalTitle, 'A changed heading') })).not.toContain('Reviewed short summary.');
  });

  test('opens with the reviewed edition lead and binds developing summaries to their authored topic', () => {
    const topic = overviewModel(SAVED_BRIEF).developing[0];
    const presentation = { status: 'reviewed', bluf: 'The reviewed lead identifies the unresolved exposure decision.',
      developing: [{ index: 0, originalTitle: topic.name, title: 'Recovery evidence remains outstanding',
        summary: 'Recovery remains unconfirmed.', condition: 'Escalate if the signed recovery record is unavailable at handoff.' }] };
    const brief = { ...SAVED_BRIEF, review: { presentation } };
    const html = renderOverview(brief);
    expect(html.indexOf(presentation.bluf)).toBeLessThan(html.indexOf('id="overview-judgment-1"'));
    expect(html).toContain('Recovery evidence remains outstanding');
    expect(html).toContain('Recovery remains unconfirmed.');
    expect(html).toContain('Escalate if the signed recovery record is unavailable at handoff.');
    const unavailable = renderOverview({ ...brief, review: { presentation: { ...presentation, status: 'unavailable' } } });
    expect(unavailable).not.toContain(presentation.bluf);
    expect(unavailable).toContain('The saved edition concerns the fictional gateway,');
    expect(unavailable).toContain('Uncertain — no completed recovery evidence.');
    const changed = renderOverview({ ...brief, content: brief.content.replace(topic.name, 'A different recovery topic') });
    expect(changed).not.toContain('Recovery evidence remains outstanding');
    expect(changed).not.toContain('Recovery remains unconfirmed.');
    expect(changed).toContain('Uncertain — no completed recovery evidence.');
  });

  test('shows the absolute assessment date and age independently of current reporting', () => {
    const html = renderOverview(SAVED_BRIEF, { now: Date.parse('2026-10-09T16:00:00Z') });
    expect(html).toContain('Assessment from Sep 4, 2026, 12:15 UTC');
    expect(html).toContain('35 days old');
    const withoutTime = renderOverview({ ...SAVED_BRIEF, generatedAt: undefined }, { now: Date.parse('2026-09-05T00:00:00Z') });
    expect(withoutTime).toContain('Assessment from Sep 4, 2026 · brief 2');
    expect(withoutTime).toContain('1 day old');
    expect(withoutTime).not.toContain('00:00 UTC');
    const undated = renderOverview({ content: SAVED_BRIEF.content }, { now: Date.parse('2026-10-09T16:00:00Z') });
    expect(undated).toContain('Assessment date unavailable');
    expect(undated).not.toContain('days old');
    const future = renderOverview(SAVED_BRIEF, { now: Date.parse('2026-09-03T16:00:00Z') });
    expect(future).not.toContain('days old');
  });

  test('an over-budget unreviewed assessment is disclosed whole, never clipped into a potentially unqualified claim', () => {
    const passage = `${'The scope remains unverified. '.repeat(24)}Only apply this recommendation after confirming the affected version.`;
    const brief = { ...SAVED_BRIEF, content: SAVED_BRIEF.content.replace('A corrected build is available, but deployment breadth remains unknown.', passage) };
    const html = renderOverview(brief);
    expect(html).toContain(passage);
    expect(html).not.toContain('scope remains unverified…');
  });

  test('keeps saved titles, sources, publication and anchors independent of newer reporting', () => {
    const before = JSON.stringify(SAVED_BRIEF);
    const model = overviewModel(SAVED_BRIEF);
    expect(model.publication).toBe('Briefing published Sep 4, 2026, 12:15 UTC');
    expect(model.judgments.map(story => story.anchor)).toEqual(['judgment-1', 'judgment-2']);
    expect(model.judgments[0].claim).toBe('A corrected build is available, but deployment breadth remains unknown.');
    expect(model.judgments[0].citations).toEqual([{ label: 'Saved vendor advisory', url: 'https://saved.example/gateway' }]);
    const recent = renderRecentDevelopments(recentDevelopmentsModel(reporting(), Date.parse('2026-09-06T12:01:00Z')));
    expect(recent).toContain('Live publisher');
    const saved = renderOverview(SAVED_BRIEF);
    expect(saved).toContain('href="/briefing/brief-2026-09-04-02.md#judgment-1"');
    expect(saved).toContain('href="https://saved.example/gateway"');
    expect(saved).not.toContain('Live publisher');
    expect(saved).not.toContain('2026-09-06T11:55');
    expect(JSON.stringify(SAVED_BRIEF)).toBe(before);
  });

  test('uses resolved saved DOM sources when the authored edition uses reference-style links', () => {
    const brief = { ...SAVED_BRIEF, content: SAVED_BRIEF.content
      .replace('[Saved vendor advisory](https://saved.example/gateway)', '[Saved vendor advisory][vendor]')
      + '\n[vendor]: https://saved.example/gateway\n' };
    expect(overviewModel(brief).judgments[0].citations).toEqual([]);
    const html = renderOverview(brief, { judgmentMetadata: [{ sources: [{
      label: 'Resolved saved vendor advisory', href: 'https://saved.example/gateway',
    }] }] });
    expect(html).toContain('href="https://saved.example/gateway"');
    expect(html).toContain('Resolved saved vendor advisory');
    expect(html).toContain('independent deployment evidence remains unavailable');
  });

  test('preserves likelihood, mixed confidence, complete qualifications and the preface', () => {
    const model = overviewModel(SAVED_BRIEF);
    expect(model.preface).toBe('Synthetic exercise. The exposure and ownership questions remain unresolved.');
    expect(model.judgments[0].certainty.label).toBe('Likelihood');
    expect(model.judgments[0].certainty.text).toContain('independent deployment evidence remains unavailable');
    const html = renderOverview(SAVED_BRIEF);
    expect(html).toContain('<span>Likelihood</span>');
    expect(html).toContain('Likely (55–80%) — the vendor confirms the build; independent deployment evidence remains unavailable.');
    expect(html).toContain('High for the existence of separate records; Moderate for response impact — impact has not been measured.');
    expect(html).toContain('Synthetic exercise. The exposure and ownership questions remain unresolved.');
    expect(model.developing[0].watch).toBe('Escalate if the signed recovery record is still unavailable at handoff.');
    const mixed = assessmentCards(html)[1];
    expect(mixed.indexOf('High for the existence of separate records; Moderate for response impact — impact has not been measured.'))
      .toBeLessThan(mixed.indexOf('<details'));
    expect(mixed.match(/High for the existence of separate records; Moderate for response impact — impact has not been measured\./g)).toHaveLength(1);
    const single = assessmentCards(html)[0];
    expect(single.indexOf('independent deployment evidence remains unavailable')).toBeLessThan(single.indexOf('<details'));
  });

  test('keeps missing confidence explicit without filling unavailable metadata from dated sources', () => {
    const brief = { ...SAVED_BRIEF, content: SAVED_BRIEF.content.replace(/^\*\*Confidence:\*\*[^\n]*\n/gm, '') };
    const html = renderOverview(brief);
    expect(html).toContain('<span>Confidence</span> Not assessed');
    expect(html).not.toContain('data-field="severity"');
    expect(html).not.toContain('data-field="time"');
    expect(html).not.toContain('data-level="danger"');
    expect(html).not.toContain('High confidence');
  });

  test('bounds a preface before the first section even with a suffixed or absent BLUF heading', () => {
    const suffixed = { ...SAVED_BRIEF, content: SAVED_BRIEF.content.replace('## BLUF', '## BLUF — September 4') };
    expect(overviewModel(suffixed).preface).toBe('Synthetic exercise. The exposure and ownership questions remain unresolved.');
    const noBluf = { ...SAVED_BRIEF, content: SAVED_BRIEF.content.replace(/## BLUF\n[^]*?(?=## KEY JUDGMENTS)/, '') };
    expect(overviewModel(noBluf).preface).toBe('Synthetic exercise. The exposure and ownership questions remain unresolved.');
  });

  test('fallback summary retains sources across the complete BLUF and does not invent a lead assessment', () => {
    const brief = { filename: SAVED_BRIEF.filename, content: `# BlueTeam.News
## BLUF — September 4
The [first saved report](https://saved.example/first) establishes the observation.

The [later source note](https://saved.example/later) qualifies its scope.

## DEVELOPING SITUATIONS
### Awaiting additional evidence
**Watch criteria:** Wait for a named source to establish scope.
` };
    const model = overviewModel(brief);
    expect(model.judgments).toEqual([]);
    expect(model.blufSources.map(source => source.url)).toEqual(['https://saved.example/first', 'https://saved.example/later']);
    const html = renderOverview(brief);
    expect(html).toContain('Edition summary');
    expect(html).not.toContain('Lead assessment');
    expect(html).toContain('href="https://saved.example/first"');
    expect(html).toContain('href="https://saved.example/later"');
    expect(html).toContain('href="/briefing/brief-2026-09-04-02.md?view=report"');
  });

  test('retains complete authored actions in the model and saved source while leaving response detail to the report', () => {
    const content = SAVED_BRIEF.content.replace(
      '- **Act now:** Infrastructure — verify installed versions — recommended target September 5, 2026.',
      '- **Act now:** Infrastructure — isolate the fictional gateway — recommended target September 5, 2026.\n  **Condition:** Only if the retained advisory confirms this build is affected.\n  **Dependencies:** Incident command approval before isolation.',
    );
    const brief = { ...SAVED_BRIEF, content };
    const before = JSON.stringify(brief);
    const model = overviewModel(brief);
    expect(model.judgments[0].action).toContain('Only if the retained advisory confirms this build is affected.');
    expect(model.judgments[0].action).toContain('Incident command approval before isolation.');
    expect(model.judgments[0].actions[0].condition).toBe('Only if the retained advisory confirms this build is affected.');
    expect(model.judgments[0].actions[0].dependencies).toBe('Incident command approval before isolation.');
    const html = renderOverview(brief);
    expect(html).not.toContain('isolate the fictional gateway');
    expect(html).not.toContain('Incident command approval before isolation.');
    expect(html).toContain('href="/briefing/brief-2026-09-04-02.md#judgment-1"');
    expect(JSON.stringify(brief)).toBe(before);
  });

  test('presents assessed implications without response blocks, decision windows or a numbered index', () => {
    const html = renderOverview(SAVED_BRIEF);
    const cards = assessmentCards(html);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('A corrected build is available, but deployment breadth remains unknown.');
    expect(cards[1]).toContain('Fragmented records may slow response.');
    expect(cards[1]).not.toContain('Establish one evidence owner.');
    expect(html).not.toContain('Infrastructure — verify installed versions — recommended target September 5, 2026.');
    expect(html).not.toContain('First response');
    expect(html).not.toContain('First action');
    expect(html).not.toContain('Decision window');
    expect(html).not.toContain('Current shift.');
    expect(html).not.toContain('data-overview-jump');
    expect(html).not.toContain('aria-label="In this edition"');
    expect(html).not.toMatch(/>Assessment \d+</);
  });

  test('keeps later assessments linked to their complete report without copying their action plans', () => {
    const content = SAVED_BRIEF.content.replace(
      '**The line:** Establish one evidence owner.',
      '**Recommended actions:**\n- **Act now:** Incident response — reconcile the ownership record — recommended target September 7, 2026.\n  **Condition:** Only if both teams confirm the record is incomplete.\n  **Dependencies:** Preserve both original logs before reconciliation.\n- **Operations** — schedule a later exercise.\n**Decision window:** Within 7 days\n**The line:** Establish one evidence owner.',
    );
    const brief = { ...SAVED_BRIEF, content };
    const before = JSON.stringify(brief);
    const model = overviewModel(brief);
    const cards = assessmentCards(renderOverview(brief));
    expect(cards[0]).not.toContain('verify installed versions');
    expect(cards[1]).not.toContain('reconcile the ownership record');
    expect(cards[1]).not.toContain('Within 7 days');
    expect(cards[1]).not.toContain('schedule a later exercise');
    expect(cards[1]).toContain('href="/briefing/brief-2026-09-04-02.md#judgment-2"');
    expect(model.judgments[1].actions).toHaveLength(2);
    expect(model.judgments[1].action).toContain('Only if both teams confirm the record is incomplete.');
    expect(model.judgments[1].action).toContain('Preserve both original logs before reconciliation.');
    expect(model.judgments[1].decision).toBe('Within 7 days');
    expect(JSON.stringify(brief)).toBe(before);
  });

  test('falls back to the authored line and then what happened when an assessment field is absent', () => {
    const withoutAssessment = SAVED_BRIEF.content.replace('**Assessment:** Fragmented records may slow response.\n', '');
    expect(assessmentCards(renderOverview({ ...SAVED_BRIEF, content: withoutAssessment }))[1])
      .toContain('Establish one evidence owner.');
    const withoutLine = withoutAssessment.replace('**The line:** Establish one evidence owner.\n', '');
    expect(assessmentCards(renderOverview({ ...SAVED_BRIEF, content: withoutLine }))[1])
      .toContain('The Saved exercise report records separate ownership systems.');
  });

  test('retains unique overview anchors and correct report destinations in authored order, including duplicate titles', () => {
    const duplicate = SAVED_BRIEF.content.replace('Ownership needs an evidence trail', 'Gateway exposure requires verification');
    const html = renderOverview({ ...SAVED_BRIEF, content: duplicate });
    const targets = [...html.matchAll(/<h2\b[^>]*id="(overview-judgment-\d+)"/g)].map(match => match[1]);
    expect(targets).toEqual(['overview-judgment-1', 'overview-judgment-2']);
    expect(new Set(targets).size).toBe(targets.length);
    const cards = assessmentCards(html);
    expect(cards).toHaveLength(targets.length);
    cards.forEach((card, index) => {
      expect(card).toMatch(new RegExp(`<h2\\b[^>]*id="${targets[index]}"`));
      expect(card).toContain(`href="/briefing/${SAVED_BRIEF.filename}#judgment-${index + 1}"`);
      expect((html.match(new RegExp(`\\bid="${targets[index]}"`, 'g')) || [])).toHaveLength(1);
    });
    expect(cards[0]).toContain('deployment breadth remains unknown');
    expect(cards[1]).toContain('Fragmented records may slow response');
    expect(cards[0]).toContain('Featured story');
    expect(cards[1]).not.toContain('Featured story');
    expect(html.indexOf('aria-label="More stories from this edition"')).toBeGreaterThan(html.indexOf('id="overview-judgment-1"'));
  });

  test('keeps the edition note and authored assessment order before watching topics and current reporting', () => {
    const html = renderOverview(SAVED_BRIEF);
    const summary = html.indexOf('The saved edition concerns the fictional gateway,');
    const feature = html.indexOf('id="overview-judgment-1"');
    const supporting = html.indexOf('id="overview-judgment-2"');
    const watch = html.indexOf('Fictional recovery check');
    const current = html.indexOf('aria-label="Recent developments"');
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(feature).toBeGreaterThanOrEqual(0);
    expect(summary).toBeLessThan(feature);
    expect(supporting).toBeGreaterThan(feature);
    expect(supporting).toBeGreaterThan(summary);
    expect(watch).toBeGreaterThan(supporting);
    expect(current).toBeGreaterThan(watch);
  });

  test('surfaces watching topics with their complete authored trajectory and escalation criteria', () => {
    const html = renderOverview(SAVED_BRIEF);
    const criterion = 'Escalate if the signed recovery record is still unavailable at handoff.';
    expect(html).toContain('Fictional recovery check');
    expect(html).toContain('Read watch criteria');
    expect(html).toContain(criterion);
    expect(html).toContain('Uncertain — no completed recovery evidence.');
    expect(overviewModel(SAVED_BRIEF).developing[0].watch).toBe(criterion);
    const watchLink = /<a\b[^>]*href="([^"]+)"[^>]*>Read watch criteria/.exec(html);
    expect(watchLink).not.toBeNull();
    expect(watchLink[1]).toBe('/briefing/brief-2026-09-04-02.md?view=report');
    const withAnchor = renderOverview(SAVED_BRIEF, { developingAnchor: 'section-7-developing-situations-retained' });
    const anchoredLink = /<a\b[^>]*href="([^"]+)"[^>]*>Read watch criteria/.exec(withAnchor);
    expect(anchoredLink?.[1]).toBe('/briefing/brief-2026-09-04-02.md#section-7-developing-situations-retained');
  });

  test('a missing summary remains explicit and does not prevent reading any saved assessment', () => {
    const brief = { ...SAVED_BRIEF, content: SAVED_BRIEF.content.replace(/## BLUF\n[^]*?(?=## KEY JUDGMENTS)/, '') };
    const html = renderOverview(brief);
    expect(html).toContain('No edition summary recorded.');
    expect(assessmentCards(html)).toHaveLength(2);
    expect(html).toContain('href="/briefing/brief-2026-09-04-02.md?view=report"');
  });

  test('keeps approved summaries complete and original qualifications inside one evidence disclosure per card', () => {
    const summary = `${'The scope remains conditional. '.repeat(20)}Only proceed after affected deployment is confirmed.`;
    const judgments = overviewModel(SAVED_BRIEF).judgments.map((story, index) => ({
      index, originalTitle: story.title, title: story.title,
      summary: index === 0 ? summary : 'Ownership impact remains unmeasured.',
      condition: 'Confirm local applicability before acting.',
    }));
    const cards = assessmentCards(renderOverview({ ...SAVED_BRIEF, review: { presentation: { status: 'reviewed', judgments } } }));
    cards.forEach((card, index) => {
      const details = [...card.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)];
      expect(details).toHaveLength(1);
      expect(details[0][1]).toContain('Full assessment and qualifications');
      expect(details[0][1]).toContain(overviewModel(SAVED_BRIEF).judgments[index].claim);
      expect(card.indexOf('Confirm local applicability before acting.')).toBeLessThan(card.indexOf('<details'));
      const reportLinks = [...card.matchAll(/<a\b(?=[^>]*\bdata-overview-open\b)[^>]*href="([^"]+)"[^>]*>/g)];
      expect(reportLinks).toHaveLength(2);
      expect(reportLinks.map(link => link[1])).toEqual(Array(2).fill(`/briefing/${SAVED_BRIEF.filename}#judgment-${index + 1}`));
      expect(card).toMatch(/<h2\b[^>]*><a\b[^>]*data-overview-open/);
    });
    expect(cards[0]).toContain(summary);
    expect(cards[0].indexOf(summary)).toBeLessThan(cards[0].indexOf('<details'));
    expect(cards[0]).toContain('independent deployment evidence remains unavailable.');
    expect(cards[1]).toContain('impact has not been measured.');
  });

  test('renders edition and live-report strings as text and preserves only safe source destinations', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const brief = { ...SAVED_BRIEF, warnings: ['<script>alert(1)</script>'],
      content: SAVED_BRIEF.content.replace('Gateway exposure requires verification', malicious)
        .replace('Saved vendor advisory', '<svg onload=alert(1)>')
        .replace('https://saved.example/gateway', 'https://name:secret@saved.example/gateway') };
    const html = renderOverview(brief);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('alert(1)&lt;/script&gt;'); // edition diagnostics belong to the shared record
    expect(html).not.toMatch(/<(?:img|script|svg)\b/i);
    expect(html).not.toContain('name:secret');
    const recent = renderRecentDevelopments(recentDevelopmentsModel(reporting({ headlines: [{
      title: malicious, source: '<script>publisher</script>', link: 'javascript:alert(1)', dateUnknown: true,
    }] })));
    expect(recent).not.toMatch(/<(?:img|script|svg)\b/i);
    expect(recent).toContain('href="/wire?signal=javascript%3Aalert(1)"');
    expect(recent).toContain('&lt;script&gt;publisher&lt;/script&gt;');
  });
});

describe('current reporting chronology', () => {
  test('sorts known publication times newest first and keeps unknowns stable after them', () => {
    const model = recentDevelopmentsModel(reporting({ headlines: [
      { title: 'Unknown original', date: '2026-09-06T13:00:00Z', dateUnknown: true },
      { title: 'Earlier', date: '2026-09-06T10:00:00Z' },
      { title: 'Latest', date: '2026-09-06T11:00:00Z' },
      { title: 'Same time', date: '2026-09-06T11:00:00Z' },
      { title: 'Unparseable', date: 'not a date' },
      { title: '  ', date: '2026-09-06T12:00:00Z' },
    ] }), Date.parse('2026-09-06T12:01:00Z'));
    expect(model.items.map(item => item.title)).toEqual(['Latest', 'Same time', 'Earlier', 'Unknown original', 'Unparseable']);
    expect(model.items[3].published).toBeNull();
    const html = renderRecentDevelopments(model);
    expect(html.match(/Publication time unknown/g)).toHaveLength(2);
    expect(html).toContain('datetime="2026-09-06T11:00:00.000Z"');
  });

  test('derives staleness from the collection clock, never from report publication', () => {
    const payload = reporting({ headlines: [{ title: 'Old publication', date: '2020-01-01T00:00:00Z' }] });
    expect(recentDevelopmentsModel(payload, Date.parse('2026-09-06T12:19:00Z')).stale).toBe(false);
    expect(recentDevelopmentsModel(payload, Date.parse('2026-09-06T12:21:00Z')).stale).toBe(false);
    expect(recentDevelopmentsModel(payload, Date.parse('2026-09-06T14:01:00Z')).stale).toBe(true);
    expect(recentDevelopmentsModel({ headlines: [], ageSeconds: null }).stale).toBe(true);
    expect(recentDevelopmentsModel({ headlines: [], ageSeconds: '' }).stale).toBe(true);
  });

  test('does not turn expanded retention into a publisher wording change', () => {
    const model = recentDevelopmentsModel(reporting({ headlines: [{ title: 'Expanded retained source',
      date: '2026-09-06T11:00:00Z', evidence: [{ changed: true, changeKind: 'capture-expanded' }] }] }));
    const html = renderRecentDevelopments(model);
    expect(html).not.toContain('Retained wording changed');
    expect(html).toMatch(/(?:More source context retained|Retained source changed)/);
  });
});

function hostFixture() {
  const listeners = new Map();
  const focus = {};
  const host = {
    innerHTML: 'Initial content', ownerDocument: { activeElement: null },
    contains: element => element === focus,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  return { host, focus, listeners };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('recent-report lifecycle', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-09-06T12:19:00Z')); });
  afterEach(() => { jest.useRealTimers(); });

  test('ages a retained collection on later polls and preserves its reporting after a failed refresh', async () => {
    jest.setSystemTime(new Date('2026-09-06T13:59:00Z'));
    const { host } = hostFixture();
    const fetchRecent = jest.fn().mockResolvedValue(reporting());
    const dispose = mountRecentDevelopments(host, fetchRecent);
    await flush();
    expect(host.innerHTML).toContain('Latest collected reporting');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(host.innerHTML).toContain('Collection is stale');
    fetchRecent.mockRejectedValueOnce(new Error('offline'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(host.innerHTML).toContain('Refresh unavailable · showing previous reporting');
    expect(host.innerHTML).toContain('New report from the live source');
    expect(host.innerHTML).toContain('data-recent-retry');
    dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('disposal removes refresh listeners and prevents an in-flight response from repainting a new view', async () => {
    const { host, listeners } = hostFixture();
    let resolve;
    const fetchRecent = jest.fn(() => new Promise(done => { resolve = done; }));
    const dispose = mountRecentDevelopments(host, fetchRecent);
    dispose();
    host.innerHTML = 'Replacement view';
    resolve(reporting());
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(host.innerHTML).toBe('Replacement view');
    expect(fetchRecent).toHaveBeenCalledTimes(1);
    expect(listeners.has('click')).toBe(false);
  });

  test('does not replace a link or button while the reader holds keyboard focus in the region', async () => {
    const { host, focus } = hostFixture();
    const fetchRecent = jest.fn().mockResolvedValue(reporting());
    host.ownerDocument.activeElement = focus;
    const dispose = mountRecentDevelopments(host, fetchRecent);
    await flush();
    expect(fetchRecent).not.toHaveBeenCalled();
    expect(host.innerHTML).toBe('Initial content');
    host.ownerDocument.activeElement = null;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(host.innerHTML).toContain('New report from the live source');
    dispose();
  });
});

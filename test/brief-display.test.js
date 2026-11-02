import { test, expect } from '@jest/globals';
import { createHash } from 'node:crypto';
import { captureBriefDisplay, verifiedBriefDisplay, displayProse } from '../lib/brief-display.js';
import { capturedCitationTokens } from '../lib/brief-citations.js';
import { assembleBrief } from '../lib/brief-assembly.js';
import { parseBrief, storyDisplay, STORY_OPENING_CONTRACT } from '../lib/brief-schema.js';
import { overviewModel, overviewPassage, renderOverview } from '../public/modules/briefing/brief-overview.js';
import { buildPresentationPages, buildGlanceModel } from '../public/modules/wall/wall-presentation.js';
import { applyBriefReview } from '../lib/brief-review.js';
import { buildUserPrompt } from '../lib/prompts.js';
import { publicationDecision } from '../lib/validation.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const grounding = { members: [
  { id: 'S1.1', label: 'Vendor', date: '2026-11-02', url: 'https://vendor.test/update' },
  { id: 'CISA-KEV', label: 'CISA', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' },
  { id: 'S2.1', label: 'Researcher', date: '2026-11-02', url: '' },
] };
const raw = `# Synthetic briefing
## TODAY'S PICTURE
Exposure determines the significance of this update. [CISA-KEV]
## PRIORITY STORIES
### Gateway update closes a remaining route
The vendor's update closes a second route on exposed gateways. [S1.1] Local exposure is unconfirmed, and updating does not establish whether prior access occurred. [CISA-KEV]

The supporting report identifies CVE-2026-12345. Follow the [affected configuration](https://vendor.test/configuration), whose prerequisites differ from the other issue. [S1.1]

The researcher has not independently confirmed prevalence. [S2.1]
`;
const content = assembleBrief(raw, { groundingManifest: grounding, briefFormatVersion: 2 }).content;
const displayCopy = captureBriefDisplay(content, grounding, STORY_OPENING_CONTRACT);
const brief = { content, presentation: { displayCopy } };

test('one authored opening serves Overview and Wall without copying support paragraphs or inventing review', () => {
  const story = overviewModel(brief).judgments[0];
  const html = overviewPassage(story);
  const page = buildPresentationPages({ ...parseBrief(content), presentation: brief.presentation }, {}).find(page => page.kind === 'judgment');
  const glance = buildGlanceModel(page);
  expect(story.display.provenance).toBe('authored-opening');
  expect(glance.summary).toBe(story.display.summary);
  expect(html).toContain('Local exposure is unconfirmed');
  expect(glance.summary).toContain('does not establish whether prior access occurred');
  expect(html).not.toContain('CVE-2026-12345');
  expect(glance.summary).not.toContain('Vendor, 2026');
  expect(glance.summary).not.toContain('CISA KEV catalog');
  expect(page.cves).toEqual(['CVE-2026-12345']);
  expect(page.citations).toEqual(parseBrief(content).stories[0].citations);
  expect(content).toContain('CVE-2026-12345');
  expect(content).toContain('[Vendor, 2026-11-02]');
  expect(brief.review).toBeUndefined();
  expect(story.display.fullParagraphs.at(-1)).not.toContain('[Researcher');
});

test('real reviewed summaries retain their separate material condition on both surfaces', () => {
  const originalTitle = parseBrief(content).stories[0].title;
  const summary = 'A corrected build is available.';
  const condition = 'Only deployments with remote access enabled are affected.';
  const applied = applyBriefReview(content, { schemaVersion: 1, originalSha256: hash(content), corrections: [],
    presentation: { schemaVersion: 1, contentSha256: hash(content), reviewer: 'Synthetic reviewer', reviewedAt: '2026-11-02T12:00:00Z',
      bluf: 'Exposure remains conditional.', judgments: [{ index: 0, originalTitle, title: 'Gateway update', summary, condition }], developing: [] } });
  const reviewed = { ...brief, review: applied.review };
  const html = overviewPassage(overviewModel(reviewed).judgments[0]);
  const page = buildPresentationPages({ ...parseBrief(content), ...{ review: applied.review, presentation: brief.presentation } }, {}).find(page => page.kind === 'judgment');
  expect(html).toContain(summary);
  expect(html).toContain(condition);
  expect(buildGlanceModel(page).summary).toBe(`${summary}\n\n${condition}`);
  expect(applied.reviewedContent).toBe(content);
});

test('old editions and edited copies fall back without publication gates or arbitrary first-paragraph truncation', () => {
  expect(captureBriefDisplay(content, grounding)).toBeNull();
  expect(verifiedBriefDisplay(content, displayCopy)).toBe(displayCopy);
  const changed = content.replace('Local exposure is unconfirmed', 'Only the management interface is affected');
  expect(verifiedBriefDisplay(changed, displayCopy)).toBeNull();
  const changedStory = parseBrief(changed).stories[0];
  expect(storyDisplay(changedStory, 0, brief).provenance).toBe('full');
  expect(overviewPassage(overviewModel({ content }).judgments[0])).toContain('CVE-2026-12345');
  expect(publicationDecision({ issues: [], displayCopy: null }).canPublish).toBe(true);
  expect(verifiedBriefDisplay(content, { ...displayCopy, stories: [null] })).toBeNull();
});

test('citation projection removes only exact captured bibliography after a sentence, preserving semantic links', () => {
  const tokens = capturedCitationTokens(grounding);
  expect(displayProse('A fix exists. [Vendor, 2026-11-02](https://vendor.test/update) Deployment remains unknown.', tokens))
    .toBe('A fix exists. Deployment remains unknown.');
  expect(displayProse('The source is [Vendor, 2026-11-02](https://vendor.test/update).', tokens)).toContain('The source is Vendor');
  expect(displayProse('A fix exists. [Vendor, 2026-11-02](https://vendor.test/update) says exposure remains unknown.', tokens)).toContain('Vendor, 2026-11-02 says');
  expect(displayProse('Example: `Fact. [Vendor, 2026-11-02](https://vendor.test/update)`', tokens)).toContain('Vendor');
  expect(displayProse('Only [the affected configuration](https://vendor.test/update) is vulnerable.', tokens)).toContain('Only the affected configuration is vulnerable.');
  expect(displayProse('A source says this. [Other, 2026-11-02](https://vendor.test/update)', tokens)).toContain('Other, 2026-11-02');
  expect(parseBrief(content).stories[0].paragraphs[0]).not.toContain('CISA KEV catalog');
});

test('phone Overview starts with stories while its complete edition introduction remains expandable', () => {
  const phone = renderOverview(brief, { compactIntroduction: true });
  const desktop = renderOverview(brief, { compactIntroduction: false });
  expect(phone).toContain('<details class="brief-overview-introduction">');
  expect(desktop).toContain('<details class="brief-overview-introduction" open>');
  expect(phone).toContain('Exposure determines the significance of this update.');
  expect(phone).toContain('Local exposure is unconfirmed');
});

test('the edition cover uses the edition introduction without borrowing a story headline', () => {
  const pages = buildPresentationPages({ ...parseBrief(content), presentation: brief.presentation }, {});
  const cover = buildGlanceModel(pages[0]);
  expect(cover.headline).toBe("Today's picture");
  expect(pages[0].topic).toBe("Today's picture");
  expect(cover.summary).toBe('Exposure determines the significance of this update.');
  expect(cover.related).toContain('Gateway update closes a remaining route');
});

test('a reviewed developing summary also retains its display condition', () => {
  const doc = { developing: [{ name: 'Vendor release', trajectory: 'Uncertain', trajectoryDetail: 'Complete original passage.', watch: 'A later source update would change the assessment.' }],
    review: { presentation: { status: 'reviewed', developing: [{ index: 0, originalTitle: 'Vendor release', title: 'Release under investigation',
      summary: 'The vendor is investigating a failure.', condition: 'Only the optional module is implicated.' }] } } };
  const page = buildPresentationPages(doc, {}).find(page => page.kind === 'developing');
  expect(buildGlanceModel(page).summary).toContain('Only the optional module is implicated.');
});

test('NVD compaction retains different captures, metrics and applicability expressions', () => {
  const record = { id: 'NVD-CVE-2026-12345', title: 'NVD record', url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-12345',
    passage: 'CVSS v3.1 9.5 (Secondary) (provisional)', observationTimes: ['2026-11-02T00:00:00Z'], applicabilityPassage: 'A AND B' };
  const records = [record, { ...record }, { ...record, observationTimes: ['2026-11-01T00:00:00Z'] },
    { ...record, passage: 'CVSS v4.0 9.0 (Primary)' }, { ...record, applicabilityPassage: 'A OR B' }];
  const input = buildUserPrompt({ headlines: records.map(() => ({ horizon: 1 })), config: {}, editionContext: { date: '2026-11-02' },
    groundingManifest: { members: [], sources: records.map(nvd => ({ members: [], nvdSources: [nvd] })) } });
  expect(input.match(/Evidence ID: NVD-CVE-2026-12345/g)).toHaveLength(4);
  expect(input).toContain('identical lookup shown earlier');
  for (const expected of ['2026-11-01T00:00:00Z', 'CVSS v4.0 9.0 (Primary)', 'A OR B', 'A AND B', '(provisional)']) expect(input).toContain(expected);
});

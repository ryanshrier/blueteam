import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { canonicalArticleUrl, deduplicateWithCorroboration } from '../lib/feeds.js';
import { assessUrgency, editorialContext, headlineCves } from '../lib/intelligence-context.js';
import { applyHorizonOverrides, classifyUrgency, scoreHeadline } from '../lib/scoring.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/retained-wire-2026-09-06.json', import.meta.url), 'utf8'));
const hostnameAlias = JSON.parse(readFileSync(new URL('./fixtures/retained-publisher-alias-2026-09-06.json', import.meta.url), 'utf8'));
const row = index => fixture.selectedEvidence.find(item => item.index === index);
const members = index => row(index).groupMembers.map(member => ({ ...member, link: member.url, date: member.publishedAt,
  description: member.passage, evidence: member.sourceRevisions, horizon: row(index).horizon, weight: row(index).weight }));
const permutations = items => [items, [...items].reverse(), [...items.slice(1), items[0]]];

describe('September 6 retained publisher, article and event identities', () => {
  test('the live hostname-labeled Help Net discovery shares the resolved publisher/article, retaining both captures', () => {
    expect(hostnameAlias.members.map(item => item.source).sort()).toEqual(['Help Net Security', 'helpnetsecurity.com']);
    for (const inputs of permutations(hostnameAlias.members)) {
      const grouped = deduplicateWithCorroboration(inputs, 0.5);
      expect(grouped).toHaveLength(1);
      expect(grouped[0].corroboration).toBe(1);
      expect(grouped[0].eventIdentity).toMatchObject({ publisherCount: 1, articleCount: 1, retainedRecordCount: 2 });
      expect(grouped[0].sourceMembers).toHaveLength(2);
      expect(grouped[0].evidence).toEqual(expect.arrayContaining(hostnameAlias.members.flatMap(member => member.evidence)));
      expect(grouped[0].articleIdentities.find(article => article.basis === 'same-publisher-exact-title')?.canonicalUrl).toContain('helpnetsecurity.com/2026/09/04/');
    }
  });
  test('Rapid7 direct and unresolved discovery copies count as one publisher and one article', () => {
    for (const inputs of permutations(members(5))) {
      const result = deduplicateWithCorroboration(inputs, 0.5);
      expect(result).toHaveLength(1);
      expect(result[0].corroboration).toBe(1);
      expect(result[0].eventIdentity).toMatchObject({ publisherCount: 1, articleCount: 1, retainedRecordCount: 2, independentObservation: 'unassessed' });
      expect(result[0].sourceMembers).toHaveLength(2);
      expect(result[0].evidence).toHaveLength(2);
      expect(result[0].sourceMembers.some(member => !member.link)).toBe(true);
      expect(result[0].articleIdentities.find(article => article.basis === 'same-publisher-exact-title').canonicalUrl).toContain('rapid7.com/blog/');
    }
  });
  test('the live Chrome records keep an unidentified discovery separate and count the duplicate Help Net Security publisher once', () => {
    const result = deduplicateWithCorroboration(members(0), 0.5);
    expect(result).toHaveLength(2);
    const identified = result.find(item => headlineCves(item).length);
    expect(identified.eventIdentity).toMatchObject({ publisherCount: 4, articleCount: 4, retainedRecordCount: 5 });
    expect(identified.evidence).toHaveLength(5);
    expect(result.find(item => !headlineCves(item).length).source).toBe('Technobezz');
  });
  test('five same-day CERT-FR templates remain five distinct product advisories', () => {
    for (const inputs of permutations(members(43))) {
      const result = deduplicateWithCorroboration(inputs, 0.5);
      expect(result).toHaveLength(5);
      expect(result.every(item => item.sourceMembers.length === 1 && item.corroboration === 1)).toBe(true);
      expect(result.map(item => editorialContext(item).product).sort()).toEqual(['Curl', 'Google Chrome', 'Elastic', 'HPE Aruba Networking', 'Mozilla'].sort());
      expect(new Set(result.map(item => item.eventIdentity.eventId)).size).toBe(5);
    }
  });
  test('tracking variants share an article, while meaningful query parameters survive canonicalization', () => {
    const article = members(5)[0];
    const tracked = { ...article, link: `${article.link}/?utm_source=rss&fbclid=tracking#comments` };
    const result = deduplicateWithCorroboration([article, tracked]);
    expect(result[0].eventIdentity.articleCount).toBe(1);
    expect(canonicalArticleUrl('https://publisher.test/article?id=7&utm_source=rss')).toBe('https://publisher.test/article?id=7');
    expect(canonicalArticleUrl('https://publisher.test/article?id=8')).not.toBe(canonicalArticleUrl('https://publisher.test/article?id=7'));
    expect(canonicalArticleUrl('https://user:secret@publisher.test/article')).toBeNull();
    expect(canonicalArticleUrl('https://news.google.com/articles/opaque')).toBeNull();
  });
  test('ambiguous source labels cannot resolve an unknown article to either publisher', () => {
    const article = members(5)[0];
    const result = deduplicateWithCorroboration([
      { ...article, source: 'Shared label', link: 'https://first.test/story' },
      { ...article, source: 'Shared label', link: 'https://second.test/story' },
      { ...article, source: 'Shared label', link: '' },
    ]);
    expect(result[0].corroboration).toBe(3);
    expect(result[0].articleIdentities.find(identity => identity.basis === 'publisher-and-title').canonicalUrl).toBeNull();
  });
});

describe('current event urgency and decision context', () => {
  test('the Patch Tuesday forecast does not inherit active urgency or triage from its August statistics', () => {
    const item = members(15)[0];
    expect(item.description).toContain('confirmed actively exploited');
    expect(classifyUrgency(item)).toBe('elevated');
    expect(assessUrgency(item)).toMatchObject({ level: 'elevated', basis: 'source-title', exploitationStatus: 'not-established' });
    applyHorizonOverrides([item]);
    expect(item.horizon).toBe(row(15).horizon);
    expect(editorialContext(item).triageEligible).toBe(false);
  });
  test('StyleSmuggler remains an owned triage candidate without a CVE or KEV entry', () => {
    const item = members(16)[0];
    expect(headlineCves(item)).toEqual([]);
    expect(classifyUrgency(item)).toBe('critical');
    applyHorizonOverrides([item]);
    expect(item.horizon).toBe(1);
    const context = editorialContext(item);
    expect(context).toMatchObject({ triageEligible: true, exploitationStatus: 'reported-active', product: 'Magento and Adobe Commerce', threatChange: 'unassessed' });
    expect(context.title).toMatch(/^Magento and Adobe Commerce:/);
    expect(context.urgency.evidenceRefs).toEqual(item.evidence);
    expect(context.urgency.statement).toBe(item.title);
    expect(context.nextStep).toMatch(/Check deployment and exposure/);
    expect(context.unknowns.join(' ')).toContain('unverified');
  });
  test('a current source-lead exploitation verb works without an identifier, but denials and historical paragraphs do not', () => {
    const original = members(16)[0];
    expect(classifyUrgency({ ...original, title: 'Online store security advisory' })).toBe('critical');
    for (const passage of ['Attackers are not exploiting this flaw.', 'There is no evidence that attackers are exploiting this flaw.',
      'Are attackers exploiting this flaw?', 'In 2024 attackers are exploiting this flaw.']) {
      expect(classifyUrgency({ ...original, title: 'Online store security advisory', passage, description: passage })).toBe('routine');
    }
    expect(classifyUrgency({ ...original, title: 'Online store security advisory', passage: 'No evidence of activity, but attackers are exploiting this flaw.' })).toBe('critical');
  });
  test('laboratory and retrospective exploitation language does not establish operational activity', () => {
    for (const title of ['Zero-day exploited in a lab demonstration', 'Proof of concept: vulnerability exploited in research',
      'Retrospective: active exploitation in 2024', 'Vulnerability actively exploited last year']) {
      const item = { title, date: '2026-09-06T12:00:00Z', horizon: 3 };
      expect(assessUrgency(item).exploitationStatus).toBe('not-established');
      expect(classifyUrgency(item)).not.toBe('critical');
      applyHorizonOverrides([item]);
      expect(item.horizon).toBe(3);
    }
  });
  test('PaperCut and SonicWall two-CVE advisories have different product-first titles', () => {
    const papercut = editorialContext(members(6)[0], ['CVE-2026-81578', 'CVE-2026-82078'].map(cve => ({ cve, vendor: 'PaperCut', product: 'NG/MF' })));
    const sonicwall = editorialContext(members(7)[0], ['CVE-2026-83548', 'CVE-2026-83549'].map(cve => ({ cve, vendor: 'SonicWall', product: 'SMA1000' })));
    expect(papercut.title).toMatch(/^PaperCut NG\/MF: 2 KEV-listed/);
    expect(sonicwall.title).toMatch(/^SonicWall SMA1000: 2 KEV-listed/);
    expect(sonicwall.nextStep).toBe('Check deployed versions of SonicWall SMA1000 against vendor mitigation guidance.');
    expect(sonicwall.sourceTitle).toBe(row(7).title);
  });
  test('a retained catalog vulnerability name supplies mechanism-specific consequence without inventing a patch', () => {
    const context = editorialContext(members(0)[0], [{ cve: 'CVE-2026-85046', vendor: 'Google', product: 'Chromium V8',
      name: 'Google Chromium V8 Type Confusion Vulnerability' }]);
    expect(context.consequence).toBe('Known exploitation: Type Confusion in Google Chromium V8.');
    expect(context.nextStep).not.toMatch(/patched|compromised|deadline/i);
  });
  test('a research publisher mention cannot become an affected product', () => {
    const item = { ...members(33)[0], vendors: row(33).enrichment.vendors };
    expect(item.vendors).toContain('Google');
    expect(editorialContext(item).product).toBeNull();
  });
  test('more retained context is explicit capture metadata and never claims a threat changed', () => {
    const item = members(15)[0];
    item.evidence = item.evidence.map(ref => ({ ...ref, changed: true, changeKind: 'capture-expanded' }));
    const context = editorialContext(item);
    expect(context.captureChanges[0]).toMatchObject({ changeKind: 'capture-expanded', materialChange: 'unassessed' });
    expect(context.threatChange).toBe('unassessed');
    expect(context.exploitationStatus).toBe('not-established');
  });
  test('the corrected source count no longer raises the score for a second copy from Rapid7', () => {
    const [single] = deduplicateWithCorroboration(members(5).slice(0, 1));
    const [copies] = deduplicateWithCorroboration(members(5));
    for (const item of [single, copies]) item.urgency = classifyUrgency(item);
    expect(scoreHeadline(copies, {})).toBe(scoreHeadline(single, {}));
    expect(copies.scoreRationale).not.toMatch(/2 publishers/);
  });
});

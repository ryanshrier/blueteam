import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { initDB, closeDB, bulkInsertKEV, getKEVRecords } from '../lib/db.js';
import { deduplicateWithCorroboration, isFresh } from '../lib/feeds.js';
import { editorialContext, headlineCves, readableExcerpt, normalizeFeedTimestamp, enrichmentStatus, sameVulnerabilityDevelopment } from '../lib/intelligence-context.js';
import { classifyEvidenceChange } from '../lib/evidence.js';
import { getEffectiveWatchProfile, evaluateApplicability } from '../lib/watch-profile.js';
import { scoreHeadline } from '../lib/scoring.js';

// Replay the actual audited retained collection. No generated fixture briefing
// supplies the expected Chrome identity, CERT-EU timestamps, or group evidence.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/retained-feed-2026-09-05.json', import.meta.url), 'utf8'));
const fromMember = member => ({ ...member, link: member.url, date: member.publishedAt,
  passage: typeof member.passage === 'string' ? member.passage : member.passage?.text || '', evidence: member.sourceRevisions || [] });
const retained = manifest.selectedEvidence.map(item => {
  const members = (item.groupMembers || []).map(fromMember);
  return { ...item, ...item.enrichment, link: item.url, date: item.publishedAt, description: members[0]?.passage || '',
    passage: members[0]?.passage || item.passage?.text || '', sourceMembers: members, evidence: item.sourceRevisions || [] };
});

describe('editorial context replay against real retained reporting', () => {
  beforeAll(() => initDB(':memory:'));
  afterAll(() => closeDB());
  test('three leading Chrome reports become one inspectable event without losing source members', () => {
    const selected = retained.slice(0, 3);
    expect(selected.map(headlineCves)).toEqual(Array(3).fill(['CVE-2026-85046']));
    const grouped = deduplicateWithCorroboration(selected, 0.5);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].sourceMembers).toHaveLength(selected.reduce((sum, item) => sum + item.sourceMembers.length, 0));
    expect(grouped[0].sources).toEqual(expect.arrayContaining(selected.map(item => item.source)));
  });
  test('an explicit follow-on or widely separated report remains a separate development', () => {
    const original = retained[0];
    expect(sameVulnerabilityDevelopment(original, { ...original, title: 'Patch bypass creates a new exploit chain', date: original.date })).toBe(false);
    expect(sameVulnerabilityDevelopment(original, { ...original, date: '2026-07-01T00:00:00Z' })).toBe(false);
    for (const suffix of ['patch bypass', 'Proof of concept released', 'public exploit published', 'patch withdrawn']) {
      const followOn = { ...original, sourceMembers: undefined, title: `${original.title} ${suffix}` };
      expect(deduplicateWithCorroboration([original, followOn], 0.5)).toHaveLength(2);
      expect(deduplicateWithCorroboration([followOn, { ...followOn, source: 'Second publisher', link: 'https://example.test/report' }], 0.5)).toHaveLength(1);
    }
  });
  test('CERT-EU July, April, and January dates are parsed and fail the current freshness window', () => {
    const old = retained.filter(item => /\b(?:CET|CEST)$/.test(item.date));
    expect(old).toHaveLength(3);
    expect(old.map(item => normalizeFeedTimestamp(item.date)?.slice(0, 10))).toEqual(['2026-07-23', '2026-04-30', '2026-01-30']);
    old.forEach(item => expect(isFresh(item.date, 72 * 3600_000)).toBe(false));
    expect(normalizeFeedTimestamp('2026-09-04T12:00:00')).toBeNull();
    expect(normalizeFeedTimestamp('Fri, 04 Sep 2026 12:00:00')).toBeNull();
    expect(normalizeFeedTimestamp('2026-09-04T12:00:00-05:00')).toBe('2026-09-04T17:00:00.000Z');
  });
  test('multi-CVE records retain distinct dates and entries with no due date', () => {
    const ids = headlineCves(retained.find(item => /SharePoint/.test(item.title)));
    expect(ids.length).toBeGreaterThan(1);
    bulkInsertKEV(ids.map((id, index) => ({ cveID: id, product: 'SharePoint', dateAdded: '2026-07-21', dueDate: index ? null : '2026-07-25' })));
    const records = getKEVRecords(ids);
    expect(Object.keys(records)).toHaveLength(ids.length);
    expect(records[ids[0]].dueDate).toBe('2026-07-25');
    expect(records[ids[1]].dueDate).toBeNull();
  });
  test('the administrative lead gains a subject and decision without inventing deployment or a fix', () => {
    const context = editorialContext(retained[0], [{ cve: 'CVE-2026-85046', vendor: 'Google', product: 'Chromium V8', name: 'Google Chromium V8 Type Confusion Vulnerability' }]);
    expect(context.title).toContain('Chromium V8 Type Confusion');
    expect(context.sourceTitle).toBe(retained[0].title);
    expect(context.nextStep).toContain('Check deployed versions');
    expect(context.title).not.toMatch(/compromised|patch available/i);
    expect(context.unknowns.join(' ')).toContain('unverified');
    const records = [{ cve: 'CVE-2026-83548', vendor: 'SonicWall', product: 'SMA1000' }, { cve: 'CVE-2026-83549', vendor: 'SonicWall', product: 'SMA1000' }];
    expect(editorialContext({ title: 'Security advisory for SonicWall' }, records).title).toContain('KEV-listed');
    expect(editorialContext({ title: 'Security advisory for SonicWall' }, records).title).not.toContain('enter KEV');
  });
  test('enrichment failure is distinct from zero and ranking contributions reconcile', () => {
    const item = { ...retained[0], cveData: null, epss: null };
    expect(enrichmentStatus(item, ['CVE', 'EPSS'])).toEqual({ cve: 'unavailable', epss: 'unavailable' });
    scoreHeadline(item, {});
    const total = Object.values(item.scoreContributions).reduce((sum, value) => sum + value, 0);
    expect(Math.abs(item.score - total)).toBeLessThanOrEqual(0.6);
    expect(item.scoreUnknowns).toContain('CVE severity not established');
  });
  test('capture extension is labeled without claiming a threat change', () => {
    const text = retained[0].passage;
    expect(classifyEvidenceChange({ title: retained[0].title, passage: text.slice(0, 200) }, { title: retained[0].title, passage: text }))
      .toEqual({ changeKind: 'capture-expanded', materialChange: 'unassessed' });
    expect(classifyEvidenceChange({ title: retained[0].title, passage: text.slice(0, 300) + '...' }, { title: retained[0].title, passage: text }).changeKind).toBe('capture-expanded');
    expect(readableExcerpt(text, 280)).toMatch(/…$/);
    expect(text).toContain(readableExcerpt(text, 280).slice(0, -1));
  });
  test('question relevance has distinct provenance and never establishes deployment', () => {
    const profile = getEffectiveWatchProfile({ organization: { watchTopics: ['Chrome'] } }, { watchProfile: { technologies: [] } });
    expect(profile.provenance.technologies).toBe('operator-declared');
    expect(profile.provenance.intelligenceQuestions).toBe('server-default');
    const result = evaluateApplicability(retained[1], profile);
    expect(result.questionRelevance).toBe('matched');
    expect(result.state).toBe('unknown');
    expect(result.exposure).toBe('unknown');
  });
});

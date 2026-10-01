import { describe, test, expect } from '@jest/globals';
import { classifyUrgency, applyHorizonOverrides, scoreHeadline } from '../lib/scoring.js';
import { normalizeFeedTimestamp } from '../lib/intelligence-context.js';
import { matchActors } from '../lib/enrichment.js';

describe('bounded current-activity classification', () => {
  test.each([
    'No known patch exists and attackers are actively exploiting the flaw.',
    'No patch exists for the actively exploited flaw.',
    'No known fix is available; attackers are actively exploiting the flaw.',
    'Attackers are actively exploiting the flaw and have done so since 2024.',
  ])('preserves explicitly ongoing exploitation: %s', title => {
    const headline = { title, horizon: 3, date: '2026-09-28T12:00:00Z' };
    expect(classifyUrgency(headline)).toBe('critical');
    applyHorizonOverrides([headline]);
    expect(headline.horizon).toBe(1);
  });
  test.each([
    'No known attackers are actively exploiting the flaw.',
    'There is no evidence that attackers are exploiting this flaw.',
    'There is no evidence that hackers and attackers are actively exploiting the flaw.',
    'Researchers deny that criminals and attackers are actively exploiting the flaw.',
    'Attackers are not actively exploiting the flaw.',
    'Attackers actively exploited the flaw in 2024.',
  ])('does not turn denial or past activity into a current claim: %s', title => {
    expect(classifyUrgency({ title, date: '2026-09-28T12:00:00Z' })).toBe('routine');
  });
  test.each(['Cybersecurity workforce report released', 'CISA and partners launch a new task force'])('does not find RCE inside another word: %s', title => {
    const headline = { title, horizon: 3 };
    expect(classifyUrgency(headline)).toBe('routine');
    applyHorizonOverrides([headline]);
    expect(headline.horizon).toBe(3);
  });
  test('still recognizes the RCE abbreviation', () => {
    expect(classifyUrgency({ title: 'Vendor fixes RCE vulnerability' })).toBe('elevated');
  });
  test('requires a ransomware qualifier for ordinary-word aliases', () => {
    expect(matchActors('Google Play removes apps; security agenda announced')).toEqual([]);
    expect(matchActors('Google Play ransomware apps removed')).toEqual([]);
    expect(matchActors('Play ransomware group claims breach').map(actor => actor.name)).toEqual(['Play']);
    expect(matchActors('Ransomware group Agenda targets hospitals').map(actor => actor.name)).toEqual(['Qilin']);
    expect(matchActors('PlayCrypt targets hospitals').map(actor => actor.name)).toEqual(['Play']);
  });
  test('zero authority remains distinct from default source weight', () => {
    const zero = { title: 'Routine update', horizon: 2, weight: 0 };
    const normal = { ...zero, weight: 1 };
    const unspecified = { ...zero, weight: undefined };
    scoreHeadline(zero, {}); scoreHeadline(normal, {}); scoreHeadline(unspecified, {});
    expect(zero.scoreComponents.relevance).toBeLessThan(normal.scoreComponents.relevance);
    expect(unspecified.scoreComponents.relevance).toBe(normal.scoreComponents.relevance);
  });
});

describe('explicit RSS timezone offsets', () => {
  test.each([
    ['EST', '17'], ['EDT', '16'], ['CST', '18'], ['CDT', '17'],
    ['MST', '19'], ['MDT', '18'], ['PST', '20'], ['PDT', '19'],
    ['GMT (UTC)', '12'], ['UT', '12'], ['CEST', '10'],
  ])('normalizes %s without using the machine timezone', (zone, hour) => {
    expect(normalizeFeedTimestamp(`Mon, 28 Sep 2026 12:00:00 ${zone}`)).toBe(`2026-09-28T${hour}:00:00.000Z`);
  });
  test('does not infer a zone for a bare clock or unknown abbreviation', () => {
    expect(normalizeFeedTimestamp('Mon, 28 Sep 2026 12:00:00')).toBeNull();
    expect(normalizeFeedTimestamp('Mon, 28 Sep 2026 12:00:00 XYZ')).toBeNull();
  });
});

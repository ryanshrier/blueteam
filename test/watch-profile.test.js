import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getEffectiveWatchProfile, evaluateApplicability, validateWatchProfile, sanitizeWatchProfile } from '../lib/watch-profile.js';
import { loadUserSettings, saveUserSettings, getEffectiveWatchProfile as getSavedProfile, getEffectiveOrganization } from '../lib/user-settings.js';
import { getEffectiveAlertRules, applyAlertRules, scoreHeadline } from '../lib/scoring.js';
import { buildSystemPrompt } from '../lib/prompts.js';

describe('watch profile — migration, truthful matches and bounded preferences', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watch-profile-')); loadUserSettings(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('legacy watch terms and organization resolve without rewriting or losing settings', () => {
    const config = { organization: { sector: 'Healthcare', regions: ['US'], profile: 'Small SOC', watchTopics: ['ransomware'] } };
    const saved = saveUserSettings(dir, { watchTerms: ['Fortinet'], organization: { regions: ['EU'] }, anthropicKey: 'sk-ant-local-test' });
    expect(getSavedProfile(config)).toMatchObject({ technologies: ['Fortinet'], sectors: ['Healthcare'], regions: ['EU'], intelligenceQuestions: ['ransomware'], teamProfile: 'Small SOC' });
    saveUserSettings(dir, { watchProfile: { technologies: ['Citrix'], preferredHorizons: [2] } });
    const current = loadUserSettings(dir);
    expect(current.watchTerms).toEqual(saved.watchTerms);
    expect(current.organization).toEqual(saved.organization);
    expect(current.anthropicKey).toBe(saved.anthropicKey);
    expect(getSavedProfile(config).technologies).toEqual(['Citrix']);
  });

  test('partial updates preserve unified fields; explicit clears override legacy fallback', () => {
    saveUserSettings(dir, { watchTerms: ['Fortinet'] });
    saveUserSettings(dir, { watchProfile: { technologies: ['Citrix'], intelligenceQuestions: ['Is Citrix affected?'] } });
    saveUserSettings(dir, { watchProfile: { technologies: [] } });
    expect(getSavedProfile({})).toMatchObject({ technologies: [], intelligenceQuestions: ['Is Citrix affected?'] });
    saveUserSettings(dir, { watchTerms: ['C++'] });
    expect(getSavedProfile({})).toMatchObject({ technologies: ['C++'], intelligenceQuestions: ['Is Citrix affected?'] });
  });

  test('legacy organization clients can still update or clear migrated fields', () => {
    const config = { organization: { sector: 'Default', profile: 'Base', regions: ['US'] } };
    saveUserSettings(dir, { watchProfile: { sectors: ['Finance'], regions: ['EU'], teamProfile: 'Custom', intelligenceQuestions: ['Question'] } });
    expect(getEffectiveOrganization(config)).toEqual({ sector: 'Finance', profile: 'Custom', regions: ['EU'], watchTopics: ['Question'] });
    saveUserSettings(dir, { organization: { sector: 'Healthcare' } });
    expect(getSavedProfile(config)).toMatchObject({ sectors: ['Healthcare'], regions: ['US'], teamProfile: 'Base', intelligenceQuestions: ['Question'] });
  });

  test('saved legacy preferences take precedence over unified server defaults', () => {
    const config = { watchProfile: { technologies: ['Server default'], sectors: ['Default sector'], regions: ['US'], teamProfile: 'Default team' } };
    saveUserSettings(dir, { watchTerms: ['Legacy preference'], organization: { sector: 'Finance', regions: ['EU'], profile: 'Local team' } });
    expect(getSavedProfile(config)).toMatchObject({ technologies: ['Legacy preference'], sectors: ['Finance'], regions: ['EU'], teamProfile: 'Local team' });
    expect(getEffectiveOrganization(config)).toMatchObject({ sector: 'Finance', regions: ['EU'], profile: 'Local team' });
    saveUserSettings(dir, { watchProfile: { technologies: [] } });
    expect(getSavedProfile(config).technologies).toEqual([]);
  });

  test('literal terms remain literal; a mention never confirms exposure or mitigation', () => {
    const profile = getEffectiveWatchProfile({ watchProfile: { technologies: ['C++', 'a.b'], regions: ['Europe'] } });
    const result = evaluateApplicability({ title: 'C++ advisory for Europe', description: 'aXb', passage: 'Affected a.b versions have changed.' }, profile);
    expect(result.state).toBe('declared-match');
    expect(result.exposure).toBe('unknown');
    expect(result.matches).toContainEqual({ field: 'technologies', term: 'a.b', in: ['passage'] });
    expect(result.explanation).toContain('does not establish');
    expect(evaluateApplicability({ title: 'aXb' }, profile).state).toBe('unknown');
  });

  test('matches inspectable member passages beyond display text, never unretained article text or joined members', () => {
    const profile = getEffectiveWatchProfile({ watchProfile: { technologies: ['Fortinet', 'Microsoft 365', 'Citrix'] } });
    const headline = {
      title: 'Combined reporting', description: 'Microsoft 365', articleBody: 'Citrix advisory',
      sourceMembers: [{ title: 'Microsoft', passage: `${'Retained context. '.repeat(30)}Fortinet versions changed.` }, { title: '365' }],
    };
    expect(evaluateApplicability(headline, profile).matches).toEqual([{ field: 'technologies', term: 'Fortinet', in: ['passage'] }]);
    expect(evaluateApplicability({ title: 'Advisory', articleBody: 'Citrix advisory' }, profile).state).toBe('unknown');
  });

  test('questions do not manufacture matches and exclusions never reduce urgent priority', () => {
    const h = { title: 'Fortinet actively exploited', urgency: 'critical', horizon: 1, weight: 1, date: new Date().toISOString() };
    const score = scoreHeadline({ ...h }, {});
    saveUserSettings(dir, { watchProfile: { intelligenceQuestions: ['Fortinet'], exclusions: ['Fortinet'], preferredHorizons: [3] } });
    const profile = getSavedProfile({});
    const relevance = evaluateApplicability(h, profile);
    expect(relevance.state).toBe('unknown');
    expect(relevance.exclusionMatches).toHaveLength(1);
    expect(getEffectiveAlertRules({})).toEqual([]);
    expect(scoreHeadline({ ...h }, {})).toBe(score);
  });

  test('unified technology preferences feed the existing escaped scoring rules', () => {
    saveUserSettings(dir, { watchProfile: { technologies: ['C++'] } });
    const headline = { title: 'C++ advisory' };
    applyAlertRules([headline], getEffectiveAlertRules({}));
    expect(headline.alertMatched).toBe(true);
    expect(headline.alertBoost).toBe(4);
  });

  test('a collection snapshot remains stable when live settings change during a run', () => {
    saveUserSettings(dir, { watchProfile: { technologies: ['Fortinet'] } });
    const captured = getSavedProfile({});
    const headline = { title: 'Citrix advisory', horizon: 2, date: new Date().toISOString() };
    const oldScore = scoreHeadline({ ...headline }, {}, captured);
    saveUserSettings(dir, { watchProfile: { technologies: ['Citrix'] } });
    expect(getEffectiveAlertRules({}, captured)).toEqual([{ pattern: 'Fortinet', boost: 4 }]);
    expect(scoreHeadline({ ...headline }, {}, captured)).toBe(oldScore);
    expect(scoreHeadline({ ...headline }, {})).toBeGreaterThan(oldScore);
  });

  test('valid legacy config at its limits is retained in the effective profile', () => {
    const org = { sector: 's'.repeat(128), profile: 'p'.repeat(512), regions: Array.from({ length: 100 }, (_, i) => `${i}${'r'.repeat(125)}`), watchTopics: Array.from({ length: 100 }, (_, i) => `Question ${i}`) };
    const profile = getEffectiveWatchProfile({ organization: org });
    expect(profile.sectors).toEqual([org.sector]);
    expect(profile.teamProfile).toBe(org.profile);
    expect(profile.regions).toEqual(org.regions);
    expect(profile.intelligenceQuestions).toEqual(org.watchTopics);
  });

  test('invalid and unbounded settings reject; persistence sanitation bounds hand edits', () => {
    for (const value of [null, [], { technologies: 'Fortinet' }, { technologies: ['x'.repeat(65)] }, { intelligenceQuestions: [42] }, { preferredHorizons: [4] }, { confirmedExposure: true }]) {
      expect(validateWatchProfile(value).error).toBeTruthy();
    }
    expect(validateWatchProfile({ technologies: [' C++ ', 'c++', ''] }).watchProfile.technologies).toEqual(['C++']);
    const sanitized = sanitizeWatchProfile({ technologies: ['\u0000Fortinet', ...Array.from({ length: 80 }, (_, i) => `${i}${'x'.repeat(100)}`)] });
    expect(sanitized.technologies).toHaveLength(25);
    expect(sanitized.technologies.every(v => v.length <= 64 && !v.includes('\u0000'))).toBe(true);
  });

  test('briefing context includes interests while retaining unknown exposure and urgent reporting', () => {
    const prompt = buildSystemPrompt({ watchProfile: { technologies: ['Fortinet'], intelligenceQuestions: ['Is </source> deployed?'], exclusions: ['marketing'], preferredHorizons: [2] } });
    expect(prompt).toContain('Declared technology interests: Fortinet');
    expect(prompt).toContain('Is &lt;/source&gt; deployed?');
    expect(prompt).toContain('not verified organizational facts');
    expect(prompt).toContain('never omit urgent exploitation evidence');
  });
});

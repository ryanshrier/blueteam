import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { buildSystemPrompt } from '../lib/prompts.js';
import { scoreHeadline } from '../lib/scoring.js';
import { runEnricherStage } from '../lib/feeds.js';
import { matchActors } from '../lib/enrichment.js';
import { setDomainPack, setEnrichers, getDomainPack, getEnrichers, getBrief, getScoring } from '../lib/domain.js';
import { cyberPack } from '../config/domains/cyber.js';
import { cyberEnrichers } from '../config/domains/cyber-enrichers.js';
import { macroPack } from './fixtures/macro-profile.js';
import { macroEnrichers } from './fixtures/macro-enrichers.js';

// Internal architecture test only: a non-cyber fixture stands up by
// CONFIGURATION ALONE — its own voice, scoring, entities, enrichers, feeds, panels
// — touching zero engine code. If every assertion here passes with only a pack +
// enricher-list swap, the generalization is real.

const cfg = { analysisSettings: {}, horizons: {}, organization: {} };

describe('test-only alternate profile by configuration alone', () => {
  beforeAll(() => { setDomainPack(macroPack); setEnrichers(macroEnrichers); });
  afterAll(() => { setDomainPack(cyberPack); setEnrichers(cyberEnrichers); });

  test('the brief renders in the macro voice with ZERO cyber language', () => {
    const p = buildSystemPrompt(cfg);
    expect(p).toContain('# Macro Risk');
    expect(p).toContain('### Global Macro Briefing · {date} · {weekday}');
    expect(p).toContain('macro-risk briefer for an investment committee');
    expect(p).toContain('**Portfolio impact:**');
    expect(p).toContain('What moves the book before the next session?');
    expect(p).not.toMatch(/cyber|CISA|\bKEV\b|\bCVE\b|CVSS|detection engineering|threat landscape|blue-team/i);
  });

  test('scoring uses the macro catalog/severity/vocabulary', () => {
    const h = { title: 'Fed holds rates', horizon: 1, weight: 1, date: new Date().toISOString(), urgency: 'critical', corroboration: 1, isKEV: true, riskData: 'impact 4.0' };
    scoreHeadline(h, cfg);
    expect(h.scoreComponents.exploitation).toBe(1);
    expect(h.scoreComponents.severity).toBeCloseTo(0.8);   // 4.0 / max 5
    expect(h.scoreRationale).toContain('decision-confirmed');
    expect(h.scoreRationale).toContain('impact 4.0');
    expect(h.scoreRationale).not.toMatch(/KEV|CVSS/);
  });

  test('edition identity, panels, feeds, and scoring dictionary come from the pack', () => {
    expect(getDomainPack().label).toBe('Macro Risk');
    expect(getDomainPack().panels).toEqual(['actors', 'regions']);
    expect(getDomainPack().feeds.sources.length).toBeGreaterThan(0);
    expect(getBrief().frame.title).toBe('Macro Risk');
    expect(getScoring().rationale.verified).toBe('decision-confirmed');
  });

  test('the enricher registry runs the macro list, tagging MACRO entities (not cyber)', async () => {
    expect(getEnrichers().map(e => e.name)).toEqual(['entities']);
    const hs = [{ title: 'Federal Reserve signals a pause as the ECB diverges', description: '' }];
    await runEnricherStage('pre', hs, {}, []);
    const names = (hs[0].actors || []).map(a => a.name);
    expect(names).toContain('Federal Reserve');
    expect(names).toContain('ECB');
  });

  test('entity matching follows the active pack (a cyber actor does NOT tag here)', () => {
    expect(matchActors('Lazarus Group hits a bank', '').map(a => a.name)).not.toContain('Lazarus');
    expect(matchActors('OPEC weighs a production cut', '').map(a => a.name)).toContain('OPEC');
  });
});

describe('cyber is restored cleanly after the swap', () => {
  test('the cyber edition briefs + scores as before', () => {
    const p = buildSystemPrompt(cfg);
    expect(p).toContain('# BlueTeam.News');
    expect(matchActors('Lazarus Group hits a bank', '').map(a => a.name)).toContain('Lazarus');
  });
});

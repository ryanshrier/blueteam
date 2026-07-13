import { describe, test, expect } from '@jest/globals';
import {
  buildActorLeaderboard, buildRegionActivity,
  buildVendorExposure, buildConvergenceClusters, buildWatchTopicHits,
  pipelineStaleAfterMs,
} from '../lib/landscape.js';
import { tagMitre, buildMitreHeatmap } from '../lib/mitre.js';
import { getDomainPack, setDomainPack } from '../lib/domain.js';
import { cyberPack } from '../config/domains/cyber.js';
import { macroPack } from './fixtures/macro-profile.js';

// buildLandscape gates the cyber-flavoured panels on this
// pack declaration, so a non-cyber edition surfaces none of them. Guards that the
// cyber edition still declares its five.
describe('pack-declared landscape panels', () => {
  test('cyber declares the five edition-specific panel kinds', () => {
    expect(getDomainPack().panels).toEqual(['kev', 'actors', 'regions', 'mitre', 'vendors']);
  });
});

describe('pipelineStaleAfterMs', () => {
  test('scales with slow configured refresh cadences instead of hard-coding 30 minutes', () => {
    expect(pipelineStaleAfterMs(60)).toBe(120 * 60_000);
    expect(pipelineStaleAfterMs(120)).toBe(240 * 60_000);
  });

  test('keeps a 20-minute floor for fast or invalid cadences', () => {
    expect(pipelineStaleAfterMs(2)).toBe(20 * 60_000);
    expect(pipelineStaleAfterMs('invalid')).toBe(20 * 60_000);
  });
});

describe('buildActorLeaderboard', () => {
  test('counts actor mentions across current and archived headlines', () => {
    const headlines = [
      { title: 'Volt Typhoon pre-positions in utility networks', description: '' },
      { title: 'LockBit affiliate arrested in joint operation', description: '' },
    ];
    const archived = [
      { title: 'Volt Typhoon targets critical infrastructure again' },
    ];
    const board = buildActorLeaderboard(headlines, archived);
    const volt = board.find(a => a.name === 'Volt Typhoon');
    const lockbit = board.find(a => a.name === 'LockBit');
    expect(volt.mentions).toBe(2);
    expect(volt.region).toBe('CN');
    expect(lockbit.mentions).toBe(1);
    expect(board[0].name).toBe('Volt Typhoon'); // sorted by mentions
  });

  test('matches aliases', () => {
    const board = buildActorLeaderboard([
      { title: 'Midnight Blizzard phishing wave hits cloud tenants', description: '' },
    ]);
    expect(board.find(a => a.name === 'APT29')).toBeTruthy();
  });

  test('empty input yields empty leaderboard', () => {
    expect(buildActorLeaderboard([], [])).toEqual([]);
  });

  // Regression: buildActorLeaderboard used to merge title+description into one
  // string before calling matchActors, collapsing its (title, body) negation
  // model back into the old single-string behavior — a negated title mention
  // suppressed the ENTIRE match with no chance for a confirming body mention to
  // count, unlike tagEntities (lib/enrichment.js), which checks each separately.
  test('counts a body-confirmed actor even when the title mention is negated', () => {
    const board = buildActorLeaderboard([
      {
        title: 'Breach not linked to Lazarus, CISA says',
        description: 'Investigators later confirmed Lazarus Group orchestrated the intrusion.',
      },
    ]);
    expect(board.find(a => a.name === 'Lazarus')?.mentions).toBe(1);
  });

  // refreshNow() archives the current run's headlines before serving them,
  // so every current headline also exists in getArchivedHeadlines(). Scanning
  // both unconditionally double-counted every current-run mention.
  test('does not double-count a current-run headline that also appears in the archive', () => {
    const headlines = [
      { title: 'Volt Typhoon pre-positions in utility networks', description: '' },
    ];
    // Same story, archived verbatim (as refreshNow does before serving the run).
    const archived = [
      { title: 'Volt Typhoon pre-positions in utility networks' },
    ];
    const board = buildActorLeaderboard(headlines, archived);
    expect(board.find(a => a.name === 'Volt Typhoon').mentions).toBe(1);
  });

  test('still counts a genuinely different archived mention of the same actor', () => {
    const headlines = [
      { title: 'Volt Typhoon pre-positions in utility networks', description: '' },
    ];
    const archived = [
      { title: 'Volt Typhoon targets critical infrastructure again' }, // different story, earlier day
    ];
    const board = buildActorLeaderboard(headlines, archived);
    expect(board.find(a => a.name === 'Volt Typhoon').mentions).toBe(2);
  });
});

describe('buildRegionActivity', () => {
  test('aggregates mentions per region', () => {
    const regions = buildRegionActivity([
      { name: 'APT29', region: 'RU', mentions: 3 },
      { name: 'Sandworm', region: 'RU', mentions: 2 },
      { name: 'LockBit', region: 'crime', mentions: 4 },
    ]);
    expect(regions[0].mentions).toBe(5); // RU first
    expect(regions[0].code).toBe('RU');
    expect(regions[1].code).toBe('crime');
  });
});

describe('buildVendorExposure', () => {
  test('counts vendor mentions with critical and kev flags', () => {
    const vendors = buildVendorExposure([
      { title: 'Fortinet zero-day exploited', description: '', urgency: 'critical', isKEV: true, vendors: ['Fortinet'] },
      { title: 'Fortinet patch released', description: '', vendors: ['Fortinet'] },
      { title: 'Microsoft advisory', description: '', vendors: ['Microsoft'] },
    ]);
    expect(vendors[0].name).toBe('Fortinet');
    expect(vendors[0].mentions).toBe(2);
    expect(vendors[0].critical).toBe(1);
    expect(vendors[0].kev).toBe(1);
  });
});

describe('buildConvergenceClusters', () => {
  test('groups multi-source stories by shared actor', () => {
    const clusters = buildConvergenceClusters([
      { title: 'LockBit hits healthcare', source: 'A', corroboration: 3, actors: [{ name: 'LockBit' }], horizon: 1, score: 10 },
      { title: 'LockBit affiliate arrested', source: 'B', corroboration: 2, actors: [{ name: 'LockBit' }], horizon: 1, score: 8 },
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].label).toBe('LockBit');
    expect(clusters[0].sourceCount).toBe(2);
  });

  test('ignores single-source stories', () => {
    expect(buildConvergenceClusters([
      { title: 'Single story', source: 'A', corroboration: 1, actors: [{ name: 'APT29' }] },
    ])).toEqual([]);
  });

  // Regression: the CVE-cluster regex used to run unconditionally, unlike every
  // other cyber-flavoured surface in this file (kev/actors/regions/mitre/vendors),
  // which all gate on the active pack's declared panels.
  describe('CVE-type gating by domain pack', () => {
    const cveHeadlines = [
      { title: 'Vendor patches CVE-2025-1234 RCE', source: 'A', corroboration: 3, actors: [], vendors: [] },
      { title: 'Second report on CVE-2025-1234', source: 'B', corroboration: 2, actors: [], vendors: [] },
    ];

    test("cyber (declares the 'kev' panel) clusters by CVE", () => {
      const clusters = buildConvergenceClusters(cveHeadlines);
      expect(clusters.some(c => c.type === 'cve' && c.label === 'CVE-2025-1234')).toBe(true);
    });

    test("a pack without the 'kev' panel produces no CVE cluster", () => {
      setDomainPack(macroPack);
      try {
        const clusters = buildConvergenceClusters(cveHeadlines);
        expect(clusters.some(c => c.type === 'cve')).toBe(false);
      } finally {
        setDomainPack(cyberPack); // restore, even if the assertion throws
      }
    });
  });
});

describe('buildWatchTopicHits', () => {
  test('matches configured watch topics', () => {
    const hits = buildWatchTopicHits([
      { title: 'New zero-day in Fortinet', description: '', score: 10 },
      { title: 'Ransomware wave continues', description: '', score: 8 },
      { title: 'Ransomware hits hospital', description: '', score: 7 },
    ], ['zero-day', 'ransomware']);
    expect(hits.find(h => h.topic === 'ransomware').count).toBe(2);
    expect(hits.find(h => h.topic === 'zero-day').count).toBe(1);
  });
});

describe('MITRE tagging', () => {
  test('tags ransomware headlines with T1486', () => {
    const headlines = [{ title: 'LockBit ransomware encrypts hospital files', description: '' }];
    tagMitre(headlines);
    expect(headlines[0].mitre.some(m => m.id === 'T1486')).toBe(true);
  });

  test('buildMitreHeatmap aggregates technique counts', () => {
    const headlines = [
      { title: 'Phishing campaign targets finance', mitre: [{ id: 'T1566', name: 'Phishing', tactic: 'Initial Access' }] },
      { title: 'Spear phishing wave', mitre: [{ id: 'T1566', name: 'Phishing', tactic: 'Initial Access' }] },
    ];
    const heat = buildMitreHeatmap(headlines);
    expect(heat[0].id).toBe('T1566');
    expect(heat[0].count).toBe(2);
  });
});

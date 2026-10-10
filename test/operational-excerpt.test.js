import { describe, expect, test } from '@jest/globals';
import { selectOperationalExcerpt, selectSourcePassage } from '../lib/evidence-quality.js';
import { buildGroundingManifest } from '../lib/grounding.js';

const background = 'General product background remains unchanged. '.repeat(150);

describe('operational excerpts preserve facts containing internal dots', () => {
  test.each([
    'AhsayCBS versions 9.13.2 and 9.13.4 are affected.',
    'The vulnerable WinRing0.sys driver and WEB-INF/classes/crowd.properties require review.',
    'Affected services listen at 127.0.0.1:5984 and run release 12.4.3-03526.',
    'CVE-2026-12345 has CVSS v3.1 score 9.8; the affected build is 4.5.6.',
  ])('retains the complete factual sentence: %s', sentence => {
    const excerpt = selectOperationalExcerpt(`${sentence} ${background}`, 300);
    expect(excerpt).toContain(sentence);
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).toContain('[…]');
  });

  test('preserves a final operational sentence without closing punctuation', () => {
    const final = 'The affected release 4.5.6 requires patch 4.5.7';
    const excerpt = selectOperationalExcerpt(`${background}${final}`, 300);
    expect(excerpt).toContain(final);
    expect(excerpt.length).toBeLessThanOrEqual(300);
  });

  test('the source selector supplies complete affected versions to prompting and grounding', () => {
    const sentence = 'The backup console versions 9.13.2 and 9.13.4 are affected.';
    const selected = selectSourcePassage({
      title: 'Backup console vulnerability',
      articleBody: `${sentence} Restrict management access until a patch is available. ${background}`,
    });
    expect(selected.quality.substantive).toBe(true);
    expect(selected.passage).toContain(sentence);
    expect(selected.passage).toContain('Restrict management access until a patch is available.');
    expect(selected.passage.length).toBeLessThanOrEqual(4000);
  });
});

describe('operational excerpts retain nearby identity context', () => {
  test('a long article retains its sole CVE beside the affected and fixed versions', () => {
    const identity = 'This issue is tracked as CVE-2026-12345.';
    const affected = 'Affected versions are 1.2.0 through 1.2.3.';
    const fixed = 'Install the fixed version 1.2.4.';
    const body = `Vendor published a Gateway update. The release addresses a security issue. ${identity} ${affected} ${fixed} `
      + 'Background context explains the product architecture and how customers use the platform. '.repeat(60);
    expect(body.length).toBeGreaterThan(4000);
    const source = { title: 'Gateway update', source: 'Vendor', articleBody: body };
    const excerpt = selectSourcePassage(source).passage;
    expect(excerpt).toContain(`${identity} ${affected} ${fixed}`);
    expect(excerpt.length).toBeLessThanOrEqual(4000);
    expect([...buildGroundingManifest({ headlines: [source] }).sources[0].cves]).toEqual(['CVE-2026-12345']);
  });

  test('retains separate multi-CVE scopes and intervening qualifications in source order', () => {
    const first = 'The first issue is CVE-2026-11111. Gateway versions 1.2.0 through 1.2.3 are affected. Only authenticated administrators can reach this feature. Install the fixed Gateway version 1.2.4.';
    const second = 'The second issue is CVE-2026-22222. Agent version 8.1 is affected. The vendor has not observed exploitation. Install the fixed Agent version 8.2.';
    const excerpt = selectOperationalExcerpt(`Vendor published an update. Teams should assess applicability. ${first} ${background} ${second}`, 800);
    expect(excerpt).toContain(first);
    expect(excerpt).toContain(second);
    expect(excerpt.indexOf(first)).toBeLessThan(excerpt.indexOf(second));
    expect(excerpt).toContain('[…]');
    expect(excerpt.length).toBeLessThanOrEqual(800);
  });

  test('unrelated CVE mentions do not crowd out the selected operational context', () => {
    const core = 'The issue is CVE-2026-12345. Gateway version 1.2.3 is affected. Install the fixed version 1.2.4.';
    const noise = Array.from({ length: 100 }, (_, index) => `Related archive story mentions CVE-2025-${10000 + index}.`).join(' ');
    const excerpt = selectOperationalExcerpt(`Vendor published an update. Teams should assess applicability. ${core} ${background} ${noise}`, 500);
    expect(excerpt).toContain(core);
    expect(excerpt).not.toMatch(/CVE-2025-/);
    expect(excerpt.length).toBeLessThanOrEqual(500);
  });

  test('does not retain an orphaned fact when its complete nearby identity context exceeds the budget', () => {
    const identity = `The issue ${'with additional conditions '.repeat(20)}is CVE-2026-12345.`;
    const affected = 'Gateway version 1.2.3 is affected.';
    const excerpt = selectOperationalExcerpt(`Vendor published an update. Teams should assess applicability. ${identity} ${affected} ${background}`, 200);
    expect(excerpt).not.toContain(affected);
    expect(excerpt.length).toBeLessThanOrEqual(200);
  });
});

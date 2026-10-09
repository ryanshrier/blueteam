import { describe, expect, test } from '@jest/globals';
import { selectOperationalExcerpt, selectSourcePassage } from '../lib/evidence-quality.js';

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

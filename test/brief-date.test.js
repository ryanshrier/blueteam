import { describe, expect, test } from '@jest/globals';
import { formatBriefLabel, formatBriefPublishedAt, formatBriefPublication, archivePublishedAt } from '../public/modules/core/brief-date.js';
import { briefingLinkModel } from '../public/modules/wire/wire-format.js';

describe('shared Briefing publication labels', () => {
  test('edition dates retain their calendar day and same-day edition number', () => {
    expect(formatBriefLabel('brief-2026-07-24-02.md')).toBe('Jul 24, 2026 · brief 2');
    expect(formatBriefLabel('2026-07-24')).toBe('Jul 24, 2026');
    expect(formatBriefLabel('2026-02-30')).toBe('');
  });

  test('publication timestamps have a declared timezone and preserve the actual instant', () => {
    expect(formatBriefPublishedAt('2026-09-04T19:30:00-05:00')).toBe('Sep 5, 2026, 00:30 UTC');
    expect(formatBriefPublishedAt('2026-09-04T14:30:00Z')).toBe('Sep 4, 2026, 14:30 UTC');
  });

  test('missing or imprecise times never become an invented midnight publication', () => {
    for (const value of [undefined, '', '2026-09-04', '2026-09-04T14:30:00', 'invalid']) {
      expect(formatBriefPublishedAt(value)).toBe('');
    }
    expect(formatBriefPublication({ filename: 'brief-2026-07-24-02.md' })).toBe('Briefing · Jul 24, 2026 · brief 2');
    expect(formatBriefPublication()).toBe('Briefing date unavailable');
  });

  test('known publication time takes precedence over the archive filename', () => {
    expect(formatBriefPublication({ generatedAt: '2026-09-05T00:30:00Z', filename: 'brief-2026-09-04.md' }))
      .toBe('Briefing published Sep 5, 2026, 00:30 UTC');
  });

  test('a recently copied legacy archive never acquires a new publication time', () => {
    const archive = { filename: 'brief-2026-07-24.md', generatedAt: '2026-09-04T14:30:00Z', meta: null };
    expect(archivePublishedAt(archive)).toBeNull();
    expect(formatBriefPublication({ filename: archive.filename, generatedAt: archivePublishedAt(archive) }))
      .toBe('Briefing · Jul 24, 2026');
    expect(archivePublishedAt({ ...archive, meta: { generated_at: '2026-07-24T12:00:00Z' } }))
      .toBe('2026-07-24T12:00:00Z');
    expect(archivePublishedAt({ ...archive, meta: { generated_at: 'unknown' } })).toBeNull();
  });
});

describe('Wire saved Briefing link', () => {
  test('an archived edition is dated honestly and opens exactly the named edition', () => {
    expect(briefingLinkModel({ filename: 'brief-2026-07-24-02.md', date: '2026-07-24' })).toEqual({
      text: 'Latest briefing · Jul 24, 2026 · brief 2 →',
      href: '/briefing/brief-2026-07-24-02.md',
    });
  });

  test('a missing Briefing yields no link; missing date never implies today', () => {
    expect(briefingLinkModel(null)).toBeNull();
    expect(briefingLinkModel({})).toEqual({ text: 'Latest briefing →', href: '/briefing' });
  });
});

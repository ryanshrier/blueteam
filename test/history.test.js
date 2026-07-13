import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractBluf, extractSignalTitles, extractContinuityContext, loadRecentBriefs, localDateISO, briefDateFromFilename } from '../lib/history.js';

const SAMPLE_BRIEF = `# THREAT LANDSCAPE BRIEFING
### 2026-06-12 · Friday

## BLUF

Edge device exploitation has shifted from opportunistic to systematic — three VPN vendors have actively exploited flaws in the same week.

---

## KEY JUDGMENTS

### Signal 1 — [Horizon 1] VPN appliance zero-day under mass exploitation
**Assessment:** Exploitation moved from targeted to mass scanning within 48 hours.
**Confidence:** High (reported across three distinct sources)

### Signal 2 — [Horizon 2] Cyber insurance carriers tighten edge-device requirements
**Assessment:** Renewal questionnaires now ask for edge inventory.

---

## DEVELOPING SITUATIONS

### Identity provider session token abuse
**Trajectory:** Accelerating — moving from research to crimeware.
**Watch criteria:** Escalate when a public PoC lands.

---

## WATCHLIST — NEXT 72 HOURS

- CISA adds CVE-2026-11111 to KEV
- Vendor ships out-of-band patch
`;

describe('extractBluf', () => {
  test('extracts the BLUF paragraph from an H2 section', () => {
    const bluf = extractBluf(SAMPLE_BRIEF);
    expect(bluf).toContain('Edge device exploitation');
    expect(bluf.length).toBeLessThanOrEqual(300);
  });

  test('returns empty string when no BLUF exists', () => {
    expect(extractBluf('## Something else\n\nText.')).toBe('');
  });
});

describe('extractSignalTitles', () => {
  test('parses horizon and title from signal headings', () => {
    const signals = extractSignalTitles(SAMPLE_BRIEF);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toEqual({ horizon: 1, title: 'VPN appliance zero-day under mass exploitation' });
    expect(signals[1].horizon).toBe(2);
  });
});

describe('extractContinuityContext', () => {
  test('builds compact context with signals, situations, and watchlist', () => {
    const ctx = extractContinuityContext([
      { date: '2026-06-12-01', content: SAMPLE_BRIEF },
    ]);
    expect(ctx).toContain('PREVIOUS BRIEFINGS');
    expect(ctx).toContain('[2026-06-12-01]');
    expect(ctx).toContain('[H1] VPN appliance zero-day');
    expect(ctx).toContain('Identity provider session token abuse');
    expect(ctx).toContain('CISA adds CVE-2026-11111 to KEV');
  });

  test('returns empty string for no briefs', () => {
    expect(extractContinuityContext([])).toBe('');
  });

});

// #22 — same-day regenerations must not consume the whole continuity window.
// loadRecentBriefs should keep only the latest brief per calendar date.
describe('loadRecentBriefs — per-day dedup', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-history-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps only the latest counter per date, across distinct days', () => {
    // Five same-day regenerations (mirrors the real briefs/ dir on 2026-06-22),
    // plus one earlier day and one later day.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `brief-2026-06-22-${String(i).padStart(2, '0')}.md`), `content ${i}`);
    }
    writeFileSync(join(dir, 'brief-2026-06-21-01.md'), 'day before');
    writeFileSync(join(dir, 'brief-2026-06-23-01.md'), 'day after');

    const briefs = loadRecentBriefs(dir, 5);
    const dates = briefs.map(b => b.date);

    // Three distinct calendar days, no duplicates — and each `date` is the clean
    // calendar day with the -NN disambiguator stripped, not "2026-06-22-05".
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toEqual(['2026-06-23', '2026-06-22', '2026-06-21']);
    // The 2026-06-22 entry must be the LAST regeneration of that day (-05), not -01.
    const jun22 = briefs.find(b => b.filename.startsWith('brief-2026-06-22'));
    expect(jun22.filename).toBe('brief-2026-06-22-05.md');
    expect(jun22.content).toBe('content 5');
  });

  test('depth limits distinct days, not raw file count', () => {
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(dir, `brief-2026-06-22-${String(i).padStart(2, '0')}.md`), 'x');
    }
    writeFileSync(join(dir, 'brief-2026-06-21-01.md'), 'x');
    writeFileSync(join(dir, 'brief-2026-06-20-01.md'), 'x');

    const briefs = loadRecentBriefs(dir, 2);
    expect(briefs).toHaveLength(2);
  });

  test('depth zero disables continuity instead of returning one brief', () => {
    writeFileSync(join(dir, 'brief-2026-06-23-01.md'), 'x');
    expect(loadRecentBriefs(dir, 0)).toEqual([]);
  });
});

// Date extraction must strip the optional -NN disambiguator WITHOUT eating the
// day. A naive `.replace(/(-\d+)?\.md$/, '')` over-matches a suffixless name
// (brief-2026-07-01.md -> "2026-07"), corrupting /api/briefs, the landscape
// latest-brief summary, and the briefs.xml feed.
describe('briefDateFromFilename', () => {
  test('suffixless name yields the full date, not a truncated month', () => {
    expect(briefDateFromFilename('brief-2026-07-01.md')).toBe('2026-07-01');
  });

  test('same-day disambiguator suffix is stripped, day preserved', () => {
    expect(briefDateFromFilename('brief-2026-07-01-2.md')).toBe('2026-07-01');
    expect(briefDateFromFilename('brief-2026-07-01-02.md')).toBe('2026-07-01');
    expect(briefDateFromFilename('brief-2026-07-01-15.md')).toBe('2026-07-01');
  });

  test('returns null for a name that is not a brief file', () => {
    expect(briefDateFromFilename('notes.md')).toBeNull();
    expect(briefDateFromFilename('brief-2026-07.md')).toBeNull();
    expect(briefDateFromFilename('brief-2026-07-01.txt')).toBeNull();
  });
});

// #73 — one shared local-date clock so filenames/dateline/weekday can't disagree.
describe('localDateISO', () => {
  test('formats a Date as local YYYY-MM-DD, not the UTC date', () => {
    // 23:30 local time on a specific local day — toISOString() on this instant
    // would roll to the next UTC day for any timezone west of UTC+0:30h.
    const d = new Date(2026, 5, 30, 23, 30, 0); // months are 0-indexed: June 30
    expect(localDateISO(d)).toBe('2026-06-30');
  });

  test('pads single-digit month and day', () => {
    const d = new Date(2026, 0, 5, 12, 0, 0); // Jan 5
    expect(localDateISO(d)).toBe('2026-01-05');
  });

  test('defaults to now when no argument is given', () => {
    expect(localDateISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

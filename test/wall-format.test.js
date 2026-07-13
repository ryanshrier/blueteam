import { describe, test, expect } from '@jest/globals';
import {
  buildPages, JUDG_MAX, CONV_MAX, splitBluf, capitalizeFirst, cvssFrom, cleanSummary,
  relAge, relDayAge, isFresh, formatBriefDateStamp, isBriefStale, staleAfterSec,
  executiveSummaryModel,
} from '../public/modules/wall/wall-format.js';

describe('buildPages', () => {
  test('empty briefDoc + empty landscape yields the single empty fallback page', () => {
    expect(buildPages(null, {})).toEqual([{ kind: 'empty' }]);
    expect(buildPages(null, { kev: {}, signals: [] })).toEqual([{ kind: 'empty' }]);
  });

  test('skips a brief section whose array/field is empty or absent', () => {
    const pages = buildPages({ bluf: '', execSummary: [], stories: [], developing: [], convergence: [], watchlist: [] }, {});
    expect(pages).toEqual([{ kind: 'empty' }]);
  });

  test('emits bluf/execsummary but keeps the watchlist out of passive rotation', () => {
    const pages = buildPages({ bluf: 'The thesis.', execSummary: [{ lead: 'x' }], watchlist: ['a trigger'] }, {});
    expect(pages.map(p => p.kind)).toEqual(['bluf', 'execsummary']);
  });

  test('caps judgment pages at JUDG_MAX, one page per story with its index', () => {
    const stories = Array.from({ length: JUDG_MAX + 3 }, (_, i) => ({ title: `S${i}` }));
    const pages = buildPages({ stories }, {});
    const judgments = pages.filter(p => p.kind === 'judgment');
    expect(judgments).toHaveLength(JUDG_MAX);
    expect(judgments.map(p => p.idx)).toEqual([0, 1, 2, 3, 4]);
  });

  test('caps convergence pages at CONV_MAX so a long list cannot monopolize the rotation', () => {
    const convergence = Array.from({ length: CONV_MAX + 4 }, (_, i) => ({ intersection: `c${i}` }));
    const pages = buildPages({ convergence }, {});
    expect(pages.filter(p => p.kind === 'convergence')).toHaveLength(CONV_MAX);
  });

  test('kev page appears only when landscape.kev.recent is non-empty', () => {
    expect(buildPages(null, { kev: { recent: [] } }).map(p => p.kind)).toEqual(['empty']);
    expect(buildPages(null, { kev: { recent: [{ cve: 'CVE-1' }] } }).map(p => p.kind)).toEqual(['kev']);
  });

  test('wire page appears only when landscape.signals is non-empty, and always trails the brief', () => {
    const pages = buildPages({ bluf: 'Thesis.' }, { signals: [{ title: 'x' }] });
    expect(pages.map(p => p.kind)).toEqual(['bluf', 'wire']);
  });

  test('the brief leads, KEV and wire are demoted to the end, in that order', () => {
    const pages = buildPages(
      { bluf: 'Thesis.', watchlist: ['w'] },
      { kev: { recent: [{ cve: 'CVE-1' }] }, signals: [{ title: 'x' }] },
    );
    expect(pages.map(p => p.kind)).toEqual(['bluf', 'kev', 'wire']);
  });

  test('respects a custom judgMax/convMax override', () => {
    const stories = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];
    const pages = buildPages({ stories }, {}, { judgMax: 1 });
    expect(pages.filter(p => p.kind === 'judgment')).toHaveLength(1);
  });
});

describe('executiveSummaryModel', () => {
  test('separates situation from owner decisions and prints a shared deadline once', () => {
    const model = executiveSummaryModel([
      { lead: 'Threat:', tail: 'Two exploited surfaces require action.' },
      { lead: 'Exposure:', tail: 'Internet-facing routers and Joomla sites.' },
      { lead: 'Required decisions:', tail: 'Infrastructure — disable exposed web management — July 13, 19:00 CT; Application Security — patch affected extensions — July 13, 19:00 CT; Detection Engineering — verify ColdFusion status — July 13, 19:00 CT.' },
    ]);

    expect(model.threat).toEqual({ label: 'Threat', text: 'Two exploited surfaces require action.' });
    expect(model.exposure).toEqual({ label: 'Exposure', text: 'Internet-facing routers and Joomla sites.' });
    expect(model.commonDeadline).toBe('July 13, 19:00 CT');
    expect(model.decisions).toEqual([
      { owner: 'Infrastructure', action: 'disable exposed web management', deadline: 'July 13, 19:00 CT' },
      { owner: 'Application Security', action: 'patch affected extensions', deadline: 'July 13, 19:00 CT' },
      { owner: 'Detection Engineering', action: 'verify ColdFusion status', deadline: 'July 13, 19:00 CT' },
    ]);
  });

  test('keeps mixed deadlines on their own decision rows', () => {
    const model = executiveSummaryModel([
      { lead: 'Decisions required', tail: 'Infrastructure — isolate the host — today; Leadership — approve replacement — July 17, close of business' },
    ]);

    expect(model.commonDeadline).toBe('');
    expect(model.decisions.map(item => item.deadline)).toEqual(['today', 'July 17, close of business']);
  });

  test('accepts archived owner separators and broader due-date forms', () => {
    const model = executiveSummaryModel([
      { lead: 'Required decisions', tail: 'Infrastructure: isolate the host — COB; Application Security—patch the edge—2026-07-17; Detection Engineering - validate telemetry - Friday' },
    ]);

    expect(model.decisions).toEqual([
      { owner: 'Infrastructure', action: 'isolate the host', deadline: 'COB' },
      { owner: 'Application Security', action: 'patch the edge', deadline: '2026-07-17' },
      { owner: 'Detection Engineering', action: 'validate telemetry', deadline: 'Friday' },
    ]);
  });

  test('retains every emitted owner action and marks an unstructured one as unassigned', () => {
    const tail = [
      'Team 1 — act — today', 'Team 2 — act — today', 'Team 3 — act — today',
      'Team 4 — act — today', 'Team 5 — act — today', 'Review the exception immediately',
    ].join('; ');
    const model = executiveSummaryModel([{ lead: 'Required decisions', tail }]);

    expect(model.decisions).toHaveLength(6);
    expect(model.decisions[5]).toEqual({ owner: 'Unassigned', action: 'Review the exception immediately', deadline: '' });
    expect(model.commonDeadline).toBe('');
  });

  test('preserves unfamiliar summary fields as situation context', () => {
    const model = executiveSummaryModel([{ lead: 'Business impact:', tail: 'Customer access may degrade.' }]);
    expect(model.context).toEqual([{ label: 'Business impact', text: 'Customer access may degrade.' }]);
    expect(model.decisions).toEqual([]);
  });
});

describe('splitBluf', () => {
  test('empty/absent text yields an empty headline and deck', () => {
    expect(splitBluf('')).toEqual({ headline: '', deck: '' });
    expect(splitBluf(undefined)).toEqual({ headline: '', deck: '' });
  });

  test('splits at the lead em-dash clause when the lead is headline-length (24-120 chars)', () => {
    const lead = 'Fortinet FortiOS is the week’s most urgent surface';   // 51 chars — inside [24,120]
    const text = `${lead} — two CVEs are actively exploited, while Klue widens exposure.`;
    const { headline, deck } = splitBluf(text);
    expect(headline).toBe(lead);
    expect(deck).toBe('Two CVEs are actively exploited, while Klue widens exposure.');
  });

  test('falls back to a sentence-boundary split (24-150 chars) when there is no clean dash break', () => {
    const text = 'This is a long enough lead sentence to count as headline length. And here is the second sentence with more detail.';
    const { headline, deck } = splitBluf(text);
    expect(headline).toBe('This is a long enough lead sentence to count as headline length.');
    expect(deck).toBe('And here is the second sentence with more detail.');
  });

  test('renders the whole thesis as the headline with no deck when neither break qualifies', () => {
    const text = 'Short.';
    expect(splitBluf(text)).toEqual({ headline: 'Short.', deck: '' });
  });

  test('a dash break outside the [24,120] window is ignored in favor of the sentence-boundary branch', () => {
    // The dash sits at index 2 — below the 24-char floor — so it must not be treated as the headline break.
    const text = 'Hi — this whole clause is actually one long headline-length sentence here. Then a second sentence follows with detail.';
    const { headline } = splitBluf(text);
    expect(headline).not.toBe('Hi');
  });
});

describe('capitalizeFirst', () => {
  test('capitalizes the first character, leaves the rest untouched', () => {
    expect(capitalizeFirst('two CVEs are exploited')).toBe('Two CVEs are exploited');
  });
  test('empty/falsy input passes through unchanged', () => {
    expect(capitalizeFirst('')).toBe('');
    expect(capitalizeFirst(undefined)).toBe(undefined);
  });
});

describe('cvssFrom', () => {
  test('extracts "CVSS X.X SEVERITY" from a freeform cveData string', () => {
    expect(cvssFrom({ cveData: 'CVE-2026-1234 · CVSS 9.8 (Critical) · exploited' })).toBe('CVSS 9.8 CRITICAL');
  });
  test('omits the severity suffix when absent', () => {
    expect(cvssFrom({ cveData: 'CVSS 5.5' })).toBe('CVSS 5.5');
  });
  test('missing/absent cveData yields an empty string, never throws', () => {
    expect(cvssFrom({})).toBe('');
    expect(cvssFrom(null)).toBe('');
    expect(cvssFrom({ cveData: { score: 9.8 } })).toBe('');
  });
});

describe('cleanSummary', () => {
  test('strips WordPress "The post ... appeared first on ..." boilerplate', () => {
    expect(cleanSummary('The real gist. The post Foo appeared first on Bar.')).toBe('The real gist.');
  });
  test('strips "Read more" / "Continue reading" tails', () => {
    expect(cleanSummary('The real gist. Read more at example.com')).toBe('The real gist.');
  });
  test('collapses whitespace and trims', () => {
    expect(cleanSummary('  a   b\n\nc  ')).toBe('a b c');
  });
  test('absent input yields an empty string', () => {
    expect(cleanSummary(undefined)).toBe('');
    expect(cleanSummary({ text: 'not yet normalized' })).toBe('');
  });
});

describe('relAge', () => {
  test('unparseable/absent date yields null', () => {
    expect(relAge('')).toBeNull();
    expect(relAge('not a date')).toBeNull();
    expect(relAge(undefined)).toBeNull();
  });
  test('sub-minute ages clamp to "1m ago", never "0m ago"', () => {
    expect(relAge(new Date(Date.now() - 5_000).toISOString())).toBe('1m ago');
  });
  test('minutes, hours, and days format on their own bands', () => {
    expect(relAge(new Date(Date.now() - 30 * 60_000).toISOString())).toBe('30m ago');
    expect(relAge(new Date(Date.now() - 5 * 3600_000).toISOString())).toBe('5h ago');
    expect(relAge(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3d ago');
  });
});

describe('relDayAge — honest day-granularity for date-only KEV timestamps', () => {
  test('a date-only string for today reads "today", never a fabricated hour/minute figure', () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    expect(relDayAge(todayStr)).toBe('today');
  });
  test('yesterday (by local calendar day) reads "yesterday"', () => {
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    expect(relDayAge(yStr)).toBe('yesterday');
  });
  test('older date-only strings read "Nd ago"', () => {
    const d = new Date(); d.setDate(d.getDate() - 10);
    const dStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(relDayAge(dStr)).toBe('10d ago');
  });
  test('a full ISO timestamp (not date-only) falls through to relAge, not day math', () => {
    const iso = new Date(Date.now() - 5 * 3600_000).toISOString();
    expect(relDayAge(iso)).toBe(relAge(iso));
  });
  test('never yields a negative or sub-day figure for a today-dated entry regardless of local timezone', () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const result = relDayAge(todayStr);
    expect(result).not.toMatch(/^-/);
    expect(result).not.toMatch(/m ago$|h ago$/);
  });
});

describe('isFresh', () => {
  test('true for a date within the 6h freshness window', () => {
    expect(isFresh(new Date(Date.now() - 3600_000).toISOString())).toBe(true);
  });
  test('false past the window, for absent, and for unparseable dates', () => {
    expect(isFresh(new Date(Date.now() - 7 * 3600_000).toISOString())).toBe(false);
    expect(isFresh(undefined)).toBe(false);
    expect(isFresh('not a date')).toBe(false);
  });
});

describe('formatBriefDateStamp', () => {
  test('formats a date-only brief date as "SAT 28 JUN" style, UTC-anchored', () => {
    // 2026-06-27 is a Saturday.
    expect(formatBriefDateStamp('2026-06-27')).toBe('SAT, JUN 27');
  });
  test('unparseable input yields an empty string, never throws', () => {
    expect(formatBriefDateStamp('not a date')).toBe('');
    expect(formatBriefDateStamp('')).toBe('');
  });
});

describe('isBriefStale', () => {
  test('false for a brief dated today', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(isBriefStale(today)).toBe(false);
  });
  test('true once the brief date is more than ~24h in the past', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    expect(isBriefStale(old)).toBe(true);
  });
  test('unparseable input is never stale (fails closed to "don\'t warn on garbage")', () => {
    expect(isBriefStale('not a date')).toBe(false);
  });
});

describe('staleAfterSec — derives the STALE threshold from the configured refresh cadence', () => {
  test('floors at 20 minutes regardless of a small/absent refreshMinutes', () => {
    expect(staleAfterSec(undefined)).toBe(20 * 60);
    expect(staleAfterSec(0)).toBe(20 * 60);
    expect(staleAfterSec(2)).toBe(20 * 60);
  });
  test('scales to 2x the configured cadence above the floor', () => {
    expect(staleAfterSec(30)).toBe(60 * 60);
    expect(staleAfterSec(60)).toBe(120 * 60);
  });
  test('never throws on a non-numeric refreshMinutes — falls back to the floor', () => {
    expect(staleAfterSec('not a number')).toBe(20 * 60);
    expect(staleAfterSec(null)).toBe(20 * 60);
  });
});

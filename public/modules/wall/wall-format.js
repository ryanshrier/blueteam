// BlueTeam.News — Wall view: pure data/format helpers, extracted from wall-view.js so
// they carry NO DOM dependency and can be unit-tested directly (test/wall-format.test.js).
// Follows the wire-format.js precedent (public/modules/wire/wire-format.js): the view
// layer imports these and wraps their output in markup / DOM writes; nothing here
// touches the document, window, or `location`.

// ── Rotation page-building: which broadsheet sections exist this cycle, and in
// what order. Pure over (briefDoc, landscape, caps) so buildPages' section-skipping
// and cap logic (JUDG_MAX/CONV_MAX — a long list can't monopolize the rotation) is
// directly testable without a mounted Wall. ──
export const JUDG_MAX = 5;   // judgment pages (one signal each), priority-ordered
export const CONV_MAX = 3;   // convergence pages — capped like the judgments

export function buildPages(briefDoc, landscape, { judgMax = JUDG_MAX, convMax = CONV_MAX } = {}) {
  const out = [];
  if (briefDoc) {
    if (briefDoc.bluf) out.push({ kind: 'bluf' });
    if (briefDoc.execSummary && briefDoc.execSummary.length) out.push({ kind: 'execsummary' });
    (briefDoc.stories || []).slice(0, judgMax).forEach((_, i) => out.push({ kind: 'judgment', idx: i }));
    if (briefDoc.developing && briefDoc.developing.length) out.push({ kind: 'developing' });
    (briefDoc.convergence || []).slice(0, convMax).forEach((_, i) => out.push({ kind: 'convergence', idx: i }));
    // The watchlist remains part of the saved brief and continuity context, but
    // not the passive Wall rotation. Its speculative five-item ledger duplicated
    // developing situations and diluted the stronger judgment/convergence arc.
  }
  // Computed-intel pages from the landscape, between the brief and the wire:
  // recently added to CISA KEV (newly confirmed exploited).
  if (landscape && landscape.kev && landscape.kev.recent && landscape.kev.recent.length) out.push({ kind: 'kev' });
  // The live wire is one demoted reference page at the end — the brief leads.
  if (landscape && (landscape.signals || []).length) out.push({ kind: 'wire' });
  return out.length ? out : [{ kind: 'empty' }];
}

// Split the single BLUF thesis into a front-page headline + standfirst deck. The
// brief's BLUF house style leads with the punchy claim, then em-dashes into the
// supporting detail ("X is the week's most urgent surface — two CVEs …, while Klue
// widens …"). Cutting at that first clause break makes the claim a short, large
// headline and the detail a deck one size down — which is also why a long BLUF no
// longer truncates: the load is split across two type sizes. Falls back to the
// whole thesis as the headline (no deck) when there is no clean break.
export function splitBluf(text) {
  const t = (text || '').trim();
  if (!t) return { headline: '', deck: '' };
  // Prefer the lead-clause em/en-dash break, but only when the lead reads as a
  // headline: long enough to be a claim, short enough not to be the whole thesis.
  const dash = t.search(/\s[—–]\s/);
  if (dash >= 24 && dash <= 120) {
    const deck = t.slice(dash).replace(/^\s*[—–]\s*/, '').trim();
    return { headline: t.slice(0, dash).trim(), deck: capitalizeFirst(deck) };
  }
  // Else split at the first sentence boundary if the lead sentence is headline-length.
  const period = t.search(/[.!?]\s+[A-Z(]/);
  if (period >= 24 && period <= 150) {
    return { headline: t.slice(0, period + 1).trim(), deck: t.slice(period + 1).trim() };
  }
  // No clean break — render the whole thesis as the lead, no deck.
  return { headline: t, deck: '' };
}

export function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function cvssFrom(s) {
  if (!s || typeof s.cveData !== 'string') return '';
  const m = s.cveData.match(/CVSS\s+([\d.]+)\s*(?:\(([A-Za-z]+)\))?/i);
  return m ? `CVSS ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}` : '';
}

// Strip RSS boilerplate so the wire gist reads as a clean fact.
export function cleanSummary(d) {
  return (typeof d === 'string' ? d : '')
    .replace(/\s*The post\b[\s\S]*?appeared first on[\s\S]*$/i, '')
    .replace(/\s*(Read more|Continue reading|The article)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function relAge(dateStr) {
  const t = dateStr ? Date.parse(dateStr) : NaN;
  if (Number.isNaN(t)) return null;
  const min = (Date.now() - t) / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// The CISA KEV catalog's dateAdded is DAY granularity (e.g. '2026-06-30'), so
// pushing it through relAge (which computes minute/hour deltas from Date.parse's
// UTC-midnight interpretation) fabricates precision the source data can't support:
// a "today" entry could read "added 14h ago", and in a UTC-ahead timezone a
// today-dated entry can even yield a negative delta that relAge's clamp prints as
// "added 1m ago". Detected by shape (a bare YYYY-MM-DD, no time component) and
// rendered as an honest day count using LOCAL calendar-day arithmetic — "today" /
// "yesterday" / "Nd ago" — never a fabricated sub-day figure. Non-date-only strings
// (a full ISO timestamp, if the source ever changes shape) fall through to relAge.
export function relDayAge(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return relAge(dateStr);
  const t = Date.parse(dateStr + 'T00:00:00');
  if (Number.isNaN(t)) return null;
  // Local calendar-day difference, not a millisecond/24h division — so a date
  // added "yesterday" 30 minutes ago local time still reads "yesterday", not
  // "today" or a fractional day.
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const startOfThat = new Date(t); startOfThat.setHours(0, 0, 0, 0);
  const days = Math.round((startOfToday - startOfThat) / (24 * 3600 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export function isFresh(dateStr) {
  const t = dateStr ? Date.parse(dateStr) : NaN;
  return !Number.isNaN(t) && (Date.now() - t) < 6 * 3600 * 1000;
}

// 'SAT 28 JUN' style stamp for the brief's own as-of date (a date-only
// string, e.g. '2026-06-28'), matching the folio date's weekday/day/month voice.
// Parsed as UTC-midnight (Date.parse's own interpretation of a bare date) purely
// for display — this is a calendar label, not an age computation, so timezone
// skew doesn't change which day it names.
export function formatBriefDateStamp(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).toUpperCase();
}

// The brief is "stale" for masthead purposes once it's more than ~24h past
// its own as-of date, independent of the feed pipeline's own staleness clock
// (updateLiveline's ageSec threshold): a brief can be old while the wire is fresh.
export function isBriefStale(dateStr) {
  const t = Date.parse(dateStr);
  return !Number.isNaN(t) && (Date.now() - t) > 24 * 3600 * 1000;
}

// The STALE threshold as a pure function of the configured refresh cadence:
// derived from analysisSettings.refreshMinutes (Zod-validated 2–120 in lib/config.js)
// rather than a bare hardcoded 20 minutes, with 20 min kept as the FLOOR so a fast
// cadence still gets a meaningful stale window. refreshMinutes is not yet served on
// the landscape payload (lib/landscape.js) — callers pass `undefined`/0 until it
// ships, which resolves to the floor, i.e. today's exact behavior.
export function staleAfterSec(refreshMinutes) {
  return Math.max(20, 2 * (Number(refreshMinutes) || 0)) * 60;
}

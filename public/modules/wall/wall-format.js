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

export function buildPages(
  briefDoc,
  landscape,
  { judgMax = JUDG_MAX, convMax = CONV_MAX, briefLoadError = false } = {}
) {
  const out = [];
  if (briefLoadError) out.push({ kind: 'brieferror' });
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

// Shape the prose-heavy Executive Summary into the Wall's command view. The
// saved brief stays untouched; this presentation pass separates the situation
// from the owner queue and collapses a shared deadline to one page-level clock.
export function executiveSummaryModel(items = []) {
  const rows = (Array.isArray(items) ? items : [])
    .map(item => ({
      label: String(item?.lead || '').replace(/\s*:\s*$/, '').trim(),
      text: String(item?.tail || '').trim(),
    }))
    .filter(item => item.label || item.text);

  const byLabel = pattern => rows.find(item => pattern.test(item.label));
  const threat = byLabel(/^threat$/i) || null;
  const exposure = byLabel(/^(?:exposure|at[- ]risk systems?)$/i) || null;
  const decisionSource = byLabel(/^(?:required decisions?|decisions? required|actions? required)$/i) || null;
  const reserved = new Set([threat, exposure, decisionSource].filter(Boolean));
  const context = rows.filter(item => !reserved.has(item));
  const decisions = splitExecutiveDecisions(decisionSource?.text || '');

  const deadlineKeys = decisions.map(item => normalizeDeadline(item.deadline));
  const commonDeadline = deadlineKeys.length > 0
    && deadlineKeys.every(Boolean)
    && deadlineKeys.every(key => key === deadlineKeys[0])
    ? decisions[0].deadline
    : '';

  return { threat, exposure, context, decisions, commonDeadline };
}

function splitExecutiveDecisions(text) {
  return String(text || '').split(/\s*;\s*/).map(clause => clause.trim()).filter(Boolean).map(clause => {
    // The brief contract uses spaced em dashes, but archived/imported editions
    // also contain en dashes, unspaced typographic dashes, spaced hyphens, and
    // `Owner: action` forms. Parse all without treating hyphens inside products
    // or CVE identifiers as separators.
    const ownerMatch = clause.match(/^(.+?)(?:\s*[—–]\s*|\s+-\s+|:\s+)(.+)$/);
    if (!ownerMatch) return { owner: 'Unassigned', action: clause, deadline: '' };

    const owner = ownerMatch[1].trim();
    const parts = ownerMatch[2].split(/\s*[—–]\s*|\s+-\s+/).map(part => part.trim()).filter(Boolean);
    let deadline = '';
    if (parts.length > 1 && looksLikeDeadline(parts[parts.length - 1])) {
      deadline = parts.pop().replace(/[.;]+$/, '').trim();
    }
    return { owner, action: parts.join(' — '), deadline };
  });
}

function looksLikeDeadline(value) {
  return /(?:\b(?:today|tomorrow|tonight|immediately|now|eod|cob|eow)\b|\b(?:this|next)\s+(?:shift|week|month|quarter)\b|\b(?:close|end) of (?:business|day|week)\b|\bwithin\s+\d+\s+(?:hours?|days?)\b|\b\d{1,2}:\d{2}\s*(?:[ap]m|[A-Z]{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\bQ[1-4]\s+\d{4}\b|\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b)/i.test(value);
}

function normalizeDeadline(value) {
  return String(value || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

// Split the single BLUF thesis into a front-page headline + standfirst deck. The
// brief's BLUF house style leads with the punchy claim, then em-dashes into the
// supporting detail ("X is the week's most urgent surface — two CVEs …, while Klue
// widens …"). Cutting at that first clause break makes the claim a short, large
// headline and the detail a deck one size down — which is also why a long BLUF no
// longer truncates: the load is split across two type sizes. Falls back to the
// whole thesis as the headline (no deck) when there is no clean break.
export function splitBluf(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { headline: '', deck: '' };

  // A BLUF can be structurally valid yet arrive as one long compound sentence.
  // Search the lead half for increasingly softer editorial breakpoints. The
  // fallback word break is intentionally reserved for genuinely long text: a
  // slightly imperfect but complete two-level read is safer than silently
  // clamping most of the day's thesis out of the cover.
  const min = 24;
  const max = 150;
  const firstMatch = (pattern, offset = 0) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    for (const match of t.matchAll(new RegExp(pattern.source, flags))) {
      const index = match.index + offset;
      if (index >= min && index <= max) {
        return { index, length: match[0].length - offset };
      }
      if (index > max) break;
    }
    return null;
  };

  const dash = firstMatch(/\s[—–]\s/);
  if (dash) return splitBlufAt(t, dash.index, dash.index + dash.length);

  const sentence = firstMatch(/[.!?](?=\s+[A-Z(])/);
  if (sentence) return splitBlufAt(t, sentence.index + 1, sentence.index + 1);

  const clause = firstMatch(/[;:](?=\s)/);
  if (clause) return splitBlufAt(t, clause.index, clause.index + 1);

  const conjunction = firstMatch(/,\s+(?=(?:while|but|and|yet|as|with|so|which|meaning)\b)/i);
  if (conjunction) return splitBlufAt(t, conjunction.index, conjunction.index + conjunction.length);

  const comma = firstMatch(/,\s+/);
  if (comma) return splitBlufAt(t, comma.index, comma.index + comma.length);

  if (t.length > 180) {
    let wordBreak = t.lastIndexOf(' ', 105);
    if (wordBreak < 70) wordBreak = t.indexOf(' ', 90);
    if (wordBreak >= min && wordBreak <= max) {
      // This is a typographic break inside one continuous sentence, not a new
      // sentence boundary. Preserve the source casing so the headline and deck
      // still read grammatically when scanned together.
      return splitBlufAt(t, wordBreak, wordBreak + 1, { capitalizeDeck: false });
    }
  }

  // A short thesis with no natural break remains one intact headline.
  return { headline: t, deck: '' };
}

function splitBlufAt(text, headlineEnd, deckStart, { capitalizeDeck = true } = {}) {
  const headline = text.slice(0, headlineEnd).replace(/[,;:\s]+$/, '').trim();
  const deck = text.slice(deckStart).trim();
  if (!headline || !deck) return { headline: text, deck: '' };
  return { headline, deck: capitalizeDeck ? capitalizeFirst(deck) : deck };
}

export function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Shape the single Act-now directive for the passive Wall. The Briefing contract
// emits `Owner — imperative — recommended target DATE`; splitting those fields
// lets the owner and target remain visible even when the imperative needs a
// visual clamp. Unknown/legacy prose remains intact rather than being guessed.
export function actionDisplayModel(actionShift) {
  if (!actionShift || typeof actionShift !== 'object') {
    return { owner: '', imperative: '', target: '' };
  }

  let imperative = String(actionShift.imperative || '').replace(/\s+/g, ' ').trim();
  let owner = String(actionShift.owner || '').replace(/\s+/g, ' ').trim();
  let target = '';
  if (!imperative) return { owner, imperative: '', target };

  const targetMatch = imperative.match(
    /(?:\s*[—–]\s*|\s+-\s+|;\s*|,\s*)(?:recommended\s+)?target(?:\s+date)?\s*:?\s+(.+?)\.?$/i
  );
  if (targetMatch?.[1]) {
    target = targetMatch[1].replace(/[.;]+$/, '').trim();
    imperative = imperative.slice(0, targetMatch.index).replace(/[\s—–-]+$/, '').trim();
  }

  if (!owner) {
    // The current contract uses a spaced dash. Do not treat a prose colon as an
    // owner separator: "Verify source: path" is an imperative, not team metadata.
    const ownerMatch = imperative.match(/^([^—–\n]{2,60}?)(?:\s*[—–]\s*|\s+-\s+)(.+)$/);
    if (ownerMatch) {
      owner = ownerMatch[1].trim();
      imperative = ownerMatch[2].trim();
    }
  }

  return { owner, imperative, target };
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

// Brief freshness is independent of the feed pipeline's own staleness clock
// (updateLiveline's ageSec threshold): a brief can be old while the wire is fresh.
//
// Prefer the persisted generation timestamp when the archive API supplies it;
// that carries enough precision for the intended 24-hour freshness window. A
// bare edition date does not. Date.parse('YYYY-MM-DD') treats that calendar
// label as UTC midnight, which can make a same-local-day brief look >24h old in
// western time zones late in the evening. With date-only input, compare LOCAL
// calendar days instead: today's edition is current, an earlier edition is stale.
export function isBriefStale(dateStr, generatedAt = null, nowMs = Date.now()) {
  const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isNaN(generatedMs)) {
    return (nowMs - generatedMs) > 24 * 3600 * 1000;
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const editionDay = new Date(year, month, day);
    // Reject rollover dates such as 2026-02-30 rather than warning on garbage.
    if (
      editionDay.getFullYear() !== year
      || editionDay.getMonth() !== month
      || editionDay.getDate() !== day
    ) return false;

    const now = new Date(nowMs);
    const localToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return editionDay < localToday;
  }

  // Compatibility for legacy callers that supplied a full timestamp as the
  // first argument before generatedAt was available.
  const fallbackMs = dateStr ? Date.parse(dateStr) : NaN;
  return !Number.isNaN(fallbackMs) && (nowMs - fallbackMs) > 24 * 3600 * 1000;
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

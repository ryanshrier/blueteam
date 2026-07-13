// BlueTeam.News — briefing history: save, load, and continuity extraction.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SECTIONS, parseBluf, parseSignalTitles, section, splitEntries, bullets, stripMd } from './brief-schema.js';

/**
 * Server-LOCAL calendar date (YYYY-MM-DD), not UTC. A brief belongs to the
 * operator's day: saveBrief's filename/dateline, the prompt's {weekday}, and
 * the Monday/Friday/weekend day-mode selection must all agree on which day it
 * is. Mixing `toISOString()` (UTC) with local-time weekday/day-mode checks
 * self-contradicts for any operator west of UTC generating in the evening
 * (e.g. files as tomorrow's date, dated "Tuesday", after already switching to
 * Wednesday's day-mode). Exported so other callers (prompt building, the
 * brief route's genDate) can standardize on the same clock.
 */
export function localDateISO(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function saveBrief(historyDir, brief) {
  const date = localDateISO();
  let counter = 1;
  let filename;
  do {
    filename = `brief-${date}-${String(counter).padStart(2, '0')}.md`;
    counter++;
  } while (existsSync(join(historyDir, filename)));
  writeFileSync(join(historyDir, filename), brief, 'utf-8');
  return filename;
}

/**
 * The calendar date (YYYY-MM-DD) a brief filename belongs to, stripping the
 * optional `-NN` same-day disambiguator saveBrief appends. Returns null for a
 * name that isn't a brief file.
 *
 * Anchoring on a full YYYY-MM-DD capture is load-bearing: a naive
 * `.replace(/(-\d+)?\.md$/, '')` over-matches — for a suffixless
 * `brief-2026-07-01.md` the greedy `(-\d+)?` eats the day too, yielding
 * "2026-07". The validator (routes/brief.js) accepts both suffixed and
 * suffixless shapes, so date extraction has to as well.
 */
export function briefDateFromFilename(filename) {
  const m = /^brief-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/.exec(filename);
  return m ? m[1] : null;
}

export function loadRecentBriefs(historyDir, depth = 5) {
  if (!Number.isFinite(depth) || depth <= 0) return [];
  try {
    const files = readdirSync(historyDir)
      .filter(f => f.startsWith('brief-') && f.endsWith('.md'))
      .sort().reverse();

    // Keep only the LATEST brief per calendar date (filenames sort so the
    // highest -NN suffix for a date comes first in this reversed order), then
    // take `depth` distinct days. Same-day regenerations (multiple manual
    // refreshes) previously could fill the whole continuity window with near-
    // identical copies of a single day, starving multi-day trajectory tracking.
    const seenDates = new Set();
    const deduped = [];
    for (const f of files) {
      const date = briefDateFromFilename(f);
      if (seenDates.has(date)) continue;
      seenDates.add(date);
      deduped.push(f);
      if (deduped.length >= depth) break;
    }

    return deduped.map(f => ({
      filename: f,
      date: briefDateFromFilename(f),
      content: readFileSync(join(historyDir, f), 'utf-8'),
    }));
  } catch {
    return [];
  }
}

export function extractBluf(content) {
  return parseBluf(content);
}

/** Signal titles with horizon tags, for continuity and the wall. */
export function extractSignalTitles(content) {
  return parseSignalTitles(content);
}

/**
 * Compact continuity context from recent briefings, injected into the next
 * generation so developing situations are tracked across days.
 */
export function extractContinuityContext(briefs) {
  if (briefs.length === 0) return '';

  const entries = briefs.map(b => {
    const c = b.content;

    const bluf = extractBluf(c);
    const signals = extractSignalTitles(c)
      .slice(0, 5)
      .map(s => `[H${s.horizon}] ${s.title}`);

    const situations = splitEntries(section(c, SECTIONS.developing))
      .map(part => stripMd(part.split('\n')[0] || ''))
      .filter(Boolean)
      .slice(0, 3);

    const watchlist = bullets(section(c, SECTIONS.watchlist)).slice(0, 4);

    let entry = `[${b.date}] BLUF: ${bluf}`;
    if (signals.length) entry += `\n  Signals: ${signals.join('; ')}`;
    if (situations.length) entry += `\n  Developing: ${situations.join('; ')}`;
    if (watchlist.length) entry += `\n  Watchlist: ${watchlist.join(' | ')}`;
    return entry;
  }).join('\n\n');

  return '\n\nPREVIOUS BRIEFINGS (for continuity tracking — reference, do not repeat):\n' + entries;
}

// Backtest harness — replays the CURRENT score model over the live headline
// archive and reports rank quality + calibration on REAL accumulated data. The
// GOLD fixture (check:scoring) proves the model on a hand-built spread; this
// proves it discriminates on the messy real stream: does it separate items, do
// KEV/critical items out-rank routine ones, is the distribution non-degenerate.
//
//   node scripts/backtest.mjs [days]      (also runnable as `npm run backtest`)
//
// Read-only (safe alongside the running server) and data-tolerant: a sparse or
// empty archive is reported, not failed — this is a measurement tool, not a gate.
// It re-scores from the archived fields (urgency, KEV, corroboration, horizon,
// published_at); CVSS/alert state aren't archived, so severity/relevance ride
// their band fallbacks — relative ordering by the available evidence still holds.
//
// KNOWN REPLAY-FIDELITY GAP (tracked, not silently absorbed): weight, cvss, and
// scoreComponents aren't archived at ingest time, so this replay recomputes
// authority as neutral (1.0) and severity from the band fallback only —
// distorting two of five axes vs. the score the item actually shipped with.
// Closing this needs a headline_archive column addition in lib/db.js and an
// archive-time capture in lib/refresher.js (outside this script's ownership).
// Recency is NOT similarly distorted: recencyUnit(headline) below scores each
// row's age at FIRST SIGHT (published_at vs. first_seen), not Date.now(), so a
// 13-day-old row is scored as fresh as it looked when it was first ranked.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scoreHeadline } from '../lib/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'watchfloor.db');
const days = Math.max(1, parseInt(process.argv[2], 10) || 14);
const TOP_K = 20; // "top-ranked on first sight" threshold for the outcome metric below

const config = {
  analysisSettings: {
    horizonWeights: { horizon1: 0.45, horizon2: 0.4, horizon3: 0.15 },
    scoring: {
      recencyHalfLifeHours: 30,
      axisWeights: { recency: 0.22, corroboration: 0.18, exploitation: 0.28, severity: 0.16, relevance: 0.16 },
    },
  },
};

let rows, kevByCVE;
try {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  rows = db.prepare(`
    SELECT title, source, horizon, score, urgency, is_kev, kev_cve, corroboration, published_at, first_seen
    FROM headline_archive
    WHERE last_seen >= datetime('now', '-' || ? || ' days')
  `).all(days);
  // date_added: when CISA confirmed the CVE as known-exploited — the outcome
  // label for the "did we call it early" metric below (kev_cache, not the
  // per-headline is_kev/kev_cve flags, since a headline can reference a CVE
  // that wasn't yet cataloged when we first archived it).
  kevByCVE = new Map(
    db.prepare('SELECT cve_id, date_added FROM kev_cache WHERE date_added IS NOT NULL').all()
      .map(r => [r.cve_id, r.date_added])
  );
  db.close();
} catch (err) {
  console.log(`\n[—] No readable archive at ${DB_PATH} (${err.code || err.message}).`);
  console.log('    Run the app + POST /api/refresh a few times to accumulate history, then retry.\n');
  process.exit(0);
}

if (rows.length < 5) {
  console.log(`\n[—] Archive has only ${rows.length} headline(s) in the last ${days}d — too sparse to measure.`);
  console.log('    Let the pipeline run a few cycles to accumulate history, then retry.\n');
  process.exit(0);
}

// scoreHeadline's recencyUnit scores age as (Date.now() - headline.date), which
// would grade a 13-day-old row as stone-cold regardless of how fresh it looked
// when it was actually ranked. We want "age AT FIRST SIGHT" instead: how old was
// this item, in hours, when the pipeline first archived it. Reconstruct that by
// feeding scoreHeadline a synthetic `date` shifted so `Date.now() - date` equals
// the true first-sight age (first_seen - published_at) — same recencyUnit code,
// faithful replay input.
function ageAtFirstSightDate(publishedAt, firstSeen) {
  const pub = publishedAt ? Date.parse(publishedAt) : NaN;
  const seen = firstSeen ? Date.parse(`${firstSeen.replace(' ', 'T')}Z`) : NaN;
  if (!Number.isFinite(pub) || !Number.isFinite(seen)) return publishedAt || null;
  const ageAtSightMs = Math.max(0, seen - pub);
  return new Date(Date.now() - ageAtSightMs).toISOString();
}

// CVE mentioned in the title, for headlines the live pipeline didn't tag as KEV
// at the time (kev_cve is null) — needed to join non-KEV-at-ingest rows against
// kev_cache below (a CVE cataloged AFTER we first saw the headline).
const CVE_IN_TITLE = /CVE-\d{4}-\d{4,7}/i;
function titleCVE(title) {
  return (String(title).match(CVE_IN_TITLE) || [])[0]?.toUpperCase() || null;
}

// Re-score every archived headline with the current model from its stored fields.
const scored = rows.map(r => ({
  title: r.title,
  horizon: r.horizon || 2,
  weight: 1.0,                       // per-feed authority weight isn't archived — neutral
  date: ageAtFirstSightDate(r.published_at, r.first_seen),
  urgency: r.urgency || 'routine',
  corroboration: r.corroboration || 1,
  isKEV: !!r.is_kev,
  kevCVE: r.kev_cve || null,
  _stored: r.score,
  _firstSeen: r.first_seen,
  _cve: r.kev_cve || titleCVE(r.title),
}));
for (const h of scored) scoreHeadline(h, config);
scored.sort((a, b) => b.score - a.score);

const scores = scored.map(h => h.score);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stdev = xs => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};

console.log(`\nBACKTEST — current score model replayed over ${scored.length} archived headlines (last ${days}d)`);
console.log('-'.repeat(74));

// ── Outcome-labeled precision: did the items that later proved important rank
// high when we FIRST saw them? An outcome-positive row is one whose CVE is in
// kev_cache with date_added AFTER first_seen — CISA confirmed active exploitation
// only after our pipeline had already archived the headline, so its rank at that
// moment is a genuine "did we call it early" test, not hindsight. Rank position
// is each row's index in `scored` (sorted by replayed score, descending) within
// this window — a same-run proxy for "rank on first sight," since we don't
// archive a per-day rank snapshot; see the header comment for that caveat.
const outcomePositive = scored
  .map((h, rank) => ({ h, rank }))
  .filter(({ h }) => h._cve && kevByCVE.has(h._cve) && h._firstSeen &&
    Date.parse(kevByCVE.get(h._cve)) > Date.parse(`${h._firstSeen.replace(' ', 'T')}Z`));

console.log('OUTCOME-LABELED PRECISION — KEV-confirmed-after-first-seen CVEs, replayed rank in this window');
if (outcomePositive.length === 0) {
  console.log(`  no outcome-positive rows in the last ${days}d (no archived CVE was added to the KEV catalog after we first saw it)`);
} else {
  const hits = outcomePositive.filter(({ rank }) => rank < TOP_K);
  const leadHours = outcomePositive.map(({ h }) =>
    (Date.parse(kevByCVE.get(h._cve)) - Date.parse(`${h._firstSeen.replace(' ', 'T')}Z`)) / 3_600_000
  ).sort((a, b) => a - b);
  const medianLead = leadHours[Math.floor(leadHours.length / 2)];
  console.log(`  top-${TOP_K} recall  ${hits.length}/${outcomePositive.length} outcome-positive rows ranked in the top ${TOP_K} on first sight`);
  console.log(`  lead time      median ${medianLead.toFixed(0)}h between first_seen and KEV date_added (n=${leadHours.length})`);
  for (const { h, rank } of outcomePositive.slice(0, 8)) {
    console.log(`    rank ${String(rank + 1).padStart(3)}  ${h._cve.padEnd(16)} ${h.title.slice(0, 46)}`);
  }
}

// Distribution + a coarse histogram (10 buckets of 0-100).
const sd = stdev(scores);
console.log(`distribution   min ${pct(scores, 0).toFixed(0)}  p25 ${pct(scores, 25).toFixed(0)}  median ${pct(scores, 50).toFixed(0)}  p75 ${pct(scores, 75).toFixed(0)}  max ${pct(scores, 100).toFixed(0)}   stdev ${sd.toFixed(1)}`);
const hist = Array(10).fill(0);
for (const s of scores) hist[Math.min(9, Math.floor(s / 10))]++;
const peak = Math.max(...hist, 1);
hist.forEach((n, i) => {
  const bar = '#'.repeat(Math.round((n / peak) * 40));
  console.log(`  ${String(i * 10).padStart(3)}-${String(i * 10 + 9).padStart(2)} ${bar.padEnd(40)} ${n}`);
});

// Calibration on real data — group means by the evidence that should move rank.
console.log('-'.repeat(74));
const groupMean = (pred) => mean(scored.filter(pred).map(h => h.score));
const kevMean = groupMean(h => h.isKEV), nonKevMean = groupMean(h => !h.isKEV);
const critMean = groupMean(h => h.urgency === 'critical');
const elevMean = groupMean(h => h.urgency === 'elevated');
const routMean = groupMean(h => h.urgency === 'routine');
console.log(`calibration    KEV ${kevMean.toFixed(1)} vs non-KEV ${nonKevMean.toFixed(1)}`);
console.log(`               urgency  critical ${critMean.toFixed(1)}  ·  elevated ${elevMean.toFixed(1)}  ·  routine ${routMean.toFixed(1)}`);

// Eyeball the extremes.
const line = h => `${String(h.score).padStart(3)}  ${h.title.slice(0, 56)}`;
console.log('-'.repeat(74));
console.log('top 3:\n  ' + scored.slice(0, 3).map(line).join('\n  '));
console.log('bottom 3:\n  ' + scored.slice(-3).map(line).join('\n  '));

// Hard invariants (fail) vs soft calibration signals (warn). Real data is noisy,
// so ordering is a WARN — only a broken/degenerate score is a hard failure.
const fails = [], warns = [];
for (const h of scored) {
  if (!(h.score >= 0 && h.score <= 100)) fails.push(`score out of [0,100]: ${h.score} — "${h.title.slice(0, 40)}"`);
  for (const [k, v] of Object.entries(h.scoreComponents || {})) {
    if (!(v >= 0 && v <= 1)) fails.push(`axis ${k} out of [0,1]: ${v} — "${h.title.slice(0, 40)}"`);
  }
}
if (sd < 3) warns.push(`scores are nearly degenerate (stdev ${sd.toFixed(1)}) — the model barely separates this set`);
if (scored.some(h => h.isKEV) && scored.some(h => !h.isKEV) && kevMean < nonKevMean) {
  warns.push(`KEV mean (${kevMean.toFixed(1)}) below non-KEV (${nonKevMean.toFixed(1)}) — exploitation signal inverted on this set`);
}
if (critMean && routMean && critMean < routMean) {
  warns.push(`critical mean (${critMean.toFixed(1)}) below routine (${routMean.toFixed(1)}) — urgency ordering inverted on this set`);
}

console.log('-'.repeat(74));
if (warns.length) console.log('[!] Calibration notes:\n' + warns.map(w => '  ' + w).join('\n'));
if (fails.length) {
  console.error('\n[X] Score-model invariant broken on real data:\n' + fails.map(f => '  ' + f).join('\n'));
  process.exit(1);
}
console.log(warns.length ? '\n[OK] Invariants hold; calibration notes above are advisory on this sample.' : '\n[OK] Invariants hold and calibration ordering is intact on real data.');

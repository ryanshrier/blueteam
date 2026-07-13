// Measurement harness for the score model. Ranks a small labeled GOLD fixture
// spanning the evidence space, prints the ranking with each item's evidence
// ledger + axis bars, and asserts the model's invariants (bounded score, [0,1]
// axes, the exploitation-evidence collapse) plus the expected band ordering —
// so a weight or model edit can't silently degrade ranking quality.
//
//   node scripts/score-report.mjs      (also runnable as `npm run check:scoring`)
//
// `band` = the expected rough rank tier (1 should rank at the top, 3 at the
// bottom). The model must preserve the band ordering by MEAN score; exact
// positions inside a band may shift as the model is tuned.

import { scoreHeadline } from '../lib/scoring.js';

const config = {
  analysisSettings: {
    horizonWeights: { horizon1: 0.45, horizon2: 0.4, horizon3: 0.15 },
    scoring: {
      recencyHalfLifeHours: 30,
      axisWeights: { recency: 0.22, corroboration: 0.18, exploitation: 0.28, severity: 0.16, relevance: 0.16 },
    },
  },
};

const now = Date.now();
const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();

const GOLD = [
  { band: 1, title: 'Cisco SD-WAN zero-day actively exploited (CVE-2026-20245)', horizon: 1, weight: 1.4, date: hoursAgo(3), urgency: 'critical', corroboration: 4, isKEV: true, cvssSeverityText: 'CVSS 9.8 (CRITICAL)', alertMatched: true, alertBoost: 5 },
  { band: 1, title: 'Confirmed breach at major SaaS vendor — customer data exposed', horizon: 1, weight: 1.2, date: hoursAgo(6), urgency: 'critical', corroboration: 3, isKEV: false, cveData: '' },
  { band: 2, title: 'New KEV addition: Lantronix code injection', horizon: 1, weight: 1.0, date: hoursAgo(20), urgency: 'elevated', corroboration: 1, isKEV: true, cvssSeverityText: 'CVSS 7.8 (HIGH)' },
  { band: 2, title: 'Patch Tuesday fixes 90 vulnerabilities', horizon: 2, weight: 1.1, date: hoursAgo(10), urgency: 'elevated', corroboration: 2, isKEV: false, cveData: '' },
  { band: 2, title: 'Ransomware crew shifts to a new initial-access broker', horizon: 2, weight: 1.0, date: hoursAgo(30), urgency: 'elevated', corroboration: 2 },
  { band: 3, title: 'Vendor announces a post-quantum roadmap', horizon: 3, weight: 1.0, date: hoursAgo(40), urgency: 'routine', corroboration: 1 },
  { band: 3, title: 'Think tank publishes a cyber-norms paper', horizon: 3, weight: 0.9, date: hoursAgo(96), urgency: 'routine', corroboration: 1 },
  { band: 3, title: 'Conference CFP opens for the security track', horizon: 2, weight: 0.7, date: hoursAgo(120), urgency: 'routine', corroboration: 1 },
];

for (const h of GOLD) scoreHeadline(h, config);
const ranked = [...GOLD].sort((a, b) => b.score - a.score);

const bar = (v, n = 10) => '#'.repeat(Math.round((Number(v) || 0) * n)).padEnd(n, '.');
console.log('\nSCORE REPORT — ranked by the normalized 0-100 evidence model\n' + '-'.repeat(74));
for (const h of ranked) {
  const c = h.scoreComponents;
  console.log(`${String(h.score).padStart(3)}  [band ${h.band}]  ${h.title.slice(0, 54)}`);
  console.log(`     exploit ${bar(c.exploitation)}  sev ${bar(c.severity)}  corrob ${bar(c.corroboration)}  rec ${bar(c.recency)}  rel ${bar(c.relevance)}`);
  console.log(`     ${h.scoreRationale || '—'}`);
}

const fails = [];
for (const h of GOLD) {
  if (!(h.score >= 0 && h.score <= 100)) fails.push(`score out of [0,100]: "${h.title}" = ${h.score}`);
  for (const [k, v] of Object.entries(h.scoreComponents)) {
    if (!(v >= 0 && v <= 1)) fails.push(`axis ${k} out of [0,1]: "${h.title}" = ${v}`);
  }
}
const kevCrit = GOLD.find(h => h.isKEV && h.urgency === 'critical');
if (kevCrit && kevCrit.scoreComponents.exploitation !== 1) {
  fails.push('exploitation axis did not collapse to 1 for a KEV + critical item (double-count regression)');
}
if (kevCrit && kevCrit.scoreComponents.severity < 0.9) {
  fails.push(`critical CVSS fixture did not exercise the severity axis (${kevCrit.scoreComponents.severity})`);
}
const mean = (b) => {
  const xs = GOLD.filter(h => h.band === b).map(h => h.score);
  return xs.reduce((a, c) => a + c, 0) / xs.length;
};
if (!(mean(1) > mean(2) && mean(2) > mean(3))) {
  fails.push(`band ordering broke: band1=${mean(1).toFixed(1)} band2=${mean(2).toFixed(1)} band3=${mean(3).toFixed(1)} (must strictly decrease)`);
}

console.log('-'.repeat(74));
console.log(`band means: 1=${mean(1).toFixed(0)}  2=${mean(2).toFixed(0)}  3=${mean(3).toFixed(0)}   (must strictly decrease)`);
if (fails.length) {
  console.error('\n[X] Score-model regression:\n' + fails.map(f => '  ' + f).join('\n'));
  process.exit(1);
}
console.log('\n[OK] Score-model invariants + gold-band ordering hold.');

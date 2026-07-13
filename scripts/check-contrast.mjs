// CI guard: enforce WCAG contrast on text tokens against the surfaces they
// render on — in BOTH themes (dark :root and light [data-theme="light"]) and
// including brand-as-text (--brand-text). An operations display carrying CISA deadlines
// must stay legible; this fails the build if a token regresses below its floor.
// Pure Node, no dependencies.
//
// Floors (WCAG 2.1): body/secondary/brand text → 4.5:1; tertiary/muted labels
// (larger sizes / decoration) → 3.0:1.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'public', 'tokens.css'), 'utf-8');

function blockBody(re) { const m = css.match(re); return m ? m[1] : ''; }
const rootBody = blockBody(/:root\s*\{([\s\S]*?)\n\}/);
const lightBody = blockBody(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);

function parseVars(body) {
  const map = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
const darkVars = parseVars(rootBody);
const lightVars = { ...darkVars, ...parseVars(lightBody) }; // light overrides the dark base

// Resolve a value, following one-level var(--x) references to a literal hex.
function resolve(map, val, depth = 0) {
  if (val == null || depth > 6) return null;
  const v = String(val).trim();
  const ref = v.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (ref) return resolve(map, map[ref[1]], depth + 1);
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null;
}

function toRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
function channel(c) { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function luminance(hex) { const [r, g, b] = toRgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function ratio(a, b) { const la = luminance(a), lb = luminance(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); }

const ALL_BG = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-card', 'bg-elevated'];
const TEXT_BG = ['bg-primary', 'bg-secondary', 'bg-card']; // surfaces brand-as-text actually renders on
const ROLES = [
  { token: 'text-primary', min: 4.5, bg: ALL_BG },
  { token: 'text-secondary', min: 4.5, bg: ALL_BG },
  { token: 'text-tertiary', min: 3.0, bg: ALL_BG },   // decoration / large text only
  { token: 'text-muted', min: 4.5, bg: ALL_BG },      // carries read-data (timestamps, KEV dates, sources) → AA
  { token: 'brand-text', min: 4.5, bg: ALL_BG },      // links/nav/wordmark render across every surface
];

// Tier/severity/KEV hues used AS TEXT (.c-chip tier badge, .cl-sev CVSS rating,
// .cl-kev/.cl-due KEV identity + deadline, .wire-priority, .toast.error) — the
// triage signal itself, not decoration. Operator-UI only (the Wall pins its own
// copy of each token in wall.css, so it isn't checked here).
const SIGNAL_ROLES = [
  { token: 'h1', min: 4.5, bg: ALL_BG },
  { token: 'h2', min: 4.5, bg: ALL_BG },
  { token: 'h3', min: 4.5, bg: ALL_BG },
  { token: 'sev-low', min: 4.5, bg: ALL_BG },
  { token: 'sev-medium', min: 4.5, bg: ALL_BG },
  { token: 'sev-high', min: 4.5, bg: ALL_BG },
  { token: 'sev-critical', min: 4.5, bg: ALL_BG },
  { token: 'kev-text', min: 4.5, bg: ALL_BG },
  { token: 'on-h1-soft', min: 4.5, bg: ALL_BG },
];

const failures = [];
const report = [];

for (const [theme, map] of [['dark', darkVars], ['light', lightVars]]) {
  report.push(`\n[${theme}]`);
  for (const { token, min, bg } of ROLES) {
    const fg = resolve(map, map[token]);
    if (!fg) { failures.push(`[${theme}] missing/unresolved token --${token}`); continue; }
    for (const bgToken of bg) {
      const bgHex = resolve(map, map[bgToken]);
      if (!bgHex) continue;
      const r = ratio(fg, bgHex);
      const ok = r >= min;
      report.push(`  ${ok ? '✓' : '✖'} --${token} on --${bgToken}: ${r.toFixed(2)}:1 (min ${min})`);
      if (!ok) failures.push(`[${theme}] --${token} on --${bgToken} = ${r.toFixed(2)}:1 (needs ${min}:1)`);
    }
  }
}

report.push('\n[signal colors as text — tier/severity/KEV badges]');
for (const [theme, map] of [['dark', darkVars], ['light', lightVars]]) {
  for (const { token, min, bg } of SIGNAL_ROLES) {
    const fg = resolve(map, map[token]);
    if (!fg) { failures.push(`[${theme}] missing/unresolved token --${token}`); continue; }
    for (const bgToken of bg) {
      const bgHex = resolve(map, map[bgToken]);
      if (!bgHex) continue;
      const r = ratio(fg, bgHex);
      const ok = r >= min;
      report.push(`  ${ok ? '✓' : '✖'} [${theme}] --${token} on --${bgToken}: ${r.toFixed(2)}:1 (min ${min})`);
      if (!ok) failures.push(`[${theme}] --${token} on --${bgToken} = ${r.toFixed(2)}:1 (needs ${min}:1)`);
    }
  }
}

// Tier pill ink — the active Wire filter pill renders --ink-on-h{n} ON the
// --h{n} fill. Each must clear AA (4.5:1) on its own bright tier fill. The tier
// hues are defined once in :root (theme-invariant), so the dark vars suffice.
report.push('\n[tier pills]');
for (const n of [1, 2, 3]) {
  const ink = resolve(darkVars, darkVars[`ink-on-h${n}`]);
  const fill = resolve(darkVars, darkVars[`h${n}`]);
  if (!ink || !fill) { failures.push(`missing --ink-on-h${n} or --h${n}`); continue; }
  const r = ratio(ink, fill);
  const ok = r >= 4.5;
  report.push(`  ${ok ? '✓' : '✖'} --ink-on-h${n} on --h${n}: ${r.toFixed(2)}:1 (min 4.5)`);
  if (!ok) failures.push(`--ink-on-h${n} on --h${n} = ${r.toFixed(2)}:1 (needs 4.5:1)`);
}

// CTA ink — the Generate button fills a FLAT --brand with --ink-on-brand (the old
// directional gradient dropped the ink to 3.70:1 on its darker bottom stop). The
// label must clear AA on that fill.
report.push('\n[CTA ink]');
{
  const ink = resolve(darkVars, darkVars['ink-on-brand']);
  const fill = resolve(darkVars, darkVars['brand']);
  if (!ink || !fill) { failures.push('missing --ink-on-brand or --brand'); }
  else {
    const r = ratio(ink, fill);
    const ok = r >= 4.5;
    report.push(`  ${ok ? '✓' : '✖'} --ink-on-brand on --brand: ${r.toFixed(2)}:1 (min 4.5)`);
    if (!ok) failures.push(`--ink-on-brand on --brand = ${r.toFixed(2)}:1 (needs 4.5:1)`);
  }
}

// Custom-accent brand-text (SIMULATED) — Settings recomputes --brand-text at
// runtime (theme.js brandTextFor + the index.html theme-init), so the shipped
// token can't catch a custom accent that lands below AA. Replicate that algorithm
// HERE (keep in sync with theme.js) and verify every selectable accent, once
// recomputed, clears 4.5:1 on EVERY surface it can render on, in both themes —
// the exact class the original P0 slipped through (the loop anchored to pure
// white instead of the real, darker ground).
const ACCENTS = ['#3b82f6', '#22d3ee', '#6d7cf0', '#14b8a6', '#64748b', '#d946ef'];
const WORST_LIGHT = [229, 233, 241]; // #e5e9f1 (--bg-tertiary) — darkest light surface
const WORST_DARK = [22, 28, 44];     // #161c2c (--bg-elevated) — lightest dark surface
const lumRgb = (rr, gg, bb) => 0.2126 * channel(rr) + 0.7152 * channel(gg) + 0.0722 * channel(bb);
function simBrandText(hex, theme) {
  let [r, g, b] = toRgb(hex);
  if (theme === 'light') {
    const bgL = lumRgb(...WORST_LIGHT);
    for (let i = 0; i < 60 && (bgL + 0.05) / (lumRgb(r, g, b) + 0.05) < 4.5; i++) { r = Math.round(r * 0.92); g = Math.round(g * 0.92); b = Math.round(b * 0.92); }
  } else {
    const cardL = lumRgb(...WORST_DARK);
    for (let i = 0; i < 60 && (lumRgb(r, g, b) + 0.05) / (cardL + 0.05) < 4.5; i++) { r = Math.min(255, Math.round(r * 1.08) + 1); g = Math.min(255, Math.round(g * 1.08) + 1); b = Math.min(255, Math.round(b * 1.08) + 1); }
  }
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
report.push('\n[custom accents — recomputed brand-text on every surface]');
for (const [theme, map] of [['dark', darkVars], ['light', lightVars]]) {
  let themeOk = true;
  for (const accent of ACCENTS) {
    const bt = simBrandText(accent, theme);
    for (const bgToken of ALL_BG) {
      const bgHex = resolve(map, map[bgToken]);
      if (!bgHex) continue;
      const r = ratio(bt, bgHex);
      if (r < 4.5) { themeOk = false; report.push(`  ✖ [${theme}] accent ${accent} → ${bt} on --${bgToken}: ${r.toFixed(2)}:1`); failures.push(`[${theme}] custom accent ${accent} → ${bt} on --${bgToken} = ${r.toFixed(2)}:1 (needs 4.5:1)`); }
    }
  }
  if (themeOk) report.push(`  ✓ [${theme}] all ${ACCENTS.length} accents clear 4.5:1 on every surface`);
}

console.log('Token contrast audit:' + report.join('\n'));
if (failures.length) {
  console.error('\n✖ Contrast check failed:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\n✓ Contrast check passed — text tokens meet their WCAG floor in both themes.');

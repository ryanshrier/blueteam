// CI guard: enforce WCAG contrast on text tokens against the surfaces they
// render on — in BOTH themes (dark :root and light [data-theme="light"]) and
// including brand-as-text (--brand-text). An operations display carrying CISA deadlines
// must stay legible; this fails the build if a token regresses below its floor.
// Pure Node, no dependencies.
//
// Normal text, including small metadata, clears 4.5:1. Field boundaries clear
// 3:1 against the field and its surrounding surface.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'public', 'tokens.css'), 'utf-8');
const landingCss = readFileSync(join(process.cwd(), 'docs', 'styles.css'), 'utf-8');

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

// Resolve a value, following var(--x) references and the simple opaque sRGB
// color-mix form used by the landing page's progressive-enhancement fallback.
function resolve(map, val, depth = 0) {
  if (val == null || depth > 6) return null;
  const v = String(val).trim();
  const ref = v.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (ref) return resolve(map, map[ref[1]], depth + 1);
  const mix = v.match(
    /^color-mix\(\s*in\s+srgb\s*,\s*(var\(\s*--[\w-]+\s*\)|#[0-9a-fA-F]{3,8})\s+(\d+(?:\.\d+)?)%\s*,\s*(var\(\s*--[\w-]+\s*\)|#[0-9a-fA-F]{3,8})\s*\)$/i,
  );
  if (mix) {
    const first = resolve(map, mix[1], depth + 1);
    const second = resolve(map, mix[3], depth + 1);
    if (!first || !second) return null;
    const weight = Math.min(100, Math.max(0, Number(mix[2]))) / 100;
    const firstRgb = toRgb(first);
    const secondRgb = toRgb(second);
    const mixed = firstRgb.map((channel, index) =>
      Math.round(channel * weight + secondRgb[index] * (1 - weight)),
    );
    return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  }
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

const ALL_BG = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-card', 'bg-elevated', 'bg-reading', 'bg-input', 'bg-selected', 'bg-hover'];
const ROLES = [
  { token: 'text-primary', min: 4.5, bg: ALL_BG },
  { token: 'text-secondary', min: 4.5, bg: ALL_BG },
  { token: 'text-tertiary', min: 4.5, bg: ALL_BG },   // small labels and metadata are normal text
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
  { token: 'warn', min: 4.5, bg: ALL_BG },
];

const failures = [];
const report = [];

for (const [theme, map] of [['dark', darkVars], ['light', lightVars]]) {
  for (const [inkToken, bgToken, min] of [
    ['text-selection', 'bg-text-selection', 4.5],
    ['text-diff', 'bg-diff-added', 4.5],
    ['text-diff', 'bg-diff-removed', 4.5],
    ['mark-added', 'bg-diff-added', 3],
    ['mark-removed', 'bg-diff-removed', 3],
  ]) {
    const ink = resolve(map, map[inkToken]), background = resolve(map, map[bgToken]);
    if (!ink || !background) { failures.push(`[${theme}] unresolved ${inkToken}/${bgToken}`); continue; }
    const value = ratio(ink, background);
    report.push(`  ${value >= min ? '✓' : '✖'} [${theme}] --${inkToken} on --${bgToken}: ${value.toFixed(2)}:1 (min ${min})`);
    if (value < min) failures.push(`[${theme}] --${inkToken} on --${bgToken} = ${value.toFixed(2)}:1 (needs ${min}:1)`);
  }
}

for (const [theme, map] of [['dark', darkVars], ['light', lightVars]]) {
  report.push(`\n[${theme} field boundaries]`);
  const border = resolve(map, map['border-control']);
  for (const token of ['bg-input', 'bg-primary', 'bg-secondary', 'bg-reading']) {
    const background = resolve(map, map[token]);
    if (!border || !background) { failures.push(`[${theme}] missing field token ${token}`); continue; }
    const value = ratio(border, background);
    report.push(`  ${value >= 3 ? '✓' : '✖'} --border-control on --${token}: ${value.toFixed(2)}:1 (min 3)`);
    if (value < 3) failures.push(`[${theme}] field boundary on --${token} = ${value.toFixed(2)}:1 (needs 3:1)`);
  }
}

// Navigation remains graphite in either reading theme and has its own ink roles.
for (const [theme, map] of [['dark', darkVars], ['light', lightVars]]) {
  report.push(`\n[${theme} navigation]`);
  for (const token of ['text-navigation', 'text-navigation-muted', 'link-navigation']) {
    const ink = resolve(map, map[token]);
    const background = resolve(map, map['bg-navigation']);
    if (!ink || !background) { failures.push(`[${theme}] missing navigation token ${token}`); continue; }
    const r = ratio(ink, background);
    report.push(`  ${r >= 4.5 ? '✓' : '✖'} --${token} on --bg-navigation: ${r.toFixed(2)}:1 (min 4.5)`);
    if (r < 4.5) failures.push(`[${theme}] --${token} on --bg-navigation = ${r.toFixed(2)}:1 (needs 4.5:1)`);
  }
}

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

// The public landing mirrors the application's reading palette in its own
// static stylesheet. Check the text/background combinations it
// actually renders so an accessible app theme cannot mask a marketing-page
// regression.
const landingRootBody = landingCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
const landingVars = parseVars(landingRootBody);
const LANDING_BACKGROUNDS = ['bg', 'bg-elev'];
const LANDING_ROLES = [
  { token: 'ink', min: 4.5 },
  { token: 'ink-2', min: 4.5 },
  { token: 'ink-3', min: 4.5 },
  { token: 'faint', min: 4.5 },
  { token: 'link', min: 4.5 },
];

report.push('\n[GitHub Pages landing palette]');
if (!landingRootBody) {
  failures.push('[landing] missing :root palette in docs/styles.css');
} else {
  for (const { token, min } of LANDING_ROLES) {
    const fg = resolve(landingVars, landingVars[token]);
    if (!fg) {
      failures.push(`[landing] missing/unresolved token --${token}`);
      continue;
    }
    for (const background of LANDING_BACKGROUNDS) {
      const bgHex = resolve(landingVars, landingVars[background]);
      if (!bgHex) {
        failures.push(`[landing] missing/unresolved token --${background}`);
        continue;
      }
      const r = ratio(fg, bgHex);
      const ok = r >= min;
      report.push(`  ${ok ? '✓' : '✖'} --${token} on --${background}: ${r.toFixed(2)}:1 (min ${min})`);
      if (!ok) failures.push(`[landing] --${token} on --${background} = ${r.toFixed(2)}:1 (needs ${min}:1)`);
    }
  }

  const ctaInk = '#04101f';
  const ctaFill = resolve(landingVars, landingVars.accent);
  if (!ctaFill) {
    failures.push('[landing] missing/unresolved CTA fill --accent');
  } else {
    const r = ratio(ctaInk, ctaFill);
    const ok = r >= 4.5;
    report.push(`  ${ok ? '✓' : '✖'} CTA ink ${ctaInk} on --accent: ${r.toFixed(2)}:1 (min 4.5)`);
    if (!ok) failures.push(`[landing] CTA ink ${ctaInk} on --accent = ${r.toFixed(2)}:1 (needs 4.5:1)`);
  }
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
const WORST_LIGHT = toRgb(resolve(lightVars, lightVars['bg-tertiary']));
const WORST_DARK = toRgb(resolve(darkVars, darkVars['bg-elevated']));
const lumRgb = (rr, gg, bb) => 0.2126 * channel(rr) + 0.7152 * channel(gg) + 0.0722 * channel(bb);
function simBrandText(hex, theme) {
  // The runtime removes the inline override for the shipped blue, preserving
  // the intentionally higher-contrast CSS value for the current theme.
  if (hex === '#3b82f6') {
    const map = theme === 'light' ? lightVars : darkVars;
    return resolve(map, map['brand-text']);
  }
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

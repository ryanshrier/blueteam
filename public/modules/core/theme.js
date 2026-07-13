// Blue Team — theme + accent. Dark is the default; light mode and a custom
// accent are operator preferences kept in localStorage and applied to <html>.
// The FOUC-free first paint is handled by an inline <head> script in index.html;
// this module owns the interactive set/persist path used by the Settings panel.

const THEME_KEY = 'bt-theme';
const ACCENT_KEY = 'bt-accent';
export const DEFAULT_ACCENT = '#3b82f6'; // IBM blue — the Blue Team brand

// Brand-chrome accents, deliberately disjoint from the load-bearing signal
// palette (horizon h1–h4 + condition levels) so brand chrome can never be
// mistaken for a severity cue. IBM Blue leads and is the shipped default.
export const ACCENTS = [
  { name: 'IBM Blue', hex: '#3b82f6' },
  { name: 'Signal Cyan', hex: '#22d3ee' },
  { name: 'Indigo', hex: '#6d7cf0' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Slate', hex: '#64748b' },
  { name: 'Fuchsia', hex: '#d946ef' },
];

// Hexes the accent must never collapse onto — they MEAN something elsewhere
// on screen (horizon hues + condition levels). Deny-by-default.
const SIGNAL_HEXES = new Set(['#f87171', '#06b6d4', '#fbbf24', '#a78bfa', '#38bdf8', '#34d399', '#fb923c']);

function validAccent(hex) {
  hex = (hex || '').toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) && !SIGNAL_HEXES.has(hex) ? hex : null;
}

// The operator's PREFERENCE — one of 'system' | 'light' | 'dark'. 'system'
// follows the OS via prefers-color-scheme; the two explicit values pin a theme.
// An absent key (a fresh install, or a store predating this default) resolves to 'system'
// — the SAME default the inline #theme-init boot uses — so the Settings segment
// and the actually-rendered theme can never disagree (the earlier 'dark' fallback
// here rendered light on a light-OS box while the segment still read Dark). Dark
// stays the fallback whenever the OS expresses no or a dark preference.
export function getThemePreference() {
  const v = localStorage.getItem(THEME_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

function systemPrefersLight() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

// getTheme() is the RESOLVED theme ('light'|'dark') — what actually renders and
// what brandText computes against. It reads the dataset the inline boot / applyTheme
// wrote, falling back to resolving the preference (system → OS) so it is correct
// even before applyTheme has run this session.
export function getTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  const pref = getThemePreference();
  if (pref === 'system') return systemPrefersLight() ? 'light' : 'dark';
  return pref;
}

export function getAccent() {
  return validAccent(localStorage.getItem(ACCENT_KEY)) || DEFAULT_ACCENT;
}

function relLum(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Brand AS TEXT. Light theme: darken the accent until it clears 4.5:1 on the
// REAL light ground --bg-secondary (#eef1f7) — NOT pure white, which stops the
// loop ~0.3 ratio early and ships nav/links/wordmark below AA. Dark theme: a
// bright accent already clears AA, but a muted one (e.g. Slate) doesn't —
// brighten it until it clears 4.5:1 on the lightest card (#0e1320).
function brandTextFor(hex, theme) {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  if (theme === 'light') {
    const bgL = relLum(229, 233, 241); // #e5e9f1 (--bg-tertiary) — the DARKEST light surface brand-text renders on (worst case for dark text)
    for (let i = 0; i < 60 && (bgL + 0.05) / (relLum(r, g, b) + 0.05) < 4.5; i++) {
      r = Math.round(r * 0.92); g = Math.round(g * 0.92); b = Math.round(b * 0.92);
    }
  } else {
    const cardL = relLum(22, 28, 44); // #161c2c (--bg-elevated) — the LIGHTEST dark surface brand-text renders on (worst case for bright text)
    for (let i = 0; i < 60 && (relLum(r, g, b) + 0.05) / (cardL + 0.05) < 4.5; i++) {
      r = Math.min(255, Math.round(r * 1.08) + 1); g = Math.min(255, Math.round(g * 1.08) + 1); b = Math.min(255, Math.round(b * 1.08) + 1);
    }
  }
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Ink ON a brand-blue fill (button labels, active chips). The shipped dark ink
// suits a bright accent; a mid-dark custom accent (Indigo/Slate) needs white ink
// or the label drops below AA. Pick whichever clears the fill better.
function inkOnFor(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const L = relLum(r, g, b);
  const onWhite = 1.05 / (L + 0.05);
  const onDark = (L + 0.05) / (relLum(4, 16, 31) + 0.05); // #04101f — the shipped dark ink
  return onWhite > onDark ? '#ffffff' : '#04101f';
}

function syncBrandText() {
  // The DEFAULT accent's brand-text ships in CSS per theme (#1d4ed8 on light at
  // 6.7:1; var(--brand) on dark) — let it stand rather than recomputing a thinner
  // minimal-pass value (and never override it below AA). Only custom accents are
  // recomputed, against the real grounds.
  const accent = getAccent();
  if (accent === DEFAULT_ACCENT) {
    document.documentElement.style.removeProperty('--brand-text');
  } else {
    document.documentElement.style.setProperty('--brand-text', brandTextFor(accent, getTheme()));
  }
}

// One live matchMedia listener, registered only while the preference is 'system'.
// We hold the query + bound handler so we can remove it the moment the operator
// pins an explicit theme (otherwise an OS flip would clobber their choice).
let systemMql = null;
let systemListener = null;

function resolveAndPaint(resolved) {
  document.documentElement.dataset.theme = resolved;
  syncBrandText();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
    meta.setAttribute('content', bg || '#070a12');
  }
}

function unwatchSystem() {
  if (systemMql && systemListener) systemMql.removeEventListener('change', systemListener);
  systemMql = null;
  systemListener = null;
}

// pref is 'system' | 'light' | 'dark'. For 'system' we resolve from the OS and keep
// re-resolving on change; for the explicit values we pin the theme and drop any live
// listener. What we PERSIST is the preference itself (so 'system' survives reload and
// keeps tracking the OS), not the resolved theme.
export function applyTheme(pref) {
  const p = pref === 'system' || pref === 'light' || pref === 'dark' ? pref : 'dark';
  localStorage.setItem(THEME_KEY, p);
  if (p === 'system') {
    resolveAndPaint(systemPrefersLight() ? 'light' : 'dark');
    if (!systemMql && typeof matchMedia === 'function') {
      systemMql = matchMedia('(prefers-color-scheme: light)');
      systemListener = (e) => resolveAndPaint(e.matches ? 'light' : 'dark');
      systemMql.addEventListener('change', systemListener);
    }
  } else {
    unwatchSystem();
    resolveAndPaint(p);
  }
}

export function applyAccent(hex) {
  hex = validAccent(hex) || DEFAULT_ACCENT;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const s = document.documentElement.style;
  s.setProperty('--brand', hex);
  s.setProperty('--brand-rgb', `${r}, ${g}, ${b}`);
  s.setProperty('--ink-on-brand', inkOnFor(hex));
  localStorage.setItem(ACCENT_KEY, hex);
  syncBrandText();
}

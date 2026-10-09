import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const wallCss = readFileSync(new URL('../public/wall.css', import.meta.url), 'utf8');
const themeCss = readFileSync(new URL('../public/tokens.css', import.meta.url), 'utf8');

function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

describe('Wall Decision timing presentation', () => {
  test('uses a compact analytic fact table rather than an alert-like tier badge', () => {
    expect(wallCss).toMatch(
      /\.nb-jfacts\s*\{[^}]*border-top:\s*1px solid var\(--paper-rule-2\);[^}]*border-bottom:\s*1px solid var\(--paper-rule-2\);/s
    );
    expect(wallCss).toMatch(
      /\.nb-jfact\s*\{[^}]*grid-template-columns:\s*minmax\(82px,\s*0\.72fr\)\s*minmax\(0,\s*1\.28fr\);/s
    );
    expect(wallCss).toMatch(/\.nb-jdecision dd\s*\{\s*color:\s*var\(--paper-ink-2\);\s*\}/s);
    expect(wallCss).not.toMatch(/\.nb-jdisc\s*\{/);
    expect(wallCss).not.toMatch(/\.nb-tag\.urgent/);
  });

  test('keeps the target outside the clamped action text and groups evidence with reasoning', () => {
    expect(wallCss).toMatch(/\.nb-act-target\s*\{[^}]*display:\s*flex;[^}]*border-top:/s);
    expect(wallCss).toMatch(/\.nb-jevidence\s*\{[^}]*display:\s*flex;[^}]*border-top:/s);
  });

  test('allows long owner, action, and target tokens to wrap inside the judgment fold', () => {
    expect(wallCss).toMatch(/\.nb-act-owner\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(wallCss).toMatch(/\.nb-act-text\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(wallCss).toMatch(/\.nb-act-target strong\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

  test('sizes the actual BLUF headline and deck classes for mobile reading', () => {
    const mobile = wallCss;
    expect(mobile).toMatch(/body:not\(\.kiosk\) :is\([^)]*\.nb-cover-deck\)\s*\{\s*font-size:\s*17px;/);
    expect(mobile).toMatch(/body:not\(\.kiosk\) :is\([^)]*\.nb-cover-head\)\s*\{\s*font-size:\s*26px;/);
    expect(mobile).not.toMatch(/\.nb-cover-(?:bluf|headline)\b/);
  });

  test.each(['developing', 'convergence', 'kev', 'wire'])('%s metadata remains readable on the light Wall surface', kind => {
    const surface = themeCss.match(/:root\[data-theme="light"\]\s*\{[^}]*--bg-primary:\s*(#[\da-f]{6})/i)?.[1];
    const selector = `html[data-theme="light"] body.kiosk .nb-display-card[data-kind="${kind}"]`;
    const rule = wallCss.slice(wallCss.indexOf(selector) + selector.length).split('}')[0];
    const foreground = rule.match(/--topic-accent:\s*(#[\da-f]{6})/i)?.[1];
    expect(surface).toBeDefined();
    expect(wallCss).toContain(selector);
    expect(foreground).toBeDefined();
    const light = Math.max(luminance(surface), luminance(foreground));
    const dark = Math.min(luminance(surface), luminance(foreground));
    expect((light + .05) / (dark + .05)).toBeGreaterThanOrEqual(4.5);
  });

});

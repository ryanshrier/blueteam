import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const wallCss = readFileSync(new URL('../public/wall.css', import.meta.url), 'utf8');

describe('Wall Decision timing presentation', () => {
  test('uses a compact analytic fact table rather than an alert-like tier badge', () => {
    expect(wallCss).toMatch(
      /\.nb-jfacts\s*\{[^}]*border-top:\s*1px solid var\(--paper-rule-2\);[^}]*border-bottom:\s*1px solid var\(--paper-rule-2\);/s
    );
    expect(wallCss).toMatch(
      /\.nb-jfact\s*\{[^}]*grid-template-columns:\s*minmax\(82px,\s*0\.72fr\)\s*minmax\(0,\s*1\.28fr\);/s
    );
    expect(wallCss).toMatch(/\.nb-jdecision dd\s*\{\s*color:\s*var\(--paper-accent\);\s*\}/s);
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

  test('has explicit 720p density rules for six-row KEV and four-row Wire pages', () => {
    expect(wallCss).toMatch(/@media \(max-height:\s*820px\)[\s\S]*\.nb-kev-page\.row-count-6 \.nb-led-name\s*\{\s*display:\s*none;/);
    expect(wallCss).toMatch(/@media \(max-height:\s*820px\)[\s\S]*\.nb-item:not\(\.lead\) \.nb-dek,[\s\S]*display:\s*none;/);
  });
});

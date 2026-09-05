import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const appCss = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

describe('Briefing section spacing selectors', () => {
  test('the narrow reading grid cannot inherit a wider intrinsic content minimum', () => {
    expect(appCss).toMatch(/\.briefing-layout > \*\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(appCss).toMatch(/\.brief-content\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(appCss).not.toMatch(/\.briefing-layout\s*\{[^}]*grid-template-columns:\s*1fr\s*;/s);
  });
  test('native print hides the app only when the print preview is actually open', () => {
    expect(appCss).toContain('body:has(.np-overlay[open]) > *:not(.np-overlay)');
    expect(appCss).not.toMatch(/(?:^|\n)\s*body\s*>\s*\*:not\(\.np-overlay\)/);
  });
  test('gives the Sources heading enough specificity to override generic h2 rules', () => {
    expect(appCss).toMatch(/\.brief-content h2\.brief-sources-heading\s*\{[^}]*border-bottom:\s*0;[^}]*padding-bottom:\s*0;/s);
    expect(appCss).not.toMatch(/(?:^|\n)\.brief-sources-heading\s*\{/);
  });

  test('gives judgment headlines a distinct editorial step above body copy', () => {
    expect(appCss).toMatch(
      /\.brief-judgment-card\s*>\s*h3:first-child\s*\{[^}]*font-size:\s*clamp\(21px,\s*1\.2vw,\s*23px\);[^}]*line-height:\s*1\.24;/s
    );
    expect(appCss).toMatch(
      /@media\s*\(max-width:\s*560px\)[\s\S]*?\.brief-judgment-card\s*>\s*h3:first-child\s*\{[^}]*font-size:\s*20px;[^}]*line-height:\s*1\.27;/s
    );
    expect(appCss).toMatch(
      /@media\s*\(max-width:\s*560px\)[\s\S]*?\.brief-content \.bluf p\s*\{[^}]*font-size:\s*clamp\(21px,\s*5\.4vw,\s*22px\);/s
    );
    expect(appCss).toMatch(/\.brief-judgment-meta\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.45;/s);
    expect(appCss).toMatch(/\.brief-content \.the-line\s*\{[^}]*font-size:\s*19px;/s);
  });

  test('labels Decision timing instead of presenting an unexplained arrow', () => {
    expect(appCss).toMatch(/\.bjm-window\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*6px;/s);
    expect(appCss).toMatch(/\.bjm-window-label\s*\{[^}]*text-transform:\s*uppercase;/s);
    expect(appCss).toMatch(/\.bjm-window-label::after\s*\{\s*content:\s*' ·';\s*\}/);
    expect(appCss).not.toMatch(/\.bjm-window::before\s*\{[^}]*⟶/s);
  });
});

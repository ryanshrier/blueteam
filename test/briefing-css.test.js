import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const appCss = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

describe('Briefing section spacing selectors', () => {
  test('gives the Sources heading enough specificity to override generic h2 rules', () => {
    expect(appCss).toMatch(/\.brief-content h2\.brief-sources-heading\s*\{[^}]*border-bottom:\s*0;[^}]*padding-bottom:\s*0;/s);
    expect(appCss).not.toMatch(/(?:^|\n)\.brief-sources-heading\s*\{/);
  });
});


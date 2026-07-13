import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

const appCss = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

describe('Wire infotip cursors', () => {
  test('passive tooltip metadata uses the normal cursor without disabling infotips', () => {
    expect(appCss).toMatch(/\[data-tip\]\s*\{\s*cursor:\s*default;\s*\}/);
    expect(appCss).toMatch(/:is\(a, button, \[role="button"\]\)\[data-tip\]\s*\{\s*cursor:\s*pointer;\s*\}/);
    expect(appCss).not.toMatch(/cursor:\s*help/);
  });
});

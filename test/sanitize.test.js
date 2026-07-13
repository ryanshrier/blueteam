// Tests for public/modules/core/sanitize.js's escapeHtml — the plain-string escaper
// used throughout the frontend to safely interpolate feed/AI-derived text into
// innerHTML templates (headline titles, vendor names, watch-terms, etc).
//
// NOTE: this file does not test `sanitize()` (the DOMPurify allowlist), which
// is the higher-value XSS-boundary target. jest.config.js maps the absolute
// specifier '/vendor/purify.es.mjs' back to node_modules (moduleNameMapper),
// so the module resolves and loads under plain Node — but DOMPurify still
// needs a real DOM (window) to actually sanitize, and this repo runs
// testEnvironment: 'node'. Covering sanitize() itself needs a per-file
// `@jest-environment jsdom` docblock plus the `jest-environment-jsdom`
// devDependency, which is not installed here.
import { describe, test, expect } from '@jest/globals';
import {
  DRAFT_SANITIZE_CONFIG, escapeHtml, SANITIZE_CONFIG, SEARCH_SNIPPET_CONFIG,
} from '../public/modules/core/sanitize.js';

describe('sanitizer policy', () => {
  test('untrusted HTML cannot supply app identities, presentation hooks, data hooks, or ARIA overrides', () => {
    expect(SANITIZE_CONFIG.ALLOWED_ATTR).not.toEqual(expect.arrayContaining(['id', 'class']));
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
    expect(SEARCH_SNIPPET_CONFIG.ALLOWED_TAGS).toEqual(['mark']);
    expect(SEARCH_SNIPPET_CONFIG.ALLOWED_ATTR).toEqual([]);
    expect(DRAFT_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain('href');
    expect(DRAFT_SANITIZE_CONFIG.FORBID_ATTR).toContain('href');
  });
});

describe('escapeHtml', () => {
  test('escapes the five reserved HTML characters', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`))
      .toBe('&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
  });

  test('neutralizes a script tag so it cannot execute if injected into innerHTML', () => {
    const escaped = escapeHtml('<img src=x onerror="alert(1)">');
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
  });

  test('neutralizes a javascript: href attempt', () => {
    const escaped = escapeHtml(`<a href="javascript:alert(1)">click</a>`);
    expect(escaped).not.toContain('<a ');
    expect(escaped).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;');
  });

  test('is idempotent-safe on already-escaped input (re-escapes rather than decoding)', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });

  test('passes plain text through unchanged', () => {
    expect(escapeHtml('CVE-2026-1234 patched in Fortinet FortiOS')).toBe('CVE-2026-1234 patched in Fortinet FortiOS');
  });

  test('maps null/undefined/empty to an empty string without throwing', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('coerces a non-string value via String() — including a numeric 0', () => {
    // 0 is falsy but a real value: a score/count of zero must render "0", not
    // vanish. Guarding on `== null` instead of `!str` is what preserves it.
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(['<b>'])).toBe('&lt;b&gt;');
  });
});

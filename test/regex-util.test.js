import { expect, test } from '@jest/globals';
import { safeCompileRegExp } from '../lib/regex-util.js';

test.each(['^(a{1,3})+$', '^((?:a+))+$', '^(a?)+$', '^(a|ab)+$', '(a)\\1+',
  '^(?:a|aa)+$', '^(a|aa){1,30}$', '^(?:(?:a|aa))+$', '^(?:(a|aa)){2,}$',
])('rejects ambiguous repeated/backreference pattern %s before matching', pattern => {
  expect(safeCompileRegExp(pattern)).toBeNull();
});
test.each(['zero.?day', '(?:active|actively).?exploit', '\\bCVE-\\d{4}-\\d{4,7}\\b', '[(){}]+',
  '(?:a|aa)?', '(?:a|aa){0,1}', '(?:a|aa){1}', '(?:ab|cd){2,4}', '\\(a\\|aa\\)+',
  '(?:a+){0,1}', '(?:a+){1}', '(?:a+)?',
  '(?:zero.?day|vulnerabilit(?:y|ies)|flaws?)\\s+(?:(?:is|are|being)\\s+)?exploited',
])('retains ordinary operator patterns %s', pattern => {
  const isolated = safeCompileRegExp(pattern);
  expect(isolated).toMatchObject({ source: pattern, flags: 'i', configured: true });
  expect(isolated).not.toBeInstanceOf(RegExp);
  // Only this fixed test fixture compiles on the test thread. The public
  // descriptor must preserve both boolean matching and capture semantics.
  const expected = new RegExp(pattern, 'i');
  for (const input of ['zero-day', 'actively exploit', 'CVE-2026-12345', '(){}', 'a', 'aa', 'abab', '(a|aa)', 'vulnerability is exploited', 'no hit']) {
    expect(isolated.test(input)).toBe(expected.test(input));
    expect(input.match(isolated)).toEqual(input.match(expected) ? [...input.match(expected)] : null);
  }
});

test('invalid syntax still fails compilation without creating a main-thread regex', () => {
  expect(safeCompileRegExp('[')).toBeNull();
});

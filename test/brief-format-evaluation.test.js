import { test, expect } from '@jest/globals';
import { evaluateFormat, evaluateMutations, factAuditView, visibleText, reviewHtml } from '../scripts/lib/brief-format-evaluation.mjs';
import { authoredFormatCandidate } from './fixtures/brief-format-evaluation.js';

test('authored format reference preserves case-specific conditions without owner/target requirements', () => {
  const result = evaluateFormat(authoredFormatCandidate());
  expect(result.authoredChecksPassed).toBe(true);
  expect(result.factAudit.trustBlockers).toEqual([]);
  expect(result.diagnostics.ownerTargetLines).toBe(0);
  expect(result.diagnostics.stories).toBe(6);
  // Explicitly reveal the migration gap rather than weakening production gates.
  expect(result.productionCompatibility.canPublish).toBe(false);
  expect(result.productionCompatibility.readerJudgments).toBe(0);
});

test('negative controls catch lost meaning as well as numerically wrong facts', () => {
  const rows = evaluateMutations(authoredFormatCandidate());
  expect(rows.length).toBeGreaterThanOrEqual(12);
  expect(rows.filter(row => !row.detected)).toEqual([]);
  expect(rows.find(row => row.id === 'wrong-score').factualCaught).toBe(true);
  expect(rows.find(row => row.id === 'credentials-dropped').authoredCaught).toBe(true);
});

test('hidden content cannot satisfy visible editorial expectations', () => {
  const original = authoredFormatCandidate();
  const phrase = 'revoking or rotating exposed credentials, and ';
  const hidden = original.replace(phrase, `<!-- ${phrase} -->`);
  expect(evaluateFormat(hidden).authoredChecksPassed).toBe(false);
  expect(visibleText('text <!-- secret -->\n```\nhidden\n```')).not.toMatch(/secret|hidden/);
});

test('audit view does not create assignments or dates and review HTML escapes source text', () => {
  const projected = factAuditView(authoredFormatCandidate());
  expect(projected).not.toMatch(/Recommended actions|recommended target|Decision window/);
  expect(projected).toContain('**What happened:**');
  const html = reviewHtml('test', [{ label: 'source', text: '<script>alert(1)</script>' }], {});
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

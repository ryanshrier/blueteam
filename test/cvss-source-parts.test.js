import { describe, expect, test } from '@jest/globals';
import { recordCvssFacts } from '../lib/cvss.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief } from '../lib/validation.js';

const a = 'CVE-2026-12345', b = 'CVE-2026-54321';
const part = (kind, passage, cves = [], changes = {}) => ({ kind, passage, cves, quality: { substantive: true }, ...changes });
const source = sourceParts => ({ cves: new Set([a, b]), sourceParts,
  passage: sourceParts[0]?.passage || '', evidenceText: sourceParts.map(value => value.passage).join('\n') });
const metrics = record => recordCvssFacts(record).map(({ cve, score, version, provisional }) => ({ cve, score, version, provisional }));
const table = 'CVSS Version Base Score Base Severity Vector String 3.1 9.8 CRITICAL CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';

describe('CVSS evidence within separately captured source parts', () => {
  test('retains each part’s independent identity, version, and provisional status', () => {
    const record = source([
      part('feed-excerpt', 'The gateway flaw has CVSS v3.1 5.0.', [a]),
      part('article-excerpts', `${b} affects the console. Its provisional assessment is CVSS v4.0 9.8.`, [b]),
    ]);
    expect(metrics(record)).toEqual([
      { cve: a, score: 5, version: '3.1', provisional: false },
      { cve: b, score: 9.8, version: '4.0', provisional: true },
    ]);
  });

  test('an article metric cannot borrow a feed identity from the enclosing record', () => {
    const record = source([
      part('feed-excerpt', `${a} affects the gateway.`, [a]),
      part('article-excerpts', 'The console flaw has CVSS v3.1 9.8.'),
    ]);
    record.cves = new Set([a]);
    expect(metrics(record)).toEqual([{ cve: null, score: 9.8, version: '3.1', provisional: false }]);
  });

  test('an unbound table remains unbound even when another capture has one CVE', () => {
    expect(metrics(source([
      part('feed-excerpt', `${a} affects the gateway.`, [a]),
      part('article-excerpts', table),
    ]))).toEqual([{ cve: null, score: 9.8, version: '3.1', provisional: false }]);
    expect(metrics(source([
      part('feed-excerpt', `${a} affects the gateway.`, [a]),
      part('article-excerpts', `${b} affects the console. ${table}`, [b]),
    ]))).toEqual([{ cve: b, score: 9.8, version: '3.1', provisional: false }]);
  });

  test('conflicting historical scores within one part still require explicit local binding', () => {
    const record = source([
      part('feed-excerpt', 'Initial CVSS 9.8; revised CVSS 4.3.', [a]),
      part('article-excerpts', `${b}: CVSS 5.0.`, [b]),
    ]);
    expect(recordCvssFacts(record).map(({ cve, score }) => ({ cve, score }))).toEqual([
      { cve: null, score: 9.8 }, { cve: null, score: 4.3 }, { cve: b, score: 5 },
    ]);
  });

  test('non-substantive parts cannot supply metrics or trigger a flattened fallback', () => {
    const record = source([
      part('feed-excerpt', `${a}: CVSS 9.8.`, [a], { quality: { substantive: false } }),
      part('article-excerpts', `${b} affects the console.`, [b]),
    ]);
    expect(recordCvssFacts(record)).toEqual([]);
  });

  test('captured structured metrics keep precedence and preserve authority metadata', () => {
    const metric = { cve: a, score: 9.5, version: '4.0', source: 'vendor@example.com', type: 'Secondary', provisional: true };
    const record = { ...source([part('article-excerpts', `${a}: CVSS 9.8.`, [a])]), cvssMetrics: [metric] };
    expect(recordCvssFacts(record)).toEqual([metric]);
  });

  test.each([undefined, []])('legacy single-passage records keep their enclosing identity with parts %j', sourceParts => {
    expect(metrics({ cves: new Set([a]), evidenceText: 'The gateway flaw has CVSS v3.1 9.8.', sourceParts }))
      .toEqual([{ cve: a, score: 9.8, version: '3.1', provisional: false }]);
  });
});

describe('complementary source parts at the publication boundary', () => {
  const headline = { title: `${a} gateway advisory`, source: 'Vendor', date: '2026-10-09', link: 'https://vendor.example/advisory',
    passage: 'The gateway vulnerability has CVSS v3.1 5.0.',
    articleBody: `${b} affects the console. Its provisional rating is CVSS v4.0 9.8. Apply the console update.` };
  const citation = '[Vendor, October 9, 2026](https://vendor.example/advisory)';
  const audit = (claim, changes = {}) => validateBrief(`## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Gateway and console\n**What happened:** ${claim} ${citation}\n**Decision window:** 72 hours`,
    '2026-10-09', { publication: true, groundingManifest: buildGroundingManifest({ headlines: [{ ...headline, ...changes }] }), kevSet: new Set() })
    .issues.filter(issue => /CVSS/.test(issue.code));

  test('one exact publisher citation supports the independently bound facts in both captures', () => {
    expect(audit(`${a}: CVSS v3.1 5.0. ${b}: provisional CVSS v4.0 9.8.`)).toEqual([]);
    expect(audit(`${a}: CVSS v4.0 9.8. ${b}: CVSS v3.1 5.0.`).map(issue => issue.code))
      .toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH']));
  });

  test('a same-publisher article score without an identity cannot be assigned to the feed CVE', () => {
    expect(audit(`${a}: CVSS v3.1 9.8.`, { passage: `${a} affects gateways.`,
      articleBody: 'The console flaw has CVSS v3.1 9.8. Apply the console update.' }).map(issue => issue.code))
      .toContain('CVE_CVSS_MISMATCH');
  });
});

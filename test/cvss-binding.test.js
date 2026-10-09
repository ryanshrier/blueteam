import { describe, expect, test } from '@jest/globals';
import { bindCvssScores, cvssTextBlocks, recordCvssFacts } from '../lib/cvss.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief } from '../lib/validation.js';

const a = 'CVE-2026-12345';
const b = 'CVE-2026-54321';
const citation = '[Vendor, September 4, 2026](https://vendor.example/advisory)';
const evidence = `${a}: CVSS v3.1 5.0. ${b}: CVSS v3.1 9.8. Update affected gateways.`;
const pairs = (text, fallback = [a, b]) => bindCvssScores(text, fallback).map(({ cve, score }) => ({ cve, score }));
function audit(claim, { passage = evidence, field = 'What happened', heading = 'Verify gateways' } = {}) {
  const content = `## BLUF\nVerify affected gateways.\n## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] ${heading}\n**${field}:** ${claim}\n${field === 'What happened' ? '' : '**What happened:** Both gateway flaws require updates. '}${citation}\n**Decision window:** 72 hours`;
  return validateBrief(content, '2026-09-05', { publication: true, editorialStandard: 2,
    groundingManifest: buildGroundingManifest({ headlines: [{ source: 'Vendor', title: 'Gateway advisory',
      link: 'https://vendor.example/advisory', date: '2026-09-04', description: passage }] }), kevSet: new Set(),
  }).issues.filter(issue => /CVSS/.test(issue.code));
}

describe('explicit trailing CVE objects', () => {
  const claim = `CVSS v3.1 5.0 (${a}) and CVSS v3.1 9.8 (${b}).`;
  test('each parenthetical identity belongs to its own preceding score in claims and source facts', () => {
    expect(pairs(claim)).toEqual([{ cve: a, score: 5 }, { cve: b, score: 9.8 }]);
    expect(recordCvssFacts({ cves: new Set([a, b]), passage: claim }).map(({ cve, score }) => ({ cve, score })))
      .toEqual([{ cve: a, score: 5 }, { cve: b, score: 9.8 }]);
    expect(audit(claim)).toEqual([]);
    expect(audit(claim, { field: 'Assessment' })).toEqual([]);
  });
  test('wrong metrics cannot borrow the preceding object or its source score', () => {
    expect(audit(`CVSS v3.1 5.0 (${a}) and CVSS v3.1 5.0 (${b}).`))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CVE_CVSS_MISMATCH', message: expect.stringContaining(b) })]));
    expect(audit(`${a}: CVSS v3.1 9.8.`, { passage: `${claim} Update affected gateways.` }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CVE_CVSS_MISMATCH', message: expect.stringContaining(a) })]));
    expect(pairs(`CVSS v3.1 5.0 (${a}) and CVSS v3.1 9.8.`)).toEqual([{ cve: a, score: 5 }, { cve: null, score: 9.8 }]);
  });
  test('a complete trailing object takes precedence over an earlier identity', () => {
    expect(pairs(`${a} is separate from the flaw rated CVSS v3.1 9.8 (${b}).`)).toEqual([{ cve: b, score: 9.8 }]);
    expect(audit(`${a} is separate from the flaw rated CVSS v3.1 9.8 (${b}).`)).toEqual([]);
  });
  test.each([`(${a} and ${b})`, `(${a}/${b})`, `(${a}`])('plural or incomplete trailing objects remain unbound: %s', object => {
    expect(pairs(`${a} is separate from CVSS v3.1 9.8 ${object}.`)[0].cve).toBeNull();
    expect(audit(`${a} is separate from CVSS v3.1 9.8 ${object}.`).map(issue => issue.code)).toContain('CVE_CVSS_AMBIGUOUS');
  });
});

describe('soft wrapping retains explicit metric associations', () => {
  const wrapped = `${a} (SSRF;\nCVSS v3.1 5.0) and ${b} (command injection; CVSS v3.1 9.8).`;
  test.each(['What happened', 'Assessment'])('soft-wrapped %s is equivalent to its one-line paragraph', field => {
    expect(audit(wrapped.replace('\n', ' '), { field })).toEqual([]);
    expect(audit(wrapped, { field })).toEqual([]);
    expect(audit(wrapped, { field, passage: wrapped })).toEqual([]);
    const swapped = wrapped.replace('CVSS v3.1 5.0', 'CVSS v3.1 9.8').replace('injection; CVSS v3.1 9.8', 'injection; CVSS v3.1 5.0');
    expect(audit(swapped, { field }).filter(issue => issue.code === 'CVE_CVSS_MISMATCH')).toHaveLength(2);
  });
  test('explicit for and parenthetical objects can wrap without inheriting a previous object', () => {
    for (const claim of [
      `CVSS v3.1 5.0 for\n${a} and CVSS v3.1 9.8 for ${b}.`,
      `CVSS v3.1 5.0 (\n${a}) and CVSS v3.1 9.8 (${b}).`,
    ]) {
      expect(pairs(claim)).toEqual([{ cve: a, score: 5 }, { cve: b, score: 9.8 }]);
      expect(audit(claim, { field: 'Assessment' })).toEqual([]);
    }
  });
  test('a trailing parenthetical object cannot reach across a blank paragraph', () => {
    expect(pairs(`CVSS v3.1 5.0 (\n\n${a}) and CVSS v3.1 9.8 (${b}).`))
      .toEqual([{ cve: null, score: 5 }, { cve: b, score: 9.8 }]);
  });
  test.each(['\n\n', '\n**Assessment:** ', '\nAssessment: ', '\n- ', '\n### Separate issue\n', '\n---\n', '\n| '])('a hard boundary cannot supply another metric subject: %j', boundary => {
    expect(pairs(`${a} affects gateways${boundary}CVSS v3.1 9.8. ${b} affects consoles.`)[0].cve).toBeNull();
  });
  test('the whole-document metric check preserves fields, paragraphs and judgments', () => {
    const unbound = `${a} affects gateways.\n\nCVSS v3.1 9.8. ${b} affects consoles.`;
    expect(audit(unbound, { field: 'Assessment' }).map(issue => issue.code))
      .toEqual(expect.arrayContaining(['CVE_CVSS_AMBIGUOUS', 'FACT_CVSS_ASSOCIATION_UNVERIFIED']));
    expect(audit(`${a} affects gateways.\n**Defender impact:** CVSS v3.1 9.8. ${b} affects consoles.`, { field: 'Assessment' }).map(issue => issue.code))
      .toEqual(expect.arrayContaining(['CVE_CVSS_AMBIGUOUS', 'FACT_CVSS_ASSOCIATION_UNVERIFIED']));
  });
  test('paragraph grouping preserves physical starting lines and plain headings', () => {
    const text = `## KEY JUDGMENTS\n### Signal 1 — ${a}\n**Assessment:** ${a} (SSRF;\nCVSS v3.1 5.0).\n**What happened:** Update.\n\n### Signal 2 — ${b}\nCVSS v3.1 9.8.`;
    expect(cvssTextBlocks(text)).toEqual([
      { line: 0, text: '## KEY JUDGMENTS' }, { line: 1, text: `### Signal 1 — ${a}` },
      { line: 2, text: `**Assessment:** ${a} (SSRF; CVSS v3.1 5.0).` },
      { line: 4, text: '**What happened:** Update.' }, { line: 5, text: '' },
      { line: 6, text: `### Signal 2 — ${b}` }, { line: 7, text: 'CVSS v3.1 9.8.' },
    ]);
  });
  test('ambiguous plurals and multi-CVE sentence anaphora remain unbound', () => {
    for (const claim of [
      `${a} and ${b} have CVSS v3.1 9.8.`,
      `${a} affects gateways.\nIts rating is CVSS v3.1 9.8. ${b} affects consoles.`,
      `${a} affects gateways;\nanother flaw has CVSS v3.1 9.8. ${b} affects consoles.`,
    ]) expect(audit(claim).map(issue => issue.code)).toContain('CVE_CVSS_AMBIGUOUS');
  });
});

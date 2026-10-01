import { describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument, DomUtils } from 'htmlparser2';
import { MARKETING_BRIEF, MARKETING_SOURCES } from './visual/marketing-brief.js';
import { buildMarketingSampleReceipt } from './visual/marketing-brief-receipt.js';
import { validationSourceFromManifest } from '../lib/brief-drafts.js';
import { validateBrief, hasHardFail, hasTrustCriticalFailure } from '../lib/validation.js';
import { NEWSPAPER_CSS } from '../public/modules/briefing/brief-export.js';

const read = name => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');

describe('complete public synthetic sample', () => {
  test('ships the exact authored Markdown and its matching no-provider receipt', () => {
    const markdown = read('sample-briefing.md');
    const receipt = JSON.parse(read('sample-briefing.manifest.json'));
    expect(markdown).toBe(MARKETING_BRIEF);
    expect(receipt).toEqual(JSON.parse(readFileSync(new URL('./visual/marketing-brief.manifest.json', import.meta.url), 'utf8')));
    expect(receipt.outputSha256).toBe(createHash('sha256').update(markdown).digest('hex'));
    expect(receipt).toMatchObject({ synthetic: true, providerAttempts: [], modelUsed: 'synthetic-fixture' });
  });

  test('replays current publication checks against the saved receipt and records their actual result', () => {
    const markdown = read('sample-briefing.md');
    const receipt = JSON.parse(read('sample-briefing.manifest.json'));
    const result = validateBrief(markdown, receipt.edition.date, validationSourceFromManifest(receipt));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(hasHardFail(result.issues)).toBe(false);
    expect(hasTrustCriticalFailure(result.issues)).toBe(false);
    expect(receipt.judgmentEvidence).toEqual(result.judgmentEvidence);
    expect(receipt.validation).toHaveLength(1);
    expect(receipt.validation[0]).toMatchObject({
      draftSha256: receipt.outputSha256, valid: result.valid,
      warnings: result.warnings, issues: result.issues, coverage: result.coverage,
      editorialReviewStatus: 'not-reviewed',
    });
    expect(receipt.publicationValidation).toMatchObject({
      valid: result.valid, warnings: result.warnings, issues: result.issues,
      coverage: result.coverage, hardFail: false, trustFail: false, partial: false,
      editorialReviewStatus: 'not-reviewed',
    });
    expect(receipt).toEqual(buildMarketingSampleReceipt({ regeneratedAt: receipt.syntheticRegeneratedAt }));
    expect(receipt.grounding.urls).toEqual([]);
    expect(receipt.grounding.sources).toHaveLength(3);
    expect(receipt.grounding.sources.every(source => source.url === '' && source.quality.substantive)).toBe(true);
    expect(receipt.edition.date).toBe('2026-07-24');
    expect(Number.isFinite(Date.parse(receipt.syntheticRegeneratedAt))).toBe(true);
    expect(receipt.syntheticNote).toContain('not a real collection or generation');
  });

  test('replay catches unsupported confidence and a missing scenario confirmation even when the saved receipt says passed', () => {
    const receipt = JSON.parse(read('sample-briefing.manifest.json'));
    const changed = read('sample-briefing.md')
      .replace('**Confidence:** High —', '**Confidence:** Almost certain (95–99%) —')
      .replace(/\*\*Confirmation:\*\*[^\n]+\n/, '');
    const result = validateBrief(changed, receipt.edition.date, validationSourceFromManifest(receipt));
    expect(receipt.publicationValidation.valid).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'EVIDENCE_CONFIDENCE_REQUIRED', 'SCENARIO_DECISION_GAP',
    ]));
  });

  test('preserves the production print CSS, all three horizons, source passages, and working local downloads', () => {
    const html = read('sample-briefing.html');
    const tree = parseDocument(html);
    const elements = DomUtils.findAll(node => ['tag', 'script', 'style'].includes(node.type), tree.children);
    const body = elements.find(node => node.name === 'body');
    const text = DomUtils.textContent(body);
    expect(html).toContain(NEWSPAPER_CSS);
    expect(elements.filter(node => /\bbrief-judgment-card\b/.test(node.attribs.class || ''))).toHaveLength(3);
    for (const source of MARKETING_SOURCES) expect(text).toContain(source.description);
    for (const section of ['EXECUTIVE SUMMARY', 'KEY JUDGMENTS', 'DEVELOPING SITUATIONS', 'CONVERGENCE', 'WATCHLIST', 'SOURCES', 'Saved input receipt']) expect(text).toContain(section);
    expect(text).toContain('All sources and systems are fictional');
    expect(text).toContain('does not independently prove every claim');
    expect(text).not.toContain('AI-generated');
    expect(elements.filter(node => ['script', 'iframe', 'img', 'link'].includes(node.name))).toEqual([]);
    expect(elements.filter(node => node.name === 'main')).toHaveLength(1);
    const links = elements.filter(node => node.name === 'a').map(node => node.attribs.href);
    const contents = elements.find(node => node.name === 'nav' && node.attribs['aria-label'] === 'Sample sections');
    expect(contents).toBeDefined();
    const destinations = new Set(elements.map(node => node.attribs?.id).filter(Boolean));
    expect(links).toEqual(expect.arrayContaining(['sample-briefing.md', 'sample-briefing.manifest.json', 'sample-briefing.pdf']));
    for (const link of links) {
      if (link.startsWith('#')) { expect(destinations.has(link.slice(1))).toBe(true); continue; }
      expect(link).toMatch(/^[a-z0-9.-]+$/);
      expect(existsSync(fileURLToPath(new URL(`../docs/${link}`, import.meta.url)))).toBe(true);
    }
  });
});

import { describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument, DomUtils } from 'htmlparser2';
import { MARKETING_BRIEF, MARKETING_SOURCES } from './visual/marketing-brief.js';
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
    expect(links).toEqual(expect.arrayContaining(['sample-briefing.md', 'sample-briefing.manifest.json', 'sample-briefing.pdf']));
    for (const link of links) {
      if (link.startsWith('#')) continue;
      expect(link).toMatch(/^[a-z0-9.-]+$/);
      expect(existsSync(fileURLToPath(new URL(`../docs/${link}`, import.meta.url)))).toBe(true);
    }
  });
});

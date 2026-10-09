import { describe, expect, test } from '@jest/globals';
import { marked } from 'marked';
import { parseDocument } from 'htmlparser2';
import {
  buildGroundingManifest, citationUrlKey, safeSourceUrl, sourceUrlKey,
  isAllowedSourceUrl, findUnallowlistedMarkdownUrls, delinkUnallowlistedMarkdownUrls,
} from '../lib/grounding.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';
import { BRIEF_EVALUATION_CASES, referenceBrief, EVAL_DATE } from './fixtures/brief-evaluation.js';

const original = 'https://example.test/article?id=123&lang=en';
const manifestFor = link => buildGroundingManifest({ headlines: [{
  title: 'Gateway update', description: 'Gateway update fixes an authentication bypass.',
  source: 'Vendor', date: '2026-09-04', link,
}] });

describe('citation destination boundary', () => {
  test.each([
    `${original}&utm_context=SYNTHETIC_CONTEXT`,
    `${original}&utm_source=SYNTHETIC_CONTEXT`,
    `${original}&fbclid=SYNTHETIC_CONTEXT`,
    `${original}&%75tm_context=SYNTHETIC_CONTEXT`,
    `${original}&%66bclid=SYNTHETIC_CONTEXT`,
    `${original}#SYNTHETIC_CONTEXT`,
    `${original}#%53YNTHETIC_CONTEXT`,
    original.replace('https://', 'https://SYNTHETIC_CONTEXT:MARKER@'),
    original.replace('https://', 'https://%53YNTHETIC_CONTEXT@'),
    'https://example.test/article?lang=en&id=123',
    'https://example.test/article?id=123&lang=en&lang=other',
    'https://example.test/article/?id=123&lang=en',
    'https://example.test/article?id=123%26lang=en',
    `${original}&amp;utm_context=SYNTHETIC_CONTEXT`,
    `${original}&#38;utm_context=SYNTHETIC_CONTEXT`,
  ])('rejects an uncaptured complete URL: %s', candidate => {
    const manifest = manifestFor(original);
    expect(candidate).not.toBe(original);
    expect(isAllowedSourceUrl(candidate, manifest)).toBe(false);
    const markdown = `[Vendor, September 4, 2026](${candidate})`;
    expect(findUnallowlistedMarkdownUrls(markdown, manifest)).toEqual([candidate]);
    const safe = delinkUnallowlistedMarkdownUrls(markdown, manifest);
    expect(safe).not.toContain(candidate);
    expect(marked.parse(safe)).not.toMatch(/<a\s/i);
  });

  test.each([
    'http://example.test/article',
    'https://example.test/article?utm_source=feed#mitigation',
    'https://example.test/article?q=affected%20versions&lang=en',
    'https://example.test:8443/article?tag=a&tag=b',
    'https://example.test/article?x=literal&amp;term=value',
    'https://example.test/article?x=%26encoded%3Dvalue',
    'https://example.test/article#CVE-2026-12345',
  ])('retains the complete captured URL and its source identity: %s', url => {
    const manifest = manifestFor(url);
    const promptCopy = url.replace(/&/g, '&amp;');
    expect(manifest.members[0]).toMatchObject({ id: 'S1.1', url });
    expect(isAllowedSourceUrl(promptCopy, manifest)).toBe(true);
    expect(citationUrlKey(promptCopy, { rendered: true })).toBe(citationUrlKey(url));
    const markdown = `[Vendor, September 4, 2026](${promptCopy})`;
    expect(findUnallowlistedMarkdownUrls(markdown, manifest)).toEqual([]);
    expect(delinkUnallowlistedMarkdownUrls(markdown, manifest)).toBe(markdown);
    const href = parseDocument(marked.parse(markdown)).children[0].children[0].attribs.href;
    expect(href).toBe(url);
  });

  test.each(['&amp;', '&AMP;', '&#38;', '&#x26;'])('allows one equivalent HTML ampersand layer: %s', entity => {
    const candidate = original.replace('&', entity);
    expect(isAllowedSourceUrl(candidate, manifestFor(original))).toBe(true);
  });

  test('does not recursively decode an HTML entity into a different URL', () => {
    expect(isAllowedSourceUrl(original.replace('&', '&amp;amp;'), manifestFor(original))).toBe(false);
    const literalEntity = 'https://example.test/article?x=1&amp;lang=en';
    expect(isAllowedSourceUrl(literalEntity, manifestFor(literalEntity))).toBe(false);
    expect(isAllowedSourceUrl(literalEntity.replace('&', '&amp;'), manifestFor(literalEntity))).toBe(true);
  });

  test.each([
    'https://user:password@example.test/article',
    'https://%75ser@example.test/article',
    'https://example.test/article\n',
    'https://example.test/art\ticle',
    'https://example.test/article\u0000',
    'https://example.test/article\u202e',
    'https://example.test/article?x=%0aHEADER',
    'https://example.test/article?x=%0DHEADER',
    'https://example.test/article%00',
    'https://example.test/article%7f',
    'https:\\example.test\\article',
    'https:example.test/article',
    'javascript:alert(1)',
  ])('never admits unsafe captured source URLs: %s', url => {
    expect(safeSourceUrl(url)).toBe('');
    expect(citationUrlKey(url)).toBe('');
    const manifest = manifestFor(url);
    expect(manifest.members[0]).toMatchObject({ id: 'S1.1', url: '' });
    expect(manifest.urls.size).toBe(0);
    // Even a malformed legacy allowlist must not authorize the unsafe URL.
    expect(isAllowedSourceUrl(url, { urls: new Set([url]) })).toBe(false);
  });

  test.each(['&#10;', '&#x09;', '&NewLine;', '&Tab;'])('rejects rendered control-character entities: %s', entity => {
    expect(citationUrlKey(`https://example.test/art${entity}icle`, { rendered: true })).toBe('');
  });

  test('lossy grouping keys cannot authorize citation URL changes', () => {
    const tracked = `${original}&utm_source=feed#mitigation`;
    expect(sourceUrlKey(tracked)).toBe(sourceUrlKey(original));
    expect(citationUrlKey(tracked)).not.toBe(citationUrlKey(original));
    expect(isAllowedSourceUrl(tracked, { urlKeys: new Set([sourceUrlKey(original)]) })).toBe(false);
    expect(isAllowedSourceUrl(tracked, manifestFor(original))).toBe(false);
    expect(isAllowedSourceUrl(original, manifestFor(tracked))).toBe(false);
  });
});

describe('publication citation regression', () => {
  const item = BRIEF_EVALUATION_CASES[0];
  const first = item.headlines[0];
  const manifest = buildGroundingManifest({ headlines: item.headlines });
  const citation = ` [${first.source}, September 4, 2026](${first.link})`;
  const baseline = referenceBrief(item).replace(/(## WATCHLIST[\s\S]*)$/, section =>
    section.replace(/^(- .+)$/gm, '$1' + citation));
  const validate = text => validateBrief(text, EVAL_DATE, {
    groundingManifest: manifest, kevSet: new Set(), publication: true, editorialStandard: 2,
  });

  test('a clean fixture retains cited evidence IDs', () => {
    const result = validate(baseline);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.judgmentEvidence[0]).toEqual({ signal: 1, sourceIds: ['S1.1'] });
  });

  test.each([
    `${first.link}?utm_context=SYNTHETIC_ORG_CONTEXT`,
    `${first.link}#SYNTHETIC_ORG_CONTEXT`,
    first.link.replace('https://', 'https://SYNTHETIC_CONTEXT:MARKER@'),
  ])('holds publication for a mutated citation: %s', candidate => {
    const changed = baseline.replaceAll(first.link, candidate);
    expect(changed).not.toBe(baseline);
    const result = validate(changed);
    expect(result.valid).toBe(false);
    expect(hasTrustCriticalFailure(result.issues)).toBe(true);
    expect(result.issues.some(issue => issue.code === 'CITATION_IDENTITY_INVALID')).toBe(true);
    expect(result.judgmentEvidence[0].sourceIds).not.toContain('S1.1');
  });
});

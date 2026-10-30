import { describe, expect, test } from '@jest/globals';
import { marked } from 'marked';
import { parseDocument } from 'htmlparser2';
import { renderBriefCitations } from '../lib/brief-citations.js';
import { buildGroundingManifest, citationUrlKey, findUnallowlistedMarkdownUrls } from '../lib/grounding.js';
import { publicationDecision, validateBrief } from '../lib/validation.js';
import { BRIEF_EVALUATION_CASES, EVAL_DATE, referenceBrief } from './fixtures/brief-evaluation.js';

const headline = { title: 'Vendor update', description: 'A retained substantive vendor advisory describes the update.',
  source: 'Vendor', date: '2026-09-04T18:00:00-05:00', link: 'https://example.test/advisory?a=1&b=2#scope' };
const grounding = buildGroundingManifest({ headlines: [headline, { ...headline, source: 'Research', link: 'https://example.test/research' }] });
const citation = '[Vendor, 2026-09-04](https://example.test/advisory?a=1&amp;b=2#scope)';

describe('app-rendered source references', () => {
  test.each(['[S1.1]', '[ s1.1 ]', '[Source: S1.1]', '[sources: s1.1]'])('renders captured identity without rewriting its surrounding claim: %s', reference => {
    const result = renderBriefCitations(`The claim stays unchanged ${reference}.\r\n`, grounding);
    expect(result.content).toBe(`The claim stays unchanged ${citation}.\r\n`);
    expect(result.issues).toEqual([]);
    expect(result.references).toEqual([{ sourceIds: ['S1.1'], raw: reference, line: 1 }]);
    expect(renderBriefCitations(result.content, grounding)).toMatchObject({ content: result.content, issues: [], references: [] });
  });

  test.each([',', ';', ' ', '\t', ' and ', ' & ', ', and '])('renders multiple exact source IDs with a %s separator', separator => {
    const result = renderBriefCitations(`[S1.1${separator} s2.1${separator} S1.1]`, grounding);
    expect(result.content).toBe(`${citation} [Research, 2026-09-04](https://example.test/research)`);
    expect(result.references[0].sourceIds).toEqual(['S1.1', 'S2.1']);
  });

  test('renders captured NVD and KEV authorities only when present in this manifest', () => {
    const manifest = buildGroundingManifest({ headlines: [{ ...headline, isKEV: true, kevCVE: 'CVE-2026-12345',
      cveData: 'CVE-2026-12345: CVSS 9.8; a captured NVD lookup.' }] });
    const result = renderBriefCitations('[NVD-CVE-2026-12345] [CISA-KEV]', manifest);
    expect(result.content).toBe('[NVD, date unavailable](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-12345) [CISA KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)');
    expect(result.issues).toEqual([]);
    expect(renderBriefCitations('[CISA-KEV]', grounding).issues[0].code).toBe('CITATION_REFERENCE_INVALID');
  });

  test('retains missing dates and genuinely unavailable links without inventing metadata', () => {
    const manifest = buildGroundingManifest({ headlines: [{ ...headline, date: '', link: '' }] });
    expect(renderBriefCitations('[S1.1]', manifest).content).toBe('[Vendor, date unavailable]');
  });

  test.each(['[S99.1]', '[S1]', '[S1.1, S88.2]', '[S1.1 and S88.2]', '[S1.1 invented publisher]',
    '[S1.1, invented publisher]', '[S1.1-S2.1]', '[S1.1 through S2.1]', '[S1.1 and]', '[S1.1,]',
    '[NVD-CVE-2026-99999]'])('keeps an unresolved reference visible and blocking: %s', reference => {
    const result = renderBriefCitations(`A claim.\nAnother claim ${reference}.`, grounding);
    expect(result.content).toContain(reference);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'CITATION_REFERENCE_INVALID', severity: 'trust', location: { line: 2, excerpt: reference } })]);
  });

  test('does not guess among duplicate IDs or captures with indistinguishable display identities', () => {
    const original = grounding.members[0];
    for (const members of [[original, { ...original, url: 'https://example.test/other' }],
      [original, { ...original, id: 'S3.1', evidenceText: 'A conflicting retained capture of the same page.' }]]) {
      const result = renderBriefCitations('[S1.1]', { members });
      expect(result.content).toBe('[S1.1]');
      expect(result.issues[0].code).toBe('CITATION_REFERENCE_INVALID');
    }
  });

  test('distinct publisher/date identities can share a URL without selecting the other capture', () => {
    const original = grounding.members[0];
    const result = renderBriefCitations('[S1.1]', { members: [original, { ...original, id: 'S3.1', date: '2026-09-03' }] });
    expect(result.content).toBe(citation);
    expect(result.issues).toEqual([]);
  });

  test.each(['javascript:alert(1)', 'https://user:password@example.test/', 'https://example.test/a\nb'])('does not generate a link from unsafe retained metadata: %s', url => {
    const result = renderBriefCitations('[S1.1]', { members: [{ ...grounding.members[0], url }] });
    expect(result.content).toBe('[S1.1]');
    expect(result.issues[0].code).toBe('CITATION_REFERENCE_INVALID');
  });

  test.each(['https://example.test/a(b)?x=1&y=literal&amp;data=value#scope',
    'https://example.test/a b?q=one two', 'https://example.test/a"b<c>'])('preserves the full captured destination at the rendered sink: %s', url => {
    const manifest = buildGroundingManifest({ headlines: [{ ...headline, link: url }] });
    const result = renderBriefCitations('[S1.1]', manifest);
    const tokens = [];
    marked.walkTokens(marked.lexer(result.content), token => { if (token.type === 'link') tokens.push(token); });
    expect(tokens).toHaveLength(1);
    expect(citationUrlKey(tokens[0].href, { rendered: true })).toBe(citationUrlKey(url));
    expect(findUnallowlistedMarkdownUrls(result.content, manifest)).toEqual([]);
  });

  test('publisher metadata cannot inject Markdown links, HTML, entities, or table columns', () => {
    const label = 'Vendor ](https://attacker.test/) <img src=x> &lt;script&gt; *claim* | column';
    const manifest = buildGroundingManifest({ headlines: [{ ...headline, source: label }] });
    const result = renderBriefCitations('[S1.1]', manifest);
    const html = marked.parse(result.content);
    expect(html).not.toMatch(/<(?:script|img)\b/i);
    expect((html.match(/<a\b/g) || [])).toHaveLength(1);
    expect(findUnallowlistedMarkdownUrls(result.content, manifest)).toEqual([]);
    const paragraph = parseDocument(html).children[0];
    const visible = node => node.type === 'text' ? node.data : (node.children || []).map(visible).join('');
    expect(visible(paragraph)).toBe(`${label}, 2026-09-04`);
  });

  test.each(['\n', '\r\n'])('preserves protected Markdown and source-like claim text (%j)', newline => {
    const examples = ['`[S1.1]`', '``code `[S1.1]` code``', '```md\n[S1.1]\n```',
      '~~~md\n[S99.1]\n~~~', '    [S1.1]', '\t[S1.1]', '<!-- [S99.1] -->',
      '<div>\n[S1.1]\n</div>', '![S1.1](https://example.test/image)', '![S1.1]',
      '\\[S1.1]', '[S1.1](https://example.test/legacy)', '[existing [S1.1]](https://example.test/legacy)',
      '> ```md\n> [S1.1]\n> ```', '- ```md\n  [S1.1]\n  ```',
      '[Example][reference]\n\n[reference]: https://example.test/legacy\n  "[S99.1]"',
      '[CVE-2026-12345]', '[Horizon 1]', '[CVSS 9.8]', '[S1.A1]'];
    const prefix = examples.map(value => value.replaceAll('\n', newline)).join(newline + newline);
    const result = renderBriefCitations(`${prefix}${newline}${newline}Actual [S1.1].`, grounding);
    expect(result.content).toBe(`${prefix}${newline}${newline}Actual ${citation}.`);
    expect(result.issues).toEqual([]);
  });

  test('leaves unfinished code fences and comments unchanged', () => {
    for (const text of ['```md\n[S1.1]', '<!-- [S1.1]', '<span hidden>[S1.1]']) {
      expect(renderBriefCitations(text, grounding)).toMatchObject({ content: text, issues: [], references: [] });
    }
  });

  test('does not rewrite inline HTML contents while retaining adjacent visible references', () => {
    const text = 'Example `<span hidden>` <span hidden><b>[S99.1]</b> [S1.1]</span>. Actual [S1.1].';
    const result = renderBriefCitations(text, grounding);
    expect(result).toMatchObject({ content: `Example \`<span hidden>\` <span hidden><b>[S99.1]</b> [S1.1]</span>. Actual ${citation}.`, issues: [] });
  });

  test('renders references in ordinary blockquotes, lists and tables', () => {
    const text = '> A claim [S1.1].\n\n- A claim [S1.1].\n\n| Claim | Source |\n| --- | --- |\n| Claim | [S1.1] |';
    expect(renderBriefCitations(text, grounding).content).toBe(text.replaceAll('[S1.1]', citation));
  });
});

describe('source references remain subject to factual checks', () => {
  const item = BRIEF_EVALUATION_CASES[0];
  const manifest = buildGroundingManifest({ headlines: item.headlines });
  const baseline = referenceBrief(item);
  const first = item.headlines[0];
  const withIds = baseline.replaceAll(`[${first.source}, September 4, 2026](${first.link})`, '[S1.1]');
  const validate = text => validateBrief(text, EVAL_DATE, { publication: true, groundingManifest: manifest });

  test('checks expanded source IDs as captured evidence without changing the caller text', () => {
    expect(withIds).not.toBe(baseline);
    expect(publicationDecision(validate(withIds)).canPublish).toBe(true);
    expect(validate(withIds).judgmentEvidence[0].sourceIds).toEqual(['S1.1']);
    expect(withIds).toContain('[S1.1]');
  });

  test('an unrelated source ID cannot authorize the claim just because it renders', () => {
    const result = validate(withIds.replaceAll('[S1.1]', '[S2.1]'));
    expect(result.issues.map(issue => issue.code)).toContain('CVE_CITATION_MISMATCH');
    expect(publicationDecision(result).canPublish).toBe(false);
  });

  test('grouped source IDs resolve without masking unsupported claims or unknown sources', () => {
    const grouped = withIds.replaceAll('[S1.1]', '[S1.1 and S2.1]');
    const result = validate(grouped);
    expect(result.judgmentEvidence[0].sourceIds).toEqual(['S1.1', 'S2.1']);
    expect(result.issues.map(issue => issue.code)).not.toContain('CITATION_REFERENCE_INVALID');
    expect(publicationDecision(result).canPublish).toBe(true);
    expect(validate(grouped.replace('[S1.1 and S2.1]', 'CVSS 10.0 [S1.1 and S2.1]')).issues.map(issue => issue.code))
      .toContain('CVSS_UNSUPPORTED');
    const unknown = validate(withIds.replace('[S1.1]', '[S1.1 and S99.1]'));
    expect(unknown.issues.map(issue => issue.code)).toContain('CITATION_REFERENCE_INVALID');
    expect(publicationDecision(unknown).canPublish).toBe(false);
  });

  test.each(['', '2026-09-04'])('source labels with Markdown characters still resolve without a URL (date %s)', date => {
    const special = buildGroundingManifest({ headlines: [{ ...first, source: 'Vendor & Research [Lab]', link: '', date }, ...item.headlines.slice(1)] });
    const result = validateBrief(withIds, EVAL_DATE, { publication: true, groundingManifest: special });
    expect(result.judgmentEvidence[0].sourceIds).toEqual(['S1.1']);
    expect(result.issues.map(issue => issue.code)).not.toContain('CITATION_IDENTITY_INVALID');
    expect(result.issues.map(issue => issue.code)).not.toContain('JUDGMENT_CITATION_MISSING');
  });

  test('unresolved IDs also block outside the What happened field', () => {
    const result = validate(`${baseline}\nA separate unsupported source reference [S88.1].`);
    expect(result.issues.map(issue => issue.code)).toContain('CITATION_REFERENCE_INVALID');
    expect(publicationDecision(result).canPublish).toBe(false);
  });

  test('legacy policy 1 retains its earlier interpretation instead of adding source-ID semantics', () => {
    const result = validateBrief(`${withIds}\nA separate reference [S88.1].`, EVAL_DATE, {
      publication: true, groundingManifest: manifest, validationPolicyVersion: 1,
    });
    expect(result.issues.map(issue => issue.code)).not.toContain('CITATION_REFERENCE_INVALID');
    expect(result.judgmentEvidence[0].sourceIds).toEqual([]);
    expect(result.issues.map(issue => issue.code)).toContain('JUDGMENT_CITATION_MISSING');
  });

  test('a valid source ID does not hide a false CVSS claim', () => {
    const result = validate(withIds.replace('[S1.1]', 'CVSS 10.0 [S1.1]'));
    expect(result.issues.map(issue => issue.code)).toContain('CVSS_UNSUPPORTED');
    expect(publicationDecision(result).canPublish).toBe(false);
  });
});

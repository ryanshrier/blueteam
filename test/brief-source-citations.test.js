import { describe, expect, test } from '@jest/globals';
import { marked } from 'marked';
import { parseDocument } from 'htmlparser2';
import { sourceCitations, parseBrief, stripMd } from '../lib/brief-schema.js';
import { renderBriefCitations } from '../lib/brief-citations.js';
import { wallDocumentHtml } from '../public/modules/wall/wall-actions.js';

function anchors(html) {
  const find = nodes => nodes.flatMap(node => [...(node.name === 'a' ? [node] : []), ...find(node.children || [])]);
  return find(parseDocument(html).children);
}
const text = node => node.type === 'text' ? node.data : (node.children || []).map(text).join('');

describe('shared citation reader destination parity', () => {
  test.each([
    'https://vendor.example/advisory?a=1&b=2#scope',
    'https://vendor.example/a(b)?x=1&y=literal&amp;data=value#scope',
    'https://vendor.example/a((b)c)?x=(d)',
    'https://vendor.example/a b?q=one two',
    'https://vendor.example/a"b<c>',
  ])('app citation and Wall link retain the exact Markdown destination: %s', url => {
    const label = 'Vendor [Lab] & team *literal* | column';
    const grounding = { members: [{ id: 'S1.1', label, date: '2026-10-22', url }] };
    const rendered = renderBriefCitations('[S1.1]', grounding).content;
    const parsed = sourceCitations(rendered);
    expect(parsed).toEqual([{ label: `${label}, 2026-10-22`, url: encodeURI(url).replace(/%25/g, '%') }]);
    const original = anchors(marked.parse(rendered))[0];
    expect(parsed[0].url).toBe(original.attribs.href);
    expect(parsed[0].label).toBe(text(original));
    const document = parseBrief(`## KEY JUDGMENTS\n\n### Signal 1 — [Horizon 1] A judgment\n\n**What happened:** A captured claim ${rendered}`);
    expect(document.stories[0].whatHappened).toContain(`${label}, 2026-10-22`);
    const wall = anchors(wallDocumentHtml(document)).find(anchor => anchor.attribs.href?.startsWith('https://vendor.example'));
    expect(wall.attribs.href).toBe(original.attribs.href);
    expect(text(wall)).toBe(text(original));
  });

  test.each([
    ['[Vendor](https://vendor.example/a(b)c)', 'https://vendor.example/a(b)c'],
    [String.raw`[Vendor \[Lab\]](https://vendor.example/a\(b\)?x=1&amp;y=2)`, 'https://vendor.example/a(b)?x=1&y=2'],
    ['[Vendor](<https://vendor.example/a b> "A title")', 'https://vendor.example/a b'],
    ['[Vendor](https://vendor.example/advisory "Title with ) punctuation")', 'https://vendor.example/advisory'],
    ["[Vendor](https://vendor.example/advisory 'A title')", 'https://vendor.example/advisory'],
    ['[Vendor](https://vendor.example/advisory (A title))', 'https://vendor.example/advisory'],
    ['[Vendor](https://vendor.example/?x=1&amp;amp;y=2)', 'https://vendor.example/?x=1&amp;y=2'],
    ['[Vendor](https://vendor.example/?q=&#40;test&#41;)', 'https://vendor.example/?q=(test)'],
  ])('reads ordinary legacy Markdown without destination truncation: %s', (markdown, url) => {
    expect(sourceCitations(markdown)).toHaveLength(1);
    expect(sourceCitations(markdown)[0].url).toBe(encodeURI(url).replace(/%25/g, '%'));
    expect(sourceCitations(markdown)[0].url).toBe(anchors(marked.parse(markdown))[0].attribs.href);
  });

  test('decodes one label layer while preserving publisher punctuation literally', () => {
    expect(sourceCitations(String.raw`[Vendor \*literal\* &#91;Lab&#93; &amp;amp;, date unavailable](https://vendor.example)`))
      .toEqual([{ label: 'Vendor *literal* [Lab] &amp;, date unavailable', url: 'https://vendor.example' }]);
  });

  test('linkless unavailable citations remain text and do not acquire a guessed URL', () => {
    const rendered = renderBriefCitations('[S1.1]', { members: [{ id: 'S1.1', label: 'Vendor [Lab] & team', date: '', url: '' }] }).content;
    expect(sourceCitations(rendered)).toEqual([]);
    expect(text(parseDocument(marked.parse(rendered)))).toContain('Vendor [Lab] & team, date unavailable');
    const document = parseBrief(`## KEY JUDGMENTS\n\n### Signal 1 — [Horizon 1] A judgment\n\n**What happened:** Captured claim ${rendered}`);
    expect(document.stories[0].whatHappened).toContain('[Vendor [Lab] & team, date unavailable]');
    expect(text(parseDocument(wallDocumentHtml(document)))).toContain('[Vendor [Lab] & team, date unavailable]');
    expect(stripMd('Literal `'+rendered+'` example.')).toContain(rendered);
  });

  test.each([
    '[Vendor](javascript:alert(1))', '[Vendor](https://user:password@vendor.example)',
    '[Vendor](https://vendor.example/%0aevil)', '[Vendor](https://vendor.example/&#10;evil)',
    '[Vendor](https://vendor.example/\\evil)', '[Vendor](https://vendor.example/a(unclosed)',
    '[Vendor](https://vendor.example/ extraneous text)', '[Vendor](<https://vendor.example/a b)',
    '![Vendor](https://vendor.example/image)', String.raw`\[Vendor](https://vendor.example)`,
    '[Vendor](https://vendor.example/&UnknownEntity;)',
  ])('does not present unsafe, malformed or non-link syntax as a source: %s', markdown => {
    expect(sourceCitations(markdown)).toEqual([]);
  });

  test.each(['`[Vendor](https://vendor.example)`', '```md\n[Vendor](https://vendor.example)\n```',
    '<!-- [Vendor](https://vendor.example) -->', '    [Vendor](https://vendor.example)', '~~~md\n[Vendor](https://vendor.example)\n~~~'])('does not borrow a source from protected examples: %s', markdown => {
    expect(sourceCitations(markdown)).toEqual([]);
  });

  test('bounds work on a pathological unfinished bracket sequence and keeps earlier citations', () => {
    const first = '[Vendor](https://vendor.example)';
    expect(sourceCitations(first + '\n' + '['.repeat(50000))).toEqual([{ label: 'Vendor', url: 'https://vendor.example' }]);
  });
});

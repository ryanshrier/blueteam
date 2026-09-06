import { describe, expect, test } from '@jest/globals';
import {
  briefTierLabel, editionDateLabel, judgmentSignalLink, decisionCopyText,
  splitPackedBriefFieldHtml,
  tocLabel,
  actionRoleHtml, authoredText,
  CITATION_APPENDIX_LABEL, extractSections,
} from '../public/modules/briefing/brief-renderer.js';
import { documentExecutiveModel, structureExecutiveSummary } from '../public/modules/briefing/brief-executive.js';

describe('complete document decision presentation', () => {
  const items = [
    { lead: 'Threat:', tail: 'Active exploitation.' },
    { lead: 'Exposure:', tail: 'Public gateways.' },
    { lead: 'Context one:', tail: 'First contextual detail.' },
    { lead: 'Context two:', tail: 'Second contextual detail.' },
    { lead: 'Required decisions:', tail: Array.from({ length: 7 }, (_, i) => `Owner ${i + 1} — Verify service ${i + 1} — September ${i + 5}, 2026`).join('; ') },
  ];
  test('keeps every context row and owner decision beyond former print caps', () => {
    const model = documentExecutiveModel(items);
    expect(model.facts.map(row => row.text)).toEqual(items.slice(0, 4).map(item => item.tail));
    expect(model.decisions).toHaveLength(7);
    expect(model.decisions[6]).toEqual({ owner: 'Owner 7', action: 'Verify service 7', deadline: 'September 11, 2026' });
  });
  test('renders every model row into the document, with an accurate decision count', () => {
    const generated = [];
    const make = tag => ({ tagName: tag.toUpperCase(), children: [], className: '', textContent: '', prepend(el) { this.children.unshift(el); }, appendChild(el) { this.children.push(el); }, append(...els) { this.children.push(...els); } });
    const list = { tagName: 'UL', querySelector: () => null, replaceWith: panel => generated.push(panel), children: items.map(item => ({
      tagName: 'LI', querySelector: () => ({ textContent: item.lead }),
      cloneNode: () => ({ textContent: item.tail, querySelector: () => ({ remove() {} }) }),
    })) };
    structureExecutiveSummary({ querySelector: () => null, querySelectorAll: () => [{ textContent: 'EXECUTIVE SUMMARY', nextElementSibling: list }], ownerDocument: { createElement: make } });
    const panel = generated[0];
    expect(panel.children[1].children).toHaveLength(4);
    expect(panel.children[0].children[0].children[0].textContent).toBe('7 action previews · complete responses below');
    expect(panel.children[0].children[1].children).toHaveLength(7);
  });
  test('leaves rich executive summaries intact rather than flattening their evidence links', () => {
    let replaced = false;
    const list = { tagName: 'UL', querySelector: () => ({}), replaceWith: () => { replaced = true; } };
    structureExecutiveSummary({ querySelector: () => null, querySelectorAll: () => [{ textContent: 'EXECUTIVE SUMMARY', nextElementSibling: list }] });
    expect(replaced).toBe(false);
  });
  test('inline CVE and version code does not suppress the executive card or alter its values', () => {
    const generated = [];
    const make = tag => ({ tagName: tag.toUpperCase(), children: [], className: '', textContent: '',
      prepend(el) { this.children.unshift(el); }, appendChild(el) { this.children.push(el); }, append(...els) { this.children.push(...els); } });
    const rows = [
      { lead: 'Threat:', tail: 'Active exploitation of CVE-2026-1234.' },
      { lead: 'Exposure:', tail: 'Unknown until verified.' },
      { lead: 'Required decisions:', tail: 'Endpoint — update to 152.0.7977.82/.83 — recommended target September 8, 2026.' },
    ];
    const list = { tagName: 'UL', querySelector: selector => /\bcode\b/.test(selector) ? { tagName: 'CODE' } : null,
      replaceWith: panel => generated.push(panel), children: rows.map(item => ({
        tagName: 'LI', querySelector: () => ({ textContent: item.lead }),
        cloneNode: () => ({ textContent: item.tail, querySelector: () => ({ remove() {} }) }),
      })) };
    structureExecutiveSummary({ querySelector: () => null,
      querySelectorAll: () => [{ textContent: 'EXECUTIVE SUMMARY — SHIFT DECISIONS', nextElementSibling: list }],
      ownerDocument: { createElement: make } });
    expect(generated).toHaveLength(1);
    const text = node => [node.textContent, ...node.children.map(text)].join(' ');
    expect(text(generated[0])).toContain('CVE-2026-1234');
    expect(text(generated[0])).toContain('152.0.7977.82/.83');
    expect(text(generated[0])).toContain('1 action preview');
    expect(text(generated[0])).toContain('Recommended target · September 8, 2026');
    expect(text(generated[0])).not.toContain('Due recommended');
  });
});

describe('authored action and citation fidelity', () => {
  test('separates explicit owner and target without changing authored characters or links', () => {
    const original = 'Infrastructure — verify <a href="https://example.test">the advisory</a> — September 5, 2026.';
    const styled = actionRoleHtml(original);
    expect(styled).toContain('<strong class="brief-action-owner">Infrastructure</strong>');
    expect(styled).toContain('<span class="brief-action-target"> — September 5, 2026.</span>');
    expect(styled.replace(/<strong class="brief-action-owner">|<\/strong>|<span class="brief-action-target">|<\/span>/g, '')).toBe(original);
    expect(actionRoleHtml(styled)).toBe(styled);
    expect(actionRoleHtml('Review the advisory before assigning a team.')).toBe('Review the advisory before assigning a team.');
  });
  test('does not duplicate retained citation labels when copying a decision', () => {
    const make = retained => {
      const clone = { textContent: retained ? 'Verify the vendor advisory[1].' : 'Verify [1].' };
      const cite = { dataset: { labelRetained: String(retained) }, querySelector: () => ({ dataset: { sourceLabel: 'vendor advisory' } }), replaceWith: value => { clone.textContent = clone.textContent.replace('[1]', value); } };
      clone.querySelectorAll = () => [cite];
      return { cloneNode: () => clone };
    };
    expect(authoredText(make(true))).toBe('Verify the vendor advisory.');
    expect(authoredText(make(false))).toBe('Verify vendor advisory.');
  });
});

describe('brief field normalization', () => {
  test('splits judgment, developing, and convergence fields with one shared grammar', () => {
    const packed = [
      '<strong>Assessment:</strong> Exploitation is active.',
      '<strong>What happened:</strong> CISA updated the catalog.',
      'This continuation belongs to the evidence field.',
      '<strong>Trajectory:</strong> Accelerating.',
      '<strong>Watch criteria:</strong> Escalate when a vendor confirms impact.',
      '<strong>The intersection:</strong> Identity meets edge access.',
      '<strong>The cascade:</strong> Access compounds impact.',
      '<strong>The move:</strong> Prepare — close the gap.',
    ].join('<br>');

    expect(splitPackedBriefFieldHtml(packed)).toEqual([
      '<strong>Assessment:</strong> Exploitation is active.',
      '<strong>What happened:</strong> CISA updated the catalog.<br>This continuation belongs to the evidence field.',
      '<strong>Trajectory:</strong> Accelerating.',
      '<strong>Watch criteria:</strong> Escalate when a vendor confirms impact.',
      '<strong>The intersection:</strong> Identity meets edge access.',
      '<strong>The cascade:</strong> Access compounds impact.',
      '<strong>The move:</strong> Prepare — close the gap.',
    ]);
  });

  test('does not split ordinary prose with an intentional line break', () => {
    const prose = '<strong>Context:</strong> First line.<br>Second line.';
    expect(splitPackedBriefFieldHtml(prose)).toEqual([prose]);
  });
});

describe('archived decision-window date labels', () => {
  test('accepts both ISO and reader-facing datelines', () => {
    expect(editionDateLabel('Threat Landscape Briefing · 2026-07-24 · Friday')).toBe('2026-07-24');
    expect(editionDateLabel('Threat Landscape Briefing · July 24, 2026 · Friday')).toBe('July 24, 2026');
    expect(editionDateLabel('Threat Landscape Briefing')).toBe('');
  });
});

describe('Briefing tier labels', () => {
  test('keeps analytic tiers separate from explicit action directives', () => {
    expect(briefTierLabel(1)).toBe('TACTICAL');
    expect(briefTierLabel(2)).toBe('OPERATIONAL');
    expect(briefTierLabel(3)).toBe('STRATEGIC');
    expect([1, 2, 3].map(briefTierLabel)).not.toContain('ACT NOW');
  });
});

describe('briefing section navigation labels', () => {
  test('distinguishes authored Sources from the generated References appendix without changing their anchors', () => {
    const nodes = [
      { id: 'section-6-sources', textContent: 'SOURCES' },
      { id: 'section-sources', textContent: CITATION_APPENDIX_LABEL },
    ].map(node => ({ ...node, tagName: 'H2', classList: { contains: () => false } }));
    const sections = extractSections({ querySelectorAll: () => nodes });
    expect(sections.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'section-6-sources', label: 'Sources' },
      { id: 'section-sources', label: 'References' },
    ]);
  });
  test.each([
    ['EXECUTIVE SUMMARY — SHIFT DECISIONS', 'Shift decisions'],
    ['KEY JUDGMENTS', 'Key judgments'],
    ['DEVELOPING SITUATIONS', 'Developing'],
    ['CONVERGENCE', 'Convergence'],
    ['WATCHLIST — THROUGH JULY 27, 2026', 'Watchlist'],
    ['WEEK IN REVIEW', 'Week in review'],
    ['Sources', 'Sources'],
  ])('shortens %s for the narrow TOC', (source, expected) => {
    expect(tocLabel(source)).toBe(expected);
  });
});

describe('judgment handoff and current-feed destinations', () => {
  test('names a current CVE search and broad tier browse accurately', () => {
    expect(judgmentSignalLink('Assessment mentions cve-2026-123456.', 1)).toEqual({ href: '/wire?q=CVE-2026-123456', label: 'Search current Wire for CVE-2026-123456 →' });
    expect(judgmentSignalLink('No identifier in this judgment.', 2)).toEqual({ href: '/wire?h=2', label: 'Browse Operational signals →' });
    expect(judgmentSignalLink('', null)).toEqual({ href: '/wire', label: 'Browse current Wire →' });
  });

  test('copies the full authored action, basis, citations and saved edition without inferred fields', () => {
    const action = `Infrastructure — ${'verify every listed service and preserve unresolved evidence; '.repeat(25)}— recommended target Sep 5, 2026.`;
    const text = decisionCopyText({
      title: 'Synthetic judgment', action,
      recommendations: ['Detection Engineering — check the authored rule — Sep 6, 2026.'],
      decisionWindow: 'Current shift as of Sep 4, 2026',
      certainty: 'Likelihood: Likely (55–80%) — incomplete source coverage.',
      sources: [
        { label: 'Vendor bulletin, Sep 4', href: 'https://example.test/bulletin' },
        { label: 'Same citation', href: 'https://example.test/bulletin' },
        { label: 'Invalid link', href: 'javascript:void(0)' },
      ],
      editionUrl: 'http://localhost:4000/briefing/brief-2026-09-04.md#judgment-1', editionLabel: 'Briefing · Sep 4, 2026',
    });
    expect(text).toContain(`Act now: ${action}`);
    expect(text).toContain('Detection Engineering — check the authored rule — Sep 6, 2026.');
    expect(text).toContain('Likelihood: Likely (55–80%) — incomplete source coverage.');
    expect(text).toContain('Vendor bulletin, Sep 4: https://example.test/bulletin');
    expect(text).not.toContain('Same citation');
    expect(text).not.toContain('javascript:');
    expect(text).toContain('/briefing/brief-2026-09-04.md#judgment-1');
  });

  test('copies recommendation-only judgments while omitting absent ownership and timing', () => {
    const text = decisionCopyText({ recommendations: ['Review the published evidence.'], editionUrl: 'https://desk.example/briefing/brief-2026-09-04.md' });
    expect(text).toContain('Recommended actions:\n- Review the published evidence.');
    expect(text).not.toMatch(/Act now:|Owner:|Target:|Decision window:|Cited sources:/);
    expect(decisionCopyText({ editionUrl: 'https://desk.example/briefing/file' })).toBe('');
    expect(decisionCopyText({ action: 'Do the authored thing.' })).toBe('');
  });
});

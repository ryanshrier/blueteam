import { describe, expect, test } from '@jest/globals';
import { assessmentSources, renderAssessmentMeta } from '../public/modules/core/assessment-meta.js';
import { briefAssessmentMetadata } from '../public/modules/briefing/brief-renderer.js';

describe('shared assessment metadata boundaries', () => {
  test('keeps missing analytical fields explicit without deriving confidence or time from sources', () => {
    const html = renderAssessmentMeta({ sources: [
      { label: 'Publisher A', href: 'https://a.example/report' },
      { label: 'Publisher B', href: 'https://b.example/report' },
    ] });
    expect(html).toContain('Assessment confidence</dt><dd class="assessment-meta__value">Not assessed');
    expect(html).toContain('Severity</dt><dd class="assessment-meta__value">Not assessed');
    expect(html).toContain('Published</dt><dd class="assessment-meta__value">Not available');
    expect(html).not.toContain('data-level=');
    expect(html).not.toContain('<time');
  });

  test('rejects unsafe destinations, deduplicates source URLs, and escapes text and attributes', () => {
    const sources = [
      { label: '<img src=x onerror=alert(1)>', href: 'https://example.test/report?x="&y=1' },
      { label: 'Duplicate', href: 'https://example.test/report?x="&y=1' },
      { label: 'Script', href: 'javascript:alert(1)' },
      { label: 'Credentials', href: 'https://name:secret@example.test/report' },
      { label: 'Relative', href: '/settings' },
    ];
    expect(assessmentSources(sources)).toHaveLength(1);
    const html = renderAssessmentMeta({ sources, certainty: { label: '<Confidence>', value: 'Low & qualified' } });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="https://example.test/report?x=&quot;&amp;y=1"');
    expect(html).toContain('&lt;Confidence&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('secret');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test('preserves caller-supplied date meaning and scoped severity instead of inventing an overall assessment', () => {
    const html = renderAssessmentMeta({
      time: { label: 'Publisher updated', value: 'September 6 at 14:30 UTC', dateTime: '2026-09-06T14:30:00Z' },
      severity: { label: 'CVE-2026-1234 · CVSS', value: '9.8 · NVD', level: 'critical' },
      certainty: { label: 'Likelihood', value: 'Likely (55–80%)' },
      compact: true,
    });
    expect(html).toContain('Publisher updated</dt>');
    expect(html).toContain('<time datetime="2026-09-06T14:30:00Z">September 6 at 14:30 UTC</time>');
    expect(html).toContain('CVE-2026-1234 · CVSS');
    expect(html).toContain('Likelihood</dt><dd class="assessment-meta__value">Likely (55–80%)');
    expect(html).toContain('data-level="danger"');
    expect(html).not.toContain('Assessment confidence');
    expect(html).not.toContain('brief-cite');
  });
});

function judgment(certainty, sources = []) {
  return {
    querySelector: selector => selector === '.brief-certainty' && certainty ? {
      cloneNode: () => ({ textContent: certainty, querySelectorAll: () => [] }),
    } : null,
    querySelectorAll: selector => selector === '.brief-cite-link' ? sources.map(source => ({
      dataset: { sourceLabel: source.label, sourceUrl: source.href },
    })) : [],
  };
}

describe('edition-bound judgment metadata', () => {
  test('keeps displayed source order after decision layout reorders the citation paragraphs', () => {
    const sources = ['basis', 'vendor', 'remediation'].map(label => ({ label, href: `https://saved.example/${label}` }));
    const card = judgment('', [sources[2], sources[1], sources[0]]);
    // Before metadata exists, initial attachment follows authored citation order.
    expect(briefAssessmentMetadata(card).sources).toEqual([sources[2], sources[1], sources[0]]);
    const originalQuery = card.querySelector;
    card.querySelector = selector => selector === ':scope > .assessment-meta' ? {
      querySelectorAll: () => sources.map(source => ({
        getAttribute: () => source.href, textContent: source.label,
      })),
    } : originalQuery(selector);
    expect(briefAssessmentMetadata(card).sources).toEqual(sources);
  });

  test('preserves likelihood and mixed authored confidence; dates in citations do not update a judgment', () => {
    const sources = [{ label: 'Vendor · 2026-09-06', href: 'https://example.test/advisory' }];
    const probable = briefAssessmentMetadata(judgment('Likelihood: Likely (55–80%) — deployment breadth remains unknown.', sources));
    expect(probable.certainty).toEqual({ label: 'Likelihood', value: 'Likely (55–80%)' });
    expect(probable.time).toEqual({ label: 'Assessment updated', value: 'Not available' });
    expect(probable.severity.value).toBe('Not assessed');
    const mixed = briefAssessmentMetadata(judgment('Confidence: High for catalog status; Moderate for campaign detail — the reported scope remains unverified.'));
    expect(mixed.certainty.value).toBe('High for catalog status; Moderate for campaign detail');
    expect(mixed.sources).toEqual([]);
  });
});

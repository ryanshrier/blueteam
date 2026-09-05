import { describe, expect, test } from '@jest/globals';
import { renderEvidenceContext, renderApplicability, renderEvidenceRecord } from '../public/modules/wire/evidence-inspector.js';

describe('retained evidence presentation', () => {
  test('separates declared relevance from exposure and escapes untrusted terms', () => {
    expect(renderEvidenceContext({ evidence: [{ changed: true }], applicability: { state: 'declared-match' } }))
      .toContain('Source text changed · Watch profile match');
    const html = renderApplicability({ explanation: '<script>unsafe</script>', matches: [{ term: '<img>', field: 'technologies', in: ['description'] }] });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Local exposure and mitigation remain unverified');
  });

  test('shows exact escaped excerpts, literal differences and explicitly dated revisions', () => {
    const html = renderEvidenceRecord({ canonicalUrl: 'https://example.test/advisory', revisions: [{
      revisionId: 'r2', title: 'Vendor correction', passage: 'Affected: <2.4.3', passageKind: 'feed-excerpt',
      firstObservedAt: '2026-09-04T12:00:00Z', publishedAt: null, retrievedAt: '2026-09-04T11:59:00Z',
      changed: true, previousPassage: 'Affected: <2.4.2', changes: { before: 'Affected: <2.4.', removed: '2', added: '3', after: '' },
    }] }, 'r2');
    expect(html).toContain('Affected: &lt;2.4.3');
    const displayedPassages = [...html.matchAll(/<blockquote class="evidence-passage">([\s\S]*?)<\/blockquote>/g)].map(match => match[1]);
    expect(displayedPassages[0]).toBe('Affected: &lt;2.4.<del aria-label="Removed text">2</del>');
    expect(displayedPassages[1]).toBe('Affected: &lt;2.4.<ins aria-label="Added text">3</ins>');
    expect(html).toContain('Previous · removed text');
    expect(html).toContain('Current · added text');
    expect(html).toContain('Published</dt><dd>Unknown');
    expect(html).toContain('retained feed excerpt; not the full article');
    expect(html).toContain('Feed snapshot revision');
  });

  test('preserves complete before and after text for insertion-only and deletion-only changes', () => {
    for (const changes of [
      { before: 'Use ', removed: '', added: '<patched> ', after: 'build.' },
      { before: 'Use ', removed: '<legacy> ', added: '', after: 'build.' },
    ]) {
      const html = renderEvidenceRecord({ source: '<Publisher>', revisions: [{ revisionId: 'r1', changes }] });
      const displayedPassages = [...html.matchAll(/<blockquote class="evidence-passage">([\s\S]*?)<\/blockquote>/g)].map(match => match[1]);
      const strip = text => text.replace(/<\/?(?:del|ins)(?: [^>]*)?>/g, '');
      expect(strip(displayedPassages[0])).toBe(`Use ${changes.removed.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}build.`);
      expect(strip(displayedPassages[1])).toBe(`Use ${changes.added.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}build.`);
      expect(html).not.toContain('<Publisher>');
      expect(html.match(/<figcaption>&lt;Publisher&gt;/g)).toHaveLength(2);
    }
  });

  test('never substitutes a newer revision silently or makes unsafe source links clickable', () => {
    const html = renderEvidenceRecord({ canonicalUrl: 'javascript:alert(1)', revisions: [{ revisionId: 'new', title: 'New observation' }] }, 'pruned');
    expect(html).toContain('revision attached to this feed snapshot is no longer retained');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('New observation');
    expect(renderEvidenceRecord({ canonicalUrl: 'https://name:secret@example.test', revisions: [] })).not.toContain('name:secret');
  });

  test('identifies each feed representation and does not invent a pruned passage comparison', () => {
    const html = renderEvidenceRecord({ source: 'Primary publisher', revisions: [{ revisionId: 'r2', source: 'Secondary feed label', feedUrl: 'https://example.test/feed', changed: true, previousPassage: null }] });
    expect(html).toContain('Secondary feed label');
    expect(html).toContain('Collected from https://example.test/feed');
    expect(html).toContain('preceding observation is no longer retained');
    expect(html).not.toContain('The title changed');
  });
});

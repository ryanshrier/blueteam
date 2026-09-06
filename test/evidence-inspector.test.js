import { describe, expect, jest, test } from '@jest/globals';
import { renderEvidenceContext, renderApplicability, renderEvidenceRecord, describeEvidenceChange, renderEvidenceSources, renderEvidenceTimeline, renderEvidenceRelationships, getEvidenceTabbables, trapEvidenceTab } from '../public/modules/wire/evidence-inspector.js';

function focusFixture() {
  const nodes = [];
  const doc = { defaultView: { getComputedStyle: node => ({ visibility: node.visibility || 'visible' }) } };
  const make = (tagName, name, parentElement = null, options = {}) => {
    const node = { tagName, name, parentElement, children: [], tabIndex: 0, open: false,
      ownerDocument: doc, focus: jest.fn(), getClientRects: () => [{}], ...options,
      matches: () => Boolean(node.disabled), hasAttribute: name => name === 'tabindex' && Boolean(node.explicitTabIndex),
      closest: () => { for (let item = node; item; item = item.parentElement) if (item.hidden || item.inert) return item; return null; },
      contains: child => { for (let item = child; item; item = item.parentElement) if (item === node) return true; return false; },
    };
    parentElement?.children.push(node);
    nodes.push(node);
    return node;
  };
  const dialog = make('DIALOG', 'dialog');
  dialog.querySelectorAll = () => nodes.filter(node => node !== dialog && node.tagName !== 'DETAILS' && node.tagName !== 'DIV');
  const close = make('BUTTON', 'Close', dialog);
  const why = make('DETAILS', 'applicability', dialog);
  make('SUMMARY', 'Why it matters', why);
  make('A', 'Hidden settings link', why);
  make('SELECT', 'Source selector', dialog);
  make('A', 'Original source', dialog);
  const selected = make('DETAILS', 'selected revision', dialog, { open: true });
  make('SUMMARY', 'Feed snapshot revision', selected);
  const observation = make('DETAILS', 'selected observation', selected);
  make('SUMMARY', 'Observation details', observation);
  const earlier = make('DETAILS', 'earlier revision', dialog);
  const earlierSummary = make('SUMMARY', 'Earlier retained revision', earlier);
  const earlierObservation = make('DETAILS', 'earlier observation', earlier);
  const concealedSummary = make('SUMMARY', 'Concealed observation details', earlierObservation);
  return { dialog, make, close, earlier, earlierSummary, concealedSummary };
}

describe('evidence dialog keyboard boundaries', () => {
  test('closed ancestor details excludes nested summary even when Chromium reports a layout rectangle', () => {
    const ui = focusFixture();
    expect(ui.concealedSummary.getClientRects()).toHaveLength(1);
    expect(getEvidenceTabbables(ui.dialog).map(node => node.name)).toEqual([
      'Close', 'Why it matters', 'Source selector', 'Original source',
      'Feed snapshot revision', 'Observation details', 'Earlier retained revision',
    ]);
  });

  test('forward and reverse Tab wrap at the actual last control as revisions expand and collapse', () => {
    const ui = focusFixture();
    const key = shiftKey => ({ key: 'Tab', shiftKey, preventDefault: jest.fn() });
    const forward = key(false);
    trapEvidenceTab(forward, ui.dialog, ui.earlierSummary);
    expect(forward.preventDefault).toHaveBeenCalled();
    expect(ui.close.focus).toHaveBeenCalledTimes(1);
    trapEvidenceTab(key(true), ui.dialog, ui.close);
    expect(ui.earlierSummary.focus).toHaveBeenCalledTimes(1);
    ui.earlier.open = true;
    const inside = key(false);
    trapEvidenceTab(inside, ui.dialog, ui.earlierSummary);
    expect(inside.preventDefault).not.toHaveBeenCalled();
    trapEvidenceTab(key(false), ui.dialog, ui.concealedSummary);
    expect(ui.close.focus).toHaveBeenCalledTimes(2);
    trapEvidenceTab(key(true), ui.dialog, ui.close);
    expect(ui.concealedSummary.focus).toHaveBeenCalledTimes(1);
    ui.earlier.open = false;
    trapEvidenceTab(key(true), ui.dialog, ui.close);
    expect(ui.earlierSummary.focus).toHaveBeenCalledTimes(2);
  });

  test('only the first summary subtree of a closed disclosure remains eligible', () => {
    const ui = focusFixture();
    const summaryButton = ui.make('BUTTON', 'Action within summary', ui.earlierSummary);
    const extraSummary = ui.make('SUMMARY', 'Additional summary', ui.earlier, { explicitTabIndex: true });
    expect(getEvidenceTabbables(ui.dialog)).toContain(summaryButton);
    expect(getEvidenceTabbables(ui.dialog)).not.toContain(extraSummary);
  });

  test('hidden, inert, disabled, negative tabindex and CSS-hidden controls are excluded', () => {
    const ui = focusFixture();
    const disabled = ui.make('BUTTON', 'Disabled', ui.dialog, { disabled: true });
    const negative = ui.make('A', 'Programmatic only', ui.dialog, { tabIndex: -1 });
    const hidden = ui.make('DIV', 'Hidden wrapper', ui.dialog, { hidden: true });
    const hiddenControl = ui.make('BUTTON', 'Hidden child', hidden);
    const inert = ui.make('DIV', 'Inert wrapper', ui.dialog, { inert: true });
    const inertControl = ui.make('BUTTON', 'Inert child', inert);
    const invisible = ui.make('BUTTON', 'Invisible', ui.dialog, { visibility: 'hidden' });
    const noLayout = ui.make('BUTTON', 'No layout', ui.dialog, { getClientRects: () => [] });
    const actual = getEvidenceTabbables(ui.dialog);
    for (const control of [disabled, negative, hiddenControl, inertControl, invisible, noLayout]) expect(actual).not.toContain(control);
    expect(actual).toContain(ui.close);
  });
});

describe('retained evidence presentation', () => {
  test('chronology separates source timestamps from retained observation changes and marks missing dates', () => {
    const previous = { revisionId: 'r1', firstObservedAt: '2026-09-04T11:00:00Z' };
    const current = { revisionId: 'r2', publishedAt: '2026-09-04T10:00:00Z', retrievedAt: '2026-09-04T12:00:00Z', firstObservedAt: '2026-09-04T12:01:00Z', changed: true, changeKind: 'capture-expanded' };
    const html = renderEvidenceTimeline({ revisions: [current, previous] }, current);
    expect(html.indexOf('2026-09-04T10:00:00.000Z')).toBeLessThan(html.indexOf('2026-09-04T11:00:00.000Z'));
    expect(html).toContain('Publisher updated');
    expect(html).toContain('Time unknown');
    expect(html).toContain('Captured');
    expect(html).toContain('More source context retained');
    expect(html).toContain('does not establish a new threat event');
  });
  test('relationship edges only represent literal CVEs in the retained observation', () => {
    const record = { source: '<Publisher>', canonicalUrl: 'https://example.test/report', cves: ['CVE-2026-9999'] };
    const revision = { title: 'Advisory on CVE-2026-1234', passage: 'CVE-2026-1234 and cve-2026-5678 are mentioned.' };
    const html = renderEvidenceRelationships(record, revision);
    expect(html).toContain('&lt;Publisher&gt;');
    expect(html).toContain('Publishes →');
    expect(html).toContain('Mentions →');
    expect(html).toContain('CVE-2026-5678');
    expect(html).not.toContain('CVE-2026-9999');
    expect(html.match(/class="evidence-related-cve"/g)).toHaveLength(2);
    expect(renderEvidenceRelationships(record, { passage: 'No vulnerability identified.' })).toContain('No relationship diagram is inferred');
    expect(renderEvidenceRelationships({ canonicalUrl: 'javascript:alert(1)' }, revision)).not.toContain('href="javascript:');
  });
  test('separates declared relevance from exposure and escapes untrusted terms', () => {
    expect(renderEvidenceContext({ evidence: [{ changed: true }], applicability: { state: 'declared-match' } }))
      .toContain('Retained source changed · Watch profile match');
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
    expect(displayedPassages[0]).toBe('Affected: &lt;2.4.<ins aria-label="Added text">3</ins>');
    expect(displayedPassages[1]).toBe('Affected: &lt;2.4.<del aria-label="Removed text">2</del>');
    expect(html.indexOf('class="evidence-passage"')).toBeLessThan(html.indexOf('Copy evidence link'));
    expect(html.indexOf('class="evidence-passage"')).toBeLessThan(html.indexOf('Source observation timeline'));
    expect(html).toContain('Previous · removed text');
    expect(html).toContain('Current · added text');
    expect(html).toContain('Published</dt><dd>Unknown');
    expect(html).toContain('retained feed excerpt; not the full article');
    expect(html).toContain('Selected source revision');
  });

  test('preserves complete before and after text for insertion-only and deletion-only changes', () => {
    for (const changes of [
      { before: 'Use ', removed: '', added: '<patched> ', after: 'build.' },
      { before: 'Use ', removed: '<legacy> ', added: '', after: 'build.' },
    ]) {
      const html = renderEvidenceRecord({ source: '<Publisher>', revisions: [{ revisionId: 'r1', changes }] });
      const displayedPassages = [...html.matchAll(/<blockquote class="evidence-passage">([\s\S]*?)<\/blockquote>/g)].map(match => match[1]);
      const strip = text => text.replace(/<\/?(?:del|ins)(?: [^>]*)?>/g, '');
      expect(strip(displayedPassages[0])).toBe(`Use ${changes.added.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}build.`);
      expect(strip(displayedPassages[1])).toBe(`Use ${changes.removed.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}build.`);
      expect(html).not.toContain('<Publisher>');
      expect(html.match(/<figcaption>&lt;Publisher&gt;/g)).toHaveLength(2);
    }
  });

  test('changes-only comparison isolates literal differences while retaining both complete excerpts', () => {
    const html = renderEvidenceRecord({ revisions: [{ revisionId: 'r2', changed: true,
      passage: 'Affected: <2.4.3', previousPassage: 'Affected: <2.4.2',
      changes: { before: 'Affected: <2.4.', removed: '2', added: '3', after: '' },
    }] }, 'r2', { changesOnly: true });
    const passages = [...html.matchAll(/<blockquote class="evidence-passage">([\s\S]*?)<\/blockquote>/g)].map(match => match[1]);
    expect(passages).toEqual(['<ins aria-label="Added text">3</ins>', '<del aria-label="Removed text">2</del>', 'Affected: &lt;2.4.3', 'Affected: &lt;2.4.2']);
    expect(html).toContain('Observation details contains both complete retained excerpts');
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

  test('labels added capture and metadata changes without inventing a publisher correction', () => {
    expect(describeEvidenceChange({ changes: { added: 'More retained text', removed: '' } })).toBe('Additional text retained');
    expect(describeEvidenceChange({ changed: true, title: 'Same', passageTruncated: false }, { title: 'Same', passageTruncated: true }))
      .toBe('Retention detail changed; excerpt unchanged');
    expect(describeEvidenceChange({ changed: true, title: 'New title' }, { title: 'Old title' })).toBe('Source title changed; excerpt unchanged');
    expect(describeEvidenceChange({ changed: true })).toBe('Retained observation changed; excerpt unchanged');
  });

  test('source choices retain a readable escaped title, date and revision status', () => {
    const html = renderEvidenceSources([{ source: '<Publisher>', title: 'A long distinct source title', changed: true, retrievedAt: '2026-09-04T12:00:00Z' }]);
    expect(html).toContain('&lt;Publisher&gt;');
    expect(html).toContain('A long distinct source title');
    expect(html).toContain('Sep 4, 2026, 12:00 UTC');
    expect(html).toContain('Retained source changed');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('<option');
  });
});

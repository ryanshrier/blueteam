import { describe, expect, jest, test } from '@jest/globals';
import { renderEvidenceContext, renderApplicability, renderEvidenceRecord, getEvidenceTabbables, trapEvidenceTab } from '../public/modules/wire/evidence-inspector.js';

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

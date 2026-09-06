import { describe, expect, test } from '@jest/globals';
import { highlightWireText, renderWireDescription, reflectReadControl } from '../public/modules/wire/wire-presentation.js';

describe('Wire readable summaries and search matches', () => {
  test('passive reading keeps menu commands action-labeled while inspector controls report state', () => {
    const button = dataset => ({ dataset, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, innerHTML: '' });
    const menu = button({ readAction: '' });
    const state = button({});
    reflectReadControl(menu, true);
    reflectReadControl(state, true);
    expect(menu.innerHTML).toBe('Mark unread');
    expect(menu.attrs['aria-label']).toBe('Mark unread');
    expect(state.innerHTML).toContain('>Read</span>');
    expect(state.attrs['aria-pressed']).toBe('true');
    reflectReadControl(menu, false);
    expect(menu.innerHTML).toBe('Mark read');
    expect(menu.attrs['aria-pressed']).toBe('false');
  });

  test('highlights literal case-insensitive matches without interpreting regex or feed HTML', () => {
    expect(highlightWireText('CVE.42 cve.42 CVEX42', 'cve.42')).toBe('<mark class="wire-match">CVE.42</mark> <mark class="wire-match">cve.42</mark> CVEX42');
    expect(highlightWireText('<img onerror="unsafe">', 'img')).toBe('&lt;<mark class="wire-match">img</mark> onerror=&quot;unsafe&quot;&gt;');
    expect(highlightWireText('<b>text</b>', '')).toBe('&lt;b&gt;text&lt;/b&gt;');
  });

  test('uses original source offsets when Unicode lowercasing changes character length', () => {
    expect(highlightWireText('İstanbul and STAN', 'stan')).toBe('İ<mark class="wire-match">stan</mark>bul and <mark class="wire-match">STAN</mark>');
    expect(highlightWireText('İstanbul <STAN> İstanbul', 'stan')).toBe('İ<mark class="wire-match">stan</mark>bul &lt;<mark class="wire-match">STAN</mark>&gt; İ<mark class="wire-match">stan</mark>bul');
  });

  test('retains the entire summary and an associated expansion control without truncating source text', () => {
    const description = `${'Complete retained summary. '.repeat(20)}Final important sentence.`;
    const html = renderWireDescription(description, { id: 'summary-1', key: 'source"key', expanded: false });
    expect(html).toContain(description);
    expect(html).toContain('aria-controls="summary-1"');
    expect(html).toContain('data-summary="source&quot;key"');
    expect(html).toContain('aria-expanded="false" hidden');
    expect(renderWireDescription(description, { id: 'summary-1', key: 'source', expanded: true })).toContain('aria-expanded="true">Show less');
    expect(renderWireDescription('', { id: 'summary-1', key: 'source' })).toBe('');
  });
});

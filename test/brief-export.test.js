import { describe, expect, jest, test } from '@jest/globals';
import {
  NEWSPAPER_CSS,
  PRINT_DOCUMENT_CSP,
  PRINT_IFRAME_SANDBOX,
  bindEditionPrintShortcut,
  buildDocument,
  collectEditionWarnings,
  exportBriefNewspaper,
  gatePrintUntilReady,
  formatGeneratedFreshness,
  isAssessmentFieldHtml,
  printTopLevelDocument,
  shouldKeepFieldParagraphTogether,
  shouldKeepShortListTogether,
  stripAssessmentLabelHtml,
  splitPackedJudgmentFieldHtml,
} from '../public/modules/briefing/brief-export.js';
import {
  actionDeadlineSuffix,
  decisionWindowDuplicatesAction,
  partitionTheLineHtml,
} from '../public/modules/briefing/brief-renderer.js';

describe('edition field normalization', () => {
  test('splits packed judgment fields while preserving an unlabelled continuation', () => {
    const packed = [
      '<strong>Assessment:</strong> Active exploitation is likely.',
      '<strong>What happened:</strong> CISA updated the catalog.',
      'This sentence continues the evidence field.',
      '<strong>Defender impact:</strong> Internet-facing routers are exposed.',
      '<strong>The line:</strong> Patch the edge before the edge becomes access.',
    ].join('<br>');

    expect(splitPackedJudgmentFieldHtml(packed)).toEqual([
      '<strong>Assessment:</strong> Active exploitation is likely.',
      '<strong>What happened:</strong> CISA updated the catalog.<br>This sentence continues the evidence field.',
      '<strong>Defender impact:</strong> Internet-facing routers are exposed.',
      '<strong>The line:</strong> Patch the edge before the edge becomes access.',
    ]);
  });

  test('does not split intentional prose breaks or promote a non-Assessment paragraph', () => {
    const prose = '<strong>Context:</strong> First line.<br>Second intentional line.';
    expect(splitPackedJudgmentFieldHtml(prose)).toEqual([prose]);
    expect(isAssessmentFieldHtml('<strong>What happened:</strong> Evidence.')).toBe(false);
    expect(isAssessmentFieldHtml('<strong>Assessment</strong>: Judgment.')).toBe(true);
    expect(isAssessmentFieldHtml('<strong>Assessment:</strong> Judgment.')).toBe(true);
    expect(stripAssessmentLabelHtml('<strong>Assessment:</strong> Judgment with <code>evidence</code>.'))
      .toBe('Judgment with <code>evidence</code>.');
  });

  test('suppresses a decision-window target only when an action repeats its exact deadline suffix', () => {
    const action = 'Infrastructure — verify every appliance — July 13, 19:00 CT.';
    expect(actionDeadlineSuffix(action)).toBe('July 13, 19:00 CT.');
    expect(decisionWindowDuplicatesAction('July 13, 19:00 CT', [action])).toBe(true);
    expect(decisionWindowDuplicatesAction('July 14, close of business', [action])).toBe(false);
    expect(decisionWindowDuplicatesAction('July 13', ['Review July 13 reporting before triage.'])).toBe(false);
  });

  test('extracts The line from a packed Recommended actions list item', () => {
    const packedLi = [
      '<strong>Detection Engineering</strong> — add the rule by close of business.',
      '<strong>The line:</strong> A 2008 bug is a live mandate when routers remain exposed.',
    ].join('<br>');

    expect(partitionTheLineHtml(packedLi)).toEqual({
      keptHtml: '<strong>Detection Engineering</strong> — add the rule by close of business.',
      lineHtml: 'A 2008 bug is a live mandate when routers remain exposed.',
    });
  });

  test('accepts both bold-colon forms for The line and preserves inline markup', () => {
    expect(partitionTheLineHtml('<strong>The line</strong>: Patch <code>CVE-2026-12345</code>.').lineHtml)
      .toBe('Patch <code>CVE-2026-12345</code>.');
    expect(partitionTheLineHtml('<strong>The line:</strong> Verify <a href="https://example.test">the source</a>.').lineHtml)
      .toBe('Verify <a href="https://example.test">the source</a>.');
  });

  test('keeps ordinary labeled fields atomic but lets unusually long prose flow', () => {
    const field = '<strong>What happened:</strong> Evidence.';
    expect(shouldKeepFieldParagraphTogether(field, 280)).toBe(true);
    expect(shouldKeepFieldParagraphTogether(field, 281)).toBe(false);
    expect(shouldKeepFieldParagraphTogether('<strong>Trajectory:</strong> Emerging.<br><strong>Watch criteria:</strong> Escalate.', 100)).toBe(true);
    expect(shouldKeepFieldParagraphTogether('<strong>Context:</strong> Prose.', 100)).toBe(false);
  });

  test('keeps only bounded short action lists atomic', () => {
    expect(shouldKeepShortListTogether(3, 640)).toBe(true);
    expect(shouldKeepShortListTogether(4, 300)).toBe(false);
    expect(shouldKeepShortListTogether(2, 641)).toBe(false);
  });
});

describe('edition print contract', () => {
  test.each(['navigation', 'close button', 'Escape', 'native close'])('preview cleanup on %s removes the iframe, readiness work and print shortcut exactly once', async reason => {
    jest.useFakeTimers();
    const priorDocument = globalThis.document;
    const priorLocation = globalThis.location;
    const listenable = () => ({ addEventListener: jest.fn(), removeEventListener: jest.fn(), setAttribute: jest.fn(), removeAttribute: jest.fn() });
    const frame = { ...listenable(), contentWindow: { focus: jest.fn(), print: jest.fn() } };
    const printButton = { ...listenable() };
    const closeButton = { ...listenable(), focus: jest.fn() };
    const opener = { isConnected: true, focus: jest.fn() };
    const bodyChildren = new Set();
    const overlay = { ...listenable(), open: false,
      showModal: jest.fn(() => { overlay.open = true; }),
      close: jest.fn(() => { overlay.open = false; }),
      remove: jest.fn(() => { bodyChildren.delete(overlay); }),
      querySelector: selector => ({ '.np-frame': frame, '.np-ov-print': printButton, '.np-ov-close': closeButton })[selector],
    };
    const doc = { ...listenable(), body: { appendChild: node => bodyChildren.add(node) },
      createElement: () => overlay, createTreeWalker: () => ({ nextNode: () => null }) };
    const completeAction = 'Incident response — review the retained evidence; if compromise is confirmed, rotate passwords and reset tokens — recommended target September 8, 2026.';
    let notePresent = true;
    let reviewPresent = true;
    const note = { innerHTML:'<summary>Editorial review · 1 correction</summary><ul><li id="review-action"><strong>Preserve recovery</strong> — Full conditional recovery from <a href="https://example.test/advisory">the retained advisory</a>.</li></ul>',
      querySelector: selector => selector === 'summary' ? { remove: () => { note.innerHTML = note.innerHTML.replace(/<summary>.*?<\/summary>/, ''); } } : null,
      remove: () => { notePresent = false; } };
    const clone = { ownerDocument: doc, get innerHTML() { return `<section class="bluf">Saved briefing.</section><ul class="brief-recommended-actions"><li>${completeAction}</li></ul>${reviewPresent ? `<details class="brief-review-summary"><summary>Editorial review</summary>${notePresent ? `<section class="brief-review-note">${note.innerHTML}</section>` : ''}</details>` : ''}`; }, textContent: 'Saved briefing.',
      querySelector: () => null, querySelectorAll: selector => selector === '.brief-review-note' && notePresent ? [note]
        : selector === '[data-review-original], .brief-review-summary' ? [{ remove:()=>{ reviewPresent = false; notePresent = false; } }] : [] };
    globalThis.document = doc;
    globalThis.location = { origin: 'https://desk.example' };
    try {
      const dispose = exportBriefNewspaper({ contentEl: { cloneNode: () => clone, querySelectorAll: () => [] }, filename: 'brief-2026-09-06-02.md', opener });
      expect(typeof dispose).toBe('function');
      expect(bodyChildren.has(overlay)).toBe(true);
      expect(frame.srcdoc).toContain('Saved briefing.');
      const intelligence = frame.srcdoc.split('<div class="np-body brief-content">')[1].split('\n    </div>')[0];
      expect(intelligence).toContain(completeAction);
      expect(intelligence).not.toContain('brief-review-note');
      expect(intelligence).not.toContain('Full conditional recovery');
      expect(frame.srcdoc.match(/Full conditional recovery/g)).toHaveLength(1);
      expect(frame.srcdoc.indexOf('Full conditional recovery')).toBeGreaterThan(frame.srcdoc.indexOf('Editorial corrections appendix'));
      expect(frame.srcdoc).toContain('id="review-action"');
      expect(frame.srcdoc).toContain('href="https://example.test/advisory"');
      expect(jest.getTimerCount()).toBe(1);
      const printShortcut = doc.addEventListener.mock.calls.find(([name]) => name === 'keydown')[1];
      if (reason === 'navigation') dispose({ restoreFocus: false });
      else if (reason === 'close button') closeButton.addEventListener.mock.calls.find(([name]) => name === 'click')[1]({});
      else {
        if (reason === 'native close') overlay.open = false;
        overlay.addEventListener.mock.calls.find(([name]) => name === (reason === 'Escape' ? 'cancel' : 'close'))[1]({ preventDefault: jest.fn() });
      }
      dispose({ restoreFocus: false });

      expect(bodyChildren.size).toBe(0);
      expect(overlay.close).toHaveBeenCalledTimes(reason === 'native close' ? 0 : 1);
      expect(overlay.remove).toHaveBeenCalledTimes(1);
      expect(doc.removeEventListener).toHaveBeenCalledWith('keydown', printShortcut);
      expect(frame.removeEventListener).toHaveBeenCalledWith('load', expect.any(Function));
      expect(jest.getTimerCount()).toBe(0);
      const subsequentPrint = { key: 'p', ctrlKey: true, preventDefault: jest.fn() };
      printShortcut(subsequentPrint);
      expect(subsequentPrint.preventDefault).not.toHaveBeenCalled();
      expect(frame.contentWindow.print).not.toHaveBeenCalled();
      expect(opener.focus).toHaveBeenCalledTimes(reason === 'navigation' ? 0 : 1);
      if (reason !== 'navigation') expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
      await jest.advanceTimersByTimeAsync(8_000);
      expect(printButton.disabled).toBe(true);
    } finally {
      globalThis.document = priorDocument;
      globalThis.location = priorLocation;
      jest.useRealTimers();
    }
  });

  test('labels generated time in UTC consistently across local time zones', () => {
    expect(formatGeneratedFreshness('2026-09-05T04:30:00Z', '', '')).toBe('Generated 04:30 UTC');
  });
  test('routes Ctrl/Cmd+P through Edition printing only while the dialog is open', () => {
    let onKeydown;
    const doc = {
      addEventListener: jest.fn((name, handler) => {
        expect(name).toBe('keydown');
        onKeydown = handler;
      }),
      removeEventListener: jest.fn((name, handler) => {
        expect(name).toBe('keydown');
        expect(handler).toBe(onKeydown);
      }),
    };
    const dialog = { open: true };
    const printEdition = jest.fn();
    const cleanup = bindEditionPrintShortcut(doc, dialog, printEdition);
    const ctrlPrint = {
      key: 'p',
      ctrlKey: true,
      preventDefault: jest.fn(),
    };

    onKeydown(ctrlPrint);
    expect(ctrlPrint.preventDefault).toHaveBeenCalledTimes(1);
    expect(printEdition).toHaveBeenCalledTimes(1);

    const repeatedPrint = {
      key: 'p',
      ctrlKey: true,
      repeat: true,
      preventDefault: jest.fn(),
    };
    onKeydown(repeatedPrint);
    expect(repeatedPrint.preventDefault).toHaveBeenCalledTimes(1);
    expect(printEdition).toHaveBeenCalledTimes(1);

    const commandPrint = { key: 'P', metaKey: true, preventDefault: jest.fn() };
    onKeydown(commandPrint);
    expect(commandPrint.preventDefault).toHaveBeenCalledTimes(1);
    expect(printEdition).toHaveBeenCalledTimes(2);

    dialog.open = false;
    const closedPrint = { key: 'p', metaKey: true, preventDefault: jest.fn() };
    onKeydown(closedPrint);
    expect(closedPrint.preventDefault).not.toHaveBeenCalled();
    expect(printEdition).toHaveBeenCalledTimes(2);

    dialog.open = true;
    const unrelatedChord = { key: 'p', ctrlKey: true, altKey: true, preventDefault: jest.fn() };
    onKeydown(unrelatedChord);
    expect(unrelatedChord.preventDefault).not.toHaveBeenCalled();
    expect(printEdition).toHaveBeenCalledTimes(2);

    cleanup();
    expect(doc.removeEventListener).toHaveBeenCalledWith('keydown', onKeydown);
  });

  test('sandboxes srcdoc without scripts while retaining font access and print dialogs', () => {
    const tokens = PRINT_IFRAME_SANDBOX.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining([
      'allow-same-origin',
      'allow-modals',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
    ]));
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens).not.toContain('allow-top-navigation');
  });

  test('makes preview and top-level print HTML non-executable while retaining inline styles and self-hosted fonts', () => {
    expect(PRINT_DOCUMENT_CSP).toContain("default-src 'none'");
    expect(PRINT_DOCUMENT_CSP).toContain("script-src 'none'");
    expect(PRINT_DOCUMENT_CSP).toContain("object-src 'none'");
    expect(PRINT_DOCUMENT_CSP).toContain("base-uri 'none'");
    expect(PRINT_DOCUMENT_CSP).toContain("connect-src 'none'");
    expect(PRINT_DOCUMENT_CSP).toContain("form-action 'none'");
    expect(PRINT_DOCUMENT_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(PRINT_DOCUMENT_CSP).toContain("font-src 'self'");

    const html = buildDocument({
      bodyHtml: '<p>Sanitized briefing</p>',
      plateTitle: 'BlueTeam News',
      plateSubtitle: 'Threat intelligence',
      longDate: 'July 24, 2026',
      readMins: 5,
      freshness: 'Generated now',
      model: '',
    });
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${PRINT_DOCUMENT_CSP}">`);
    expect(html).toContain('<title>BlueTeam News print edition — July 24, 2026</title>');
    expect(html).toContain('<link rel="stylesheet" href="/fonts.css">');
    expect(html).toContain('<style>');
  });

  test('keeps a white, ink-efficient single-column design in print', () => {
    expect(NEWSPAPER_CSS).toContain('--paper:#fff');
    expect(NEWSPAPER_CSS).toMatch(/@page\{\s*size:auto;\s*margin:14mm;/);
    expect(NEWSPAPER_CSS).toContain("content:'BlueTeam.News · Print edition'");
    expect(NEWSPAPER_CSS).toContain("content:'Page ' counter(page) ' of ' counter(pages)");
    expect(NEWSPAPER_CSS).toContain('html,body{ background:#fff; }');
    expect(NEWSPAPER_CSS).not.toContain('#f6f3ea');
    expect(NEWSPAPER_CSS).not.toContain('print-color-adjust:exact');
    expect(NEWSPAPER_CSS).toContain('print-color-adjust:economy');
    expect(NEWSPAPER_CSS).not.toMatch(/column-count\s*:/);
    expect(NEWSPAPER_CSS).not.toMatch(/hyphens\s*:\s*auto/);
    expect(NEWSPAPER_CSS).toContain('white-space:nowrap');
    expect(NEWSPAPER_CSS).toContain('break-after:avoid-page');
    expect(NEWSPAPER_CSS).toContain('.np-exec-panel');
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body \.np-lead-deck\{[^}]*max-width:66ch; margin:0;[^}]*text-align:left;[^}]*\}/
    );
    expect(NEWSPAPER_CSS).toContain('.np-lead-body{ text-align:left; }');
    expect(NEWSPAPER_CSS).not.toMatch(/\.np-lead-body\s*>\s*p:first-of-type::first-letter/);
  });

  test('keeps narrow-screen layout rules out of print rendering', () => {
    expect(NEWSPAPER_CSS).toContain('@media screen and (max-width:760px)');
    expect(NEWSPAPER_CSS).not.toMatch(/@media\s*\(\s*max-width\s*:/);
  });

  test('keeps story openings, headings, and reasonable field paragraphs intact', () => {
    expect(NEWSPAPER_CSS).toContain('.np-body .np-judgment-opening{ border-top:0; padding:4px 0 0; }');
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body h3,\s*\.np-body \.np-judgment-opening,\s*\.np-body p\.np-field-unit\{\s*break-inside:avoid-page; page-break-inside:avoid;/
    );
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body p\.np-list-intro\{\s*break-after:avoid-page; page-break-after:avoid;/
    );
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body p\.np-list-intro \+ ul,\s*\.np-body p\.np-list-intro \+ ol\{\s*break-before:avoid-page; page-break-before:avoid;/
    );
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body \.np-short-list-group\{\s*break-inside:avoid-page; page-break-inside:avoid;/
    );
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body \.c-action\{\s*display:block;/
    );
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body \.c-action-text\{ display:block; width:100%;/
    );
    expect(NEWSPAPER_CSS).toContain('.np-body p{ orphans:2; widows:2; }');
  });

  test('prints from a top-level document and reports popup refusal cleanly', async () => {
    const writes = [];
    const target = {
      document: {
        fonts: { ready: Promise.resolve() },
        open: jest.fn(),
        write: value => writes.push(value),
        close: jest.fn(),
      },
      focus: jest.fn(),
      print: jest.fn(),
    };

    await expect(printTopLevelDocument('<p>Edition</p>', () => target, 10)).resolves.toBe(true);
    expect(target.document.open).toHaveBeenCalled();
    expect(writes).toEqual(['<p>Edition</p>']);
    expect(target.print).toHaveBeenCalled();
    await expect(printTopLevelDocument('<p>Edition</p>', () => null, 10)).resolves.toBe(false);
  });

  test('carries escaped validation details into the standalone edition', () => {
    const html = buildDocument({
      bodyHtml: '<p>Sanitized briefing</p>',
      plateTitle: 'BlueTeam News',
      plateSubtitle: 'Threat intelligence',
      longDate: 'July 24, 2026',
      readMins: 5,
      freshness: 'Generated now',
      model: '',
      warnings: ['Missing Watchlist', '<script>not markup</script>'],
    });

    expect(html).toContain('Original publication notes — review before distribution');
    expect(html).toContain('<li>Missing Watchlist</li>');
    expect(html).toContain('&lt;script&gt;not markup&lt;/script&gt;');
    expect(html).toContain('Original publication notes: 2 notes retained in the appendix');
    expect(html).toContain('QA review are later editorial annotations');
    expect(html.indexOf('<p>Sanitized briefing</p>')).toBeLessThan(html.indexOf('<li>Missing Watchlist</li>'));
  });

  test('corrected print copies lead with brief provenance and keep full historical notes after the intelligence', () => {
    const html = buildDocument({ bodyHtml: '<div class="bluf">Current corrected assessment.</div>', plateTitle: 'BlueTeam.News', plateSubtitle: 'Threat intelligence',
      longDate: 'September 5, 2026', readMins: 9, freshness: 'Published Sep 5, 2026, 21:56 UTC',
      warnings: ['QA review: A now-corrected historical count mismatch.'], review: { status: 'editorially-corrected', reviewer: 'Authorized editorial review', reviewedAt: '2026-09-06T03:30:00Z', scope: 'Review against retained passages.', originalSha256:'original-edition-digest' },
      reviewNotesHtml:'<ul><li id="review-count">Retained correction explanation and <a href="https://example.test/report">source</a>.</li></ul>' });
    const assessment = html.indexOf('Current corrected assessment.');
    expect(html.indexOf('Editorially corrected · Reviewed Sep 6, 2026, 03:30 UTC')).toBeLessThan(assessment);
    expect(html.indexOf('Original publication notes (before later correction)')).toBeGreaterThan(assessment);
    expect(html.indexOf('A now-corrected historical count mismatch.')).toBeGreaterThan(assessment);
    expect(html.indexOf('Authorized editorial review')).toBeGreaterThan(assessment);
    expect(html.indexOf('Editorial corrections appendix')).toBeGreaterThan(html.indexOf('Authorized editorial review'));
    expect(html).toContain('Original edition SHA-256: <code>original-edition-digest</code>');
    expect(html).toContain('id="review-count"');
    expect(html).toContain('href="https://example.test/report"');
    expect(html).toContain('style="break-inside:auto;page-break-inside:auto"');
    expect(html).toContain('href="#npPublicationNotes"');
    expect(html).toContain('href="#npEditorialReview"');
  });

  test('merges client-derived archive warnings before the live banner is stripped', () => {
    const liveWarnings = [
      { textContent: 'Missing the Key Judgments section.' },
      { textContent: '  Unsupported source URL.  ' },
    ];
    const content = {
      querySelectorAll: selector => (
        selector === '.brief-validation-warning li' ? liveWarnings : []
      ),
    };

    expect(collectEditionWarnings(content, [
      'Unsupported source URL.',
      'Persisted generation warning.',
    ])).toEqual([
      'Unsupported source URL.',
      'Persisted generation warning.',
      'Missing the Key Judgments section.',
    ]);
  });

  test('keeps Print disabled until iframe load and fonts.ready settle', async () => {
    let onLoad;
    let resolveFonts;
    const fontsReady = new Promise(resolve => { resolveFonts = resolve; });
    const attrs = new Map();
    const button = {
      disabled: false,
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: name => attrs.delete(name),
    };
    const frame = {
      contentDocument: { fonts: { ready: fontsReady } },
      addEventListener: (name, handler, options) => {
        expect(name).toBe('load');
        expect(options).toEqual({ once: true });
        onLoad = handler;
      },
    };

    const ready = gatePrintUntilReady(frame, button);
    expect(button.disabled).toBe(true);
    expect(attrs.get('aria-busy')).toBe('true');

    const loading = onLoad();
    await Promise.resolve();
    expect(button.disabled).toBe(true);

    resolveFonts();
    await loading;
    await ready;
    expect(button.disabled).toBe(false);
    expect(attrs.has('aria-busy')).toBe(false);
  });

  test('enables Print with fallback fonts when iframe/font readiness stalls', async () => {
    jest.useFakeTimers();
    try {
      const attrs = new Map();
      const button = {
        disabled: false,
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: name => attrs.delete(name),
      };
      const frame = { addEventListener: jest.fn() };

      const ready = gatePrintUntilReady(frame, button, 250);
      expect(button.disabled).toBe(true);

      await jest.advanceTimersByTimeAsync(250);
      await ready;

      expect(button.disabled).toBe(false);
      expect(attrs.has('aria-busy')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

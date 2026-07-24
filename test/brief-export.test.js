import { describe, expect, jest, test } from '@jest/globals';
import {
  NEWSPAPER_CSS,
  PRINT_DOCUMENT_CSP,
  PRINT_IFRAME_SANDBOX,
  buildDocument,
  gatePrintUntilReady,
  isAssessmentFieldHtml,
  shouldKeepFieldParagraphTogether,
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
    expect(shouldKeepFieldParagraphTogether(field, 720)).toBe(true);
    expect(shouldKeepFieldParagraphTogether(field, 721)).toBe(false);
    expect(shouldKeepFieldParagraphTogether('<strong>Trajectory:</strong> Emerging.<br><strong>Watch criteria:</strong> Escalate.', 100)).toBe(true);
    expect(shouldKeepFieldParagraphTogether('<strong>Context:</strong> Prose.', 100)).toBe(false);
  });
});

describe('edition print contract', () => {
  test('sandboxes srcdoc without scripts while retaining font access and print dialogs', () => {
    const tokens = PRINT_IFRAME_SANDBOX.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(['allow-same-origin', 'allow-modals']));
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens).not.toContain('allow-top-navigation');
  });

  test('makes preview and downloaded HTML non-executable while retaining inline styles and self-hosted fonts', () => {
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
    expect(html).toContain('<link rel="stylesheet" href="/fonts.css">');
    expect(html).toContain('<style>');
  });

  test('keeps the warm single-column preview design in print', () => {
    expect(NEWSPAPER_CSS).toContain('@page{ size:letter portrait; margin:14mm; background:#f6f3ea; }');
    expect(NEWSPAPER_CSS).toContain('html,body{ background:var(--paper); }');
    expect(NEWSPAPER_CSS).not.toMatch(/column-count\s*:/);
    expect(NEWSPAPER_CSS).not.toMatch(/hyphens\s*:\s*auto/);
    expect(NEWSPAPER_CSS).toContain('white-space:nowrap');
    expect(NEWSPAPER_CSS).toContain('break-after:avoid-page');
    expect(NEWSPAPER_CSS).toContain('.np-exec-panel');
    expect(NEWSPAPER_CSS).toContain('.np-lead-deck');
    expect(NEWSPAPER_CSS).toContain('text-align:center');
    expect(NEWSPAPER_CSS).toContain('.np-lead-body{ text-align:left; }');
    expect(NEWSPAPER_CSS).not.toMatch(/\.np-lead-body\s*>\s*p:first-of-type::first-letter/);
  });

  test('keeps story openings, headings, and reasonable field paragraphs intact', () => {
    expect(NEWSPAPER_CSS).toContain('.np-body .np-judgment-opening{ border-top:1px solid var(--hair); padding:14px 0 0; }');
    expect(NEWSPAPER_CSS).toMatch(
      /\.np-body h3,\s*\.np-body \.np-judgment-opening,\s*\.np-body p\.np-field-unit\{\s*break-inside:avoid-page; page-break-inside:avoid;/
    );
    expect(NEWSPAPER_CSS).toContain('.np-body p{ orphans:4; widows:4; }');
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

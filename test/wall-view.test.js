import { describe, expect, test } from '@jest/globals';
import { judgmentHtml } from '../public/modules/wall/wall-view.js';

function judgment(overrides = {}) {
  return {
    horizon: 1,
    title: 'Synthetic ransomware judgment',
    line: 'A fictional incident demonstrates the decision model.',
    assessment: 'The example requires a bounded internal response.',
    decision: '7 days.',
    confidence: 'Likely (55-80%)',
    actionShift: null,
    isKEV: false,
    kevCVE: '',
    ...overrides,
  };
}

describe('Wall Key Judgment timing', () => {
  test('renders Horizon, Decision, and calibrated Confidence as separate analytic axes', () => {
    const html = judgmentHtml(judgment(), '2026-07-28');

    expect(html).toContain('class="nb-jfacts"');
    expect(html).toContain('<dt>Horizon</dt>');
    expect(html).toContain('TACTICAL</dd>');
    expect(html).toContain('<dt>Decision</dt>');
    expect(html).toContain('<dd>Within 7 days</dd>');
    expect(html).toContain('<dt>Confidence</dt><dd>Likely (55-80%)</dd>');
    expect(html).toContain(
      'aria-label="Decision window: within 7 days, measured from the July 28, 2026 Briefing"'
    );
    expect(html).not.toContain('7 DAYS.');
    expect(html).not.toContain('ACT NOW');
  });

  test('uses Act now only when the Briefing carries an explicit this-shift action', () => {
    const html = judgmentHtml(judgment({
      decision: 'Current shift.',
      actionShift: { owner: null, imperative: 'Verify the synthetic exposure now.' },
    }));

    expect(html).toContain('<dd>This shift</dd>');
    expect(html).toContain('Verify the synthetic exposure now.');
  });

  test('keeps action owner and recommended target outside the clamped imperative', () => {
    const html = judgmentHtml(judgment({
      decision: 'Current shift.',
      actionShift: {
        owner: null,
        imperative: 'Infrastructure — verify every synthetic server and isolate any unpatched instance — recommended target July 29, 2026.',
      },
    }));

    expect(html).toContain('class="nb-act-owner">Infrastructure</span>');
    expect(html).toContain('class="nb-act-text nb-clamp nb-clamp-3">verify every synthetic server and isolate any unpatched instance</span>');
    expect(html).toContain('<small>Recommended target</small><strong>July 29, 2026</strong>');
  });

  test('moves KEV provenance beside the assessment rather than into the fact rail', () => {
    const html = judgmentHtml(judgment({
      isKEV: true,
      kevCVE: 'CVE-2026-50522',
    }));

    expect(html).toContain('class="nb-jevidence"');
    expect(html).toContain('class="nb-evidence-kev">KEV · CVE-2026-50522</span>');
    const rail = html.slice(html.indexOf('class="nb-jhead-aside"'), html.indexOf('</div>', html.indexOf('class="nb-jhead-aside"')));
    expect(rail).not.toContain('CVE-2026-50522');
  });

  test('preserves an archived absolute deadline without making it look sourced', () => {
    const html = judgmentHtml(judgment({ decision: 'July 17, close of business.' }));

    expect(html).toContain('nb-jdecision is-legacy');
    expect(html).toContain('<dd>By July 17, close of business</dd>');
    expect(html).not.toContain('CISA');
    expect(html).not.toContain('SOURCE');
  });

  test('omits an empty Decision block and escapes unknown archived text', () => {
    expect(judgmentHtml(judgment({ decision: '' }))).not.toContain('nb-jdecision');

    const html = judgmentHtml(judgment({ decision: '<script>alert(1)</script>.' }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('falls back to a generic Decision label when no valid Briefing date is available', () => {
    const html = judgmentHtml(judgment(), 'not-a-date');
    expect(html).toContain('aria-label="Decision window: Within 7 days"');
    expect(html).not.toContain('measured from');
  });
});

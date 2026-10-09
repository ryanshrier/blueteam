import { expect, test } from '@jest/globals';
import { presentDecisionFirst } from '../public/modules/briefing/brief-renderer.js';
import { expandReaderDisclosures } from '../public/modules/briefing/brief-export.js';

// A small DOM contract for moving existing nodes: the test checks that the
// authored evidence is preserved across the reader and printable artifact.
function fixture() {
  const doc = { createElement: tag => node(tag) };
  function node(tag, cls = '', text = '') {
    return {
      tagName: tag.toUpperCase(), className: cls, textContent: text, children: [], parent: null, ownerDocument: doc,
      get childNodes() { return this.children; },
      appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
      replaceWith(...children) {
        const parent = this.parent;
        const index = parent.children.indexOf(this);
        children.forEach(child => child.remove());
        parent.children.splice(index, 1, ...children);
        children.forEach(child => { child.parent = parent; });
        this.parent = null;
      },
      querySelectorAll(selector) {
        if (selector.includes(',')) return selector.split(',').flatMap(part => this.querySelectorAll(part.trim()));
        const direct = selector.startsWith(':scope > ');
        const target = selector.replace(':scope > ', '');
        const match = child => target.startsWith('.') ? child.className === target.slice(1) : child.tagName === target.toUpperCase();
        const descendants = list => list.flatMap(child => [child, ...descendants(child.children)]);
        return (direct ? this.children : descendants(this.children)).filter(match);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    };
  }
  const card = node('div', 'brief-judgment-card');
  const heading = node('h3', '', 'Authored judgment');
  const meta = node('div', 'brief-judgment-meta', 'Tactical · Likely');
  const assessment = node('p', '', 'Assessment: complete authored claim with retained citation and qualification');
  const caveat = node('p', '', 'Exposure remains unverified');
  const action = node('div', 'c-action', 'Operations — confirm affected versions');
  const tools = node('div', 'brief-judgment-tools', 'Copy decision');
  [heading, meta, assessment, caveat, action, tools].forEach(child => card.appendChild(child));
  return { card, heading, meta, assessment, caveat, action, tools };
}

test('report keeps complete assessment and supporting paragraphs before its action, also in print', () => {
  const { card, heading, meta, assessment, caveat, action, tools } = fixture();
  presentDecisionFirst(card);
  expect(card.children).toEqual([heading, assessment, meta, caveat, action, tools]);
  presentDecisionFirst(card);
  expect(card.children).toHaveLength(6);
  expandReaderDisclosures(card);
  expect(card.children).toEqual([heading, assessment, meta, caveat, action, tools]);
  expect(card.querySelectorAll('.brief-judgment-support')).toEqual([]);
});

test('a technical table stays attached to its evidence paragraph ahead of the response', () => {
  const { card, caveat, action } = fixture();
  caveat.textContent = 'What happened: affected builds are listed below.';
  const table = card.ownerDocument.createElement('table');
  table.textContent = 'Branch A: fixed in 7.111.21; Branch B: fixed in 7.117.28.';
  card.children.splice(card.children.indexOf(caveat) + 1, 0, table);
  table.parent = card;
  presentDecisionFirst(card);
  expect(card.children[card.children.indexOf(caveat) + 1]).toBe(table);
  expect(card.children.indexOf(table)).toBeLessThan(card.children.indexOf(action));
  expandReaderDisclosures(card);
  expect(table.textContent).toContain('7.117.28');
});

test('source metadata remains visible after the response instead of entering a disclosure', () => {
  const { card, heading, assessment, action } = fixture();
  const metadata = card.ownerDocument.createElement('dl');
  metadata.className = 'assessment-meta';
  card.appendChild(metadata);
  presentDecisionFirst(card);
  expect(card.children.slice(0, 2)).toEqual([heading, assessment]);
  expect(card.children.indexOf(assessment)).toBeLessThan(card.children.indexOf(action));
  expect(card.children.indexOf(metadata)).toBeGreaterThan(card.children.indexOf(action));
  expect(metadata.parent).toBe(card);
});

test('decision summary keeps version applicability and defender impact outside collapsed assessment', () => {
  const { card, assessment, caveat, action } = fixture();
  assessment.textContent = 'What happened: affected before 7.111.21; exploitation reported.';
  caveat.textContent = 'Defender impact: preserve logs; local exposure is unknown.';
  presentDecisionFirst(card);
  expect(assessment.parent).toBe(card);
  expect(caveat.parent).toBe(card);
  expect(assessment.textContent).toContain('7.111.21');
  expect(card.children.indexOf(assessment)).toBeLessThan(card.children.indexOf(action));
  expect(card.children.indexOf(caveat)).toBeLessThan(card.children.indexOf(action));
});

test('mixed confidence precedes the response and survives print with its complete context', () => {
  const { card, action } = fixture();
  const confidence = card.ownerDocument.createElement('p');
  confidence.className = 'brief-certainty';
  confidence.textContent = 'Confidence: High for catalog status; Moderate for campaign detail. The fetched body was rejected. This assessment does not use that body.';
  card.appendChild(confidence);
  presentDecisionFirst(card);
  const detail = card.querySelector('.brief-confidence-detail');
  expect(detail.querySelector('summary').textContent).toBe('Confidence details');
  expect(card.children.indexOf(detail)).toBeLessThan(card.children.indexOf(action));
  expect(confidence.textContent).toBe('Confidence: High for catalog status; Moderate for campaign detail. The fetched body was rejected. This assessment does not use that body.');
  expect(card.querySelector('.brief-material-unknown').textContent).toBe('The fetched body was rejected. This assessment does not use that body.');
  expandReaderDisclosures(card);
  expect(confidence.parent).toBe(card);
  expect(confidence.textContent).toContain('does not use that body');
});

test('likelihood details keep probability distinct from confidence and preserve the authored paragraph', () => {
  const { card } = fixture();
  const likelihood = card.ownerDocument.createElement('p');
  likelihood.className = 'brief-certainty';
  likelihood.textContent = 'Likelihood: Likely (55–80%). Limited deployment evidence bounds this forecast.';
  card.appendChild(likelihood);
  presentDecisionFirst(card);
  expect(card.querySelector('.brief-confidence-detail').querySelector('summary').textContent).toBe('Likelihood details');
  expandReaderDisclosures(card);
  expect(likelihood.parent).toBe(card);
  expect(likelihood.textContent).toBe('Likelihood: Likely (55–80%). Limited deployment evidence bounds this forecast.');
});

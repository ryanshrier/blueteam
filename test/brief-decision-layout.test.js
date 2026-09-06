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

test('reader keeps the complete assessment before its action and prints every supporting paragraph', () => {
  const { card, heading, meta, assessment, caveat, action, tools } = fixture();
  presentDecisionFirst(card);
  expect(card.children.slice(0, 5)).toEqual([heading, assessment, meta, action, tools]);
  const disclosure = card.children[5];
  expect(disclosure.className).toBe('brief-judgment-support');
  expect(disclosure.children.slice(1)).toEqual([caveat]);
  presentDecisionFirst(card);
  expect(card.children).toHaveLength(6);
  expandReaderDisclosures(card);
  expect(card.children).toEqual([heading, assessment, meta, action, tools, caveat]);
  expect(card.querySelectorAll('.brief-judgment-support')).toEqual([]);
});

test('shared metadata stays beside the authored assessment instead of entering the evidence disclosure', () => {
  const { card, heading, assessment, action } = fixture();
  const metadata = card.ownerDocument.createElement('dl');
  metadata.className = 'assessment-meta';
  card.appendChild(metadata);
  presentDecisionFirst(card);
  expect(card.children.slice(0, 3)).toEqual([heading, assessment, metadata]);
  expect(card.children.indexOf(assessment)).toBeLessThan(card.children.indexOf(action));
  expect(metadata.parent).toBe(card);
});

test('decision summary keeps version applicability and defender impact outside collapsed assessment', () => {
  const { card, assessment, caveat } = fixture();
  assessment.textContent = 'What happened: affected before 7.111.21; exploitation reported.';
  caveat.textContent = 'Defender impact: preserve logs; local exposure is unknown.';
  presentDecisionFirst(card);
  expect(assessment.parent).toBe(card);
  expect(caveat.parent).toBe(card);
  expect(assessment.textContent).toContain('7.111.21');
});

test('mixed confidence and complete uncertainty context survive summary and print', () => {
  const { card } = fixture();
  const confidence = card.ownerDocument.createElement('p');
  confidence.className = 'brief-certainty';
  confidence.textContent = 'Confidence: High for catalog status; Moderate for campaign detail. The fetched body was rejected. This assessment does not use that body.';
  card.appendChild(confidence);
  presentDecisionFirst(card);
  const detail = card.querySelector('.brief-confidence-detail');
  expect(detail.querySelector('summary').textContent).toContain('High for catalog status; Moderate');
  expect(card.querySelector('.brief-material-unknown').textContent).toBe('The fetched body was rejected. This assessment does not use that body.');
  expandReaderDisclosures(card);
  expect(confidence.parent).toBe(card);
  expect(confidence.textContent).toContain('does not use that body');
});

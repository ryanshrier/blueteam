import { describe, expect, jest, test } from '@jest/globals';
import { attachEditorialReview } from '../public/modules/briefing/brief-review.js';

function reader() {
  const targets = [
    { id:'section-bluf', tagName:'H2', textContent:'BLUF', after:jest.fn() },
    { id:'section-0-executive-summary', tagName:'H2', textContent:'Executive summary', after:jest.fn() },
    { id:'judgment-1', tagName:'H3', textContent:'Signal 1 — Conditional recovery', after:jest.fn() },
  ];
  const inserted = [];
  const document = { createElement:tagName=>({ tagName:tagName.toUpperCase(), attributes:{}, setAttribute(name,value){ this.attributes[name] = value; } }) };
  const content = { ownerDocument:document, innerHTML:'<p>Unchanged reviewed reading copy.</p><aside class="brief-validation-warning">Unresolved check remains visible.</aside>',
    querySelectorAll:selector=>selector === '[id]' ? targets : [], querySelector:()=>null, prepend:node=>inserted.unshift(node) };
  return { content, targets, inserted };
}

describe('one consolidated reader review disclosure', () => {
  test('preserves every located reason and identity while leaving the reading body and unresolved warnings intact', () => {
    const { content, targets, inserted } = reader();
    const before = content.innerHTML;
    const notes = [
      { id:'review-bluf', anchor:'section-bluf', label:'Correct scope', reason:'Seven named identities, with an explicit period.' },
      { id:'review-exec', anchor:'section-0-executive-summary', label:'Align decisions', reason:'Use the complete canonical action.' },
      { id:'review-response', anchor:'judgment-1', label:'Preserve recovery', reason:'Keep the conditional review and credential recovery.' },
      { id:'review-legacy-anchor', anchor:'removed-legacy-heading', label:'Retained explanation', reason:'The original heading was removed; this reason remains accessible.' },
    ];
    const review = { status:'editorially-corrected', reviewer:'AI editorial review against captured evidence', reviewedAt:'2026-09-06T16:15:00Z', scope:'Corrected reading copy; original source checks preserved.', originalSha256:'original-digest', notes };
    attachEditorialReview(content, { review });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ tagName:'DETAILS', id:'editorial-review', className:'brief-review-summary' });
    const html = inserted[0].innerHTML;
    expect(html.match(/Editorial review ·/g)).toHaveLength(1);
    expect(html).toContain('Editorial review · 4 corrections');
    expect(html).toContain('href="#section-bluf"');
    expect(html).toContain('href="#section-0-executive-summary"');
    expect(html).toContain('href="#judgment-1"');
    expect(html).not.toContain('href="#removed-legacy-heading"');
    for (const note of notes) {
      expect(html.split(`id="${note.id}"`)).toHaveLength(2);
      expect(html).toContain(note.reason);
    }
    expect(html).toContain(review.reviewer);
    expect(html).toContain(review.scope);
    expect(html).toContain('original-digest');
    expect(html).toContain('data-review-original');
    expect(content.innerHTML).toBe(before);
    expect(targets.every(target=>target.after.mock.calls.length === 0)).toBe(true);
  });

  test('review-required disposition and unavailable-review errors remain visible outside a collapsed disclosure', () => {
    const { content, inserted } = reader();
    attachEditorialReview(content, { disposition:{ status:'review-required', reason:'Unresolved source claim.' }, review:{ status:'unavailable', message:'Review digest does not match; original displayed.' } });
    expect(inserted).toHaveLength(2);
    expect(inserted.every(node=>node.tagName === 'ASIDE')).toBe(true);
    expect(inserted.find(node=>node.className === 'brief-review-summary')).toMatchObject({ textContent:'Review digest does not match; original displayed.', attributes:{ role:'alert' } });
    expect(inserted.find(node=>node.className === 'brief-disposition-notice').innerHTML).toContain('Unresolved source claim.');
  });
});

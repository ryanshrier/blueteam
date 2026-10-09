import { describe, expect, jest, test } from '@jest/globals';
import { attachEditorialReview, editionNotice, editionNoticeHtml, readerPresentation, readerEvidenceLimits } from '../public/modules/briefing/brief-review.js';

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
    expect(inserted[0]).toMatchObject({ tagName:'DETAILS', id:'edition-record', className:'brief-review-summary brief-edition-record' });
    const html = inserted[0].innerHTML;
    expect(html.match(/<summary>Edition record<\/summary>/g)).toHaveLength(1);
    expect(html).toContain('Correction record');
    expect(html).toContain('id="editorial-review"');
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

  test('one shared exception retains the precise reason and replacement independently of the record', () => {
    const brief = { disposition:{ status:'review-required', reason:'Unresolved source claim.' }, review:{ status:'unavailable', message:'Review digest does not match; original displayed.' } };
    expect(editionNoticeHtml(brief)).toContain('Review digest does not match; original displayed.');
    expect(editionNoticeHtml(brief)).not.toContain('<details');
    expect(editionNoticeHtml({ disposition:{ status:'superseded', reason:'Affected versions corrected.', replacementFilename:'brief-2026-09-06.md' } })).toContain('href="/briefing/brief-2026-09-06.md"');
    expect(editionNotice({ disposition:{ status:'eligible', eligibleForLatest:true }, sourceCheckStatus:'findings', review:{ status:'editorially-corrected' } })).toBeNull();
  });

  test('current repaired checks win over raw legacy flags and history never links to current passages', () => {
    const { content, inserted } = reader();
    const presentation = { schemaVersion:1, copy:{ kind:'operator-repaired', contentSha256:'current' }, currentChecks:{ status:'checked', issues:[], warnings:[] },
      history:[{ kind:'original-generation', label:'Original generation', issues:[{ message:'Old unsupported claim.', location:{ line:3, excerpt:'Earlier text.' } }], warnings:['Old unsupported claim.'] }], approval:{ status:'recorded', scope:'security-control-change', reviewer:'Duty analyst', reason:'Scoped maintenance.' } };
    attachEditorialReview(content, { content:'## BLUF\nold\n### Signal 1 — Current', sourceCheckStatus:'findings', presentation });
    const html = inserted[0].innerHTML;
    expect(html).toContain('Automated source checks recorded for this copy.');
    expect(html).toContain('Original generation');
    expect(html).not.toContain('data-record-passage');
    expect(html).toContain('Specific security-control review');
    expect(readerPresentation({ sourceCheckStatus:'checked-supported-forms' }).currentChecks.status).toBe('checked');
    expect(readerPresentation({ sourceCheckStatus:'checked-supported-forms', inputManifest:{ integrity:'invalid', validation:{} } }).currentChecks.status).toBe('unavailable');
  });

  test('only explicitly reader-directed current findings enter the matching judgment', () => {
    const brief = { content:'## KEY JUDGMENTS\n### Signal 1 — First\nAssessment\n### Signal 2 — Second\nAssessment', presentation:{ schemaVersion:1, currentChecks:{ issues:[
      { message:'Current material limit.', audience:'reader', location:{ line:3 } },
      { message:'Other judgment limit.', audience:'reader', location:{ line:5 } },
      { message:'Routine formatting.', audience:'operator', location:{ line:3 } },
      { message:'Unknown old check.', audience:'unclassified', location:{ line:3 } },
    ] } } };
    expect(readerEvidenceLimits(brief,1).map(issue=>issue.message)).toEqual(['Current material limit.']);
  });
});

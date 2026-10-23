import { describe, expect, jest, test } from '@jest/globals';
import { attachEditorialReview, attachReaderLimits, editionNotice, editionNoticeHtml, readerPresentation, readerEvidenceLimits } from '../public/modules/briefing/brief-review.js';
import { decisionCopyText, readerIssueIdentity } from '../public/modules/briefing/brief-renderer.js';

function reader() {
  const targets = [
    { id:'section-bluf', tagName:'H2', textContent:'BLUF', after:jest.fn() },
    { id:'section-0-executive-summary', tagName:'H2', textContent:'Executive summary', after:jest.fn() },
    { id:'judgment-1', tagName:'H3', textContent:'Signal 1 — Conditional recovery', after:jest.fn() },
  ];
  const inserted = [];
  const document = { createElement:tagName=>({ tagName:tagName.toUpperCase(), attributes:{}, dataset:{}, setAttribute(name,value){ this.attributes[name] = value; } }) };
  const content = { ownerDocument:document, innerHTML:'<p>Unchanged reviewed reading copy.</p><aside class="brief-validation-warning">Unresolved check remains visible.</aside>',
    querySelectorAll:selector=>['[id]', 'h2, h3'].includes(selector) ? targets : [], querySelector:selector=>targets.find(target => selector === `#${target.id}`) || null, prepend:node=>inserted.unshift(node) };
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

  test('repeated claim limits appear once per signal while every source location remains in the edition record', () => {
    const { content, inserted, targets } = reader();
    const issue = { code:'CVE_CVSS_AMBIGUOUS', audience:'reader', consequence:'note', message:'Signal 1 CVSS v4.0 9.2 has no unambiguous CVE association.' };
    const first = { ...issue, location:{ scope:'paragraph', line:3, excerpt:'Assessment: a CVSS v4.0 9.2 issue.' } };
    const repeated = { ...issue, location:{ scope:'paragraph', line:4, excerpt:'What happened: CVSS v4.0 9.2 was reported.' } };
    const differentMetric = { ...issue, message:'Signal 1 CVSS v3.1 7.5 has no unambiguous CVE association.', location:{ scope:'paragraph', line:4 } };
    const otherSignal = { ...issue, location:{ scope:'paragraph', line:6, excerpt:'Assessment in a different signal.' } };
    const bookkeeping = { code:'PRIORITY_COVERAGE_MISSING', audience:'operator', consequence:'note', message:'Optional coverage accounting.', location:{ scope:'document' } };
    const brief = { content:'## KEY JUDGMENTS\n### Signal 1 — First\nAssessment\nWhat happened\n### Signal 2 — Second\nAssessment',
      presentation:{ schemaVersion:1, currentChecks:{ status:'checked', issues:[first, repeated, differentMetric, otherSignal, bookkeeping], warnings:[issue.message] } } };
    const before = JSON.stringify(brief);
    const limits = readerEvidenceLimits(brief, 1);
    expect(limits).toHaveLength(2);
    expect(limits[0].readerIssueIds).toEqual([readerIssueIdentity(first), readerIssueIdentity(repeated)]);
    expect(readerEvidenceLimits(brief, 2)).toHaveLength(1);
    expect(readerEvidenceLimits(brief)).toHaveLength(3);
    attachReaderLimits(content, brief);
    expect(targets[2].after).toHaveBeenCalledTimes(2);
    expect(JSON.parse(targets[2].after.mock.calls[0][0].dataset.readerIssueIds)).toEqual(limits[0].readerIssueIds);
    const copied = decisionCopyText({ action:'Verify exposure.', signal:1, sourceContent:brief.content,
      editionUrl:'https://desk.test/briefing/brief-2026-10-23.md', presentation:brief.presentation });
    expect(copied.split(issue.message)).toHaveLength(2);
    expect(copied).toContain(differentMetric.message);
    expect(copied).not.toContain(bookkeeping.message);
    attachEditorialReview(content, brief);
    const html = inserted[0].innerHTML;
    for (const location of [first.location, repeated.location, otherSignal.location]) {
      expect(html).toContain(`Line ${location.line}`);
      expect(html).toContain(location.excerpt);
    }
    expect(html).toContain('<strong>Optional note:</strong>');
    expect(html).toContain(bookkeeping.message);
    expect(JSON.stringify(brief)).toBe(before);
  });

  test('consequence labels retain blocking and review findings, and do not label unknown legacy messages optional', () => {
    const { content, inserted } = reader();
    attachEditorialReview(content, { presentation:{ schemaVersion:1, currentChecks:{ status:'checked', issues:[
      { code:'CVE_CVSS_MISMATCH', consequence:'block', message:'The score conflicts with the captured source.' },
      { code:'PRIORITY_EVIDENCE_UNRESOLVED', consequence:'review', message:'Review unresolved evidence.' },
      { code:'LEGACY_NOTE', message:'Legacy finding with no retained consequence.' },
    ] } } });
    const html = inserted[0].innerHTML;
    expect(html).toContain('<strong>Required fix:</strong> The score conflicts');
    expect(html).toContain('<strong>Review finding:</strong> Review unresolved');
    expect(html).not.toContain('Optional note:');
    expect(html).toContain('Legacy finding with no retained consequence.');
  });
});

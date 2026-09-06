import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDocument, DomUtils } from 'htmlparser2';
import { applyBriefReview } from '../lib/brief-review.js';
import { receiptSources, inputReceiptHtml, filterReceiptSources } from '../public/modules/briefing/brief-inputs.js';

const retained = JSON.parse(readFileSync(new URL('./fixtures/retained-magento-review-2026-09-06.json', import.meta.url), 'utf8'));
const opening = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-06-02-opening.json', import.meta.url), 'utf8')).opening;
const ref = retained.selectedEvidence[0].groupMembers[0].sourceRevisions[0];
const sourceId = `retained:${ref.sourceId}:${ref.revisionId}`;
const copy = value => JSON.parse(JSON.stringify(value));
const reviewFor = evidenceBindings => ({ schemaVersion:1, originalSha256:createHash('sha256').update(opening).digest('hex'), corrections:[], evidenceBindings });

describe('reviewed source bindings against actual retained Magento evidence', () => {
  test('binds display summaries to the corrected reading copy and falls back safely for malformed or stale records', () => {
    const authored = reviewFor([]);
    authored.presentation = { schemaVersion:1, contentSha256:authored.originalSha256, reviewer:'Display review', reviewedAt:'2026-09-06T17:00:00Z', bluf:'Reviewed display assessment.', judgments:[], developing:[] };
    expect(applyBriefReview(opening, authored).review.presentation.status).toBe('reviewed');
    expect(applyBriefReview(opening, authored).reviewedContent).toBe(opening);
    for (const change of [{contentSha256:'stale'}, {judgments:[null]}, {schemaVersion:2}, {judgments:[{index:0},{index:0}]}]) {
      const result = applyBriefReview(opening, {...authored,presentation:{...authored.presentation,...change}});
      expect(result.review.presentation.status).toBe('unavailable');
      expect(result.reviewedContent).toBe(opening);
      expect(result.review.status).toBe('editorially-corrected');
    }
  });
  test('exposes the exact retained feed passage alongside the original promotional grounding passage', () => {
    const before = JSON.stringify(retained);
    const sources = receiptSources(retained);
    expect(sources).toHaveLength(2);
    expect(sources.find(item => item.id === 'S11.1').passageText).toContain('6-day SANS course');
    const feed = sources.find(item => item.id === sourceId);
    expect(feed.passageText).toBe(retained.selectedEvidence[0].groupMembers[0].passage);
    expect(feed.passageText).toContain('StyleSmuggler');
    expect(feed).toMatchObject({ revisionBinding:'exact-member-reference', passageKind:'feed-excerpt', quality:null });
    expect(feed.sourceRevisions).toEqual([ref]);
    expect(JSON.stringify(retained)).toBe(before);
  });

  test('passes bounded review bindings without changing the original and labels judgment seven as reviewed', () => {
    const authored = reviewFor([{ signal:7, sourceIds:[sourceId] }]);
    const overlay = applyBriefReview(opening, authored);
    expect(overlay.reviewedContent).toBe(opening);
    expect(overlay.review.evidenceBindings).toEqual(authored.evidenceBindings);
    expect(overlay.review.evidenceBindings).not.toBe(authored.evidenceBindings);
    const data = { ...retained, filename:'brief-2026-09-06-02.md', judgmentEvidence:[{ signal:1, sourceIds:['S11.1'] }], review:overlay.review };
    const sources = receiptSources(data);
    expect(sources.find(item => item.id === sourceId).judgments).toEqual([7]);
    expect(sources.find(item => item.id === 'S11.1').judgments).toEqual([]);
    const html = inputReceiptHtml(data);
    expect(html).toContain('Reviewed judgment 7');
    expect(html).toContain('Cited in reviewed judgments only');
    expect(html).toContain('/briefing/brief-2026-09-06-02.md#judgment-7');
    expect(html).toContain('Original generation bindings remain in the unchanged saved-input download');
    expect(html).not.toContain('Original judgment 7');
    expect(data.judgmentEvidence).toEqual([{ signal:1, sourceIds:['S11.1'] }]);
  });

  test('uses a readable retained-capture label while exact ID search and reviewed bindings remain intact', () => {
    const data = { ...retained, filename: 'brief-2026-09-06-02.md', review: { evidenceBindings: [{ signal: 7, sourceIds: [sourceId] }] } };
    const before = JSON.stringify(data);
    const tree = parseDocument(inputReceiptHtml(data));
    const rows = DomUtils.findAll(node => Object.hasOwn(node.attribs || {}, 'data-input-source'), tree.children);
    const feed = rows.find(node => node.attribs['data-input-text'].includes(sourceId));
    const label = DomUtils.findOne(node => node.attribs?.class === 'brief-input-source-label', feed.children);
    expect(DomUtils.textContent(label)).toBe('Retained feed capture · Signal group 11');
    expect(DomUtils.textContent(label)).not.toContain(ref.sourceId);
    const capture = DomUtils.findOne(node => node.name === 'details', feed.children);
    expect(Object.hasOwn(capture.attribs, 'open')).toBe(false);
    const identities = DomUtils.findAll(node => node.name === 'code', capture.children).map(DomUtils.textContent);
    expect(identities).toEqual([sourceId, ref.sourceId, ref.revisionId]);
    expect(feed.attribs['data-input-judgments']).toBe('7');

    const search = { value: sourceId.toUpperCase() };
    const count = {};
    const filteredRows = rows.map(node => ({ dataset: { inputText: node.attribs['data-input-text'], inputJudgments: node.attribs['data-input-judgments'] } }));
    const root = { querySelector: selector => ({ '[data-input-search]': search, '[data-input-cited]': { checked: true }, '[data-input-judgment]': { value: '7' }, '[data-input-count]': count })[selector], querySelectorAll: () => filteredRows };
    filterReceiptSources(root);
    expect(filteredRows.filter(row => !row.hidden)).toHaveLength(1);
    expect(count.textContent).toBe('1 retained passage shown');
    search.value = ref.revisionId;
    filterReceiptSources(root);
    expect(filteredRows.filter(row => !row.hidden)).toHaveLength(1);
    expect(JSON.stringify(data)).toBe(before);
  });

  test('retains original binding semantics when the review has no mapping, and an explicit empty mapping stays empty', () => {
    const data = { ...retained, judgmentEvidence:[{ signal:1, sourceIds:['S11.1'] }] };
    expect(receiptSources(data).find(item => item.id === 'S11.1').judgments).toEqual([1]);
    expect(inputReceiptHtml(data)).toContain('Original judgment 1');
    expect(receiptSources({ ...data, review:{ evidenceBindings:[] } }).every(item => item.judgments.length === 0)).toBe(true);
  });

  test('does not bind a different publisher, URL, or ambiguous revision to the retained member text', () => {
    for (const mutate of [
      member => { member.sourceRevisions[0].source = 'Other publisher'; },
      member => { member.sourceRevisions[0].canonicalUrl = 'https://example.test/another-report'; },
      member => { member.sourceRevisions.push({ ...ref, revisionId:`rev_${'1'.repeat(64)}` }); },
    ]) {
      const data = copy(retained);
      mutate(data.selectedEvidence[0].groupMembers[0]);
      data.review = { evidenceBindings:[{ signal:7, sourceIds:[sourceId] }] };
      const feed = receiptSources(data).find(item => item.retainedMember);
      expect(feed.passageText).toContain('StyleSmuggler');
      expect(feed.revisionBinding).toBe('unavailable');
      expect(feed.sourceRevisions).toEqual([]);
      expect(feed.judgments).toEqual([]);
    }
  });

  test('uses only an exact unique group-level fallback and refuses two texts attributed to one revision', () => {
    const fallback = copy(retained);
    fallback.selectedEvidence[0].groupMembers[0].sourceRevisions = [];
    expect(receiptSources(fallback).find(item => item.id === sourceId).sourceRevisions).toEqual([ref]);
    const ambiguous = copy(retained);
    ambiguous.selectedEvidence[0].groupMembers.push({ ...copy(ambiguous.selectedEvidence[0].groupMembers[0]), passage:'Different retained text under the same reference.' });
    const extras = receiptSources(ambiguous).filter(item => item.retainedMember);
    expect(extras).toHaveLength(2);
    expect(extras.every(item => item.revisionBinding === 'unavailable' && item.sourceRevisions.length === 0)).toBe(true);
    expect(new Set(extras.map(item => item.id)).size).toBe(2);
  });

  test('does not duplicate an identical grounding passage or retain unsupported binding payloads', () => {
    const same = copy(retained);
    same.grounding.sources[0].passage = same.selectedEvidence[0].groupMembers[0].passage;
    expect(receiptSources(same)).toHaveLength(1);
    expect(() => applyBriefReview(opening, reviewFor([{ signal:7, sourceIds:['https://example.test/report'] }]))).toThrow('Invalid editorial evidence bindings');
    expect(() => applyBriefReview(opening, reviewFor([{ signal:0, sourceIds:[sourceId] }]))).toThrow('Invalid editorial evidence bindings');
    expect(() => applyBriefReview(opening, reviewFor('invalid'))).toThrow('Invalid editorial evidence bindings');
  });
});

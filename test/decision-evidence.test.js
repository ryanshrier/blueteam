import { decisionEvidence, decisionReviewState } from '../public/modules/wire/decision-evidence.js';
import { importDecisionRecords, exportDecisionRecords, normalizeDecision, decisionLabel } from '../public/modules/wire/wire-workspace.js';

const headline = { evidence: [{ sourceId: 'source', revisionId: 'one' }] };
const saved = { state: 'unaffected', recordedAt: '2026-10-09T12:00:00Z', note: 'Checked inventory', evidenceBinding: decisionEvidence(headline) };
const now = new Date(2026, 9, 9, 12);

test('changed evidence preserves the assessment and flags it as historical', () => {
  const changed = { evidence: [{ sourceId: 'source', revisionId: 'two' }] };
  expect(decisionReviewState(headline, saved, now)).toEqual({ needsReview: false, reasons: [] });
  expect(decisionReviewState(changed, saved, now)).toEqual({ needsReview: true, reasons: ['Evidence revision differs'] });
  expect(decisionLabel(changed, saved)).toContain('Previous assessment: Not affected');
  expect(saved.state).toBe('unaffected');
});

test('portable content bindings tolerate different local revision numbers and ignore malformed refs', () => {
  const contentHash = 'a'.repeat(64);
  const evidenceBinding = decisionEvidence({ evidence: [null, { sourceId: 'source', revisionId: 'machine-a', contentHash }] });
  expect(evidenceBinding).toHaveLength(1);
  expect(decisionReviewState({ evidence: [{ sourceId: 'source', revisionId: 'machine-b', contentHash }] }, { ...saved, evidenceBinding }, now).needsReview).toBe(false);
  expect(decisionReviewState({ evidence: [{ sourceId: 'source', revisionId: 'machine-b', contentHash: 'b'.repeat(64) }] }, { ...saved, evidenceBinding }, now).needsReview).toBe(true);
});

test('legacy bindings, missing evidence and review dates request review without erasing the basis', () => {
  expect(decisionReviewState(headline, { ...saved, evidenceBinding: undefined }, now).reasons).toContain('Evidence revision unavailable');
  expect(decisionReviewState({}, saved, now).needsReview).toBe(true);
  expect(decisionReviewState(headline, { ...saved, nextReview: '2026-10-09' }, now).reasons).toEqual(['Review due']);
  expect(decisionReviewState(headline, { ...saved, nextReview: '2026-10-10' }, now).needsReview).toBe(false);
  expect(normalizeDecision(saved).note).toBe('Checked inventory');
});

test('portable export/import preserves revision bindings and never silently replaces conflicts', () => {
  let body = '{}';
  const storage = { getItem: () => body, setItem: (_key, value) => { body = value; } };
  const records = exportDecisionRecords(new Map([['https://example.test/advisory', saved]]));
  const first = importDecisionRecords(storage, new Map(), records);
  expect(first).toMatchObject({ imported: 1, conflicts: 0, persisted: true });
  expect(first.decisions.get(records[0].signal).evidenceBinding).toEqual(saved.evidenceBinding);
  expect(importDecisionRecords(storage, first.decisions, records)).toMatchObject({ imported: 0, unchanged: 1 });
  records[0].decision.state = 'affected';
  records[0].decision.recordedAt = '2026-10-10T12:00:00Z';
  const conflict = importDecisionRecords(storage, first.decisions, records);
  expect(conflict.conflicts).toBe(1);
  expect(conflict.decisions.get(records[0].signal).state).toBe('unaffected');
});

test('bad import records are rejected and blocked storage preserves session records', () => {
  const result = importDecisionRecords({ setItem() { throw new Error('disabled'); } }, new Map(), [
    { signal: 'x', decision: { ...saved, state: 'unknown' } },
    { signal: 'y', decision: { ...saved, recordedAt: 'bad-date' } },
    { signal: 'z', decision: saved },
  ]);
  expect(result).toMatchObject({ imported: 1, invalid: 2, persisted: false });
  expect(result.decisions.get('z').evidenceBinding).toEqual(saved.evidenceBinding);
  expect(() => importDecisionRecords(null, new Map(), {})).toThrow('Expected');
});

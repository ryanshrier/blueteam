import { describe, expect, test } from '@jest/globals';
import { correctiveRecoveryDecision } from '../lib/brief-recovery.js';

const text = '## KEY JUDGMENTS\n### Signal 1\nReported gateway change.\n### Signal 2\nReported operational change.\n';
const finding = (code, message, severity = 'trust') => ({ code, message, severity });
const draft = (issues, changes = {}) => ({ text, validation: { issues }, partial: false, ...changes });
const citation = finding('CVE_CITATION_MISMATCH', 'Signal 1 CVE-2026-1234 is absent from its cited evidence');
const version = finding('VERSION_UNSUPPORTED', 'Signal 2 version 14.1-43.56 is not present in its cited evidence');

describe('bounded corrective recovery without sacrificing coverage', () => {
  test('fewer findings cannot outweigh a newly introduced factual contradiction', () => {
    const result = correctiveRecoveryDecision(draft([citation, version]), draft([
      finding('KEV_DEADLINE_MISMATCH', 'CVE-2026-1234 deadline contradicts the captured catalog'),
    ]));
    expect(result).toEqual({ accepted: false, reason: 'new-material-findings' });
  });

  test('clearing all findings by dropping a judgment is not a successful repair', () => {
    expect(correctiveRecoveryDecision(draft([citation]), draft([], {
      text: '## KEY JUDGMENTS\n### Signal 1\nReported gateway change.\n',
    }))).toEqual({ accepted: false, reason: 'judgments-removed' });
  });

  test('an incomplete retry cannot replace a complete draft with a repairable finding', () => {
    expect(correctiveRecoveryDecision(draft([citation]), draft([], { partial: true })))
      .toEqual({ accepted: false, reason: 'incomplete-replacement' });
  });

  test('allows a resolved subset, relocation and judgment reordering without trading claims', () => {
    expect(correctiveRecoveryDecision(draft([citation, version]), draft([
      { ...version, message: version.message.replace('Signal 2', 'Signal 1'), location: { line: 25 } },
    ]))).toEqual({ accepted: true, reason: 'resolved-findings' });
    expect(correctiveRecoveryDecision(draft([version]), draft([
      { ...version, message: version.message.replace('14.1-43.56', '14.1-43.57') },
    ])).accepted).toBe(false);
  });

  test('does not lose repeated findings in a set or count editorial notes as improvement', () => {
    expect(correctiveRecoveryDecision(draft([citation]), draft([citation, citation])).accepted).toBe(false);
    expect(correctiveRecoveryDecision(draft([citation, finding('REVIEW', 'Long BLUF', 'review')]), draft([citation])))
      .toEqual({ accepted: false, reason: 'no-material-improvement' });
  });

  test('keeps output-limit recovery able to produce a shorter complete edition', () => {
    expect(correctiveRecoveryDecision(draft([], { partial: true }), draft([], {
      text: '## KEY JUDGMENTS\n### Signal 1\nReported gateway change.\n',
    }))).toEqual({ accepted: true, reason: 'resolved-findings' });
  });

  test('a repair cannot introduce a security-control approval requirement', () => {
    expect(correctiveRecoveryDecision(draft([citation]), draft([
      finding('SECURITY_CONTROL_CHANGE', 'Disable a named security control', 'review'),
    ]))).toEqual({ accepted: false, reason: 'new-material-findings' });
  });

  test.each([
    'Ungrounded CVE(s) in no source headline',
    'CVE(s) labeled KEV but not in the verified catalog',
    'CVE(s) described as pending/not in KEV but already in the verified catalog',
    'KEV catalog unavailable — cannot verify claim(s)',
  ])('recognizes partial repair of the aggregated finding: %s', prefix => {
    const aggregate = ids => finding('GROUNDING', `${prefix}: ${ids}`);
    const original = draft([aggregate('CVE-2026-1234, CVE-2026-5678')]);
    expect(correctiveRecoveryDecision(original, draft([aggregate('CVE-2026-5678')])).accepted).toBe(true);
    expect(correctiveRecoveryDecision(original, draft([aggregate('CVE-2026-9999')])).accepted).toBe(false);
    expect(correctiveRecoveryDecision(original, draft([aggregate('CVE-2026-5678, CVE-2026-1234')])).accepted).toBe(false);
  });

  test('does not infer resolved identities from a truncated or unknown diagnostic list', () => {
    for (const prefix of ['Ungrounded CVE(s) in no source headline', 'Unknown finding']) {
      expect(correctiveRecoveryDecision(
        draft([finding('GROUNDING', `${prefix}: CVE-2026-1234, CVE-2026-5678…`)]),
        draft([finding('GROUNDING', `${prefix}: CVE-2026-5678`)]),
      ).accepted).toBe(false);
    }
  });
});

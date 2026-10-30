import { describe, expect, test } from '@jest/globals';
import { correctiveRecoveryDecision } from '../lib/brief-recovery.js';

const text = '## KEY JUDGMENTS\n### Signal 1\nReported gateway change.\n### Signal 2\nReported operational change.\n';
const finding = (code, message, severity = 'trust') => ({ code, message, severity });
const draft = (issues, changes = {}) => ({ text, validation: { issues }, partial: false, ...changes });
const citation = finding('CVE_CITATION_MISMATCH', 'Signal 1 CVE-2026-1234 is absent from its cited evidence');
const version = finding('VERSION_UNSUPPORTED', 'Signal 2 version 14.1-43.56 is not present in its cited evidence');

describe('bounded corrective recovery without sacrificing coverage', () => {
  test('can omit one defective judgment and repair another while preserving unaffected coverage', () => {
    const originalText = '## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Bad gateway claim\nCVE-2026-1234 has bad evidence.\n### Signal 2 — [Horizon 1] Bad version claim\nCVE-2026-5678 version 14.1-43.56.\n### Signal 3 — [Horizon 2] Unaffected reporting\nRetain this entire assessment.\n';
    const candidateText = '## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Bad version claim\nCVE-2026-5678 version 14.1-43.55.\n### Signal 2 — [Horizon 2] Unaffected reporting\nRetain this entire assessment.\n';
    const original = draft([citation, version], { text: originalText });
    expect(correctiveRecoveryDecision(original, draft([], { text: candidateText })).accepted).toBe(true);
    expect(correctiveRecoveryDecision(original, draft([], { text: candidateText.replace('entire assessment', 'different assessment') })).accepted).toBe(false);
    expect(correctiveRecoveryDecision(original, draft([], { text: candidateText.replace('Bad version claim', 'Unrelated story').replace('CVE-2026-5678', 'CVE-2026-9999') })).accepted).toBe(false);
    expect(correctiveRecoveryDecision(original, draft([finding('KEV_DEADLINE_MISMATCH', 'New unsupported deadline')], { text: candidateText })).accepted).toBe(false);
  });
  test('fewer findings cannot outweigh a newly introduced factual contradiction', () => {
    const result = correctiveRecoveryDecision(draft([citation, version]), draft([
      finding('KEV_DEADLINE_MISMATCH', 'CVE-2026-1234 deadline contradicts the captured catalog'),
    ]));
    expect(result).toEqual({ accepted: false, reason: 'new-material-findings' });
  });

  test('clearing all findings by dropping an unaffected judgment is not a successful repair', () => {
    expect(correctiveRecoveryDecision(draft([citation]), draft([], {
      text: '## KEY JUDGMENTS\n### Signal 1\nReported gateway change.\n',
    }))).toEqual({ accepted: false, reason: 'judgments-removed' });
  });

  test('can remove defective Signal 1 while retaining and renumbering unaffected Signal 2', () => {
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n' });
    expect(correctiveRecoveryDecision(draft([citation]), candidate))
      .toEqual({ accepted: true, reason: 'resolved-findings' });
  });

  test('a validated paragraph location can identify the defective judgment without an ordinal message', () => {
    const located = { ...finding('FACT_CVE_COUNT_MISMATCH', 'The closed list names the wrong number of identities.'),
      location: { scope: 'paragraph', line: 3, excerpt: 'Reported gateway change.' } };
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n' });
    expect(correctiveRecoveryDecision(draft([located]), candidate).accepted).toBe(true);
  });

  test.each([
    { scope: 'document', line: 3, excerpt: 'Reported gateway change.' },
    { scope: 'paragraph', line: 3 },
    { scope: 'paragraph', line: 3, excerpt: 'Different retained text.' },
    { scope: 'paragraph', line: 99, excerpt: 'Reported gateway change.' },
  ])('an uncertain location cannot authorize deletion: %j', location => {
    const located = { ...finding('FACT_CVE_COUNT_MISMATCH', 'The closed list names the wrong number of identities.'), location };
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n' });
    expect(correctiveRecoveryDecision(draft([located]), candidate))
      .toEqual({ accepted: false, reason: 'judgments-removed' });
  });

  test.each([
    { ...citation, location: { scope: 'paragraph', line: 5, excerpt: 'Reported operational change.' } },
    { ...citation, message: 'Signal 1 and Signal 2 have an unresolved citation relationship.' },
    { ...citation, message: 'Signal 99 has unsupported evidence.' },
    { ...citation, message: 'Unsupported evidence remains somewhere in the document.' },
  ])('conflicting or absent judgment identity cannot authorize deletion', issue => {
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n' });
    expect(correctiveRecoveryDecision(draft([issue]), candidate).accepted).toBe(false);
  });

  test.each([
    finding('CITED_SOURCE_LIMITED', 'Signal 1 also cites a limited extract.', 'review'),
    finding('SECURITY_CONTROL_CHANGE', 'Signal 1 recommends a control exception.', 'review'),
  ])('advisory or human-review findings alone cannot authorize removing a judgment', issue => {
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n' });
    expect(correctiveRecoveryDecision(draft([issue]), candidate).accepted).toBe(false);
  });

  test('a deletion repair cannot rewrite surviving claims or replace them with a new judgment', () => {
    for (const survivor of ['Reported operational change with a new detail.', 'CVE-2099-99999 is exploited.', 'Reported gateway change.']) {
      const candidate = draft([], { text: `## KEY JUDGMENTS\n### Signal 1\n${survivor}\n` });
      expect(correctiveRecoveryDecision(draft([citation]), candidate).accepted).toBe(false);
    }
  });

  test('preserves unaffected coverage through reordering, renumbering and the final section separator', () => {
    const originalText = text + '### Signal 3\nReported policy change.\n\n---\n\n## WATCHLIST\n- Reassess.';
    const candidateText = '## KEY JUDGMENTS\n### Signal 1\nReported policy change.\n'
      + '### Signal 2\nReported operational change.\n\n---\n\n## WATCHLIST\n- Reassess.';
    expect(correctiveRecoveryDecision(draft([citation], { text: originalText.replaceAll('\n', '\r\n') }),
      draft([], { text: candidateText })).accepted).toBe(true);
    expect(correctiveRecoveryDecision(draft([citation], { text: originalText }),
      draft([], { text: candidateText.replace('### Signal 2\nReported operational change.\n', '') })).accepted).toBe(false);
  });

  test('each removed judgment needs its own original blocker', () => {
    const originalText = text + '### Signal 3\nReported policy change.\n';
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported policy change.\n' });
    expect(correctiveRecoveryDecision(draft([citation, version], { text: originalText }), candidate).accepted).toBe(true);
    expect(correctiveRecoveryDecision(draft([citation], { text: originalText }), candidate).accepted).toBe(false);
  });

  test('duplicate identities and hidden entry boundaries cannot authorize a smaller repair', () => {
    const candidate = draft([], { text: '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n' });
    for (const originalText of [
      text.replace('Signal 2', 'Signal 1'),
      text + '\n## KEY JUDGMENTS\n### Signal 3\nOther content.',
      text.replace('### Signal 1', '```markdown\n### Signal 1') + '\n```',
      text.replace('### Signal 1', '<!--\n### Signal 1') + '\n-->',
      `<!--\n${text}\n## WATCHLIST\n- Reassess.\n-->`,
      `\u0060\u0060\u0060markdown\n${text}\n## WATCHLIST\n- Reassess.\n\u0060\u0060\u0060`,
      `~~~~markdown\n${text}\n## WATCHLIST\n- Reassess.\n~~~~`,
      text.replace('Reported gateway change.', 'Reported operational change.'),
    ]) expect(correctiveRecoveryDecision(draft([citation], { text: originalText }), candidate).accepted).toBe(false);
  });

  test('closed commentary before the report and auxiliary metadata after it do not hide real judgments', () => {
    const prefix = '<!-- Draft source note -->\n\u0060\u0060\u0060text\nPrior example.\n\u0060\u0060\u0060\n';
    const suffix = '\n## WATCHLIST\n- Reassess.\n<!-- BRIEF_METADATA {} -->';
    const candidate = draft([], { text: `${prefix}## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n${suffix}` });
    expect(correctiveRecoveryDecision(draft([citation], { text: prefix + text + suffix }), candidate).accepted).toBe(true);
  });

  test('a permitted omission still cannot introduce another material finding or incomplete response', () => {
    const survivor = '## KEY JUDGMENTS\n### Signal 1\nReported operational change.\n';
    expect(correctiveRecoveryDecision(draft([citation]), draft([
      finding('KEV_DEADLINE_MISMATCH', 'CVE-2026-5678 contradicts the captured deadline'),
    ], { text: survivor }))).toEqual({ accepted: false, reason: 'new-material-findings' });
    expect(correctiveRecoveryDecision(draft([citation]), draft([], { text: survivor, partial: true })))
      .toEqual({ accepted: false, reason: 'incomplete-replacement' });
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

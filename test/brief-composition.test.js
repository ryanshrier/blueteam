import { describe, expect, test } from '@jest/globals';
import { composeBriefActions } from '../lib/brief-composition.js';
import { canonicalActions, editorialIssues } from '../lib/brief-editorial.js';
import { parseJudgments, section, SECTIONS } from '../lib/brief-schema.js';

const action = (task = 'verify Gateway deployment', owner = 'Infrastructure', target = 'October 10, 2026') => `${owner} — ${task} — recommended target ${target}.`;
const judgment = (number, actions) => `### Signal ${number} — [Horizon 1] Gateway ${number} response
**Assessment:** Local exposure requires verification.
**Recommended actions:**
${actions.map(value => `- ${value}`).join('\n')}

**Decision window:** Current shift
**The line:** Verify deployment before changing systems.
`;
const draft = (actions, { summary = 'Someone else — do unrelated work — recommended target October 20, 2026.', others = '' } = {}) => `## EXECUTIVE SUMMARY — SHIFT DECISIONS
- **Threat:** A captured advisory describes the issue.
- **Exposure:** Local deployment is unconfirmed.
- **Required decisions:** ${summary}

---

## KEY JUDGMENTS
${judgment(1, actions)}${others}
## WATCHLIST
- Updated vendor guidance.
`;
const summaryIssues = (text, options = {}) => editorialIssues(text, [], options).filter(issue => issue.code.startsWith('ACTION_SUMMARY'));

describe('app-owned decisions from shared visible action facts', () => {
  test('replaces an independently authored summary with every complete leading action', () => {
    const text = draft([
      action('verify Gateway inventory; **Condition:** restrict access only if deployed; **Completion criterion:** record verified absence or tested restrictions'),
      action('investigate exposed Gateway hosts; **Recovery:** if compromise is confirmed, restore from a verified safe backup; **Dependencies:** retain isolation until validated', 'Incident response', 'October 12, 2026'),
    ]);
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    const executive = section(result.text, SECTIONS.execSummary);
    expect(executive).not.toContain('unrelated work');
    expect(executive).toContain('restrict access only if deployed');
    expect(executive).toContain('if compromise is confirmed, restore from a verified safe backup');
    expect(executive).toContain('retain isolation until validated');
    expect(result.actions.map(value => [value.owner, value.target])).toEqual([
      ['Infrastructure', 'October 10, 2026'], ['Incident response', 'October 12, 2026'],
    ]);
    expect(result.executiveActions).toEqual([{ decision: 1, actionIds: ['S1.A1'] }, { decision: 2, actionIds: ['S1.A2'] }]);
    expect(composeBriefActions(result.text).text).toBe(result.text);
    expect(composeBriefActions(result.text).summaryMatches).toBe(true);
  });

  test.each([
    'Infrastructure - verify Gateway deployment - Target: October 10, 2026.',
    'Infrastructure–verify Gateway deployment–recommended target October 10, 2026.',
    '**Infrastructure** — verify Gateway deployment; **Target:** October 10, 2026.',
    'Infrastructure — verify Gateway deployment — due October 10, 2026.',
  ])('tolerates an unambiguous owner/task/target spelling: %s', value => {
    const result = composeBriefActions(draft([value]));
    expect(result.composed).toBe(true);
    expect(result.actions[0]).toMatchObject({ owner: 'Infrastructure', imperative: 'verify Gateway deployment', target: 'October 10, 2026' });
    expect(canonicalActions(result.text)).toHaveLength(1);
    expect(summaryIssues(result.text, { compositionVersion: 1 })).toEqual([]);
  });

  test('keeps multiline conditions, recovery, links, and standalone qualifications', () => {
    const text = draft([`**Act now:** Infrastructure — verify Gateway deployment — recommended target October 10, 2026.
  **Condition:** change only affected appliances.
  **Evidence/artifact:** [Vendor guidance](https://example.com/gateway) must be verified before use.
  **Recovery:** if compromised, restore from a validated backup.
  Keep the system isolated until the owner confirms recovery.`]);
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    const records = parseJudgments(result.text)[0].actions;
    expect(records).toHaveLength(1);
    expect(records[0].condition).toBe('change only affected appliances.');
    expect(records[0].recoverySteps).toContain('Keep the system isolated until the owner confirms recovery.');
    expect(records[0].citations).toContainEqual({ label: 'Vendor guidance', url: 'https://example.com/gateway' });
    expect(result.text.match(/Keep the system isolated until the owner confirms recovery\./g)).toHaveLength(2);
    expect(result.text).toContain('- **Act now:** Infrastructure');
    expect(composeBriefActions(result.text).text).toBe(result.text);
  });

  test('accepts ordered action bullets and a standalone target line without losing their continuation', () => {
    const text = draft([action()]).replace(`- ${action()}`, `1. Infrastructure - verify Gateway deployment
   **Condition:** if the product is deployed, inventory affected builds
   **Target:** October 10, 2026.`);
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    expect(result.actions[0]).toMatchObject({ condition: 'if the product is deployed, inventory affected builds', target: 'October 10, 2026' });
  });

  test('does not absorb an indented judgment field into an action or its summary', () => {
    const text = draft([action()]).replace('**Decision window:**', '  **Decision window:**');
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    expect(result.text).toContain('  **Decision window:** Current shift');
    expect(section(result.text, SECTIONS.execSummary)).not.toContain('Decision window:');
  });

  test('derives a missing decisions row without changing the other executive facts', () => {
    const text = draft([action()]).replace(/^- \*\*Required decisions:\*\*[^\n]*\n/m, '');
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    expect(section(result.text, SECTIONS.execSummary)).toContain('- **Required decisions:** Infrastructure');
    expect(result.text).toContain('- **Exposure:** Local deployment is unconfirmed.');
    expect(result.text).toContain('## WATCHLIST\n- Updated vendor guidance.');
  });

  test('canonicalizes a Decisions required alias and a wrapped duplicate row', () => {
    const text = draft([action()]).replace('- **Required decisions:** Someone', '- **Decisions required:** Someone')
      .replace('\n\n---', '\n  with an old qualification.\n- **Required decisions:** Another stale decision.\n\n---');
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    expect(result.text.match(/\*\*Required decisions:/g)).toHaveLength(1);
    expect(result.text).not.toContain('old qualification');
    expect(result.text).not.toContain('stale decision');
  });

  test('summarizes every action in the first three judgments while retaining later actions', () => {
    const others = [2, 3, 4].map(number => judgment(number, [action(`verify Gateway ${number} deployment`), action(`review Gateway ${number} logs`, 'Incident response')])).join('');
    const result = composeBriefActions(draft([action()], { others }));
    const executive = section(result.text, SECTIONS.execSummary);
    expect(result.actions).toHaveLength(7);
    expect(result.executiveActions).toHaveLength(5);
    expect(executive).toContain('review Gateway 3 logs');
    expect(executive).not.toContain('Gateway 4');
    expect(section(result.text, SECTIONS.keyJudgments)).toContain('review Gateway 4 logs');
  });

  test('same-owner actions and semicolons do not need hidden mapping guesses', () => {
    const text = draft([action('verify deployment; retain inventory; document exceptions')], {
      others: judgment(2, [action('verify deployment; retain inventory; document exceptions', 'Infrastructure', 'October 12, 2026')]),
    });
    const result = composeBriefActions(text);
    expect(summaryIssues(result.text, { compositionVersion: 1, executiveActions: [{ decision: 1, actionIds: ['S99.A1'] }] })).toEqual([]);
    // The opt-in does not excuse a later edit that borrows a different target.
    const changed = result.text.replace('— recommended target October 10, 2026;', '— recommended target October 20, 2026;');
    expect(composeBriefActions(changed).summaryMatches).toBe(false);
    expect(summaryIssues(changed, { compositionVersion: 1 }).map(issue => issue.code)).toContain('ACTION_SUMMARY_CONFLICT');
    // Archived editions do not change their old checker interpretation.
    expect(summaryIssues(result.text).map(issue => issue.code)).toContain('ACTION_SUMMARY_ASSOCIATION_REVIEW');
  });

  test('composed summaries do not disable checks on the canonical action itself', () => {
    const result = composeBriefActions(draft([action('restrict management access and review access logs')]));
    expect(editorialIssues(result.text, [], { compositionVersion: 1 }).map(issue => issue.code)).toContain('ACTION_PHASE_BUNDLE_REVIEW');
  });

  test.each([
    'Infrastructure — verify deployment.',
    'Verify deployment — recommended target October 10, 2026.',
    'Infrastructure — verify deployment — recommended target October 10, 2026; due October 11, 2026.',
    'Infrastructure — verify deployment — recommended target October 10, 2026.\n  **Target:** October 11, 2026.',
    'FCEB agencies — meet the CISA requirement — due October 10, 2026.',
    'Infrastructure — meet the federal remediation deadline — target October 10, 2026.',
  ])('preserves incomplete or ambiguous authored actions for existing checks: %s', value => {
    const text = draft([action(), value]);
    expect(composeBriefActions(text)).toMatchObject({ text, composed: false, reason: 'actions-ambiguous' });
  });

  test.each(['```\n', '<!--\n'])('does not compose fake actions hidden in a protected document: %s', opener => {
    const closer = opener.startsWith('`') ? '```' : '-->';
    const text = opener + draft([action()]) + closer;
    expect(composeBriefActions(text)).toMatchObject({ text, composed: false });
  });

  test('does not take fields from a fence or comment inside a visible judgment', () => {
    const text = draft([action()]).replace('**Recommended actions:**', '```markdown\n**Recommended actions:**')
      .replace('**Decision window:**', '```\n**Decision window:**');
    expect(composeBriefActions(text)).toMatchObject({ text, composed: false });
  });

  test.each([
    `<div style="display:none">\n**Recommended actions:**\n- ${action()}\n</div>\n`,
    `    **Recommended actions:**\n    - ${action()}\n`,
    `**Recommended actions:**\n- Infrastructure — verify <span style="display:none">hidden</span> deployment — recommended target October 10, 2026.\n`,
  ])('does not promote HTML or indented code into visible action instructions', replacement => {
    const text = draft([action()]).replace(`**Recommended actions:**\n- ${action()}\n`, `\n${replacement}`);
    expect(composeBriefActions(text)).toMatchObject({ text, composed: false });
  });

  test('does not partially rewrite duplicate action fields or uncertain nested bullets', () => {
    for (const text of [
      draft([action()]).replace('**Decision window:**', `**Recommended actions:**\n- ${action()}\n**Decision window:**`),
      draft([`${action()}\n  - restore only when validated`]),
    ]) expect(composeBriefActions(text)).toMatchObject({ text, composed: false });
  });

  test('preserves CRLF and unrelated trailing metadata without needing it', () => {
    const text = `${draft([action()])}\n<!-- unrelated retained note -->\n`.replaceAll('\n', '\r\n');
    const result = composeBriefActions(text);
    expect(result.composed).toBe(true);
    expect(result.text).toContain('\r\n');
    expect(result.text.replaceAll('\r\n', '')).not.toContain('\n');
    expect(result.text).toContain('<!-- unrelated retained note -->');
    expect(composeBriefActions(result.text).text).toBe(result.text);
  });
});

import { describe, expect, test } from '@jest/globals';
import { canonicalActions, canonicalizeExecutiveActions, editorialIssues } from '../lib/brief-editorial.js';

const draft = (summary, secondTarget = 'October 9, 2026') => `## EXECUTIVE SUMMARY
- **Required decisions:** ${summary}
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] NetScaler response
**Recommended actions:**
- **Act now:** Infrastructure — verify NetScaler deployment; **Initiation:** begin inventory this shift; **Condition:** patch only affected appliances; **Completion criterion:** verify the installed fixed build — recommended target October 10, 2026.
- Incident response — investigate exposed NetScaler appliances; **Recovery:** if compromised, rebuild from trusted software — recommended target October 10, 2026.
**Decision window:** Current shift
### Signal 2 — [Horizon 1] AhsayCBS containment
**Recommended actions:**
- **Act now:** Infrastructure — verify AhsayCBS deployment; **Initiation:** begin inventory this shift; **Condition:** if deployed, restrict management access while fix status is unresolved; **Completion criterion:** record verified absence or restrictions — recommended target ${secondTarget}.
- Incident response — investigate AhsayCBS hosts; **Recovery:** if compromised, restore from a verified safe backup — recommended target October 10, 2026.
**Decision window:** Current shift
## WATCHLIST
- Vendor changes its advice.
`;
const issues = (text, executiveActions) => editorialIssues(text, [], { executiveActions }).filter(issue => issue.code.startsWith('ACTION_SUMMARY'));
const mapping = (...actionIds) => [{ decision: 1, actionIds }];

describe('action-specific executive decisions', () => {
  test('exposes stable IDs and complete canonical action metadata without changing prose', () => {
    const text = draft('Infrastructure — verify AhsayCBS deployment and restrict access if deployed — recommended target October 9, 2026.');
    const actions = canonicalActions(text);
    expect(actions.map(action => action.id)).toEqual(['S1.A1', 'S1.A2', 'S2.A1', 'S2.A2']);
    expect(actions[2]).toMatchObject({ signal: 2, signalId: 'S2', actionIndex: 1, owner: 'Infrastructure', target: 'October 9, 2026' });
    expect(actions[2].response).toContain('Initiation: begin inventory this shift');
    expect(actions[2].response).toContain('Condition: if deployed');
    expect(actions[2].response).toContain('Completion criterion: record verified absence or restrictions');
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(issues(text, mapping('S2.A1'))).toEqual([]);
  });

  test('the same owner cannot borrow another signal\'s otherwise valid target', () => {
    const text = draft('Infrastructure — verify AhsayCBS deployment and restrict access if deployed — recommended target October 10, 2026.');
    expect(issues(text)).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT', message: expect.stringContaining('Signal 2') })]);
    expect(issues(text, mapping('S2.A1'))).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT' })]);
    expect(issues(text, mapping('S1.A1'))).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_MAPPING_INVALID' })]);
  });

  test.each(['Infrastructure / Incident response', 'Infrastructure and Incident response', 'Infrastructure & Incident response'])('allows a concise paired decision with one shared target: %s', owners => {
    const text = draft(`${owners} — verify NetScaler applicability and pair remediation with investigation — recommended target October 10, 2026.`);
    expect(issues(text, mapping('S1.A1', 'S1.A2'))).toEqual([]);
    expect(canonicalizeExecutiveActions(text)).toBe(text);
  });

  test('an explicitly paired owner in the response preserves its own target', () => {
    const valid = draft('Infrastructure — verify NetScaler applicability, paired with Incident response investigation if deployed — recommended target October 10, 2026.');
    expect(issues(valid, mapping('S1.A1', 'S1.A2'))).toEqual([]);
    const invalid = draft('Infrastructure — verify AhsayCBS deployment and restrict access, paired with Incident response recovery if compromised — recommended target October 10, 2026.');
    expect(issues(invalid, mapping('S2.A1', 'S2.A2')).map(issue => issue.code)).toContain('ACTION_SUMMARY_CONFLICT');
    expect(issues(invalid, mapping('S2.A2')).map(issue => issue.code)).toContain('ACTION_SUMMARY_MAPPING_INVALID');
  });

  test('different containment and recovery targets remain separate with their conditions intact', () => {
    const text = draft('Infrastructure — verify AhsayCBS deployment and restrict access if deployed — recommended target October 9, 2026; Incident response — investigate AhsayCBS hosts and restore from a verified safe backup if compromised — recommended target October 10, 2026.');
    expect(issues(text, [{ decision: 1, actionIds: ['S2.A1'] }, { decision: 2, actionIds: ['S2.A2'] }])).toEqual([]);
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(canonicalActions(text)[3].response).toContain('if compromised, restore from a verified safe backup');
  });

  test('target remains the completion target rather than the initiation date mentioned inside an action', () => {
    const text = draft('Infrastructure — verify AhsayCBS deployment and restrict access if deployed — recommended target October 9, 2026.', 'October 10, 2026')
      .replaceAll('begin inventory this shift', 'begin inventory October 9, 2026');
    expect(issues(text, mapping('S2.A1'))).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT' })]);
    expect(issues(text.replace('access if deployed — recommended target October 9, 2026', 'access if deployed — recommended target October 10, 2026'), mapping('S2.A1'))).toEqual([]);
  });

  test('equivalent calendar date formatting does not create a false contradiction', () => {
    const text = draft('Infrastructure — verify AhsayCBS deployment and restrict access if deployed — recommended target 2026-10-09.');
    expect(issues(text, mapping('S2.A1'))).toEqual([]);
  });

  test('preserves a full function name containing and', () => {
    const text = draft('Identity and access management — verify AhsayCBS deployment — recommended target October 9, 2026.').replaceAll('Infrastructure', 'Identity and access management');
    expect(issues(text, mapping('S2.A1'))).toEqual([]);
  });

  test('does not silently drop one owner of a grouped canonical action', () => {
    const text = draft('Infrastructure — verify AhsayCBS deployment — recommended target October 9, 2026.')
      .replace('Infrastructure — verify AhsayCBS deployment; Initiation:', 'Infrastructure / Incident response — verify AhsayCBS deployment; Initiation:')
      .replace('Infrastructure — verify AhsayCBS deployment; **Initiation:**', 'Infrastructure / Incident response — verify AhsayCBS deployment; **Initiation:**');
    expect(issues(text, mapping('S2.A1')).map(issue => issue.code)).toContain('ACTION_SUMMARY_MAPPING_INVALID');
  });

  test.each([
    null,
    {},
    [],
    [{ decision: 0, actionIds: ['S2.A1'] }],
    [{ decision: 2, actionIds: ['S2.A1'] }],
    [{ decision: 1, actionIds: [] }],
    [{ decision: 1, actionIds: ['S99.A1'] }],
    [{ decision: 1, actionIds: ['S2.A1', 'S2.A1'] }],
    [{ decision: 1, actionIds: ['S2.A1'] }, { decision: 1, actionIds: ['S2.A1'] }],
  ])('rejects malformed, missing or ambiguous supplied mappings: %j', executiveActions => {
    const text = draft('Infrastructure — verify AhsayCBS deployment — recommended target October 9, 2026.');
    expect(issues(text, executiveActions).map(issue => issue.code)).toContain('ACTION_SUMMARY_MAPPING_INVALID');
  });

  test('an unparseable decision cannot use an empty mapping to bypass checks', () => {
    expect(issues(draft('Do everything by Friday.'), []).map(issue => issue.code)).toContain('ACTION_SUMMARY_MAPPING_INVALID');
  });

  test('reports ambiguous legacy association as review rather than proving semantic equivalence', () => {
    const text = draft('Infrastructure — verify applicability and restrict affected access — recommended target October 10, 2026.');
    expect(issues(text)).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_ASSOCIATION_REVIEW' })]);
    expect(issues(text, mapping('S1.A1'))).toEqual([]);
  });

  test('an asserted ID cannot borrow another task\'s date within the same signal and owner', () => {
    const text = `## EXECUTIVE SUMMARY
- **Required decisions:** Infrastructure — restrict Acme Gateway management access — recommended target October 10, 2026.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Acme Gateway response
**Recommended actions:**
- Infrastructure — restrict Acme Gateway management access — recommended target October 9, 2026.
- Infrastructure — investigate Acme Gateway deployment records — recommended target October 10, 2026.
**Decision window:** Current shift
## WATCHLIST`;
    expect(issues(text, mapping('S1.A2')).map(issue => issue.code)).toContain('ACTION_SUMMARY_CONFLICT');
    const corrected = text.replace('access — recommended target October 10, 2026.', 'access — recommended target October 9, 2026.');
    expect(issues(corrected, mapping('S1.A1'))).toEqual([]);
    const ambiguous = text.replace('**Required decisions:** Infrastructure — restrict Acme Gateway management access', '**Required decisions:** Infrastructure — establish the necessary access safeguards');
    expect(issues(ambiguous, mapping('S1.A2'))).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_ASSOCIATION_REVIEW' })]);
    const sharedObject = text.replace('**Required decisions:** Infrastructure — restrict Acme Gateway management access', '**Required decisions:** Infrastructure — review Acme Gateway management reachability');
    expect(issues(sharedObject, mapping('S1.A2'))).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_ASSOCIATION_REVIEW' })]);
  });
});

test('retained October 9 Ahsay decision cannot inherit the NetScaler owner\'s October 10 target', () => {
  // Exact retained summary clauses and relevant canonical action paragraphs.
  // Unrelated briefing content and private watch-profile data are excluded.
  const text = `## EXECUTIVE SUMMARY — SHIFT DECISIONS
- **Required decisions:** Infrastructure — verify NetScaler applicability and update affected appliances, paired with Incident response compromise review — recommended target October 10, 2026; Infrastructure — verify AhsayCBS deployment and restrict affected management access, paired with Incident response investigation and safe-backup restoration if compromised — recommended target October 10, 2026.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] NetScaler needs fresh patching and compromise review
**Recommended actions:**
- **Act now:** Infrastructure — verify every NetScaler deployment against CVE-2026-88771, CVE-2026-88772, CVE-2026-88779 and CVE-2026-107406; **Initiation:** start build, SAML-role and external-reachability checks this shift and retrieve the Citrix bulletins linked by CCCS; **Condition:** prioritize affected internet-facing appliances, coordinate feasible evidence preservation before changes, and update to the vendor-specified build; restrict exposure immediately if completion is deferred; **Completion criterion:** record absent, affected or unresolved status per appliance, verified installed build and any containment exception — recommended target October 10, 2026.
- Incident response — investigate previously exposed appliances alongside remediation; **Initiation:** preserve available appliance, syslog and Console records this shift and retrieve and verify the NetScaler Console IOC tool and attached indicators from the CCCS alert; **Dependencies:** base the proposed lookback on exposure history and retained telemetry, not advisory publication as the earliest compromise date; **Recovery:** if compromise is suspected, isolate, contact Citrix, assess credential exposure, prepare credential resets, session invalidation and certificate replacement, and rebuild or replace compromised appliances from trusted software and known-good configurations; **Completion criterion:** document findings, retention limits and support-directed recovery or remaining exceptions — recommended target October 10, 2026.
**Decision window:** Current shift
### Signal 2 — [Horizon 1] AhsayCBS latest-build reporting changes the containment decision
**Recommended actions:**
- **Act now:** Infrastructure — verify AhsayCBS deployment, installed build and management-interface reachability; **Initiation:** start inventory checks this shift and retrieve the updated Huntress analysis and vendor guidance; **Condition:** if deployed, restrict management access to trusted IP addresses while fix status is resolved; **Completion criterion:** record verified absence or interface restrictions, affected-build assessment and current vendor response — recommended target October 9, 2026.
- Incident response — investigate deployed hosts and complete conditional recovery; **Initiation:** begin evidence preservation and review this shift; **Evidence/artifact:** retrieve and verify Huntress’s published IOCs and Sigma rules before use, then review webshells, service creation and associated process activity; **Dependencies:** set the lookback from exposure history and retention, with October 7 an observed activity date rather than the earliest possible compromise; **Recovery:** restore confirmed-compromised hosts fully from a verified safe backup; **Completion criterion:** document compromise findings, backup validation and restoration outcome or isolated recovery exceptions — recommended target October 10, 2026.
**Decision window:** Current shift
## WATCHLIST
`;
  expect(issues(text)).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT', message: expect.stringContaining('Signal 2') })]);
  expect(issues(text, [{ decision: 1, actionIds: ['S1.A1', 'S1.A2'] }, { decision: 2, actionIds: ['S2.A1', 'S2.A2'] }]))
    .toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT' })]);
  expect(canonicalizeExecutiveActions(text)).toBe(text);
});

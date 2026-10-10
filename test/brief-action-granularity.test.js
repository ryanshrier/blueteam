import { describe, expect, test } from '@jest/globals';
import { canonicalActions, canonicalizeExecutiveActions, editorialIssues } from '../lib/brief-editorial.js';
import { parseRecommendedActions, section, SECTIONS } from '../lib/brief-schema.js';
import { publicationDecision } from '../lib/validation.js';

const draft = (actions, summary = '', title = 'AhsayCBS response') => `## EXECUTIVE SUMMARY
- **Required decisions:** ${summary}
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] ${title}
**Recommended actions:**

${actions.map(action => `- ${action}`).join('\n')}

**Decision window:** Current shift
## WATCHLIST
- Updated vendor guidance.
`;
const action = (response, owner = 'Infrastructure', target = 'October 9, 2026') => `${owner} — ${response} — recommended target ${target}.`;
const phaseIssues = text => editorialIssues(text, []).filter(issue => issue.code === 'ACTION_PHASE_BUNDLE_REVIEW');

describe('separately assignable response phases', () => {
  test.each([
    ['containment and investigation', 'restrict management access and review access logs'],
    ['investigation and recovery', 'investigate affected hosts; **Recovery:** if compromised, restore hosts from a verified safe backup'],
    ['containment and recovery', 'restrict management access; **Recovery:** restore confirmed compromised hosts from a safe backup'],
  ])('retains %s bundled under one target for operator review', (_, response) => {
    const text = draft([action(response)]);
    const issues = phaseIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'review', message: expect.stringContaining('Signal 1 action 1') });
    expect(publicationDecision({ issues })).toMatchObject({ blockers: [], canPublish: false, requiresReview: true });
    expect(canonicalActions(text)[0].response).toBe(response.replaceAll('**', ''));
  });

  test('detects the actual new-brief NetScaler, Ahsay and Atlassian bundles', () => {
    // Retained action paragraphs only, without source/private profile material.
    const retained = [
      'verify NetScaler inventory, builds, SAML roles and exposure; **Condition:** if affected, preserve logs and support bundles where feasible, prioritize internet-facing updates and begin Citrix-assisted compromise review in parallel; restrict exposure if remediation is deferred; **Recovery:** for suspected compromise, isolate, assess credential exposure, prepare credential resets, session invalidation and certificate replacement, and rebuild or replace compromised appliances from trusted software and known-good configurations; **Completion criterion:** record applicability, vendor-validated fixed build, investigation findings and recovery or contained exceptions',
      'verify AhsayCBS deployment and management-interface reachability this shift; **Condition:** if deployed, restrict management access to trusted IP addresses or required VPN access, preserve host and application evidence, and retrieve current vendor guidance plus Huntress’s IOC and Sigma artifacts before using them; **Recovery:** restore confirmed compromised hosts from a safe backup and validate restored configuration and access restrictions; **Completion criterion:** record absent, affected or unresolved status, tested restrictions, artifact-based investigation results and verified recovery',
      'verify deployment model, installed branches and external reachability this shift; **Condition:** if affected, retrieve Atlassian’s bulletin through the Rapid7 advisory, validate the exact fixed release, and patch; restrict external network access immediately where patching is deferred; review access logs using verified technical request patterns and identify sensitive files within the web root; **Recovery:** if credential disclosure is supported, rotate affected secrets and investigate their downstream use; **Completion criterion:** attach vendor-supported version evidence, reachability tests and exposure findings',
    ];
    for (const response of retained) {
      const issues = phaseIssues(draft([action(response, 'Infrastructure and Incident response')]));
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('completion evidence');
    }
  });

  test.each([
    'verify inventory and restrict management access; **Initiation:** preserve available logs this shift; **Completion criterion:** record tested restrictions',
    'review access logs and preserve host evidence; **Completion criterion:** record investigation findings and recovery dependencies',
    'restrict management access; **Dependencies:** Incident response will investigate affected hosts, then Operations will restore hosts from a safe backup',
    'verify recovery-plan readiness with Incident response; **Completion criterion:** record the accountable owner and unresolved restoration target',
    'restrict management access and prepare a recovery plan to restore hosts from a safe backup',
    'review access logs for attempts to restore hosts from a backup',
    'review access logs to determine whether attackers can restore hosts from a backup',
    'restrict management access; **Condition:** do not restore hosts from a backup until it has been verified safe',
    'restrict management access; **Condition:** do not restore hosts or rebuild hosts until recovery dependencies are verified',
    'review access logs; **Condition:** never patch affected systems during this evidence-preservation step',
  ])('does not mistake one deliverable or a dependency for a bundle: %s', response => {
    expect(phaseIssues(draft([action(response)]))).toEqual([]);
  });

  test('keeps a scoped cross-functional task valid without interpreting and in a function name', () => {
    expect(phaseIssues(draft([action('review access logs together; **Completion criterion:** produce one compromise assessment', 'Infrastructure and Incident response')]))).toEqual([]);
    expect(phaseIssues(draft([action('rotate affected secrets; **Completion criterion:** verify invalidation', 'Identity and access management')]))).toEqual([]);
  });

  test('a denial of one step cannot hide a separately assigned second phase', () => {
    expect(phaseIssues(draft([action('restrict management access; do not restore hosts prematurely; if safe backup is verified, restore hosts from that backup')]))).toHaveLength(1);
  });

  test('a three-action response preserves distinct targets, dependencies, deliverables and summary references', () => {
    const actions = [
      action('verify AhsayCBS deployment and restrict management access if deployed; **Initiation:** start this shift; **Completion criterion:** record applicability and tested restrictions'),
      action('investigate affected AhsayCBS hosts; **Initiation:** preserve available evidence this shift; **Dependencies:** verified guidance and exposure history; **Completion criterion:** record initial findings and remaining investigation scope', 'Incident response', 'October 10, 2026'),
      action('prepare conditional recovery for AhsayCBS compromise; **Dependencies:** Incident response findings and a validated safe backup; **Completion criterion:** record a feasible restoration target and recovery owner, retaining isolation until recovery is verified', 'Infrastructure', 'October 10, 2026'),
    ];
    const summary = 'Infrastructure — verify AhsayCBS deployment and restrict management access if deployed — recommended target October 9, 2026; Incident response / Infrastructure — investigate affected AhsayCBS hosts and prepare conditional recovery if compromised — recommended target October 10, 2026.';
    const text = draft(actions, summary);
    const mapping = [{ decision: 1, actionIds: ['S1.A1'] }, { decision: 2, actionIds: ['S1.A2', 'S1.A3'] }];
    expect(editorialIssues(text, [], { executiveActions: mapping })).toEqual([]);
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(canonicalActions(text).map(record => record.id)).toEqual(['S1.A1', 'S1.A2', 'S1.A3']);
    const records = parseRecommendedActions(section(text, SECTIONS.keyJudgments));
    expect(records).toHaveLength(3);
    expect(records.every(record => record.owner && record.target && record.completionCriterion)).toBe(true);
    expect(records[2]).toMatchObject({ owner: 'Infrastructure', target: 'October 10, 2026', dependencies: 'Incident response findings and a validated safe backup' });
    expect(records[2].completionCriterion).toContain('feasible restoration target');
  });
});

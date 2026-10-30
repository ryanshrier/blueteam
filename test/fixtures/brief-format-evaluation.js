// Synthetic editorial stress set, frozen before any model outputs are read.
// Expectations are case-specific review aids, not a semantic accuracy score.
export const FORMAT_EVAL_DATE = '2026-10-30';
export const FORMAT_EVAL_CASES = [
  {
    id: 'gateway', horizon: 1, title: 'Gateway exploitation reaches virtualization',
    evidence: 'Vendor incident responders report exploitation of CVE-2026-12345 in internet-exposed Gateway versions 1.0 through 1.2. Gateway version 1.3 fixes the authentication bypass. One investigated intrusion reached a virtualization management server. The vendor recommends upgrading affected installations, reviewing historical gateway sessions, and investigating successful sessions linked to its published indicators. Patching does not establish whether earlier access occurred. Local deployment, exposure, compromise and departmental ownership are unknown.',
    anchors: [['CVE-2026-12345'], ['1.3'], ['virtualization'], ['sessions', 'session'], ['earlier', 'historical', 'prior', 'past']],
    forbidden: ['our gateways are compromised', 'all gateway intrusions reach virtualization'],
    candidate: 'Vendor responders report exploitation of CVE-2026-12345 in exposed Gateway versions 1.0 through 1.2; version 1.3 fixes the bypass. One investigated intrusion reached virtualization management. [S1.1]\n\nThat observed pivot broadens the possible investigation scope without establishing that it occurs in every intrusion. For affected deployments, remediation and earlier access remain separate questions. The vendor recommends reviewing historical gateway sessions and investigating successful indicator-linked sessions. Local exposure is unconfirmed.',
    mutations: [
      { id: 'invented-cve', from: 'CVE-2026-12345', to: 'CVE-2026-99999', detection: 'factual' },
      { id: 'invented-local-compromise', from: 'Local exposure is unconfirmed.', to: 'Our gateways are compromised.', detection: 'authored' },
      { id: 'lost-virtualization-implication', from: 'virtualization', to: 'network', detection: 'authored' },
    ],
  },
  {
    id: 'scores', horizon: 1, title: 'Two scoring assessments describe the same flaw',
    evidence: 'CVE-2026-23456 affects FileRelay version 2.0. FileRelay version 2.1 fixes the issue. The vulnerability requires an authenticated account. The vendor has not confirmed exploitation. NVD supplies CVSS v4.0 9.5 as a Secondary assessment marked provisional, and CVSS v3.1 8.1 as a Primary assessment without a provisional label. These are different assessments of the same vulnerability. Local deployment and account exposure are unknown.',
    cvssMetrics: [
      { cve: 'CVE-2026-23456', version: '4.0', score: 9.5, type: 'Secondary', provisional: true, selected: true },
      { cve: 'CVE-2026-23456', version: '3.1', score: 8.1, type: 'Primary', provisional: false },
    ],
    anchors: [['authenticated'], ['2.1'], ['confirmed exploitation', 'exploitation remains unconfirmed', 'exploitation is unconfirmed']],
    forbidden: ['unauthenticated access', 'confirmed exploitation in our environment'],
    candidate: 'FileRelay version 2.1 fixes CVE-2026-23456, which requires an authenticated account; exploitation remains unconfirmed. That access condition matters to applicability alongside version and exposure. [S2.1]\n\nNVD lists CVE-2026-23456: CVSS v4.0 9.5 (Secondary assessment) (provisional), and CVE-2026-23456: CVSS v3.1 8.1 (Primary assessment). Different scoring versions do not by themselves establish a disagreement about exploitation. [NVD-CVE-2026-23456]',
    mutations: [
      { id: 'wrong-score', from: '9.5', to: '9.9', detection: 'factual' },
      { id: 'provisional-presented-final', from: '(provisional)', to: '(final)', detection: 'factual' },
      { id: 'wrong-assessment-type', from: '(Secondary assessment)', to: '(Primary assessment)', detection: 'factual' },
      { id: 'lost-access-condition', from: 'requires an authenticated account', to: 'allows unauthenticated access', detection: 'authored' },
    ],
  },
  {
    id: 'conflicting-scope', horizon: 1, title: 'A claimed fix remains disputed',
    evidence: 'The Gateway vendor says version 3.2 fixes CVE-2026-34567. An independent researcher reports that version 3.2 remains affected in one configuration. The supplied evidence does not resolve this disagreement or establish exploitation. Local deployment and configuration are unknown.',
    anchors: [['3.2'], ['disagree', 'disputed', 'disagreement', 'conflict', 'contradict'], ['configuration']],
    forbidden: ['version 3.2 is verified safe', 'the researcher confirmed all configurations are affected'],
    candidate: 'The vendor says Gateway version 3.2 fixes CVE-2026-34567; an independent researcher reports continued exposure in one configuration. The supplied evidence leaves that disagreement unresolved. [S3.1]\n\nA version-only status check could therefore conceal a configuration-dependent question. The reporting supports checking the disputed configuration against updated guidance; it does not establish exploitation or justify treating every installation as affected.',
    mutations: [{ id: 'dispute-erased', from: 'The supplied evidence leaves that disagreement unresolved.', to: 'Version 3.2 is verified safe.', detection: 'authored' }],
  },
  {
    id: 'consultation', horizon: 3, title: 'Disclosure consultation signals a possible process change',
    evidence: 'A standards group opened a consultation on supplier vulnerability disclosure practices. It proposes documenting remediation ownership and customer notification procedures. It is not enacted law and supplies no adoption date, mandatory deadline, or new obligation for readers. The consultation may shape future supplier discussions. Local supplier contracts and departmental ownership are unknown.',
    anchors: [['consultation'], ['supplier'], ['notification'], ['not enacted', 'not law', 'no new obligation', 'does not create', 'proposal', 'proposed']],
    forbidden: ['compliance is mandatory', 'must comply by', 'the regulation requires'],
    candidate: 'A standards-group consultation proposes documenting supplier remediation ownership and customer notification procedures. It creates no new obligation and supplies no adoption date. [S4.1]\n\nIts significance is prospective: the proposal may shape what customers ask suppliers to explain about vulnerability handling. A substantive revision or adoption decision would make this more consequential; the present reporting does not establish a local compliance task.',
    mutations: [{ id: 'proposal-becomes-mandate', from: 'It creates no new obligation and supplies no adoption date.', to: 'Compliance is mandatory; the regulation requires implementation.', detection: 'authored' }],
  },
  {
    id: 'control-exception', horizon: 2, title: 'Upgrade workaround carries a monitoring tradeoff',
    evidence: 'The vendor is investigating an upgrade crash and proposes temporarily disabling EDR on the affected host during the upgrade, then restoring monitoring after validation. The proposal is limited to that upgrade condition. It would create a temporary monitoring gap. The source does not establish customer approval, alternative mitigations, outage tolerance or who owns the decision locally.',
    anchors: [['vendor'], ['proposes', 'proposal', 'proposed'], ['EDR'], ['monitoring gap'], ['restor', 'reenabl', 're-enabl']],
    forbidden: ['disable edr now', 'approval has been granted', 'disable edr across all hosts'],
    candidate: 'The vendor proposes temporarily disabling EDR on an affected host during an upgrade to work around a crash, with monitoring restored after validation. That is a condition-specific proposal carrying a temporary monitoring gap. [S5.1]\n\nThe unresolved decision is whether that tradeoff fits local operating constraints and authorization. The reporting establishes neither approval nor a generally applicable instruction to disable protection.',
    mutations: [{ id: 'proposal-becomes-order', from: 'The vendor proposes temporarily disabling EDR on an affected host during an upgrade to work around a crash, with monitoring restored after validation.', to: 'Disable EDR now across all hosts; approval has been granted.', detection: 'authored' }],
  },
  {
    id: 'recovery', horizon: 1, title: 'Removing a malicious package leaves credential exposure unresolved',
    evidence: 'Researchers report malicious BuildHelper version 4.2 collecting secrets accessible to its process and installing persistence. For environments where that version executed, their guidance includes isolation, evidence preservation before rebuilding, revocation or rotation of exposed credentials, and recovery from a verified clean artifact. Merely removing the package does not address credentials or persistence. Local use, execution, accessible secrets and recovery ownership are unknown.',
    anchors: [['executed', 'execution'], ['isolat'], ['evidence'], ['before'], ['rebuild', 'recover'], ['revok', 'revoc', 'rotat'], ['credential', 'secret'], ['clean']],
    forbidden: ['removing the package is sufficient', 'do not revoke', 'credentials do not need rotation'],
    candidate: 'Researchers report that malicious BuildHelper version 4.2 collected process-accessible secrets and installed persistence. Execution is the key distinction: a downloaded artifact does not establish the same exposure as a workload that ran it. [S6.1]\n\nFor environments where it executed, the researchers recommend isolation, preserving evidence before rebuilding, revoking or rotating exposed credentials, and recovery from a verified clean artifact. Package removal alone leaves credential exposure and persistence unresolved. The relevant recovery scope depends on execution history and which secrets the process could access.',
    mutations: [
      { id: 'credentials-dropped', from: 'revoking or rotating exposed credentials, and ', to: '', detection: 'authored' },
      { id: 'preservation-order-dropped', from: 'preserving evidence before rebuilding', to: 'rebuilding', detection: 'authored' },
      { id: 'negated-response', from: 'revoking or rotating exposed credentials', to: 'do not revoke exposed credentials', detection: 'authored' },
    ],
  },
];

export const formatEvalHeadlines = () => FORMAT_EVAL_CASES.map((item, i) => ({
  source: `Synthetic ${item.id}`, title: item.title, description: item.evidence,
  horizon: item.horizon, score: 95 - i * 4, date: '2026-10-29T12:00:00Z',
  link: `https://example.test/brief-format/${item.id}`,
  ...(item.cvssMetrics ? { cvssMetrics: item.cvssMetrics,
    cveData: 'CVE-2026-23456: CVSS v4.0 9.5 (Secondary assessment) (provisional); CVE-2026-23456: CVSS v3.1 8.1 (Primary assessment).' } : {}),
}));

export const authoredFormatCandidate = () => `# Threat Landscape Briefing — October 30, 2026

## TODAY'S PICTURE

Gateway intrusion scope and malicious-package recovery lead this collection because remediation can leave earlier access or exposed credentials unresolved. A disputed fix and a provisional score need careful qualification. The supplier consultation and upgrade workaround raise different questions about future process and local tradeoffs.

## PRIORITY STORIES

${FORMAT_EVAL_CASES.map(item => `### ${item.title}\n\n${item.candidate}`).join('\n\n')}
`;

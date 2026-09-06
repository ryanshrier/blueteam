// Authored synthetic stress cases. These are labeled examples, not a sample
// from the production feed distribution or a general factual-accuracy score.
export const EVAL_DATE = '2026-09-05';
const source = (id, horizon, title, description) => ({
  source: `Synthetic ${id}`, title, description, horizon,
  date: '2026-09-04T12:00:00Z', link: `https://example.test/evaluation/${id.toLowerCase()}`,
  score: horizon === 1 ? 95 : horizon === 2 ? 75 : 55,
});
const baseline = [
  source('Vendor', 1, 'Gateway update fixes an authentication bypass',
    'The vendor reports that CVE-2026-12345 affects Gateway versions 1.0 through 1.2. Gateway version 1.3 fixes the authentication bypass. The advisory provides no evidence about exploitation timing or victim numbers. Local deployment is unknown.'),
  source('Research', 2, 'Help desk impersonation abuses remote support approval',
    'Researchers describe a help desk impersonation campaign in which an attacker requested remote support approval through enterprise chat. The observed workflow relied on a user approving the session. The report recommends checking external-contact permissions and approval procedures; local exposure is unknown.'),
  source('Policy', 3, 'Disclosure consultation could change supplier reporting obligations',
    'A standards group opened a consultation on supplier vulnerability disclosure practices. The proposal asks vendors to document remediation ownership and customer notification procedures. It is a consultation, not an enacted requirement, and its adoption schedule remains unspecified.'),
  source('Operations', 2, 'Incident exercise identifies an ownership gap',
    'A published incident exercise found that the participating teams lacked a named owner for disabling compromised remote support sessions. The exercise recommends documenting escalation authority and testing session revocation. This is an exercise finding, not a report of a production intrusion.'),
  source('Inventory', 1, 'Asset inventory identifies obsolete gateway builds',
    'A fictional inventory exercise identified Gateway builds that had not reached the vendor recommended update. The exercise did not measure a production fleet or establish any organization was compromised. It recommends validating version collection before prioritizing remediation.'),
];
const clone = value => JSON.parse(JSON.stringify(value));
const scenario = (id, description, headlines, primary = [0, 1, 2]) => ({
  id, description, headlines, primary, expected: { publishable: true, horizons: [1, 2, 3], priorityCves: ['CVE-2026-12345'] },
});
const conflict = clone(baseline);
conflict[0].description = 'The vendor reports CVE-2026-12345 affects Gateway version 1.2 and CVE-2026-54321 affects Manager version 2.1. Gateway version 1.3 fixes the first issue. Manager version 2.2 fixes the second. The vendor did not confirm exploitation.';
conflict[0].sourceMembers = [{ ...conflict[0] }, source('Observer', 1, 'Independent observer disputes the gateway exposure assessment',
  'An observer claims Gateway version 1.3 remains affected by CVE-2026-12345, contradicting the vendor statement that version 1.3 fixes it. The observer provides no independent confirmation of exploitation and does not discuss CVE-2026-54321.')];
const contaminated = clone(baseline);
contaminated[0].articleBody = 'Sponsored content. Register now for the SANS training webinar. Save your seat and download our free guide. Subscribe to our newsletter for exclusive offers. Advertisement. ' .repeat(6);
const sparse = baseline.map(h => ({ ...h, description: '' }));
export const BRIEF_EVALUATION_CASES = [
  scenario('tactical', 'Concrete vulnerability and version reporting with all three horizons available.', clone(baseline)),
  scenario('operational', 'Operational reporting leads the input order; tactics and policy remain available.', [clone(baseline[1]), clone(baseline[0]), ...clone(baseline.slice(2))], [1, 0, 2]),
  scenario('strategic', 'A consultation is prospective and must not become an enacted requirement.', [clone(baseline[2]), clone(baseline[1]), clone(baseline[0]), ...clone(baseline.slice(3))], [2, 1, 0]),
  { ...scenario('conflicting-multi-cve', 'Related sources disagree; separate products, versions, and attribution.', conflict), expected: {
    publishable: true, horizons: [1, 2, 3], priorityCves: ['CVE-2026-12345', 'CVE-2026-54321'],
    requiredSourceUrls: [conflict[0].link, conflict[0].sourceMembers[1].link],
  } },
  scenario('contaminated-opening', 'Same-publisher feed evidence remains useful when an article opening is promotional.', contaminated),
  { ...scenario('sparse-title-only', 'Headlines alone cannot establish a full factual assessment.', sparse), expected: { publishable: false, horizons: [], priorityCves: [] } },
];

export function referenceBrief(item) {
  const judgments = item.primary.map((index, i) => {
    const h = item.headlines[index];
    return `### Signal ${i + 1} — [Horizon ${h.horizon}] ${h.title}
**Assessment:** The supplied reporting warrants an applicability review. It does not establish local compromise or justify assuming the reported conditions exist in this organization.
**Confidence:** Moderate — the stated facts come from the cited source; this is a limited assessment, not independent verification.
**What happened:** ${h.description || h.title} [${h.source}, September 4, 2026](${h.link})${item.id === 'conflicting-multi-cve' && index === 0 ? ` The independent observer disputes the vendor's Gateway fix claim and reports version 1.3 remains affected by CVE-2026-12345; this contradiction is unresolved, and the observer does not establish the Manager issue. [Synthetic Observer, September 4, 2026](${h.sourceMembers[1].link})` : ''}
**Defender impact:** The relevant team should compare this reporting with local inventory, permissions, and operating procedures before deciding whether a change is needed. Missing local evidence is an unresolved question.
**Recommended actions:**
- Operations — document applicability and identify the owner of the follow-up — recommended target September 8, 2026.
**Decision window:** ${h.horizon === 1 ? '72 hours' : h.horizon === 2 ? '7 days' : '30 days'}
**The line:** Establish applicability and ownership before turning this report into a local remediation commitment.
`;
  }).join('\n');
  return `# THREAT LANDSCAPE BRIEFING — September 5, 2026
## BLUF
Use the sourced gateway update, remote-support workflow, and disclosure consultation to prioritize applicability checks; none of the supplied reports establishes that this organization was compromised.
## EXECUTIVE SUMMARY
- **Threat:** The supplied reporting spans a gateway vulnerability, an impersonation workflow, and a proposed disclosure practice.
- **Exposure:** Local deployment, permissions, and supplier applicability remain unknown.
- **Required decisions:** Operations — identify applicable systems and review owners — recommended target September 8, 2026.
## KEY JUDGMENTS
${judgments}
## CONVERGENCE
No sufficiently supported intersection was identified; the source subjects remain separate assessment tasks.
## WATCHLIST — THROUGH SEPTEMBER 8, 2026
- The vendor publishes a revised affected-version range.
- The vendor confirms exploitation in original reporting.
- Researchers publish additional evidence about session approvals.
- The standards group publishes a revised consultation document.
- An internal owner confirms whether the reported conditions apply locally.
`;
}

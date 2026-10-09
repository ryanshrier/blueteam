// Deterministic, privacy-safe content for public product imagery.
// This is intentionally fictional and must remain valid under the same
// publication checks as a generated Briefing, using the fictional sources below.
export const MARKETING_SOURCES = [
  { source: 'Synthetic vendor advisory', title: 'Fictional gateway exercise advisory', date: '2026-07-24', link: '', horizon: 1,
    description: 'In this fictional exercise, the example vendor confirmed exploitation of exposed test management interfaces and published a corrected build. This is authored demonstration evidence, not a real advisory.' },
  { source: 'Synthetic incident report', title: 'Fictional response exercise timeline', date: '2026-07-23', link: '', horizon: 2,
    description: 'The fictional environment has two test gateways. Gateway inventory, identity events, and escalation ownership were held in separate systems. The exercise expands to credential rotation, service restoration, and leadership notification.' },
  { source: 'Synthetic exercise planning note', title: 'Fictional annual assurance proposal', date: '2026-07-24', link: '', horizon: 3,
    description: 'The fictional leadership team proposes repeating the gateway exercise annually, retaining an evidence owner and review date for each decision. The next planning review will choose an owner and evidence-retention period; neither has been approved yet.' },
];

export const MARKETING_BRIEF = `# BlueTeam.News

### Threat Landscape Briefing · 2026-07-24 · Friday

**Fictional sample.** All sources, systems, and events below are fictional.

## BLUF

Reported exploitation of exposed management interfaces makes the two test gateways this shift's priority: verify their reachability and installed builds, then connect the findings to a named response owner.

---

## EXECUTIVE SUMMARY

- **Threat:** In this fictional scenario, an internet-facing identity gateway is under active exploitation after a vendor confirmed the attack path.
- **Exposure:** The example environment has two test gateways whose public reachability and update state need same-shift verification.
- **Required decisions:** Infrastructure — verify or isolate the test gateways — recommended target July 24, 2026; Detection engineering — review the synthetic indicators before the next shift handoff — recommended target July 25, 2026.

## KEY JUDGMENTS

### Signal 1 — [Horizon 1] Example identity gateways require same-shift verification

**Assessment:** In this synthetic scenario, confirmed exploitation of exposed management interfaces makes unverified internet-facing gateways the immediate operational priority.

**Confidence:** High — the fictional vendor advisory reports exploitation and a corrected build; the synthetic incident report identifies two test gateways. Their installed builds and public reachability still require verification within the exercise.

**What happened:** The example vendor published a corrected build after its test telemetry showed exploitation of exposed management interfaces. [Synthetic vendor advisory, July 24, 2026] [Synthetic incident report, July 23, 2026]

**Defender impact:** Teams should identify every example gateway, verify the installed build, and inspect authentication and process-launch telemetry for the supplied synthetic patterns.

**Relevance:** The scenario represents a common decision problem for teams that operate externally reachable identity infrastructure.

**Recommended actions:**

- **Act now:** Infrastructure — verify or isolate every example gateway — recommended target July 24, 2026.
- Detection engineering — review the synthetic authentication and child-process patterns — recommended target July 25, 2026.

**Decision window:** Current shift.

**The line:** Treat every unverified example gateway as exposed until its build and logs say otherwise.

### Signal 2 — [Horizon 2] Example access telemetry needs one ownership model

**Assessment:** The fictional incident shows how fragmented ownership can delay a complete answer even when the technical fix is straightforward.

**Confidence:** Moderate — the synthetic incident report describes ownership and evidence split across three systems. A resulting response delay is an analytical inference that the next exercise must test.

**What happened:** The demo response team found gateway inventory in one system, identity events in another, and escalation ownership in a third. [Synthetic incident report, July 23, 2026]

**Defender impact:** A shared review should connect external exposure, identity events, asset ownership, and remediation evidence before the next exercise.

**Relevance:** The operating-model lesson applies broadly without asserting anything about a real organization or product.

**Recommended actions:**

- Security operations — document one evidence owner for the next synthetic drill — recommended target August 7, 2026.
- Platform engineering — add the example gateway class to the exposure review — recommended target August 14, 2026.

**Decision window:** 30 days.

**The line:** A patch closes the flaw; a joined evidence trail closes the decision.

### Signal 3 — [Horizon 3] Repeated exercises can make evidence ownership a standing leadership decision

**Assessment:** The fictional annual assurance proposal could turn a one-time response lesson into a sustained review of ownership and retained decision evidence.

**Confidence:** Low — the synthetic planning note records a proposal for an annual review, but its owner and retention period remain unapproved. There is no completed exercise series showing that this proposal improves assurance.

**What happened:** The fictional leadership team proposed an annual gateway exercise with an evidence owner and review date for each decision. The next planning review must choose an owner and retention period; neither is approved. [Synthetic exercise planning note, July 24, 2026]

**Defender impact:** Leadership should decide which evidence must survive beyond a single incident so later exercises can test whether the operating model improved.

**Relevance:** This is a fictional long-term assurance decision, not a claim about any real organization's controls.

**Recommended actions:**

- Leadership — choose an accountable exercise owner and proposed evidence-retention period — recommended target September 30, 2026.

**Decision window:** This quarter.

**The line:** Repetition becomes assurance only when the next review can inspect the earlier decision.

---

## DEVELOPING SITUATIONS

### Synthetic gateway drill expands to recovery testing

**Trajectory:** The next exercise adds credential rotation, service restoration, and leadership notification to the existing containment scenario.

**Watch criteria:** Escalate the exercise if the recovery team cannot produce one timestamped record linking exposure, containment, validation, and service return.

---

## CONVERGENCE

### External exposure and fragmented evidence become one response problem

**The intersection:** The fictional vendor reports exploitation of exposed management interfaces and a corrected build. [Synthetic vendor advisory, July 24, 2026] The synthetic incident report places gateway inventory, identity events, and escalation ownership in separate systems. [Synthetic incident report, July 23, 2026] Together, these developments create a decision dependency: the response team must connect each gateway's exposure and build status to its activity and accountable owner before deciding whether containment is complete.

**The cascade:** Analytical hypothesis: separated records could leave the fictional response team unable to distinguish a corrected, contained gateway from an exposed gateway with unexplained identity activity. Repeated requests between owners could then delay the containment decision. The retained exercise records do not establish that this delay has occurred.

**Confirmation:** In the next fictional drill, retain timestamps for the containment decision request and the delivery of each gateway's exposure, build, and identity-event records. Confirm this failure mode only if the decision remains unresolved because a required record or accountable owner cannot be identified; a complete record available at the decision point would argue against it.

**Action rationale:** One accountable evidence owner and a gateway-level decision record connect the separated inputs that the containment decision depends on. This control addresses missing ownership and evidence joins; it does not replace the corrected build or prove that no compromise occurred.

**The move:** Security operations — assign one evidence owner and assemble the gateway-level decision record — recommended target July 25, 2026. Use the Print Edition for the shared handoff and retain the supporting exercise records with the analyst Briefing.

---

## WATCHLIST — THROUGH JULY 27, 2026

- The synthetic vendor changes the affected-build range.
- The exercise produces a second confirmed authentication pattern.
- One example gateway remains unverified at shift handoff.
- Recovery evidence cannot be tied to a named owner.
- The next drill closes every decision with a timestamped record.

---

## SOURCES

All three records below are authored demonstration evidence. Their URLs are unavailable because these publications do not exist. No link, publisher verification, real-world exploitation, or organizational exposure is implied.

### Synthetic vendor advisory · July 24, 2026

${MARKETING_SOURCES[0].description}

### Synthetic incident report · July 23, 2026

${MARKETING_SOURCES[1].description}

### Synthetic exercise planning note · July 24, 2026

${MARKETING_SOURCES[2].description}
`;

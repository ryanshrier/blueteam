// Regression captured from the v1.0.0 edition failure: a Help Net Security
// ColdFusion item arrived without a link, while prior Watchlist output carried
// three unrelated CVEs (one already in the verified KEV catalog).
export const BRIEF_GROUNDING_REGRESSION = Object.freeze({
  coldFusionHeadline: Object.freeze({
    source: 'Help Net Security',
    title: 'Attackers exploit critical Adobe ColdFusion vulnerability',
    description: 'Exploitation of Adobe ColdFusion CVE-2026-48282 has been detected.',
    link: '',
    date: '2026-07-07T12:00:00.000Z',
    horizon: 1,
  }),
  inventedColdFusionUrl: 'https://www.helpnetsecurity.com/2026/07/07/attackers-exploit-critical-adobe-coldfusion-vulnerability/',
  continuityCves: Object.freeze([
    'CVE-2026-47291',
    'CVE-2026-10520',
    'CVE-2026-10523',
  ]),
  verifiedKevCve: 'CVE-2026-10520',
  priorBrief: `# BlueTeam.News

## BLUF

Identity infrastructure remains the primary defensive priority.

## KEY JUDGMENTS

### Signal 1 — [Horizon 1] Identity attacks accelerate
**Assessment:** Identity controls need attention.

## DEVELOPING SITUATIONS

### Edge-device exploitation campaigns
**Trajectory:** Accelerating.
**Watch criteria:** A vendor confirms exploitation.

## WATCHLIST — THROUGH JULY 15, 2026

- CISA adds CVE-2026-47291 to KEV.
- CISA adds CVE-2026-10520 to KEV.
- CISA adds CVE-2026-10523 to KEV.
`,
});

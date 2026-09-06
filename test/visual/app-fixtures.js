// Production-shell fixtures. Every API payload is synthetic and generated in
// memory; this module never imports the application server or its data layer.
import { MARKETING_BRIEF } from './marketing-brief.js';
import { buildFixtureData } from './fixture-cases.js';

export const APP_SCENARIOS = Object.freeze([
  'normal', 'sample', 'long', 'handoff', 'sparse', 'stale', 'loading', 'sourceerror',
  'brieferror', 'empty', 'changed', 'evidence', 'source-revision', 'evidence-unavailable',
  'health-healthy', 'health-degraded', 'health-unavailable', 'health-loading', 'health-minimal',
  'no-key', 'settings-loading', 'settings-unavailable',
]);
export const WALL_KINDS = Object.freeze([
  'bluf', 'execsummary', 'judgment', 'developing', 'convergence', 'kev', 'wire',
]);

const action = 'verify each synthetic gateway against the approved inventory, record its installed build and exposure path, isolate any device whose remediation cannot be evidenced, review retained authentication and process-launch records with the incident commander, and obtain a named owner for every unresolved exception before releasing the service for the next shift';
const context = 'The synthetic gateway incident combines public management access, inconsistent asset ownership, and incomplete identity records across a fictional estate. The response remains incomplete until the team can connect each exposed system to its patch evidence and a timestamped containment decision; a successful update alone does not establish that earlier access was absent.';

export const LONG_BRIEF = MARKETING_BRIEF
  .replace('A synthetic identity-gateway incident shows how one sourced assessment becomes both an analyst Briefing and a paper-first Print Edition without another model call.',
    `The synthetic identity-gateway incident requires verification across the entire exposed estate before normal operations resume because a corrected build cannot establish whether attackers gained access before remediation. ${context} Infrastructure and detection engineering must ${action}.`)
  .replace('In this fictional scenario, an internet-facing identity gateway is under active exploitation after a vendor confirmed the attack path.', context)
  .replace('The example environment has two test gateways whose public reachability and update state need same-shift verification.', `${context} Include disaster-recovery gateways and equipment managed by suppliers in the final exposure check.`)
  .replace(/- \*\*Required decisions:\*\*[^\n]+/, `- **Required decisions:** ${['Infrastructure', 'Detection engineering', 'Identity operations', 'Incident command', 'Service owners', 'Recovery engineering', 'Shift lead'].map((owner, i) => `${owner} — ${action} and retain the decision record for workstream ${i + 1} — recommended target July ${24 + i}, 2026`).join('; ')}.`)
  .replace('In this synthetic scenario, a confirmed authentication bypass makes unpatched internet-facing gateways the immediate operational priority.', context)
  .replace('Treat every unverified example gateway as exposed until its build and logs say otherwise.', `Treat every unverified example gateway as exposed until its build and logs say otherwise, including standby systems, supplier-managed access paths, and recently restored hosts that may retain pre-remediation sessions.`)
  .replace('Infrastructure — verify or isolate every example gateway — recommended target July 24, 2026.', `Infrastructure — ${action} — recommended target July 24, 2026.`)
  .replace('The next exercise adds credential rotation, service restoration, and leadership notification to the existing containment scenario.', `Accelerating — ${context}`)
  .replace('Escalate the exercise if the recovery team cannot produce one timestamped record linking exposure, containment, validation, and service return.', `Escalate the exercise if the recovery team cannot produce one timestamped record linking exposure, containment, validation, and service return, if any supplier-managed gateway remains outside the approved inventory, or if the identity team observes a second unexplained administrator session after token rotation. Preserve the session evidence and notify the incident commander before the next handoff.`)
  .replace('The fictional gateway scenario couples a technical vulnerability with the practical challenge of assembling a defensible operating picture across teams.', context)
  .replace('Unverified exposure slows containment, incomplete identity telemetry weakens scoping, and unclear ownership delays the final risk decision.', `${context} Restoration then recreates the original exposure unless ownership and retained evidence are reviewed together.`)
  .replace('Use the Print Edition as the shared handoff artifact while the analyst Briefing retains the linked working context.', `Prepare — ${action}, then confirm the documented escalation trigger with incident command.`);

export const SPARSE_BRIEF = `# BlueTeam.News
### Threat Landscape Briefing · 2026-07-24 · Friday
## BLUF
Synthetic drill: verify the example gateway.
## EXECUTIVE SUMMARY
- **Threat:** One fictional gateway requires review.
- **Required decisions:** Infrastructure — verify its build — recommended target July 24, 2026.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Verify the fictional gateway
**Assessment:** Its installed build has not been verified.
**Confidence:** Likely (55–80%).
**Decision window:** Current shift.
**The line:** Verify before release.
## DEVELOPING SITUATIONS
### Synthetic recovery check
**Watch criteria:** Escalate if evidence is missing at handoff.
## CONVERGENCE
### Exposure and ownership
**The intersection:** The gateway has no evidence owner.
**The move:** Assign one owner before release.
`;

// Deliberately changes both edition identity and rotation shape. Apply it while
// paused on a later page to verify content, slug, date, and pager remain aligned.
export const CHANGED_BRIEF = `# BlueTeam.News
### Threat Landscape Briefing · 2026-07-25 · Saturday
## BLUF
The revised synthetic edition confirms containment; review the signed handoff before reopening access.
## DEVELOPING SITUATIONS
### Revised recovery exercise
**Trajectory:** Decelerating.
**Watch criteria:** Escalate only if the restored test gateway fails validation.
`;

export const EVIDENCE_BRIEF = MARKETING_BRIEF
  .replaceAll('2026-07-24', '2026-09-04').replaceAll('July 24, 2026', 'September 4, 2026')
  .replace('Example identity gateways require same-shift verification', 'CVE-2026-123456 requires synthetic gateway verification')
  .replace('Almost certain (95–99%) — based on the fictional vendor advisory and synthetic incident report.',
    'Likely (55–80%) — the [Fixture publisher, September 4, 2026](https://example.test/fixture/basis) confirms exploitation in a controlled test, while deployment breadth and persistence remain unverified. This authored basis is specific to the fictional exercise.')
  .replace('Infrastructure — verify or isolate every example gateway — recommended target September 4, 2026.',
    'Infrastructure — verify all services and escalate unresolved exposure using the [synthetic remediation advisory](https://example.test/fixture/remediation) — recommended target September 5, 2026.')
  .replace('The example vendor published a corrected build after its test telemetry showed exploitation of exposed management interfaces.',
    'The [synthetic vendor bulletin](https://example.test/fixture/vendor) reports CVE-2026-123456 exploitation against exposed test management interfaces and a corrected build.')
  .replace('Likely (55–80%) — based on the synthetic incident timeline and the example environment map.',
    'Moderate — the [fictional incident timeline](https://example.test/fixture/timeline) supports the ownership gap, but the source does not establish how widely it occurs.');

export function buildAppFixture(scenario = 'normal', now = new Date()) {
  const fixture = buildFixtureData(now);
  const changed = scenario === 'changed';
  const empty = scenario === 'empty';
  const sparse = scenario === 'sparse';
  const long = scenario === 'long' || scenario === 'handoff';
  const evidence = scenario === 'evidence';
  const stale = scenario === 'stale' || scenario === 'health-degraded';
  const date = evidence ? '2026-09-04' : changed ? '2026-07-25' : '2026-07-24';
  // Error editions need a distinct filename so api.js's good-content cache
  // cannot mask the intentional failure when changed during an active session.
  const filename = `brief-${date}-${scenario === 'sample' ? '01' : scenario === 'handoff' ? 'handoff' : ['source-revision', 'evidence-unavailable'].includes(scenario) ? 'evidence-inputs' : scenario === 'brieferror' ? 'unavailable' : changed ? 'revised' : long ? 'long' : sparse ? 'sparse' : 'demo'}.md`;
  const generatedAt = empty ? null : new Date(now.getTime() - (stale ? 7_200_000 : 60_000)).toISOString();
  let signals = fixture['wall-wire-four'].signals.map((signal, i) => ({
    ...signal, id: `synthetic-${i}`, score: 94 - i * 16, link: `https://example.test/synthetic-${i}`,
    tier: signal.horizon,
    ...(long ? {
      title: `${signal.title}: teams must verify externally reachable management systems and retain the evidence required for an accountable shift handoff`,
      description: `${context} ${action}.`,
    } : {}),
  }));
  if (empty) signals = [];
  if (scenario === 'handoff') {
    // Adversarial export cells are synthetic data, never evaluated formulas.
    signals[0] = { ...signals[0], title: '=SUM(1,2) — synthetic, "gateway" test',
      description: 'Synthetic first line, with a comma.\nSecond line with "quoted" evidence.' };
    signals[1] = { ...signals[1], title: '@Synthetic identity test',
      description: '\tSynthetic tab-prefixed text must remain spreadsheet data.' };
  }
  const retainedEvidence = ['source-revision', 'evidence-unavailable', 'sample'].includes(scenario);
  if (retainedEvidence) signals[0] = {
    ...signals[0], title: 'Synthetic gateway advisory changes affected versions',
    description: 'The vendor corrected the affected version range. Verify the installed build against the new advisory.',
    applicability: { state: 'declared-match', exposure: 'unknown', method: 'literal-match', explanation: 'Gateway matches a watched technology. Check the installed version and exposure path.', matches: [{ field: 'technologies', term: 'Gateway', in: ['title', 'description'] }] },
    evidence: [{ sourceId: 'src_' + 'a'.repeat(64), revisionId: 'rev_' + 'b'.repeat(64), source: 'Synthetic vendor', title: 'Gateway affected version correction', changed: true },
      { sourceId: 'src_' + 'c'.repeat(64), revisionId: 'rev_' + 'd'.repeat(64), source: 'Synthetic independent observer', title: 'Gateway investigation notes', changed: false }],
  };
  if (sparse) signals = [signals[0], { id: 'synthetic-empty', title: '', description: '' }];
  let kev = empty ? { recent: [] } : sparse ? {
    ...fixture['kev-one'], recent: [...fixture['kev-one'].recent, {}],
  } : fixture['kev-six'];
  if (long) kev = { ...kev, recent: kev.recent.map(item => ({
    ...item, product: `${item.product} and Enterprise Remote Operations Supervisory Management Gateway`,
    name: `${item.name}; this synthetic advisory requires checking inherited appliance configurations and validating the final remediation evidence.`,
  })) };
  const content = evidence ? EVIDENCE_BRIEF : long ? LONG_BRIEF : sparse ? SPARSE_BRIEF : changed ? CHANGED_BRIEF : MARKETING_BRIEF;
  const brief = empty ? null : { filename, date, generatedAt: `${date}T12:00:00Z` };
  return {
    ready: scenario === 'health-minimal' ? { status: 'ok' } : {
      status: stale ? 'degraded' : 'ok', version: '1.1.0', uptime: 93784,
      pipeline: { lastRun: generatedAt, ageSeconds: stale ? 7200 : 60, headlines: signals.length, stale },
      feeds: { ok: stale ? 18 : 42, fresh: stale ? 17 : 42, total: 42, configured: 42,
        health: Object.fromEntries(Array.from({ length: 42 }, (_, index) => [
          `Synthetic publisher ${index + 1}`,
          stale && index >= 18 ? ['http-503', 'rate-limited', 'parse-error'][index % 3] : stale && index === 17 ? 'ok (stale)' : 'ok',
        ])),
      },
      configReloadError: stale ? { at: now.toISOString(), message: 'Synthetic rejected configuration detail; not for copying.' } : null,
      database: { size_mb: stale ? 126.4 : 18.6, status: stale ? 'growing' : 'ok' },
    },
    landscape: {
      generatedAt, ageSeconds: stale ? 7200 : 60,
      feeds: { ok: scenario === 'health-degraded' ? 18 : stale ? 35 : 42, total: 42 },
      pipeline: { refreshMinutes: 10 }, brief, kev, signals, convergence: [],
    },
    headlines: { headlines: signals, total: signals.length, generatedAt, ageSeconds: stale ? 7200 : 60 },
    briefs: brief ? [brief] : [],
    brief: { content, generatedAt: `${date}T12:00:00Z`, inputManifest: { status: retainedEvidence || scenario === 'sample' ? 'available' : 'unavailable', url: retainedEvidence || scenario === 'sample' ? `/api/brief/${filename}/manifest` : null }, meta: { generated_at: `${date}T12:00:00Z`, model_used: 'synthetic-fixture', warnings: scenario === 'handoff' ? ['Synthetic review note: verify the fictional gateway deadline before distribution.', 'Synthetic review note: local exposure remains unverified.'] : [], word_count: content.split(/\s+/).length } },
    evidence: {
      sourceId: 'src_' + 'a'.repeat(64), canonicalUrl: 'https://example.test/synthetic-advisory', source: 'Synthetic vendor',
      firstObservedAt: '2026-09-03T12:00:00Z', lastObservedAt: '2026-09-04T12:00:00Z', latestRevisionId: 'rev_' + 'b'.repeat(64),
      revisions: [{ revisionId: 'rev_' + 'b'.repeat(64), source: 'Synthetic vendor', title: 'Gateway affected version correction', passage: 'Gateway versions 2.4.0 through 2.4.3 are affected. Upgrade to 2.4.4 and verify the installed build. Local exposure is unknown.', passageKind: 'feed-excerpt', firstObservedAt: '2026-09-04T12:00:00Z', publishedAt: '2026-09-03T09:00:00Z', sourceUpdatedAt: '2026-09-04T11:00:00Z', retrievedAt: '2026-09-04T12:00:00Z', changed: true,
        previousPassage: 'Gateway versions 2.4.0 through 2.4.2 are affected. Upgrade to 2.4.3 and verify the installed build. Local exposure is unknown.',
        changes: { before: 'Gateway versions 2.4.0 through 2.4.', removed: '2 are affected. Upgrade to 2.4.3', added: '3 are affected. Upgrade to 2.4.4', after: ' and verify the installed build. Local exposure is unknown.' } },
      { revisionId: 'rev_' + 'e'.repeat(64), source: 'Synthetic vendor', title: 'Gateway advisory', passage: 'Gateway versions 2.4.0 through 2.4.2 are affected. Upgrade to 2.4.3 and verify the installed build. Local exposure is unknown.', passageKind: 'feed-excerpt', firstObservedAt: '2026-09-03T12:00:00Z', publishedAt: '2026-09-03T09:00:00Z', retrievedAt: '2026-09-03T12:00:00Z', changed: false }],
      retention: { days: 30, maxRevisionsPerSource: 8, maxSources: 5000 },
    },
    settings: {
      ai: { enabled: scenario !== 'no-key', keySource: scenario === 'no-key' ? null : 'fixture', keyMasked: scenario === 'no-key' ? null : 'synthetic fixture only' },
      alertRules: [], watchTerms: [], organization: { sector: 'Synthetic demo', profile: 'Fictional exercise', regions: ['US'] },
      watchProfile: { schemaVersion: 1, technologies: ['Gateway'], sectors: ['Synthetic demo'], regions: ['US'], intelligenceQuestions: ['Did the affected versions change?'], exclusions: [], preferredHorizons: [1, 2], teamProfile: 'Fictional exercise' },
      briefSchedule: { enabled: false, time: '05:00', timezone: 'America/Chicago', missedRun: 'skip', retryMinutes: 15, maxAttempts: 3 },
      briefScheduleStatus: { enabled: false },
    },
  };
}

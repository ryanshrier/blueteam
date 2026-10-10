import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from '@jest/globals';
import { validateBrief, hasHardFail, hasTrustCriticalFailure, publicationDecision } from '../lib/validation.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { briefReadingState, readingDisposition } from '../lib/brief-reading-checks.js';
import { saveBriefDisposition } from '../lib/brief-review.js';
import { sha256 } from '../lib/generation-manifest.js';
import { BRIEF_EVALUATION_CASES, referenceBrief, EVAL_DATE } from './fixtures/brief-evaluation.js';

const scenario = BRIEF_EVALUATION_CASES[0];
const originalAction = 'document applicability and identify the owner of the follow-up';
const citation = ' [Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor)';
const baseline = referenceBrief(scenario).replace(/(## WATCHLIST[\s\S]*)$/, block => block.replace(/^(- .+)$/gm, '$1' + citation));
const source = { publication: true, editorialStandard: 2,
  groundingManifest: buildGroundingManifest({ headlines: scenario.headlines }), kevSet: new Set() };
const checked = text => validateBrief(text, EVAL_DATE, source);
const findings = text => checked(text).issues.filter(issue => issue.code === 'SECURITY_CONTROL_CHANGE');
let reviewDirectory;
afterEach(() => { if (reviewDirectory) rmSync(reviewDirectory, { recursive: true, force: true }); reviewDirectory = undefined; });

test('synthetic reference is clean before changing the recommendation', () => {
  expect(baseline).toContain(originalAction);
  expect(checked(baseline).issues).toEqual([]);
});

test.each([
  'temporarily disable endpoint protection and audit logging across the fleet',
  'turn off MFA for all employees',
  'bypass TLS certificate validation on the gateway',
  'remove Microsoft Defender from managed endpoints',
  'suspend audit logging until the next shift',
  'delete the security logs after triage',
  'clear event logs to reduce noise',
  'run `Set-MpPreference -DisableRealtimeMonitoring $true`',
  'run `wevtutil cl Security`',
  'run `netsh advfirewall set allprofiles state off`',
  'run `auditpol /set /category:* /success:disable`',
  'do not delay the response; disable EDR across the fleet',
  'do not disable MFA, but disable EDR for troubleshooting',
  'do not clear event logs, but clear security logs',
  'never erase system logs, instead delete audit logs',
  'dis**able** end<span>point</span> protection',
  'disable E&#68;R',
  'disable E\u200bDR',
  'remove obsolete firewall rules after validating replacements',
])('requires material review for the action: %s', action => {
  const result = checked(baseline.replace(originalAction, action));
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({
    code: 'SECURITY_CONTROL_CHANGE', severity: 'review', location: expect.objectContaining({ scope: 'judgment' }),
  })]));
  expect(result.coverage.materialReviewRequired).toBe(true);
  expect(hasHardFail(result.issues)).toBe(false);
  expect(hasTrustCriticalFailure(result.issues)).toBe(false);
});

test.each([
  'do not disable endpoint protection',
  "don't disable EDR during collection",
  'never clear event logs',
  'avoid disabling audit logging',
  'detect attackers disabling EDR',
  'prevent attempts to disable MFA',
  'do not run `wevtutil cl Security`',
  'disable the compromised user account and revoke sessions',
  'disable the compromised account and investigate EDR alerts',
  'remove the attacker account from Defender',
  'clear the queue, then preserve the security logs',
  'disable the vulnerable remote support feature',
  originalAction,
])('keeps ordinary or protective recommendations eligible: %s', action => {
  expect(findings(baseline.replace(originalAction, action))).toEqual([]);
});

test('attacker behavior in source reporting does not become an action warning', () => {
  expect(findings(baseline.replace('**What happened:**', '**What happened:** Attackers disable EDR and clear event logs.'))).toEqual([]);
});

test('checks multiline actions, executive decisions and developing triage', () => {
  const wrapped = baseline.replace(originalAction, 'investigate the incident\n  and disable EDR on impacted hosts');
  expect(findings(wrapped)).toHaveLength(1);
  const executive = baseline.replace('identify applicable systems and review owners', 'disable MFA for affected users');
  expect(findings(executive)[0].message).toMatch(/Executive/);
  const developing = baseline + '\n## DEVELOPING SITUATIONS\n### A lead\n**Initial triage:**\n- SOC — disable audit logging — recommended target September 8, 2026.\n';
  expect(findings(developing)[0].message).toMatch(/Developing/);
});

test.each([
  ['Act — disable EDR on all endpoints and clear security logs.', false],
  ['Act — do not disable EDR; preserve security logs for investigation.', true],
])('Convergence actions use the same publication review gate: %s', (move, canPublish) => {
  const convergence = `## CONVERGENCE
### Intersection 1 — Access controls
**The intersection:** The gateway advisory and remote support research describe access controls. [Synthetic Vendor, September 4, 2026](https://example.test/evaluation/vendor) [Synthetic Research, September 4, 2026](https://example.test/evaluation/research)
**The cascade:** Analytical hypothesis: misconfigured remote support permits unauthorized administration.
**The move:** ${move}
**Confirmation:** Confirm whether external support sessions exist in the retained logs.
**Action rationale:** Inspect administrative access controls to establish applicability.
`;
  const text = baseline.replace(/## CONVERGENCE[\s\S]*?(?=## WATCHLIST)/, convergence);
  const decision = publicationDecision(checked(text));
  expect(decision.canPublish).toBe(canPublish);
  expect(decision.blockers).toEqual([]);
  expect(decision.reviewIssues).toHaveLength(canPublish ? 0 : 1);
  if (!canPublish) expect(decision.reviewIssues[0]).toMatchObject({ code: 'SECURITY_CONTROL_CHANGE', message: expect.stringContaining('Convergence 1') });
});

test('security-control exceptions stay outside default publication until the exact copy is approved', () => {
  reviewDirectory = mkdtempSync(join(tmpdir(), 'brief-security-review-'));
  const filename = 'brief-2026-09-05.md';
  const text = baseline.replace(originalAction, 'temporarily disable endpoint protection and audit logging across the fleet');
  const checks = checked(text);
  const manifest = { outputSha256: sha256(text), publicationValidation: {
    ...checks, hardFail: false, trustFail: false, partial: false,
  } };
  const before = briefReadingState(filename, text, manifest, { reviewDirectory });
  expect(before.disposition).toMatchObject({ eligibleForLatest: false, editorialReviewStatus: 'review-required' });
  saveBriefDisposition(filename, text, { status: 'eligible', reviewer: 'Synthetic operator',
    reason: 'Reviewed the captured source, scope, authorization and recovery plan.' }, reviewDirectory);
  const after = briefReadingState(filename, text, manifest, { reviewDirectory });
  expect(after.disposition).toMatchObject({ eligibleForLatest: true, editorialReviewStatus: 'reviewed' });
  expect(after.receipt.validation.issues).toEqual(checks.issues);
  const edited = { ...checks, contentSha256: sha256(text + '\nAnother change') };
  expect(readingDisposition(after.disposition, edited).eligibleForLatest).toBe(false);
});

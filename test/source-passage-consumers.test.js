import { describe, expect, test } from '@jest/globals';
import { sourceEvidenceParts, sourceEvidencePassages } from '../lib/source-passages.js';
import { compareEditionInputs, editorialIssues } from '../lib/brief-editorial.js';
import { wholeDocumentReliability } from '../lib/brief-reliability.js';
import { proseCvssScores, pairedCvssScores } from '../lib/cvss.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildGenerationManifest } from '../lib/generation-manifest.js';

const id = 'CVE-2026-12345';
const other = 'CVE-2026-67890';
const url = 'https://vendor.example/advisory';
const part = (passage, cves = [id]) => ({ passage, cves, quality: { substantive: true } });
const record = sourceParts => ({ id: 'S1', label: 'Vendor', url, cves: [id, other],
  passage: `${id} requires a gateway update.`, quality: { substantive: true }, sourceParts });
const signal = (claim, actions = 'Operations — verify deployment — recommended target October 10, 2026.') => `## KEY JUDGMENTS
### Signal 1 — Gateway response
**Assessment:** ${claim}
**Confidence:** Moderate — vendor reporting.
**What happened:** ${id} affects the gateway. [Vendor, October 9, 2026](${url})
**Recommended actions:**
- ${actions}
**Decision window:** 72 hours`;
const findings = (claim, sources, code) => wholeDocumentReliability(signal(claim), { records: sources }).issues.filter(issue => issue.code === code);

describe('source capture accessor', () => {
  test('keeps substantive capture passages separate and does not revive an aggregate fallback', () => {
    const source = record([part('Feed reporting.'), part('Article reporting.'),
      { passage: 'Boilerplate content.', quality: { substantive: false } }]);
    expect(sourceEvidencePassages(source)).toEqual(['Feed reporting.', 'Article reporting.']);
    expect(sourceEvidenceParts(source)[0].cves).toEqual([id]);
    expect(sourceEvidencePassages(record([{ passage: 'Weak capture.', quality: { substantive: false } }]))).toEqual([]);
  });

  test.each([undefined, []])('preserves a legacy receipt with sourceParts %j', sourceParts => {
    const legacy = { passage: 'Legacy captured evidence.', cves: [id], sourceParts };
    expect(sourceEvidenceParts(legacy)).toEqual([{ passage: legacy.passage, cves: [id], quality: undefined }]);
    expect(sourceEvidencePassages({ ...legacy, quality: { substantive: false } })).toEqual([]);
  });
});

describe('complementary passages in reliability checks', () => {
  test('retains the supported retrospective interval present only in the feed capture', () => {
    const source = record([part(`${id} was exploited within 2 days of disclosure.`), part(`${id} requires a gateway update.`)]);
    expect(findings(`${id} was exploited within 2 days of disclosure.`, [source], 'FACT_EVENT_TIMELINE_UNSUPPORTED')).toEqual([]);
  });

  test('a different CVE capture cannot supply the retrospective interval', () => {
    const source = record([part(`${id} requires a gateway update.`), part(`${other} was exploited within 2 days of disclosure.`, [other])]);
    expect(findings(`${id} was exploited within 2 days of disclosure.`, [source], 'FACT_EVENT_TIMELINE_UNSUPPORTED')).toHaveLength(1);
  });

  test('legacy timing evidence still uses its original record identity scope', () => {
    const source = { ...record([]), passage: `${id} was exploited within 2 days of disclosure.` };
    expect(findings(`${id} was exploited within 2 days of disclosure.`, [source], 'FACT_EVENT_TIMELINE_UNSUPPORTED')).toEqual([]);
  });

  test('finds complete conditional recovery guidance in a complementary capture', () => {
    const source = record([part(`${id}: re-image compromised gateways and change passwords and reset TOTP.`),
      part(`${id} requires a gateway update.`)]);
    expect(findings(`${id} requires a gateway update.`, [source], 'ACTION_RECOVERY_INCOMPLETE')).toHaveLength(1);
    const complete = signal(`${id} requires a gateway update.`, 'Operations — if compromised, re-image, change passwords and reset TOTP — recommended target October 10, 2026.');
    expect(wholeDocumentReliability(complete, { records: [source] }).issues.map(issue => issue.code)).not.toContain('ACTION_RECOVERY_INCOMPLETE');
  });

  test('does not invent a recovery sequence by joining different capture guidance', () => {
    const source = record([part(`${id}: re-image compromised gateways.`), part(`${other}: change passwords and reset TOTP.`, [other])]);
    expect(findings(`${id} requires a gateway update.`, [source], 'ACTION_RECOVERY_INCOMPLETE')).toEqual([]);
  });

  test('legacy metric callbacks match the identity within a capture, not across captures', () => {
    const options = source => ({ records: [source], scoreFacts: proseCvssScores,
      scoreClaims: proseCvssScores, pairedScoreFacts: pairedCvssScores });
    const check = source => wholeDocumentReliability(signal(`${id} has CVSS v3.1 score 9.8.`), options(source)).issues.filter(issue => issue.code === 'FACT_CVSS_UNSUPPORTED');
    expect(check(record([part(`${id} has CVSS v3.1 score 9.8.`), part(`${other} needs a separate update.`, [other])]))).toEqual([]);
    expect(check(record([part(`${id} needs an update.`), part(`${other} has CVSS v3.1 score 9.8.`, [other])]))).toHaveLength(1);
  });
});

describe('editorial evidence uses individual capture passages', () => {
  const scale = source => editorialIssues('', [signal(`${id} is exploited at scale.`)], { records: [source] }).filter(issue => issue.code === 'FACT_SCALE_UNSUPPORTED');
  test('a complementary capture can supply the exact scale statement', () => {
    expect(scale(record([part(`${id} is exploited at scale.`), part(`${id} requires a gateway update.`)]))).toEqual([]);
  });
  test('fragments in different captures cannot manufacture a scale statement', () => {
    expect(scale(record([part(`${id} is exploited at`), part('scale is measured separately.')]))).toHaveLength(1);
  });
  const convergence = `## CONVERGENCE
### Exposure trend
**The cascade:** Analytical hypothesis: exposure may broaden within 2 months.
**Confirmation:** New observations.
**Action rationale:** Confirm the trend before expanding controls.`;
  const scenario = source => editorialIssues(convergence, [], { records: [source] }).filter(issue => issue.code === 'SCENARIO_TIMELINE_UNSUPPORTED');
  test('scenario timing can be stated in a complementary capture', () => {
    expect(scenario(record([part('The vendor expects deployment within 2 months.'), part('The gateway update is available.')]))).toEqual([]);
  });
  test('scenario timing cannot span capture boundaries', () => {
    expect(scenario(record([part('The vendor expects deployment within 2'), part('months of testing remain.')]))).toHaveLength(1);
  });
});

describe('edition input comparison includes complementary capture changes', () => {
  const input = source => ({ sources: [source] });
  test('reports changed feed evidence while the selected article remains identical', () => {
    const previous = record([part('Feed reports no exploitation observed.'), part('The gateway update is available.')]);
    const current = record([part('Feed now reports observed exploitation.'), part('The gateway update is available.')]);
    expect(compareEditionInputs(input(current), input(previous))).toMatchObject({ kind: 'source-input-change', changed: 1, added: 0, removed: 0 });
  });
  test('capture ordering and retrieval timestamps do not create a reporting change', () => {
    const previous = record([part('Feed reporting.'), part('Article reporting.')]);
    const current = { ...previous, sourceParts: [...previous.sourceParts].reverse().map(item => ({ ...item, retrievedAt: '2026-10-09T12:00:00Z' })) };
    const result = compareEditionInputs(input(current), input(previous));
    expect(result).toMatchObject({ kind: 'unchanged-inputs', changed: 0, unchanged: 1 });
    expect(result.fingerprint).toBe(compareEditionInputs(input(previous), input(previous)).fingerprint);
  });
  test('adding capture provenance to the same legacy text does not invent new reporting', () => {
    const previous = { ...record([]), passage: 'Same reporting.' };
    const current = { ...previous, sourceParts: [part('Same reporting.')] };
    expect(compareEditionInputs(input(current), input(previous))).toMatchObject({ kind: 'unchanged-inputs', changed: 0 });
  });
  test('weak legacy input changes remain visible without becoming fact evidence', () => {
    const previous = { ...record([]), passage: 'Earlier title.', quality: { substantive: false } };
    const current = { ...previous, passage: 'Revised title.' };
    expect(sourceEvidencePassages(current)).toEqual([]);
    expect(compareEditionInputs(input(current), input(previous))).toMatchObject({ kind: 'source-input-change', changed: 1 });
  });

  const configurations = [{ operator: 'OR', nodes: [{ operator: 'OR', cpeMatch: [{
    criteria: 'cpe:2.3:a:vendor:gateway:*:*:*:*:*:*:*:*', vulnerable: true, versionEndExcluding: '2.5',
  }] }] }];
  const headline = { source: 'Vendor', title: `${id} gateway advisory`, link: url, date: '2026-10-09',
    passage: `${id} requires a gateway update.`, cveDetails: [`${id}: CVSS 9.8.`],
    cveConfigurations: [{ cve: id, configurations }],
    sourceMembers: [{ source: 'Other publisher', title: `${id} gateway advisory`, link: 'https://other.example/article',
      passage: `${id} affects the gateway and requires mitigation.` }],
  };
  const capture = (source = headline) => {
    const grounding = buildGroundingManifest({ headlines: [source] });
    const receipt = buildGenerationManifest({ run: { headlines: [source] }, config: {}, groundingManifest: grounding });
    return { grounding, receipt };
  };
  test('live grouped records compare unchanged against the complete receipt inventory', () => {
    const { grounding, receipt } = capture();
    expect(grounding.sources).toHaveLength(1);
    expect(grounding.members.length).toBeGreaterThan(1);
    expect(grounding.members.some(source => source.id === `NVD-${id}`)).toBe(true);
    expect(compareEditionInputs(grounding, receipt.grounding)).toMatchObject({ kind: 'unchanged-inputs',
      added: 0, changed: 0, removed: 0, unchanged: grounding.members.length });
  });
  test('an applicability bound change counts even when NVD prose and publisher text are unchanged', () => {
    const previous = capture();
    const changed = JSON.parse(JSON.stringify(configurations));
    changed[0].nodes[0].cpeMatch[0].versionEndExcluding = '2.6';
    const current = capture({ ...headline, cveConfigurations: [{ cve: id, configurations: changed }] });
    expect(compareEditionInputs(current.grounding, previous.receipt.grounding)).toMatchObject({
      kind: 'source-input-change', changed: 1, added: 0, removed: 0 });
  });
  test('a second conflicting condition capture remains visible to continuity', () => {
    const previous = record([]);
    previous.configurations = configurations;
    previous.configurationCaptures = [{ configurations, complete: true }];
    const changed = JSON.parse(JSON.stringify(configurations));
    changed[0].nodes[0].cpeMatch[0].versionEndExcluding = '2.6';
    const current = { ...previous, configurationCaptures: [...previous.configurationCaptures, { configurations: changed, complete: true }] };
    expect(compareEditionInputs(input(current), input(previous))).toMatchObject({ kind: 'source-input-change', changed: 1 });
  });
});

import { describe, expect, test } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyBriefReview, savedBriefReview } from '../lib/brief-review.js';
import { canonicalizeExecutiveActions, canonicalActions, compareEditionInputs, editorialIssues } from '../lib/brief-editorial.js';
import { selectSourcePassage } from '../lib/evidence-quality.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';
import { section, splitEntries, SECTIONS, parseBrief, judgmentCertainty } from '../lib/brief-schema.js';
import { receiptSources } from '../public/modules/briefing/brief-inputs.js';

const path = new URL('../briefs/brief-2026-09-05-02.md', import.meta.url);
const retained = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-05.json', import.meta.url)));
describe('actual saved September 5 edition replay — no provider or archive writes', () => {
  const { original, manifest } = retained;
  const review = JSON.parse(readFileSync(new URL('./fixtures/reviews/brief-2026-09-05-02.review.json', import.meta.url)));
  test('applies explicit corrections only to the exact original and preserves its bytes', () => {
    const result = applyBriefReview(original, review);
    expect(result.review.originalSha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(result.review.notes.length).toBeGreaterThan(25);
    expect(result.reviewedContent).toContain('five product families and five vendors');
    expect(result.reviewedContent).not.toContain('Nine distinct products across four vendors');
    expect(parseBrief(result.reviewedContent).stories).toHaveLength(5);
    expect(result.reviewedContent).toContain('AI ransomware autonomy claim — source follow-up');
    expect(createHash('sha256').update(original).digest('hex')).toBe(retained.provenance.originalSha256);
    if (existsSync(path)) expect(readFileSync(path, 'utf8')).toBe(original);
    expect(() => applyBriefReview(original + '\n', review)).toThrow(/does not match/);
    expect(savedBriefReview('brief-2026-09-05-02.md', original + '\n', new URL('./fixtures/reviews/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')).review.status).toBe('unavailable');
  });
  test('reselects the retained operational guidance and excludes the captured advertisement', () => {
    const sonic = manifest.selectedEvidence.find(item => item.source === 'Rapid7');
    const selected = selectSourcePassage({ title: sonic.title, articleBody: sonic.passage.text, description: sonic.groupMembers[0].passage });
    expect(selected.passage).toMatch(/Re-imaging|re-deploying/);
    expect(selected.passage).toContain('TOTP');
    expect(selected.passage).toContain('12.4.3-03526');
    const paper = manifest.selectedEvidence.find(item => /Attackers Exploit PaperCut/.test(item.title));
    const fallback = selectSourcePassage({ title: paper.title, articleBody: paper.passage.text, description: paper.groupMembers[0].passage });
    expect(fallback.passage).not.toContain('6-day SANS course');
    expect(fallback.excludedArticle.quality.status).toBe('contaminated');
  });
  test('detects actual repeated inputs and exposes every original grouped citation', () => {
    expect(retained.provenance.previousGroundingTextSha256).toBe(retained.provenance.currentGroundingTextSha256);
    // The bounded fixture records independently hashed, identical original
    // passage projections; retaining the duplicate text would add no evidence.
    expect(compareEditionInputs(manifest.grounding, manifest.grounding)).toMatchObject({ kind: 'unchanged-inputs', added: 0, changed: 0, removed: 0 });
    const sources = receiptSources(manifest);
    const additional = sources.filter(item => item.retainedMember);
    // This retained receipt has 75 original grounding records and 52 distinct
    // member passages that were not selected as those grounding passages.
    // Expose both, preserving exact evidence identity and original bindings.
    expect(sources.filter(item => !item.retainedMember)).toHaveLength(75);
    expect(additional).toHaveLength(52);
    expect(sources).toHaveLength(127);
    expect(new Set(sources.map(item => item.id)).size).toBe(sources.length);
    for (const original of manifest.grounding.sources) {
      const matches = sources.filter(item => item.id === original.id);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject(original);
      expect(matches[0].passageText).toBe(original.passage || original.evidenceText || '');
      expect(matches[0].judgments).toEqual((manifest.judgmentEvidence || []).filter(binding => binding.sourceIds.includes(original.id)).map(binding => binding.signal));
    }
    const members = manifest.selectedEvidence.flatMap(group => group.groupMembers || []);
    for (const extra of additional) {
      expect(members.some(member => member.source === extra.label && member.url === extra.url && member.passage === extra.passageText)).toBe(true);
      expect(manifest.grounding.sources.some(original => original.label === extra.label && original.url === extra.url && original.passage === extra.passageText)).toBe(false);
    }
    expect(sources.length).toBeGreaterThan(manifest.selectedEvidence.length);
    expect(sources.find(item => item.id === 'S20.1').judgments).toEqual([6]);
  });
  test('current strict review catches saved certainty, scale, applicability and scenario defects', () => {
    const issues = editorialIssues(original, splitEntries(section(original, SECTIONS.keyJudgments)), { records: manifest.grounding.sources, inputDelta: { kind: 'unchanged-inputs' } });
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['EVIDENCE_CONFIDENCE_REQUIRED', 'INDEPENDENCE_UNESTABLISHED', 'APPLICABILITY_ACTION_UNCONDITIONAL', 'FACT_SCALE_UNSUPPORTED', 'SCENARIO_TIMELINE_UNSUPPORTED', 'ACTION_MECHANISM_CONFLICT', 'CONTINUITY_WITHOUT_NEW_INPUT']));
  });
  test('the publication validator rejects the saved edition when replayed against its retained sources', () => {
    const headlines = manifest.selectedEvidence.map(item => ({ title: item.title, source: item.source, link: item.url, date: item.publishedAt, description: item.groupMembers?.[0]?.passage || item.passage?.text, articleBody: item.passage?.kind === 'article-opening' ? item.passage.text : '', sourceMembers: (item.groupMembers || []).map(member => ({ ...member, source: member.source, link: member.url, date: member.publishedAt, description: member.passage })) }));
    const grounding = buildGroundingManifest({ headlines });
    const result = validateBrief(original, '2026-09-05', { publication: true, editorialStandard: 2, groundingManifest: grounding, kevSet: new Set(manifest.verification?.selectedKevCves || []), kevTiming: manifest.verification?.kevTiming || {} });
    expect(hasTrustCriticalFailure(result.issues)).toBe(true);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['ENUMERATED_COUNT_MISMATCH', 'FACT_DURATION_UNSUPPORTED', 'JUDGMENT_EVIDENCE_WEAK']));
  });
});

test('canonical executive actions reuse the judgment record and qualitative confidence remains distinct', () => {
  const text = '## EXECUTIVE SUMMARY\n- **Required decisions:** Wrong date.\n## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Scope\n**Recommended actions:**\n- Operations — verify applicability — recommended target September 8, 2026.\n**Decision window:** 72 hours\n## WATCHLIST\n- Change';
  const result = canonicalizeExecutiveActions(text);
  expect(result).toContain('- **Required decisions:** Operations — verify applicability — recommended target September 8, 2026.');
  expect(canonicalActions(result)).toHaveLength(1);
  expect(judgmentCertainty('Moderate — one primary source')).toMatchObject({ label: 'Confidence', value: 'Moderate', basis: 'one primary source' });
  expect(judgmentCertainty('Likely (55-80%) — legacy forecast')).toMatchObject({ label: 'Likelihood' });
});

describe('concise executive decisions with complete canonical responses', () => {
  const summary = 'Infrastructure / Incident response — confirm deployment; pair the gateway fix with compromise review — recommended target September 8, 2026; Detection engineering — verify the browser rollout and assign unresolved devices — recommended target September 9, 2026.';
  const draft = decisions => `## EXECUTIVE SUMMARY
- **Required decisions:** ${decisions}
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Gateway response
**Recommended actions:**
- **Act now:** Infrastructure — verify deployment and apply the fix if affected; **Initiation:** begin inventory this shift; **Condition:** only affected deployments need the update; **Completion criterion:** record the installed fixed build — recommended target September 8, 2026.
- Incident response — review exposed deployments for compromise; **Dependencies:** retrieve vendor guidance and preserve logs; **Recovery:** if compromised, follow the vendor's recovery procedure — recommended target September 8, 2026.
**Decision window:** Current shift
### Signal 2 — [Horizon 1] Browser rollout
**Recommended actions:**
- Detection engineering — verify installed browser versions; **Completion criterion:** identify unresolved devices and accountable owners — recommended target September 9, 2026.
**Decision window:** 72 hours
## WATCHLIST
- Vendor revises its recovery guidance.
`;
  const summaryIssues = text => editorialIssues(text, []).filter(issue => issue.code.startsWith('ACTION_SUMMARY'));

  test('preserves an authored paired-response summary without copying the full task list over it', () => {
    const text = draft(summary);
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(summaryIssues(text)).toEqual([]);
    const actions = canonicalActions(text);
    expect(actions).toHaveLength(3);
    expect(actions[0].text).toContain('Initiation: begin inventory this shift');
    expect(actions[1].text).toContain("Recovery: if compromised, follow the vendor's recovery procedure");
    expect(section(text, SECTIONS.execSummary)).not.toContain('Completion criterion:');
  });

  test.each(['Infrastructure / Incident response', 'Infrastructure and Incident response', 'Infrastructure & Incident response'])('accepts explicitly grouped canonical owners: %s', owners => {
    const text = draft(summary.replace('Infrastructure / Incident response', owners));
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(summaryIssues(text)).toEqual([]);
  });

  test('does not invent an owner or silently overwrite its conflicting summary', () => {
    const text = draft(summary.replace('Infrastructure / Incident response', 'Human resources'));
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(summaryIssues(text)).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_OWNER_CONFLICT', severity: 'trust' })]);
  });

  test('the publication path retains summary ownership disagreements as editorial notes', () => {
    const text = draft(summary.replace('Infrastructure / Incident response', 'Human resources'));
    const checked = validateBrief(canonicalizeExecutiveActions(text), '2026-09-06', { publication: true, editorialStandard: 2 });
    const summaryFindings = checked.issues.filter(issue => issue.code === 'ACTION_SUMMARY_OWNER_CONFLICT');
    expect(summaryFindings).toHaveLength(1);
    expect(hasTrustCriticalFailure(summaryFindings)).toBe(false);
  });

  test('rejects a summary date absent from the complete response', () => {
    const text = draft(summary.replace('September 8, 2026', 'September 10, 2026'));
    expect(canonicalizeExecutiveActions(text)).toBe(text);
    expect(summaryIssues(text).map(issue => issue.code)).toContain('ACTION_SUMMARY_CONFLICT');
  });

  test('a known owner cannot borrow a different owner\'s otherwise valid target', () => {
    const text = draft(summary.replace('September 8, 2026', 'September 9, 2026'));
    expect(summaryIssues(text)).toEqual([expect.objectContaining({ code: 'ACTION_SUMMARY_CONFLICT', severity: 'trust' })]);
  });

  test('recognizes a complete function name containing and before trying grouped-owner syntax', () => {
    const text = draft(summary).replaceAll('Detection engineering', 'Identity and access management');
    expect(summaryIssues(text)).toEqual([]);
  });

  test('one well-formed decision cannot conceal an incomplete trailing decision', () => {
    const text = draft('Infrastructure — verify applicability — recommended target September 8, 2026; Follow up with somebody later.');
    const repaired = canonicalizeExecutiveActions(text);
    expect(repaired).not.toBe(text);
    expect(section(repaired, SECTIONS.execSummary)).toContain('Recovery:');
    expect(section(repaired, SECTIONS.execSummary)).not.toContain('Follow up with somebody later.');
    expect(canonicalActions(repaired)).toEqual(canonicalActions(text));
    expect(summaryIssues(repaired)).toEqual([]);
  });
});

test('new forecasts require an explicit proposition, resolution, probability and basis', () => {
  const valid = '**Confidence:** Moderate — one primary disclosure; deployment unknown.\n**Forecast:** Event: Vendor issues a fixed build | Resolve by: 2026-10-01 | Likelihood: 60% | Confirm when: Vendor advisory names the build | Basis: Published vendor remediation commitment.';
  expect(editorialIssues('', [valid])).toEqual([]);
  expect(editorialIssues('', [valid.replace('60%', '0%')]).map(issue => issue.code)).toContain('FORECAST_UNRESOLVABLE');
  expect(editorialIssues('', [valid.replace(/ \| Confirm when:.+/, '')]).map(issue => issue.code)).toContain('FORECAST_UNRESOLVABLE');
  const incident = '**Confidence:** Likely (55-80%) — confirmed report.';
  expect(editorialIssues('', [incident]).map(issue => issue.code)).toContain('EVIDENCE_CONFIDENCE_REQUIRED');
});

test('an unrelated independently sourced record cannot justify this judgment\'s confidence', () => {
  const entry = '**Confidence:** High — independent reporting confirms the event.\n**What happened:** [Publisher, 2026-09-05](https://example.test/report)';
  const records = [{ url: 'https://example.test/report', passage: 'Vendor statement repeated.' }, { url: 'https://example.test/other', passage: 'Independent observations of another event.', independence: { verified: true } }];
  expect(editorialIssues('', [entry], { records }).map(issue => issue.code)).toContain('INDEPENDENCE_UNESTABLISHED');
});

describe('source independence claim polarity', () => {
  const issues = basis => editorialIssues('', [`**Confidence:** Moderate — ${basis}\n**What happened:** [Publisher, 2026-09-05](https://example.test/report)`], {
    records: [{ url: 'https://example.test/report', passage: 'One reported observation.' }],
  }).filter(issue => issue.code === 'INDEPENDENCE_UNESTABLISHED');

  test('the September 7 corrective draft explicitly disclaims independent corroboration', () => {
    expect(issues('CCCS relays the vendor advisory and confirms the vulnerability details; BleepingComputer cites vulnerability-intelligence firm Previdian as the source of the exploitation claim — this is a single reported observation, not independently corroborated. This CVE pair is not in the captured CISA KEV catalog as of this briefing.')).toEqual([]);
  });

  test.each([
    'The observation is not independently confirmed.',
    'The observation has not yet been independently corroborated.',
    'The observation hasn’t been independently confirmed.',
    'The observation cannot be independently confirmed.',
    'The observation can’t yet be independently corroborated.',
    'The observation is neither independently confirmed nor independently corroborated.',
    'The observation is not independently confirmed or independently corroborated.',
    'No independent reporting is available.',
    'Without any independent researcher reporting, confidence remains limited.',
    'No retained evidence of independent reporting.',
    'Independent reporting is not yet available.',
    'Single report; **not** independently corroborated.',
    'Not independently confirmed and not independently corroborated.',
  ])('accepts a directly attached disclaimer: %s', basis => {
    expect(issues(basis)).toEqual([]);
  });

  test.each([
    'Independently corroborated.',
    'Not only independently corroborated, but independently confirmed.',
    'Deployment is not established; independently confirmed exploitation.',
    'Not independently corroborated initially, but independently confirmed now.',
    'Independently confirmed exploitation; attribution is not established.',
    'No independent reporting on attribution. Independent reporting confirms exploitation.',
    'Not independently corroborated; multiple independent outlets confirm the event.',
    'Not independently confirmed, or attribution is unresolved; independently corroborated exploitation.',
  ])('still blocks an unsupported affirmative claim: %s', basis => {
    expect(issues(basis)).toHaveLength(1);
  });
});

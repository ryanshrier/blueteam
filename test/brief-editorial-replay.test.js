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

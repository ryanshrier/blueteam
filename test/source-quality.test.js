import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { classifySourceEvidence, selectSourcePassage } from '../lib/evidence-quality.js';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildUserPrompt } from '../lib/prompts.js';
import { buildGenerationManifest } from '../lib/generation-manifest.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';
import { enumeratedCountIssues, assertionPrecisionIssues } from '../lib/claim-checks.js';

const source = { source: 'Vendor', title: 'Vendor patches CVE-2026-12345', description: 'Version 2.4 fixes CVE-2026-12345. The vendor confirmed active exploitation.', link: 'https://vendor.example/advisory', date: '2026-09-04', horizon: 1 };
const ad = 'What does your monitoring catch? A 6-day certification course rebuilds hybrid detection across endpoint and network. Enroll today.';
const retainedSources = JSON.parse(readFileSync(new URL('./fixtures/retained-source-quality-2026-09-06.json', import.meta.url), 'utf8')).records;
function draft(claim) {
  return `## BLUF
Check affected inventory.
## EXECUTIVE SUMMARY
- **Threat:** A patch is available.
- **Exposure:** Local deployment is unknown.
- **Required decisions:** Operations — check inventory — recommended target September 6, 2026.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Patch applicability needs review
**Assessment:** Verify the affected inventory before scheduling changes.
**Confidence:** Likely (55-80%) — vendor reporting.
**What happened:** ${claim} [Vendor, September 4, 2026](https://vendor.example/advisory)
**Defender impact:** Applicability needs a local check.
**Recommended actions:**
- Operations — check inventory — recommended target September 6, 2026.
**Decision window:** 72 hours
**The line:** Check the patch applicability.
## CONVERGENCE
No supported intersection was found in the supplied sources.
## WATCHLIST
- Affected versions change.
- A patch is updated.
- Mitigation is published.
- More exploitation is confirmed.
- An advisory is corrected.
`;
}
const audit = (claim, headline = source) => validateBrief(draft(claim), '2026-09-05', { publication: true, groundingManifest: buildGroundingManifest({ headlines: [headline] }) });

describe('substantive source evidence', () => {
  test('empty and repeated headings are title-only, including punctuation differences', () => {
    expect(classifySourceEvidence({ title: 'Vendor patch', passage: '' }).status).toBe('title-only');
    expect(classifySourceEvidence({ title: 'Vendor patch', passage: 'Vendor patch. Vendor patch.' }).status).toBe('title-only');
  });

  test.each(['Fixed in 2.4.', 'No exploitation observed.', 'A patch is available.', 'Rotated keys after compromise.', 'Sign in processing was patched.', 'CVE-2026-12345: CVSS 9.8.'])('accepts a concrete short advisory: %s', passage => {
    expect(classifySourceEvidence({ title: 'Vendor advisory', passage }).substantive).toBe(true);
  });

  test('classifies interstitials, unrelated fragments and off-topic advertising without trusting body length', () => {
    expect(classifySourceEvidence({ title: source.title, passage: ad }).status).toBe('contaminated');
    expect(classifySourceEvidence({ title: source.title, passage: 'Enable JavaScript to continue reading.' }).status).toBe('contaminated');
    expect(classifySourceEvidence({ title: source.title, passage: 'Another twist in the story' }).status).toBe('limited');
    expect(classifySourceEvidence({ title: 'A vendor introduces a new training course', passage: 'A 6-day course teaches network incident handling. Register today.' }).substantive).toBe(true);
  });

  test.each(['This page is not available.', 'We have updated our cookie preferences. Read more.'])('does not mistake page-state boilerplate for reporting: %s', articleBody => {
    expect(classifySourceEvidence({ title: source.title, passage: articleBody }).status).toBe('contaminated');
    expect(selectSourcePassage({ ...source, articleBody })).toMatchObject({ passage: source.description, kind: 'feed-excerpt' });
  });

  test('falls back to a usable original feed excerpt and retains rejected article provenance separately', () => {
    const headline = { ...source, articleBody: ad };
    const selection = selectSourcePassage(headline);
    expect(selection).toMatchObject({ passage: source.description, kind: 'feed-excerpt', quality: { substantive: true }, excludedArticle: { passage: ad, quality: { status: 'contaminated' } } });
    const grounding = buildGroundingManifest({ headlines: [headline] });
    const prompt = buildUserPrompt({ headlines: [headline], groundingManifest: grounding, config: {} });
    expect(prompt).toContain(source.description);
    expect(prompt).not.toContain(ad);
    const receipt = buildGenerationManifest({ run: { headlines: [headline] }, config: {}, editionContext: { date: '2026-09-05' }, groundingManifest: grounding });
    expect(receipt.selectedEvidence[0]).toMatchObject({ passage: { text: source.description, kind: 'feed-excerpt' }, excludedArticle: { text: ad } });
    expect(receipt.grounding.sources[0]).toMatchObject({ label: source.source, url: source.link, passage: source.description, quality: { substantive: true } });
  });

  test.each(retainedSources)('rejects the same retained course advert for $title and keeps source identity through the prompt and receipt', headline => {
    const before = JSON.stringify(headline);
    expect(classifySourceEvidence({ title: headline.title, passage: headline.articleBody }).status).toBe('contaminated');
    expect(selectSourcePassage(headline)).toMatchObject({ passage: headline.description, kind: 'feed-excerpt', quality: { substantive: true }, excludedArticle: { passage: headline.articleBody, quality: { status: 'contaminated' } } });
    const grounding = buildGroundingManifest({ headlines: [headline] });
    expect(grounding.members[0]).toMatchObject({ id: 'S1.1', label: headline.source, url: headline.link, passage: headline.description, passageKind: 'feed-excerpt', sourceRevisions: headline.sourceMembers[0].evidence });
    const prompt = buildUserPrompt({ headlines: [headline], groundingManifest: grounding, config: {} });
    expect(prompt).toContain(headline.description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(prompt).not.toContain(headline.articleBody);
    const receipt = buildGenerationManifest({ run: { headlines: [headline] }, config: {}, editionContext: { date: '2026-09-06' }, groundingManifest: grounding });
    expect(receipt.selectedEvidence[0]).toMatchObject({ passage: { text: headline.description, kind: 'feed-excerpt' }, excludedArticle: { text: headline.articleBody }, sourceRevisions: headline.evidence });
    expect(receipt.grounding.sources[0]).toMatchObject({ passage: headline.description, passageKind: 'feed-excerpt', sourceRevisions: headline.sourceMembers[0].evidence });
    expect(JSON.stringify(headline)).toBe(before);
  });

  test('recovers the exact retained primary feed member when the grouped description is unusable', () => {
    const original = retainedSources[1];
    const headline = { ...original, description: original.articleBody };
    expect(selectSourcePassage(headline)).toMatchObject({ passage: original.description, kind: 'feed-excerpt' });
    expect(buildGroundingManifest({ headlines: [headline] }).members[0]).toMatchObject({ passage: original.description, sourceRevisions: original.sourceMembers[0].evidence });
  });

  test('keeps recovered feed revision identity when an earlier tracking-URL record has a different revision', () => {
    const original = retainedSources[1];
    const earlier = { ...original.sourceMembers[0], link: `${original.link}?utm_source=earlier`, passage: original.articleBody,
      evidence: [{ ...original.evidence[0], revisionId: 'rev_earlier-unusable' }] };
    const headline = { ...original, description: original.articleBody, sourceMembers: [earlier, ...original.sourceMembers] };
    const grounding = buildGroundingManifest({ headlines: [headline] });
    expect(grounding.members[0]).toMatchObject({ passage: original.description, sourceRevisions: original.sourceMembers[0].evidence });
    expect(grounding.members[0].sourceRevisions[0].revisionId).not.toBe('rev_earlier-unusable');
    const receipt = buildGenerationManifest({ run: { headlines: [headline] }, config: {}, editionContext: { date: '2026-09-06' }, groundingManifest: grounding });
    expect(receipt.grounding.sources[0].sourceRevisions).toEqual(original.sourceMembers[0].evidence);
  });

  test.each(['publisher', 'article'])('never recovers another %s as the primary feed passage', difference => {
    const original = retainedSources[1];
    const member = { ...original.sourceMembers[0], ...(difference === 'publisher' ? { source: 'Another publisher' } : { link: `${original.link}?article=different` }) };
    const headline = { ...original, description: original.articleBody, sourceMembers: [member] };
    expect(selectSourcePassage(headline)).toMatchObject({ passage: '', kind: 'title-only', quality: { substantive: false } });
  });

  test('does not reject topical reporting that mentions training or contains a course promotion after real details', () => {
    const original = retainedSources[1];
    const articleBody = `${original.description} The advisory recommends training responders to review affected stores. ${original.articleBody}`;
    expect(classifySourceEvidence({ title: original.title, passage: articleBody }).substantive).toBe(true);
    expect(selectSourcePassage({ ...original, articleBody }).kind).toBe('article-excerpts');
    expect(classifySourceEvidence({ title: 'SANS announces incident-response training', passage: 'A 6-day SANS course teaches network incident handling. Register today.' }).substantive).toBe(true);
  });

  test('does not use a promotional body or a related member as primary publisher facts', () => {
    const headline = { ...source, description: ad, sourceMembers: [{ source: 'Other', title: 'CVE-2026-98765', description: 'CVE-2026-98765 has CVSS 9.8.', link: 'https://other.example/advisory' }] };
    const grounding = buildGroundingManifest({ headlines: [headline] });
    expect(grounding.sources[0].quality.substantive).toBe(false);
    expect(grounding.sources[0].evidenceText).not.toContain(ad);
    expect(grounding.sources[0].cves.has('CVE-2026-98765')).toBe(false);
    expect(audit('CVE-2026-12345 has a patch.', headline).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'JUDGMENT_EVIDENCE_WEAK' })]));
  });

  test('requires substantive cited evidence for a new judgment and preserves legacy reading', () => {
    expect(hasTrustCriticalFailure(audit('CVE-2026-12345 has a patch.').issues)).toBe(false);
    const weak = { ...source, description: '' };
    expect(audit('CVE-2026-12345 has a patch.', weak).issues.map(value => value.code)).toContain('JUDGMENT_EVIDENCE_WEAK');
    expect(validateBrief(draft('CVE-2026-12345 has a patch.'), null, { headlines: [weak] }).issues.map(value => value.code)).not.toContain('JUDGMENT_EVIDENCE_WEAK');
  });

  test('a substantive co-citation does not hide a weak source or let its score support a claim', () => {
    const weak = { ...source, source: 'Unusable', title: 'A campaign report', description: '', link: 'https://weak.example/report', articleBody: 'Advertisement CVSS 9.7; subscribe today.' };
    const text = draft('CVE-2026-12345 has CVSS 9.7.').replace('**Defender impact:**', '[Unusable, September 4, 2026](https://weak.example/report)\n**Defender impact:**');
    const result = validateBrief(text, '2026-09-05', { publication: true, groundingManifest: buildGroundingManifest({ headlines: [source, weak] }) });
    expect(result.issues.map(value => value.code)).toEqual(expect.arrayContaining(['CITED_SOURCE_LIMITED', 'CVSS_UNSUPPORTED']));
  });
});

describe('bounded factual precision and explicit counts', () => {
  test('blocks unsupported retrospective intervals but accepts equivalent sourced units', () => {
    expect(assertionPrecisionIssues('Attackers exploited the issue within roughly 48 hours of disclosure.', ['The vendor disclosed the issue.'], 1).map(value => value.code)).toEqual(['FACT_DURATION_UNSUPPORTED']);
    expect(assertionPrecisionIssues('Attackers exploited the issue within 48 hours.', ['Exploitation began within two days.'], 1)).toEqual([]);
    expect(assertionPrecisionIssues('If exposure continues for 48 hours, risk may increase.', [], 1)).toEqual([]);
    expect(assertionPrecisionIssues('Over the next 72 hours, validate the inventory before patching.', [], 1)).toEqual([]);
    expect(assertionPrecisionIssues('Exploitation within 48 hours could overwhelm review queues.', [], 1)).toEqual([]);
    expect(assertionPrecisionIssues('The attack completed in 48 hours and could recur.', [], 1).map(value => value.code)).toEqual(['FACT_DURATION_UNSUPPORTED']);
    expect(assertionPrecisionIssues('If attacks recur, review logs; the previous attack completed in 48 hours.', [], 1).map(value => value.code)).toEqual(['FACT_DURATION_UNSUPPORTED']);
    expect(assertionPrecisionIssues('The attackers may have exploited the issue within 48 hours.', [], 1).map(value => value.code)).toEqual(['FACT_DURATION_UNSUPPORTED']);
  });

  test('blocks an unsupported incident ranking but accepts an explicitly sourced ranking', () => {
    const claim = 'These are the most repeatedly breached appliances this year.';
    expect(assertionPrecisionIssues(claim, ['Five appliance vulnerabilities were exploited.'], 1).map(value => value.code)).toEqual(['FACT_COMPARISON_UNSUPPORTED']);
    expect(assertionPrecisionIssues(claim, ['The study calls these the most repeatedly breached appliances.'], 1)).toEqual([]);
  });

  test('checks vendor and CVE closed enumerations while leaving nonexhaustive examples alone', () => {
    expect(enumeratedCountIssues('Four vendors (Acme, Nimbus, Cedar, Delta, Elm) are affected.').map(value => value.code)).toEqual(['ENUMERATED_COUNT_MISMATCH']);
    expect(enumeratedCountIssues('Five vendors (Acme, Nimbus, Cedar, Delta, Elm) are affected.')).toEqual([]);
    expect(enumeratedCountIssues("Three of this week's KEV entries — CVE-2026-10001, CVE-2026-10002, CVE-2026-10003, and CVE-2026-10004 — have updates.")).toHaveLength(1);
    expect(enumeratedCountIssues('Five vendors (including Acme, Nimbus) are affected.')).toEqual([]);
    expect(enumeratedCountIssues('Two of the listed vendors (Acme, Nimbus, Cedar) have released patches.')).toEqual([]);
    expect(enumeratedCountIssues('Three vendors (Acme, Nimbus, Marks and Spencer) issued fixes.')).toEqual([]);
    expect(enumeratedCountIssues('Three vendors (Acme, Nimbus, and Cedar) issued fixes.')).toEqual([]);
  });

  test('validates assertion fields but leaves recommended action durations outside evidence matching', () => {
    expect(audit('The issue was exploited within 48 hours.').issues.map(value => value.code)).toContain('FACT_DURATION_UNSUPPORTED');
    const text = draft('CVE-2026-12345 has a patch.').replace('check inventory — recommended', 'check 48 hours of logs — recommended');
    expect(validateBrief(text, '2026-09-05', { publication: true, groundingManifest: buildGroundingManifest({ headlines: [source] }) }).issues.map(value => value.code)).not.toContain('FACT_DURATION_UNSUPPORTED');
  });
});

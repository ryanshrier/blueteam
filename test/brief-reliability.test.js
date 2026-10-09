import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { wholeDocumentReliability, expandBriefCves } from '../lib/brief-reliability.js';
import { validateBrief } from '../lib/validation.js';
import { validationSourceFromManifest } from '../lib/brief-drafts.js';
import { sha256 } from '../lib/generation-manifest.js';
import { buildGroundingManifest } from '../lib/grounding.js';

const replay = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-06.json', import.meta.url),'utf8'));
const secondOpening = JSON.parse(readFileSync(new URL('./fixtures/retained-briefing-2026-09-06-02-opening.json', import.meta.url),'utf8'));
const audit = content => validateBrief(content, '2026-09-06', validationSourceFromManifest(replay.manifest));

describe('one citation contract for judgment and whole-document metric checks', () => {
  const id = 'CVE-2026-1234';
  const source = { source: 'Vendor', title: `${id} gateway advisory`, date: '2026-09-04',
    description: `${id} has CVSS v3.1 score 9.8. The gateway update addresses the affected access control.`,
    link: 'https://vendor.example/advisory?id=123&utm_source=feed' };
  const check = (citation, headline = source, assessment = `${id} has CVSS v3.1 score 9.8.`) => {
    const text = `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Verify affected gateways\n**Assessment:** ${assessment}\n**What happened:** ${id} affects the gateway. ${citation}\n**Decision window:** 72 hours\n`;
    return validateBrief(text, '2026-09-05', { publication: true,
      groundingManifest: buildGroundingManifest({ headlines: [headline] }), kevSet: new Set() }).issues;
  };
  const metricFindings = issues => issues.filter(issue => issue.code === 'FACT_CVSS_UNSUPPORTED');

  test('accepts a complete captured citation with HTML-escaped query delimiters', () => {
    const issues = check('[Vendor, September 4, 2026](https://vendor.example/advisory?id=123&amp;utm_source=feed)');
    expect(metricFindings(issues)).toEqual([]);
    expect(issues.map(issue => issue.code)).not.toContain('CITATION_IDENTITY_INVALID');
  });

  test('accepts the explicit URL-unavailable fallback for an otherwise substantive source', () => {
    expect(metricFindings(check('[Vendor, September 4, 2026]', { ...source, link: '' }))).toEqual([]);
  });

  test.each([
    '[Other publisher, September 4, 2026](https://vendor.example/advisory?id=123&utm_source=feed)',
    '[Vendor, September 3, 2026](https://vendor.example/advisory?id=123&utm_source=feed)',
    '[Vendor, September 4, 2026](https://vendor.example/advisory?id=999)',
    '[Vendor, September 4, 2026](https://vendor.example/advisory?id=123)',
    '`[Vendor, September 4, 2026](https://vendor.example/advisory?id=123&utm_source=feed)`',
    '[Vendor, September 4, 2026]',
  ])('does not treat malformed or different-source citations as metric evidence: %s', citation => {
    expect(metricFindings(check(citation))).toHaveLength(1);
  });

  test('a canonical citation still cannot establish a different score', () => {
    expect(metricFindings(check('[Vendor, September 4, 2026](https://vendor.example/advisory?id=123&utm_source=feed)', source,
      `${id} has CVSS v3.1 score 9.9.`))).toHaveLength(1);
  });
});

test('source-count disclaimers do not become independence claims or hide later claims', () => {
  const check = text => wholeDocumentReliability(text).issues.filter(issue => issue.code === 'SOURCE_INDEPENDENCE_UNESTABLISHED');
  expect(check('No independent sources are available; publisher count alone is insufficient.')).toEqual([]);
  expect(check('Independent publishers are not established in the retained provenance.')).toEqual([]);
  expect(check('No independent sources on attribution; independent publishers confirm exploitation.')).toHaveLength(1);
  expect(check('Not only independent outlets but primary observations confirm exploitation.')).toHaveLength(1);
});

describe('whole-document reliability against actual retained September 6 inputs', () => {
  test('detects the known material contradictions outside What happened with locations', () => {
    expect(sha256(replay.content)).toBe(replay.provenance.originalSha256);
    const result = audit(replay.content);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'FACT_CVE_COUNT_MISMATCH', 'FACT_CVE_WINDOW_MISMATCH', 'EVIDENCE_ABSENCE_CONTRADICTED',
      'FACT_EVENT_TIMELINE_UNSUPPORTED', 'ACTION_DEPENDENCY_CONFLICT', 'ACTION_RECOVERY_INCOMPLETE',
      'ACTION_LOOKBACK_BASIS_REQUIRED', 'SUPPORTING_SECTION_PROVENANCE_REQUIRED', 'SOURCE_INDEPENDENCE_UNESTABLISHED',
      'STATISTICAL_SCOPE_UNESTABLISHED',
    ]));
    expect(result.issues.find(issue => issue.code === 'FACT_CVE_COUNT_MISMATCH').location.line).toBe(11);
    expect(result.issues.find(issue => issue.code === 'FACT_CVE_WINDOW_MISMATCH').message).toContain('8 of the 10');
    expect(result.issues.find(issue => issue.code === 'EVIDENCE_ABSENCE_CONTRADICTED').sourceIds).toContain('NVD-CVE-2026-83549');
    expect(result.coverage).toMatchObject({ editorialReviewStatus:'not-reviewed', materialReviewRequired:true });
    expect(result.coverage.notEstablished).toContain('arbitrary natural-language entailment');
  });

  test('correct full identities/count and an explicit bounded date window do not inherit the count error', () => {
    const corrected = replay.content.replace('Nine separate CVEs', 'Ten separate CVEs').replace('in the past five days', 'in the inclusive August 31–September 6 window');
    expect(audit(corrected).issues.map(issue => issue.code)).not.toContain('FACT_CVE_COUNT_MISMATCH');
    expect(audit(corrected).issues.map(issue => issue.code)).not.toContain('FACT_CVE_WINDOW_MISMATCH');
  });

  test('absence checking uses the complete captured inventory rather than previous cited-only failure', () => {
    const result = audit(replay.content.replace('no CVSS supported in retained passages for this record', 'CVSS 7.8 [NVD, date unavailable](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-83549)'));
    expect(result.issues.map(issue => issue.code)).not.toContain('EVIDENCE_ABSENCE_CONTRADICTED');
  });

  test('a summary cannot introduce a different score than its entity-bound cited fact', () => {
    const wrong = replay.content.replace('- **Exposure:**', '- **Exposure:** CVE-2026-83549 CVSS 9.9.');
    expect(audit(wrong).issues.map(issue=>issue.code)).toContain('FACT_CVSS_UNSUPPORTED');
    const supported = replay.content.replace('- **Exposure:**', '- **Exposure:** CVE-2026-82329 CVSS 9.8.');
    expect(audit(supported).issues.map(issue=>issue.code)).not.toContain('FACT_CVSS_UNSUPPORTED');
    const misattributed = replay.content.replace('- **Exposure:**', '- **Exposure:** CVE-2026-9586 CVSS 9.3 per NVD.');
    expect(audit(misattributed).issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'FACT_CVSS_UNSUPPORTED',message:expect.stringContaining('attributed to NVD')})]));
  });

  test('full identifier expansion does not borrow a year for unrelated numbers', () => {
    expect(expandBriefCves('CVE-2026-83548/83549 and version 12.4/12.5')).toBe('CVE-2026-83548 / CVE-2026-83549 and version 12.4/12.5');
  });

  test('open enumerations and prospective time windows are not declared factual mismatches', () => {
    const result = wholeDocumentReliability('Nine CVEs (including CVE-2026-83548 and CVE-2026-83549).\nIf exploitation occurs within a day of disclosure, reassess.', {expectedDate:'2026-09-06'});
    expect(result.issues).toEqual([]);
  });

  test('the actual second edition counts all product-labelled groups rather than only the first pair', () => {
    const check = text => wholeDocumentReliability(text, { expectedDate:'2026-09-06' }).issues.filter(issue => issue.code === 'FACT_CVE_COUNT_MISMATCH');
    expect(check(secondOpening.opening)).toEqual([]);
    expect(check(secondOpening.opening.replace('Seven actively', 'Nine actively'))).toEqual([
      expect.objectContaining({ message:'The closed list states 9 CVEs but names 7 distinct full CVE identities.' }),
    ]);
    // Full slash-separated IDs were used in the first attempt's retained
    // finding excerpt. They still belong to the complete product list.
    const slashes = secondOpening.opening.replace('83548, CVE-2026-83549', '83548/CVE-2026-83549').replace('81578, CVE-2026-82078', '81578/CVE-2026-82078');
    expect(check(slashes)).toEqual([]);
    expect(check(slashes.replace('Seven actively', 'Nine actively'))[0].message).toContain('7 distinct full CVE identities');
  });

  test('closed list scope stops before separate sentences, clauses and paragraphs', () => {
    const pair = 'Three CVEs — SonicWall (CVE-2026-83548, CVE-2026-83549)';
    for (const boundary of ['. Separately, Chrome', '; separately, Chrome', ' — separately, Chrome', '\nChrome']) {
      const result = wholeDocumentReliability(`${pair}${boundary} (CVE-2026-85046).`);
      expect(result.issues).toEqual([expect.objectContaining({ code:'FACT_CVE_COUNT_MISMATCH', message:expect.stringContaining('2 distinct full CVE identities') })]);
    }
    expect(wholeDocumentReliability('Three CVEs, including SonicWall (CVE-2026-83548, CVE-2026-83549), and Chrome (CVE-2026-85046).').issues).toEqual([]);
    expect(wholeDocumentReliability('Nine CVEs. SonicWall (CVE-2026-83548, CVE-2026-83549).').issues).toEqual([]);
  });

  test('an explicit artifact-acquisition action and explained lookback do not trigger omission findings', () => {
    const result = wholeDocumentReliability('- Detection engineering — retrieve and verify the vendor IOC set — recommended target September 8, 2026.\n- Incident response — audit tokens since 2026-08-28; proposed lookback basis: available retention only, extend to earliest exposure where possible — recommended target September 8, 2026.');
    expect(result.issues).toEqual([]);
  });
});

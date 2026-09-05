import { describe, expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { buildUserPrompt } from '../lib/prompts.js';
import { validateBrief, hasHardFail, hasTrustCriticalFailure } from '../lib/validation.js';
import { parseJudgments } from '../lib/brief-schema.js';

const vendor = { source: 'Vendor', title: 'Patch CVE-2026-12345', description: 'Version 1.0 fixes CVE-2026-12345. CVSS 5.0.', cveData: 'CVE-2026-12345: CVSS 5.0', link: 'https://vendor.example/advisory', date: '2026-09-04', horizon: 1 };
const other = { source: 'Other', title: 'Password guidance CVE-2026-54321', description: 'Version 2.0 addresses CVE-2026-54321. CVSS 9.8.', cveData: 'CVE-2026-54321: CVSS 9.8', link: 'https://other.example/passwords', date: '2026-09-01', horizon: 2 };
const citation = '[Vendor, September 4, 2026](https://vendor.example/advisory)';
const draft = `# THREAT LANDSCAPE BRIEFING
## BLUF
Check applicability before changing the affected systems.
## EXECUTIVE SUMMARY
- **Threat:** A vendor released a patch.
- **Exposure:** Local deployment is unknown.
- **Required decisions:** Operations — check applicability — recommended target September 6, 2026.
## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Patch applicability needs review
**Assessment:** Unpatched systems may remain exposed.
**Confidence:** Likely (55-80%) — vendor advisory.
**What happened:** Vendor fixed CVE-2026-12345 in version 1.0; CVSS 5.0. ${citation}
**Defender impact:** Inventory determines whether remediation is needed.
**Recommended actions:**
- Operations — check applicability — recommended target September 6, 2026.
**Decision window:** 72 hours
**The line:** Check the inventory before scheduling the patch.
## CONVERGENCE
No supported intersection was found in the supplied reporting.
## WATCHLIST
- Vendor changes the affected range.
- Vendor changes the patch.
- New exploitation is reported.
- New mitigations are published.
- Catalog status changes.
`;
const audit = (text = draft, headlines = [vendor, other]) => validateBrief(text, '2026-09-05', {
  publication: true, groundingManifest: buildGroundingManifest({ headlines }), kevSet: new Set(['CVE-2026-54321']),
});

describe('new publication integrity', () => {
  test('a complete, attributable decision product is publishable', () => {
    const result = audit();
    expect(hasHardFail(result.issues)).toBe(false);
    expect(hasTrustCriticalFailure(result.issues)).toBe(false);
  });

  test.each([
    ['citation omitted', draft.replace(citation, ''), 'JUDGMENT_CITATION_MISSING'],
    ['wrong publisher URL', draft.replace('](https://vendor.example/advisory)', '](https://other.example/passwords)'), 'CITATION_IDENTITY_INVALID'],
    ['wrong publication date', draft.replace('September 4, 2026]', 'September 1, 2026]'), 'CITATION_IDENTITY_INVALID'],
    ['source identity invented', draft.replace('[Vendor,', '[Imaginary source,'), 'CITATION_IDENTITY_INVALID'],
    ['live URL removed', draft.replace(citation, '[Vendor, September 4, 2026]'), 'CITATION_IDENTITY_INVALID'],
    ['globally present unrelated CVE', draft.replace('fixed CVE-2026-12345', 'fixed CVE-2026-54321'), 'CVE_CITATION_MISMATCH'],
    ['invented score', draft.replace('CVSS 5.0.', 'CVSS 10.0.'), 'CVSS_UNSUPPORTED'],
    ['invented version', draft.replace('version 1.0;', 'version 99.0;'), 'VERSION_UNSUPPORTED'],
  ])('blocks %s', (_name, text, code) => {
    const result = audit(text);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code, severity: 'trust' })]));
    expect(hasTrustCriticalFailure(result.issues)).toBe(true);
  });

  test.each(['Assessment', 'What happened', 'Defender impact', 'Confidence', 'The line'])('blocks an empty %s field', label => {
    const text = draft.replace(new RegExp('\\*\\*' + label + ':\\*\\*[^\\n]*'), `**${label}:**`);
    expect(audit(text).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'JUDGMENT_FIELD_MISSING', severity: 'structure' })]));
  });

  test('blocks omitted actions, malformed windows and incomplete executive decisions', () => {
    const text = draft.replace('- Operations — check applicability — recommended target September 6, 2026.', '')
      .replace('**Decision window:** 72 hours', '**Decision window:** Soon')
      .replace('- **Exposure:** Local deployment is unknown.', '');
    expect(audit(text).issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['JUDGMENT_ACTION_INVALID', 'DECISION_WINDOW_INVALID', 'EXECUTIVE_DECISION_MISSING']));
  });

  test('legacy reading does not acquire new publication requirements', () => {
    const result = validateBrief(draft.replace(citation, ''), null, { headlines: [vendor] });
    expect(result.issues.map(issue => issue.code)).not.toContain('JUDGMENT_CITATION_MISSING');
  });

  test('cannot swap scores between two CVEs even when both sources are cited', () => {
    const text = draft.replace('Vendor fixed CVE-2026-12345 in version 1.0; CVSS 5.0.', 'CVE-2026-12345: CVSS 9.8; CVE-2026-54321: CVSS 5.0.')
      .replace(citation, `${citation} [Other, September 1, 2026](https://other.example/passwords)`);
    expect(audit(text).issues.filter(issue => issue.code === 'CVE_CVSS_MISMATCH')).toHaveLength(2);
  });

  test('records immutable source IDs supporting each judgment', () => {
    expect(audit().judgmentEvidence).toEqual([{ signal: 1, sourceIds: ['S1.1'] }]);
  });

  test('a source explicitly lacking its URL can use an accurate plain citation', () => {
    const result = audit(draft.replace(citation, '[Vendor, September 4, 2026]'), [{ ...vendor, link: '' }]);
    expect(hasTrustCriticalFailure(result.issues)).toBe(false);
  });
});

describe('grouped passage attribution and saved badges', () => {
  test('does not expose a stale cached article as current source evidence', () => {
    const h = { ...vendor, articleBody: 'Stale article claims CVE-2026-99999.', articleStale: true };
    const grounding = buildGroundingManifest({ headlines: [h] });
    const prompt = buildUserPrompt({ headlines: [h], groundingManifest: grounding, config: {} });
    expect(grounding.cves.has('CVE-2026-99999')).toBe(false);
    expect(prompt).not.toContain(h.articleBody);
    expect(prompt).toContain(vendor.description);
    expect(prompt).toContain('stale cached body excluded');
  });

  test('keeps contradictory member claims under their original publisher, URL and date', () => {
    const rumor = { ...other, title: vendor.title, description: '9,000 organizations were compromised; the patch is ineffective.' };
    const headline = { ...vendor, sourceMembers: [vendor, rumor], corroboration: 2 };
    const grounding = buildGroundingManifest({ headlines: [headline] });
    const prompt = buildUserPrompt({ headlines: [headline], groundingManifest: grounding, config: {}, editionContext: { date: '2026-09-05' } });
    const vendorBlock = prompt.slice(prompt.indexOf('Evidence ID: S1.1'), prompt.indexOf('Evidence ID: S1.2'));
    const rumorBlock = prompt.slice(prompt.indexOf('Evidence ID: S1.2'));
    expect(vendorBlock).toContain(vendor.description);
    expect(vendorBlock).not.toContain('9,000');
    expect(rumorBlock).toContain(other.link);
    expect(rumorBlock).toContain(other.date);
    expect(rumorBlock).toContain('9,000');
    expect(grounding.members[1]).toMatchObject({ id: 'S1.2', label: 'Other', url: other.link });
    expect(grounding.members[1].evidenceText).not.toContain('CVSS 5.0');
  });

  test.each([
    ['CVE-2026-12345 has a patch; CISA KEV lists CVE-2026-54321.', 'CVE-2026-54321'],
    ['CVE-2026-12345 is outside the KEV catalog.', ''],
    ['CVE-2026-12345 remains absent from KEV.', ''],
    ['Check whether CVE-2026-54321 is in KEV.', ''],
    ['Verify CISA KEV lists CVE-2026-54321.', ''],
    ['CISA KEV lists CVE-2026-12345.', ''],
  ])('only badges an affirmative, verified clause: %s', (claim, expected) => {
    const md = draft.replace('**Assessment:** Unpatched systems may remain exposed.', `**Assessment:** ${claim}`);
    expect(parseJudgments(md, { verifiedKevCves: ['CVE-2026-54321'] })[0].kevCVE).toBe(expected);
  });

  test('official badges abstain without saved verification and citations use saved links', () => {
    const md = draft.replace('**Assessment:** Unpatched systems may remain exposed.', '**Assessment:** CISA KEV lists CVE-2026-54321.');
    expect(parseJudgments(md)[0]).toMatchObject({ isKEV: false, kevCVE: '', citations: [{ label: 'Vendor, September 4, 2026', url: vendor.link }] });
  });
});

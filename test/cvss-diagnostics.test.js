import { describe, expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { publicationDecision, validateBrief } from '../lib/validation.js';

const first = 'CVE-2026-11111', second = 'CVE-2026-22222';
const grounding = buildGroundingManifest({ headlines: [
  { source: 'Vendor', title: 'Two gateway fixes', date: '2026-10-09', link: 'https://vendor.example/fixes',
    description: `${first}: CVSS v3.1 5.0. ${second}: CVSS v3.1 9.8. Apply the corresponding gateway fixes.` },
] });
const citation = '[Vendor, October 9, 2026](https://vendor.example/fixes)';
const validate = text => validateBrief(text, '2026-10-09', {
  publication: true, groundingManifest: grounding, kevSet: new Set(),
});

describe('actionable CVSS publication findings', () => {
  test('an ambiguous score points to the raw metric line and its captured source', () => {
    const text = `## KEY JUDGMENTS
### Signal 1 — [Horizon 1] First gateway
**What happened:** ${first}: CVSS v3.1 5.0. ${citation}

### Signal 2 — [Horizon 1] Both gateway fixes
**Assessment:** Check deployed gateway builds.
**What happened:** ${first} and ${second} affect the gateway.
The pair has CVSS v3.1 9.8. ${citation}
**Decision window:** 72 hours
`;
    const result = validate(text);
    const issue = result.issues.find(item => item.code === 'CVE_CVSS_AMBIGUOUS');
    expect(issue).toMatchObject({ severity: 'trust', sourceIds: ['S1.1'],
      location: { scope: 'paragraph', line: 8 } });
    expect(text.split('\n')[issue.location.line - 1]).toContain('The pair has CVSS');
    expect(issue.location.excerpt).toContain('CVSS v3.1 9.8');
    expect(issue.message).toContain('Signal 2');
    expect(issue.message).toContain('captured evidence');
    expect(issue.message).toContain('or omit the score');
    expect(publicationDecision(result).blockers).toContainEqual(issue);
  });

  test('long lines retain the offending metric in the bounded repair excerpt', () => {
    const text = `## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Gateway
**What happened:** ${'Review the applicable installation. '.repeat(15)} ${first}: CVSS v4.0 9.9 (provisional). ${citation}
`;
    const issues = validate(text).issues.filter(item => ['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED'].includes(item.code));
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.location.line).toBe(3);
      expect(issue.location.excerpt.length).toBeLessThanOrEqual(300);
      expect(issue.location.excerpt).toContain('CVSS v4.0 9.9');
      expect(issue.message).toContain('v4.0 9.9 (provisional)');
      expect(issue.sourceIds).toEqual(['S1.1']);
    }
  });

  test('CRLF and inline Markdown do not move a finding to a heading or another score', () => {
    const text = `## KEY JUDGMENTS\r\n### Signal 1 — [Horizon 1] Gateway\r\n**What happened:** ${first}: **CVSS v3.1 5.0**.\r\n${second}: **CVSS v3.1 9.9**. ${citation}\r\n`;
    const issue = validate(text).issues.find(item => item.code === 'CVE_CVSS_MISMATCH');
    expect(issue.location.line).toBe(4);
    expect(issue.location.excerpt).toContain(`${second}: CVSS v3.1 9.9`);
    expect(text.split('\n')[issue.location.line - 1]).toContain(second);
  });

  test('a soft-wrapped metric selects its actual raw line rather than the paragraph start', () => {
    const text = `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Gateway\n**What happened:** ${first} (gateway issue;\nCVSS v3.1 9.9) and ${second} (console issue; CVSS v3.1 9.8). ${citation}\n`;
    const issue = validate(text).issues.find(item => item.code === 'CVE_CVSS_MISMATCH');
    expect(issue.location.line).toBe(4);
    expect(issue.location.excerpt).toContain('CVSS v3.1 9.9');
    expect(issue.message).toContain(first);
  });
});

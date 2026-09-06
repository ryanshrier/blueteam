import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief, hasTrustCriticalFailure } from '../lib/validation.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/retained-ixon-2026-09-06.json', import.meta.url), 'utf8'));
const ixon = fixture.headline;
const citation = `[CISA Advisories, September 3, 2026](${ixon.link})`;
const header = 'CVSS Version Base Score Base Severity Vector String';
const vector3 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H';
const vector4 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H';
const row3 = `3.1 9.6 CRITICAL ${vector3}`;
const row4 = `4.0 9.4 CRITICAL ${vector4}`;

function audit(claim, headlines = [ixon], citations = citation) {
  return validateBrief(`## KEY JUDGMENTS
### Signal 1 — [Horizon 1] Verify IXON client exposure
**What happened:** ${claim} ${citations}
**Decision window:** 72 hours
`, '2026-09-06', { publication: true, groundingManifest: buildGroundingManifest({ headlines }), kevSet: new Set() });
}

function metricsSource(metrics) {
  return { ...ixon, description: `CVE-2026-75925 allows elevated command execution through injected configuration. Update affected clients. Metrics ${metrics}` };
}

const codes = result => result.issues.map(issue => issue.code);

describe('retained CISA metric tables at the publication boundary', () => {
  test('replays the actual retained public passage without substituting NVD enrichment', () => {
    expect(createHash('sha256').update(ixon.description).digest('hex')).toBe(fixture.provenance.passageSha256);
    const grounding = buildGroundingManifest({ headlines: [ixon] });
    expect(grounding.members).toHaveLength(1);
    expect(grounding.members[0].quality.substantive).toBe(true);
    expect([...grounding.members[0].cves]).toEqual(['CVE-2026-75925']);
    expect(grounding.members[0].evidenceText).toContain(`${header} ${row3} ${row4}`);
    const result = audit('CVE-2026-75925 CVSS 9.6.');
    expect(hasTrustCriticalFailure(result.issues)).toBe(false);
    expect(result.judgmentEvidence).toEqual([{ signal: 1, sourceIds: ['S1.1'] }]);
  });

  test.each(['CVSS 9.6', 'CVSS v3.1 score 9.6', 'CVSS 3.1 base score 9.6', 'CVSS v4.0 score 9.4'])(
    'accepts the matching retained base metric: %s', score => {
      expect(hasTrustCriticalFailure(audit(`CVE-2026-75925 ${score}.`).issues)).toBe(false);
    },
  );

  test.each(['CVSS 9.5', 'CVSS v4.0 score 9.6', 'CVSS v3.1 score 9.4', 'CVSS 3.1', 'CVSS 4.0'])(
    'rejects an absent or mismatched score: %s', score => {
      expect(codes(audit(`CVE-2026-75925 ${score}.`))).toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']));
    },
  );

  test('a current real table still requires its exact supplied citation', () => {
    expect(codes(audit('CVE-2026-75925 CVSS 9.6.', [ixon], '')))
      .toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']));
    expect(codes(audit('CVE-2026-75925 CVSS 9.6.', [ixon], citation.replace('September 3', 'September 4'))))
      .toEqual(expect.arrayContaining(['CITATION_IDENTITY_INVALID', 'CVSS_UNSUPPORTED']));
  });

  test('metric rows cannot be distributed among multiple CVEs in one source', () => {
    const source = { ...ixon, description: `${ixon.description} Also references CVE-2026-99999.` };
    expect(codes(audit('CVE-2026-75925 CVSS 9.6.', [source]))).toContain('CVE_CVSS_MISMATCH');
    expect(codes(audit('CVE-2026-99999 CVSS 9.4.', [source]))).toContain('CVE_CVSS_MISMATCH');
  });

  test('a different cited CVE cannot borrow IXON table scores', () => {
    const other = { source: 'Other vendor', title: 'CVE-2026-99999', description: 'CVE-2026-99999 has CVSS 4.3. An update fixes its authentication issue.', date: '2026-09-03', link: 'https://vendor.example/other', horizon: 1 };
    const both = `${citation} [Other vendor, September 3, 2026](${other.link})`;
    expect(codes(audit('CVE-2026-99999 CVSS 9.6.', [ixon, other], both))).toContain('CVE_CVSS_MISMATCH');
    expect(codes(audit('CVE-2026-75925 CVSS 4.3.', [ixon, other], both))).toContain('CVE_CVSS_MISMATCH');
  });

  test.each([
    ['no header', row3],
    ['header without a vector', `${header} 3.1 9.6 CRITICAL`],
    ['wrong table header', `CVSS Version Guess Severity Vector String ${row3}`],
    ['row/vector version mismatch', `${header} ${row3.replace('CRITICAL CVSS:3.1', 'CRITICAL CVSS:4.0')}`],
    ['missing base metric', `${header} ${row3.replace('/A:H', '')}`],
    ['invalid base metric', `${header} ${row3.replace('/AV:N', '/AV:X')}`],
    ['duplicate metric', `${header} ${row3}/AV:N`],
    ['out-of-range score', `${header} ${row3.replace('9.6', '19.6')}`],
    ['header followed by prose before a row', `${header} Unrelated text says ${row3}`],
  ])('does not accept malformed or unbound metrics: %s', (_label, metrics) => {
    expect(codes(audit('CVE-2026-75925 CVSS 9.6.', [metricsSource(metrics)])))
      .toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']));
  });

  test.each([vector3, vector4])('a bare vector version is not a base score: %s', vector => {
    const score = vector.includes('3.1') ? '3.1' : '4.0';
    expect(codes(audit(`CVE-2026-75925 CVSS ${score}.`, [metricsSource(vector)])))
      .toEqual(expect.arrayContaining(['CVE_CVSS_MISMATCH', 'CVSS_UNSUPPORTED']));
    // A faithfully repeated vector does not itself assert its version as a score.
    expect(codes(audit(`CVE-2026-75925 uses vector ${vector}.`, [metricsSource(vector)]))).not.toContain('CVSS_UNSUPPORTED');
  });
});

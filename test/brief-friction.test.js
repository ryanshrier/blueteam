import { expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { repairMetricQualifiers } from '../lib/brief-metric-repair.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { buildGenerationManifest, sha256 } from '../lib/generation-manifest.js';
import { saveRejectedBrief, revalidateBriefDraft, readBriefDraft } from '../lib/brief-drafts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cve = 'CVE-2026-12345';
const claim = `${cve}: CVSS v4.0 9.5 (Secondary assessment)`;
const nvd = `[NVD, date unavailable](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve})`;
const vendor = '[Vendor, October 9, 2026](https://vendor.example/gateway)';
const groundingManifest = buildGroundingManifest({ headlines: [{ source: 'Vendor', title: `${cve} gateway advisory`,
  link: 'https://vendor.example/gateway', date: '2026-10-09',
  description: `${cve} affects deployed gateway configurations. Administrators should verify applicability and follow the vendor remediation guidance.`,
  cvssMetrics: [{ cve, score: 9.5, version: '4.0', type: 'Secondary', provisional: true, selected: true }],
  cveData: `${claim} (provisional)` }] });
const source = { publication: true, groundingManifest, kevSet: new Set() };
const report = (assessment, happened = `${cve} affects the gateway. ${vendor}`) =>
  `## KEY JUDGMENTS\n### Signal 1 — [Horizon 1] Gateway review\n**Assessment:** ${assessment}\n**What happened:** ${happened}\n`;
const check = (text, version = 4) => validateBrief(text, '2026-10-09', { ...source, validationPolicyVersion: version });
const relevant = result => result.issues.filter(issue => /CVSS|CVE_CITATION|JUDGMENT_CITATION/.test(issue.code));

test('a captured metric cited beside its Assessment claim has the same support as a What happened citation', () => {
  const text = report(`${claim} (provisional). ${nvd}`);
  expect(relevant(check(text))).toEqual([]);
  expect(relevant(check(text, 3)).map(issue => issue.code)).toContain('CVE_CVSS_MISMATCH');
  expect(check(text).judgmentEvidence[0].sourceIds).toContain(`NVD-${cve}`);
});

test('an absent qualifier is advisory; an explicit conflicting qualification still blocks', () => {
  const text = report(`${claim}. ${nvd}`);
  const findings = relevant(check(text));
  expect(findings.length).toBeGreaterThan(0);
  expect(findings.every(issue => issue.code === 'CVSS_QUALIFIER_OMITTED')).toBe(true);
  expect(publicationDecision({ validationPolicyVersion: 4, issues: findings }).canPublish).toBe(true);
  for (const value of [claim.replace('9.5', '9.9'), claim.replace('4.0', '3.1'), claim.replace('Secondary', 'Primary'),
    `${claim} (non-provisional)`, `${claim} (final)`, `${claim} (no longer provisional)`, claim.replace('CVSS', 'final CVSS')]) {
    const issues = relevant(check(report(`${value}. ${nvd}`)));
    expect(publicationDecision({ validationPolicyVersion: 4, issues }).canPublish).toBe(false);
  }
});

test.each(['CVSS v4 9.5', 'CVSS:4.0 9.5', 'CVSS version 4.0 score 9.5', 'CVSS v4.0 9.5/10', 'CVSS:9.5/10'])(
  'equivalent score notation is accepted without hiding a wrong number: %s', metric => {
    const value = `${cve}: ${metric} (Secondary assessment) (provisional). ${nvd}`;
    expect(relevant(check(report(value)))).toEqual([]);
    expect(publicationDecision({ validationPolicyVersion: 4, issues: relevant(check(report(value.replace('9.5', '9.9')))) }).canPublish).toBe(false);
  });

test('a citation in another judgment or an unknown source cannot supply the missing metric', () => {
  const text = report(`${claim} (provisional).`) + `### Signal 2 — [Horizon 1] Another topic\n**What happened:** Captured lookup. ${nvd}\n`;
  expect(relevant(check(text)).map(issue => issue.code)).toContain('CVE_CVSS_MISMATCH');
  expect(check(report(`${claim} (provisional). [Unknown](https://other.example/metric)`)).issues
    .map(issue => issue.code)).toContain('CITATION_IDENTITY_INVALID');
});

test('a precise provisional insertion is idempotent and preserves all other authored content', () => {
  const text = report(`${claim}. ${nvd}`);
  const repaired = repairMetricQualifiers(text, check(text).issues);
  expect(repaired.content).toBe(text.replace('9.5', '9.5 (provisional)'));
  expect(repaired.repairs).toHaveLength(1);
  expect(repaired.repairs[0]).toMatchObject({ kind: 'add-provisional-qualifier', cve, score: 9.5 });
  expect(relevant(check(repaired.content))).toEqual([]);
  expect(repairMetricQualifiers(repaired.content, check(repaired.content).issues).repairs).toEqual([]);
});

test('repair does not modify code, quoted text, links, unknown mappings or explicit disagreements', () => {
  const plain = report(`${claim}. ${nvd}`);
  for (const text of [plain.replace(claim, `\`${claim}\``), plain.replace(claim, `[${claim}](https://vendor.example/gateway)`),
    plain.replace('**Assessment:**', '> **Assessment:**'), plain.replace('9.5', '9.9'), plain.replace(claim, `${claim} (final)`),
    plain.replace(nvd, '')]) {
    expect(repairMetricQualifiers(text, check(text).issues).content).toBe(text);
  }
});

test('new-generation worker repairs missing provisional wording without any provider work', async () => {
  const validator = createBriefValidator();
  try {
    const text = report(`${claim}. ${nvd}`);
    const prepared = await validator.prepare(text, '2026-10-09', source, { assemble: false });
    expect(prepared.content).toBe(text.replace('9.5', '9.5 (provisional)'));
    expect(prepared.automaticRepairs).toHaveLength(1);
    expect(relevant(prepared.validation)).toEqual([]);
    expect(text).not.toContain('9.5 (provisional)');
  } finally { await validator.close(); }
});

test('a saved-draft recheck records its qualifier repair without rewriting the original receipt or submitted metadata findings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'brief-qualifier-repair-'));
  const validator = createBriefValidator();
  try {
    const text = report(`${claim}. ${nvd}`);
    const manifest = buildGenerationManifest({ run: {}, config: {}, groundingManifest,
      editionContext: { date: '2026-10-09', timezone: 'America/Chicago' } });
    const saved = saveRejectedBrief(directory, { content: text, manifest, validation: check(text, 3) });
    const updated = await revalidateBriefDraft(directory, saved.id, {
      baseRevision: 1, content: `${text}\n<!-- briefing-metadata {broken} -->`,
    }, { automatic: true, prepareDraft: payload => validator.prepareDraft(payload) });
    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[0]).toEqual(saved.revisions[0]);
    expect(updated.manifest).toEqual(saved.manifest);
    expect(updated.manifestSha256).toBe(saved.manifestSha256);
    const revision = updated.revisions[1];
    expect(revision).toMatchObject({ kind: 'automatic-recheck', metadataExtracted: true,
      automaticRepairs: [expect.objectContaining({ kind: 'add-provisional-qualifier', cve, score: 9.5 })] });
    expect(revision.content).toContain('9.5 (provisional)');
    expect(revision.sha256).toBe(sha256(revision.content));
    expect(revision.briefingMetadataContentSha256).toBe(revision.sha256);
    expect(revision.briefingMetadataIssues.map(issue => issue.code)).toContain('BRIEF_METADATA_INVALID');
    expect(relevant(revision.validation)).toEqual([]);
    expect(updated.automaticCheckedAt).toBeTruthy();
    expect(updated.operatorSavedAt).toBeUndefined();
    expect(readBriefDraft(directory, saved.id)).toEqual(updated);
  } finally { await validator.close(); rmSync(directory, { recursive: true, force: true }); }
});

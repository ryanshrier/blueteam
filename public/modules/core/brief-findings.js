// Shared presentation/repair grouping. Raw checks and publication consequences
// remain unchanged; only explicitly identified occurrences can share a row.
export const metricClaimKey = (claim, cve = claim.cve) => `cvss:${JSON.stringify([
  cve || null, claim.version || null, claim.score, claim.type || null, claim.provisional === true,
])}`;

export function groupBriefFindings(issues = []) {
  const groups = new Map();
  issues.forEach((issue, index) => {
    const line = issue.location?.line;
    const key = /^(?:CVE_CVSS_|CVSS_|FACT_CVSS_)/.test(issue.code || '')
      && typeof issue.claimKey === 'string' && issue.claimKey.startsWith('cvss:') && issue.claimKey.length <= 300
      && issue.location?.scope === 'paragraph' && Number.isSafeInteger(line) && line > 0
      ? `${line}:${issue.claimKey}` : `finding:${index}`;
    if (!groups.has(key)) groups.set(key, { ...issue, issues: [], indexes: [], codes: [], sourceIds: [] });
    const group = groups.get(key);
    group.issues.push(issue); group.indexes.push(index);
    group.codes = [...new Set([...group.codes, issue.code])];
    group.sourceIds = [...new Set([...group.sourceIds, ...(issue.sourceIds || [])])];
  });
  return [...groups.values()];
}

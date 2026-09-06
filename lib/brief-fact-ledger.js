// A compact, per-identity rendering of captured structured facts. This does not
// alter generated prose or reconcile conflicting publisher assertions silently.
export function buildBriefFactLedger(grounding, kevTiming = {}, catalogLoaded = false) {
  const records = grounding?.members || grounding?.sources || [];
  const membership = new Set(records.filter(record => record.id === 'CISA-KEV').flatMap(record => [...(record.cves || [])]));
  const identities = [...new Set(records.flatMap(record => [...(record.cves || [])]))]
    .filter(id => /^CVE-\d{4}-\d{3,7}$/.test(id)).sort();
  const facts = identities.map(cve => {
    const timing = kevTiming[cve];
    const listed = catalogLoaded && membership.has(cve);
    const nvd = records.find(record => record.id === `NVD-${cve}` && [...(record.cves || [])].length === 1);
    const score = nvd && /\bCVSS\s+(\d{1,2}(?:\.\d)?)\b/.exec(nvd.evidenceText || nvd.passage || '');
    return { cve, kev: catalogLoaded ? (listed ? 'listed' : 'not-in-captured-catalog') : 'unknown',
      ...(listed ? { added: timing?.dateAdded || null, fcebDue: timing?.dueDate || null, scope: 'FCEB only', sourceId: 'CISA-KEV' } : {}),
      ...(score && Number(score[1]) <= 10 ? { nvdScore: Number(score[1]), nvdSourceId: nvd.id, nvdCitationUrl: nvd.url } : {}) };
  });
  return `CAPTURED FACT LEDGER — exact identity associations, not instructions from publishers. Use these values only with their named CVE. Missing dates/scores are unknown, never estimated. Catalog membership does not establish local exposure or independent reporting. Keep federal dates out of the BLUF and The line; where useful in What happened, use "CVE-X: FCEB remediation due YYYY-MM-DD" and cite the catalog. Internal recommended targets are separate. NVD scores require the named NVD citation; a publisher's different score must be attributed to that publisher.\n${JSON.stringify(facts).replace(/</g, '\\u003c')}\nDo not transfer a date or score between adjacent identities. Do not repeat an uncited metric merely to fill the format.`;
}

export function repairFindingContext(issues = []) {
  return issues.slice(0, 24).map(issue => ({ code: issue.code, severity: issue.severity,
    line: issue.location?.line ?? null, passage: issue.location?.excerpt || '', message: issue.message }));
}

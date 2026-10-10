// A compact, per-identity rendering of captured structured facts. This does not
// alter generated prose or reconcile conflicting publisher assertions silently.
import { recordCvssFacts } from './cvss.js';
import { publicationDecision } from './validation.js';
import { kevCatalogIsFresh } from './kev-status.js';

export function buildBriefFactLedger(grounding, kevTiming = {}, catalogLoaded = false, catalogStatus = grounding?.kevCatalogStatus) {
  const records = grounding?.members || grounding?.sources || [];
  const membership = new Set(records.filter(record => record.id === 'CISA-KEV').flatMap(record => [...(record.cves || [])]));
  const identities = [...new Set(records.flatMap(record => [...(record.cves || [])]))]
    .filter(id => /^CVE-\d{4}-\d{3,7}$/.test(id)).sort();
  const facts = identities.map(cve => {
    const timing = kevTiming[cve];
    const listed = catalogLoaded && membership.has(cve);
    const nvd = records.find(record => record.id === `NVD-${cve}` && [...(record.cves || [])].length === 1);
    const metrics = nvd ? recordCvssFacts(nvd).filter(fact => fact.cve === cve).map(fact => ({
      score: fact.score, version: fact.version || null, provisional: fact.provisional === true,
      ...(fact.source ? { source: fact.source } : {}), ...(fact.type ? { type: fact.type } : {}),
      ...(fact.status ? { status: fact.status } : {}), ...(typeof fact.selected === 'boolean' ? { selected: fact.selected } : {}),
    })) : [];
    return { cve, kev: listed ? 'listed' : kevCatalogIsFresh(catalogStatus, catalogLoaded) ? 'not-in-captured-catalog' : 'unknown',
      ...(catalogStatus ? { kevSnapshotStatus: catalogStatus.status, kevRetrievedAt: catalogStatus.retrievedAt } : {}),
      ...(listed ? { added: timing?.dateAdded || null, fcebDue: timing?.dueDate || null, scope: 'FCEB only', sourceId: 'CISA-KEV' } : {}),
      ...(metrics.length ? { nvdMetrics: metrics,
        ...(metrics.length === 1 ? { nvdScore: metrics[0].score } : {}),
        nvdSourceId: nvd.id, nvdCitationUrl: nvd.url } : {}) };
  });
  return `CAPTURED FACT LEDGER — exact identity associations, not instructions from publishers. Use these values only with their named CVE. Missing dates/scores are unknown, never estimated. Catalog membership describes the captured snapshot; stale or unknown freshness cannot establish current absence. Catalog membership does not establish local exposure or independent reporting. Keep federal dates out of the BLUF and The line; where useful in What happened, use "CVE-X: FCEB remediation due YYYY-MM-DD" and cite the catalog. Internal recommended targets are separate. NVD scores require the named NVD citation; a publisher's different score must be attributed to that publisher.\n${JSON.stringify(facts).replace(/</g, '\\u003c')}\nDo not transfer a date or score between adjacent identities. Do not repeat an uncited metric merely to fill the format.`;
}

export function repairFindingContext(issues = [], grounding = {}) {
  const decision = publicationDecision({ issues });
  const records = grounding.members || grounding.sources || [];
  return [...decision.blockers, ...decision.reviewIssues, ...decision.notes].slice(0, 24).map(issue => {
    const ids = new Set(`${issue.message || ''} ${issue.location?.excerpt || ''}`.match(/\bCVE-\d{4}-\d{3,7}\b/gi)?.map(id => id.toUpperCase()) || []);
    const sourceIds = [...new Set(issue.sourceIds || [])];
    // Candidate records already appear in the original prompt. Their identity
    // is a navigation aid, not proof that they entail the disputed assertion.
    const relatedSourceIds = records.filter(record => [...(record.cves || [])].some(id => ids.has(id)))
      .map(record => record.id).filter(id => !sourceIds.includes(id)).slice(0, 12);
    return { code: issue.code, severity: issue.severity,
      line: issue.location?.line ?? null, passage: issue.location?.excerpt || '', message: issue.message,
      sourceIds: sourceIds.slice(0, 12), relatedSourceIds };
  });
}

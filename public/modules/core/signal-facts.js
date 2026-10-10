// Pure fact presentation shared by API, Wire, Wall and exports. A display
// preference never changes the captured authority, identity or uncertainty.
const cve = value => /^CVE-\d{4}-\d{3,7}$/i.test(value || '') ? value.toUpperCase() : '';
const text = value => typeof value === 'string' ? value : '';
const cveObservations = headline => (Array.isArray(headline.cveObservations) ? headline.cveObservations : [])
  .filter(item => cve(item?.cve)).map(item => ({ cve: cve(item.cve), retrievedAt: text(item.retrievedAt) || null }));
const band = score => score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'none';

export function signalMetrics(headline = {}) {
  if (Array.isArray(headline.cvssMetrics) && headline.cvssMetrics.length) {
    return headline.cvssMetrics.filter(metric => cve(metric?.cve) && Number.isFinite(metric.score)
      && metric.score >= 0 && metric.score <= 10 && !/reject/i.test(metric.status || '')).map(metric => ({
      cve: cve(metric.cve), score: metric.score, version: text(metric.version), source: text(metric.source),
      type: text(metric.type), status: text(metric.status), provisional: metric.provisional === true,
      selected: typeof metric.selected === 'boolean' ? metric.selected : null,
      severity: text(metric.severity).toLowerCase() || band(metric.score), basis: 'structured',
    }));
  }
  const raw = Array.isArray(headline.cveDetails) ? headline.cveDetails.filter(value => typeof value === 'string').join('\n') : text(headline.cveData);
  return (raw.match(/CVE-\d{4}-\d{3,7}[\s\S]*?(?=CVE-\d{4}-\d{3,7}|$)/gi) || []).flatMap(entry => {
    if (/reject/i.test(entry)) return [];
    const metric = /\bCVSS\s+(?:(v?(?:2\.0|3\.[01]|4\.0))\s+)?(?:base\s+score\s+|score\s+)?(\d{1,2}(?:\.\d+)?)\b(?![\d.])/i.exec(entry);
    if (!metric || Number(metric[2]) > 10) return [];
    const score = Number(metric[2]);
    return [{ cve: cve(entry.match(/^CVE-\d{4}-\d{3,7}/i)?.[0]), score,
      version: (metric[1] || '').replace(/^v/i, ''), source: /\(source:\s*([^)]*)\)/i.exec(entry)?.[1] || '',
      type: /\((Primary|Secondary) assessment\)/i.exec(entry)?.[1] || '', status: '',
      provisional: /\bprovisional\b/i.test(entry), selected: null,
      severity: /\((critical|high|medium|low|none)\)/i.exec(entry)?.[1]?.toLowerCase() || band(score), basis: 'legacy',
    }];
  });
}

export function signalSeverity(headline = {}) {
  const metrics = signalMetrics(headline);
  const chosen = [];
  let unresolved = 0;
  for (const id of new Set(metrics.map(metric => metric.cve))) {
    const entries = metrics.filter(metric => metric.cve === id);
    let candidates = entries.filter(metric => metric.selected === true);
    if (!candidates.length && !entries.some(metric => metric.selected === false)) {
      candidates = entries.length === 1 ? entries : entries.filter(metric => /^primary$/i.test(metric.type));
    }
    const unique = [...new Map(candidates.map(metric => [JSON.stringify([metric.score, metric.version, metric.source, metric.type, metric.provisional]), metric])).values()];
    if (unique.length === 1) chosen.push(unique[0]); else unresolved++;
  }
  chosen.sort((a, b) => b.score - a.score || a.cve.localeCompare(b.cve));
  if (!chosen.length) return { label: 'CVSS severity', value: metrics.length ? 'Conflicting assessments' : 'Not available', scope: '', metrics, unresolved };
  const metric = chosen[0];
  const severity = metric.severity ? `${metric.severity[0].toUpperCase()}${metric.severity.slice(1)}` : '';
  const qualifier = [metric.version ? `v${metric.version}` : 'version not recorded', metric.source || 'authority not recorded', metric.type ? `${metric.type} assessment` : '',
    metric.provisional ? 'provisional' : '', metrics.length > chosen.length ? 'other assessments retained' : '', unresolved ? 'unresolved assessments' : ''].filter(Boolean).join(' · ');
  return { label: chosen.length > 1 ? 'Highest CVSS severity' : 'CVSS severity',
    value: `${metric.score.toFixed(1)}${severity ? ` ${severity}` : ''} · ${qualifier}`, scope: metric.cve,
    level: ['critical', 'high'].includes(metric.severity) ? metric.severity : undefined, metric, metrics, unresolved };
}

export function kevFact(headline = {}) {
  const status = ['fresh', 'stale', 'unknown', 'unavailable'].includes(headline.kevCatalogStatus?.status) ? headline.kevCatalogStatus.status : 'unknown';
  const retrievedAt = text(headline.kevCatalogStatus?.retrievedAt);
  const records = (Array.isArray(headline.kevRecords) ? headline.kevRecords : []).filter(record => cve(record?.cve));
  const legacyId = cve(headline.kevCVE || headline.kev_cve);
  const ids = [...new Set(records.map(record => cve(record.cve)))];
  if (!ids.length && status !== 'fresh' && (headline.isKEV || headline.is_kev) && legacyId) ids.push(legacyId);
  const listed = ids.length > 0 || (status !== 'fresh' && Boolean(headline.isKEV || headline.is_kev));
  const id = ids.includes(legacyId) ? legacyId : ids[0] || '';
  const record = records.find(item => cve(item.cve) === id);
  const dueDate = text(record ? record.dueDate : id === legacyId ? headline.kevDueDate : '');
  const dateAdded = text(record ? record.dateAdded : id === legacyId ? headline.kevDateAdded : '');
  return { listed, cve: id, cves: ids, status, retrievedAt, dueDate, dateAdded,
    overdue: Boolean(record ? record.overdue : id === legacyId && headline.kevOverdue), scope: 'FCEB only',
    label: listed ? status === 'fresh' ? 'KEV' : 'KEV · retained' : status === 'fresh' ? 'Not in captured KEV catalog' : 'KEV status unknown',
    description: listed
      ? status === 'fresh' ? `Listed in the captured CISA KEV catalog${retrievedAt ? ` (${retrievedAt})` : ''}.`
        : `Listed in retained CISA KEV evidence${retrievedAt ? ` captured ${retrievedAt}` : '; capture time unavailable'}. Current catalog membership is unverified.`
      : status === 'fresh' ? 'Not listed in the captured CISA KEV catalog; this does not establish absence of exploitation.'
        : 'Current KEV membership is unknown; missing catalog data does not establish absence.',
  };
}

// Normalize the API's current catalog join before any surface reads old flags.
// A failed/stale catalog can retain a historical positive, but cannot prove a
// negative. Exact evidence revision references are carried separately unchanged.
export function capturedSignalFacts(headline = {}, currentRecords = [], catalogStatus = { status: 'unknown' }) {
  catalogStatus = catalogStatus && typeof catalogStatus === 'object' ? catalogStatus : { status: 'unknown' };
  const records = (Array.isArray(currentRecords) ? currentRecords : []).filter(record => cve(record?.cve));
  if (catalogStatus.status !== 'fresh') {
    for (const record of Array.isArray(headline.kevRecords) ? headline.kevRecords : []) {
      if (cve(record?.cve) && !records.some(item => item.cve === record.cve)) records.push(record);
    }
  }
  const kevCatalogStatus = { status: ['fresh', 'stale', 'unknown', 'unavailable'].includes(catalogStatus.status) ? catalogStatus.status : 'unknown',
    retrievedAt: text(catalogStatus.retrievedAt) || null, checkedAt: text(catalogStatus.checkedAt) || null };
  const kev = kevFact({ ...headline, kevRecords: records, kevCatalogStatus });
  return { kevRecords: records, kevCatalogStatus, isKEV: kev.listed, kevCVE: kev.cve || null,
    kevDueDate: kev.listed ? kev.dueDate || null : null, kevDateAdded: kev.listed ? kev.dateAdded || null : null,
    kevOverdue: kev.listed && kev.overdue, cvssMetrics: signalMetrics(headline),
    cveObservations: cveObservations(headline),
    cveDetails: Array.isArray(headline.cveDetails) ? headline.cveDetails.filter(value => typeof value === 'string') : [],
    retrievedAt: text(headline.retrievedAt) || null, collectionStale: Boolean(headline.collectionStale),
    articleRetrievedAt: text(headline.articleRetrievedAt) || null,
    articleRetrievalStatus: ['fetched', 'revalidated', 'cached', 'stale-fallback', 'unavailable'].includes(headline.articleRetrievalStatus) ? headline.articleRetrievalStatus : 'unknown' };
}

export function evidenceQualifications(headline = {}) {
  const kev = kevFact(headline);
  return { sourceRetrievedAt: text(headline.retrievedAt), collectionState: headline.collectionStale ? 'retained-cache' : headline.retrievedAt ? 'observed' : 'unknown',
    articleRetrievedAt: text(headline.articleRetrievedAt), articleRetrievalStatus: text(headline.articleRetrievalStatus) || 'unknown',
    enrichmentAvailability: Object.entries(headline.enrichmentStatus || {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => `${key}: ${value}`).join('; '),
    kevCatalogState: kev.status, kevCatalogRetrievedAt: kev.retrievedAt, kevMembership: kev.description,
    kevDeadlineScope: kev.dueDate ? 'FCEB only; external catalog deadline, not an organizational target' : '',
    cvssAssessments: signalMetrics(headline),
    cveObservations: cveObservations(headline),
  };
}

export function briefingReadinessLabel(readiness, { elapsedMs = 0, refreshMinutes = 10 } = {}) {
  const maxAgeMs = Math.max(15, (Number(refreshMinutes) || 10) * 3) * 60_000;
  if (!readiness || !['ready', 'limited', 'blocked'].includes(readiness.status)) return { status: 'unknown', label: 'Briefing readiness unknown', reason: 'Readiness was not recorded with this snapshot.' };
  if (Number.isFinite(readiness.ageMs) && readiness.ageMs + Math.max(0, elapsedMs) > maxAgeMs) {
    return { status: 'blocked', label: 'Briefing evidence stale', reason: 'Refresh the landscape before generating a briefing.' };
  }
  return { status: readiness.status, label: readiness.status === 'ready' ? 'Briefing ready' : readiness.status === 'limited' ? 'Limited briefing ready' : 'Briefing unavailable', reason: text(readiness.reason) };
}

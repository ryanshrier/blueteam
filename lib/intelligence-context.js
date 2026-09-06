// Evidence-derived presentation helpers. Original publisher records stay intact.
import { affirmativeMatch } from './claims.js';
import { getDomainPack } from './domain.js';

export function retainedMembers(headline) {
  return Array.isArray(headline?.sourceMembers) && headline.sourceMembers.length
    ? headline.sourceMembers.slice(0, 100) : [headline || {}];
}

export function retainedText(headline) {
  return retainedMembers(headline).map(member => [member.title, member.passage || member.description]
    .filter(value => typeof value === 'string').map(value => value.slice(0, 8192)).join('\n')).join('\n');
}

export function headlineCves(headline) {
  return [...new Set((retainedText(headline).match(/\bCVE-\d{4}-\d{4,7}\b/gi) || []).map(id => id.toUpperCase()))].slice(0, 100);
}

// Recognize explicit, unambiguous source timezone suffixes. Never infer a local
// timezone for a bare clock time. Keep the source string separately for receipts.
export function normalizeFeedTimestamp(value) {
  const raw = typeof value === 'string' ? value.trim().slice(0, 256) : '';
  if (!raw) return null;
  const zones = { CET: '+0100', CEST: '+0200', EET: '+0200', EEST: '+0300', BST: '+0100', UTC: '+0000', GMT: '+0000' };
  const normalized = raw.replace(/\b(CET|CEST|EET|EEST|BST|UTC|GMT)\s*$/i, zone => zones[zone.toUpperCase()]);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(normalized);
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})\s*(?:\([^)]*\))?$/i.test(normalized);
  if (!dateOnly && !explicitZone) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function readableExcerpt(value, limit = 480) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const prefix = text.slice(0, Math.max(1, limit - 1));
  const boundary = prefix.lastIndexOf(' ');
  return (boundary > limit * 0.6 ? prefix.slice(0, boundary) : prefix).trimEnd() + '…';
}

const BACKGROUND_TITLE = /\b(?:forecast|roundup|round-up|retrospective|lookback|look back|year in review|lessons learned)\b/i;
const ACTIVE_EXPLOITATION = /(?:active(?:ly)?.?exploit|exploited.?in.?the.?wild|(?:attackers?|threat.?actors?)\s+(?:are|is)\s+exploit|(?:zero.?day|vulnerabilit(?:y|ies)|flaws?)\s+(?:(?:is|are|being)\s+)?exploited)/i;
const NON_OPERATIONAL_ACTIVITY = /\b(?:proof[ -]of[ -]concept|PoC|hypothetical|simulat(?:ed|ion)|(?:in|within) (?:a |the )?lab(?:oratory)?|could be exploited|can be exploited)\b/i;

function historicalStatement(text, year) {
  return /\b(?:last (?:month|year)|previous(?:ly| year| month)|historically|at the time|used to|back in)\b/i.test(text)
    || Boolean(year && [...text.matchAll(/\b(?:in|during|since)\s+(20\d{2})\b/gi)].some(match => Number(match[1]) < year));
}

// Urgency concerns the reported event, not every keyword in a retained article.
// Keep the original statements and references so this lexical assessment remains
// inspectable. Forecast/retrospective bodies and explicitly historical clauses
// cannot establish current activity. This is not an independent fact check.
export function currentEventStatements(headline) {
  return retainedMembers(headline).flatMap(member => {
    const title = String(member.title || '');
    const refs = (member.evidence || member.sourceRevisions || []).map(ref => ({ sourceId: ref.sourceId, revisionId: ref.revisionId }));
    const base = { source: member.source || '', reportedAt: normalizeFeedTimestamp(member.date || member.publishedAt), evidenceRefs: refs };
    const year = base.reportedAt ? Number(base.reportedAt.slice(0, 4)) : null;
    const statements = [{ ...base, text: title, basis: 'source-title',
      activityEligible: !BACKGROUND_TITLE.test(title) && !historicalStatement(title, year) && !NON_OPERATIONAL_ACTIVITY.test(title) }];
    if (BACKGROUND_TITLE.test(title)) return statements;
    const lead = String(member.passage || member.description || '').slice(0, 1600);
    for (const text of (lead.match(/[^.!?\n]+[.!?]?/g) || []).slice(0, 4)) {
      if (historicalStatement(text, year)) continue;
      statements.push({ ...base, text: text.trim(), basis: 'source-lead', activityEligible: !NON_OPERATIONAL_ACTIVITY.test(text) });
    }
    return statements;
  });
}

export function assessUrgency(headline, pack = getDomainPack()) {
  const statements = currentEventStatements(headline);
  const c = pack?._compiled || {};
  const critical = statements.find(statement => statement.activityEligible && affirmativeMatch(statement.text, c.critical));
  const elevated = statements.find(statement => affirmativeMatch(statement.text, c.elevated));
  const active = pack?.id === 'cyber' && statements.find(statement => statement.activityEligible && affirmativeMatch(statement.text, ACTIVE_EXPLOITATION));
  const match = critical || elevated;
  const level = critical ? 'critical' : elevated ? 'elevated' : 'routine';
  return {
    level,
    reason: active && critical ? 'Source reports active exploitation'
      : critical ? 'Current report matches critical urgency terms'
        : elevated ? (BACKGROUND_TITLE.test(headline.title || '') ? 'Planning or retrospective report; historical activity excluded' : 'Current report matches elevated urgency terms')
          : 'No current urgency trigger established in the retained title or lead',
    basis: match?.basis || 'retained-title-and-lead',
    statement: match?.text || null,
    source: match?.source || null,
    reportedAt: match?.reportedAt || null,
    evidenceRefs: match?.evidenceRefs || [],
    exploitationStatus: active ? 'reported-active' : 'not-established',
  };
}

// Extract subjects only from explicit affected-product title forms. A vendor
// mentioned by entity enrichment can be the researcher or publisher, not a
// vulnerable product. Keep that distinction rather than guessing a fallback.
export function advisorySubject(headline) {
  const title = String(headline?.title || '');
  const patterns = [
    /(?:multiples?\s+)?vuln[ée]rabilit[ée]s?\s+dans\s+(?:les produits?\s+)?(.+?)(?:\s*\(|$)/i,
    /(?:vulnerabilit(?:y|ies)\s+(?:in|affecting)|security (?:advisory|update) for)\s+(.+?)(?:\s*\(|$)/i,
    /^(.+?)\s+security advisory(?:\s*\(|$)/i,
    /^unpatched\s+(.+?)\s+zero[ -]day\b/i,
  ];
  for (const pattern of patterns) {
    const value = title.match(pattern)?.[1]?.trim();
    if (value && value.length <= 160) return value;
  }
  // ICS feeds commonly use only the product name as their advisory title.
  if (headline?.category === 'ics-advisory' && title.length <= 100 && !/[.!?:]/.test(title)) return title;
  return null;
}

function kevProduct(record) {
  const vendor = String(record.vendor || '').trim(), product = String(record.product || '').trim();
  return product.toLowerCase().startsWith(vendor.toLowerCase()) ? product : [vendor, product].filter(Boolean).join(' ');
}

function kevConsequence(records, productScope) {
  if (records.length === 1 && records[0].description) return readableExcerpt(records[0].description, 240);
  const mechanisms = records.map(record => {
    const name = String(record.name || '').replace(/\s+vulnerability$/i, '');
    const product = kevProduct(record);
    return product && name.toLowerCase().startsWith(product.toLowerCase() + ' ') ? name.slice(product.length).trim() : null;
  }).filter(Boolean);
  return mechanisms.length
    ? readableExcerpt(`Known exploitation: ${[...new Set(mechanisms)].join(' / ')} in ${productScope}.`, 240)
    : `Known exploitation affects ${productScope || 'the catalog-listed products'}.`;
}

export function editorialContext(headline, kevRecords = []) {
  const sourceTitle = String(headline.title || '');
  const products = [...new Set(kevRecords.map(kevProduct).filter(Boolean))];
  const titleSubject = !products.length && advisorySubject(headline);
  if (titleSubject) products.push(titleSubject);
  const ids = headlineCves(headline);
  const primary = kevRecords[0];
  const productScope = products.slice(0, 2).join(', ') + (products.length > 2 ? ` +${products.length - 2} products` : '');
  const isAdministrative = /(?:adds? .+ (?:vulnerabilit|catalog)|security advisory\s*(?:\(|for|$)|security update for|vulnerabilit(?:y|ies) (?:in|affecting))/i.test(sourceTitle);
  const isCatalogAddition = /(?:adds? .+ (?:vulnerabilit|catalog)|(?:added|enter(?:s|ed)?) .+ (?:KEV|known exploited|catalog))/i.test(sourceTitle);
  let title = sourceTitle;
  if (isAdministrative && primary && kevRecords.length === 1) {
    const subject = primary.name || products[0] || primary.cve;
    title = `${subject.replace(/\s+vulnerability$/i, '')}: known exploitation (${primary.cve})`;
  } else if (isAdministrative && kevRecords.length > 1) {
    title = isCatalogAddition
      ? `${productScope || 'Multiple products'}: ${kevRecords.length} flaws added to KEV`
      : `${productScope || 'Multiple products'}: ${kevRecords.length} KEV-listed flaws; check affected versions`;
  }
  const urgency = assessUrgency(headline);
  const active = urgency.exploitationStatus === 'reported-active';
  if (!primary && active && titleSubject && /^unpatched\b/i.test(sourceTitle)) {
    title = `${titleSubject}: exploitation of an unpatched zero-day reported`;
  }
  const triageEligible = Boolean(primary || headline.isKEV || active || urgency.level === 'critical');
  const evidenceRefs = (headline.evidence || []).map(ref => ({ sourceId: ref.sourceId, revisionId: ref.revisionId }));
  return {
    title, sourceTitle, product: products.join(' · ') || null,
    products: products.map(name => ({ name, basis: primary ? 'kev-record' : 'source-title' })),
    identity: headline.eventIdentity || null,
    articles: headline.articleIdentities || [],
    changeKind: primary ? 'catalog-context' : 'source-report',
    urgency,
    exploitationStatus: urgency.exploitationStatus,
    triageEligible,
    triageReason: primary || headline.isKEV ? 'Catalog-listed exploitation; check local applicability'
      : active ? 'Reported active exploitation; an identifier is not required for an applicability check'
        : urgency.level === 'critical' ? urgency.reason : null,
    captureChanges: (headline.evidence || []).filter(ref => ref.changed || ref.changeKind).map(ref => ({
      sourceId: ref.sourceId, revisionId: ref.revisionId, changeKind: ref.changeKind || 'retained-source-changed', materialChange: 'unassessed',
    })),
    threatChange: 'unassessed',
    consequence: primary
      ? kevConsequence(kevRecords, productScope)
      : active ? `The source reports exploitation${products.length ? ` affecting ${productScope}` : ''}.` : null,
    nextStep: primary
      ? `Check deployed versions of ${productScope || 'the listed products'} against vendor mitigation guidance.`
      : active ? `Check deployment and exposure${products.length ? ` for ${productScope}` : ''}; assign review of the cited advisory and mitigations.` : null,
    cves: ids,
    evidenceRefs,
    unknowns: ['Local deployment and exposure are unverified.', 'Publisher count does not establish independent observation.'],
  };
}

export function enrichmentStatus(headline, failures = []) {
  const hasCve = headlineCves(headline).length > 0;
  const status = (available, key) => available ? 'available' : !hasCve ? 'not-applicable'
    : failures.some(failure => String(failure).toLowerCase().includes(key)) ? 'unavailable' : 'unknown';
  return { cve: status(Boolean(headline.cveData?.length), 'cve'), epss: status(Number.isFinite(headline.epss), 'epss') };
}

// A narrow grouping key supplements title similarity. Same single CVE within
// three days may be one development; an explicit follow-on (bypass, campaign,
// mitigation revision) remains separate. No shared-CVE blanket collapse.
export function mustKeepSeparateDevelopments(left, right) {
  const leftSubject = advisorySubject(left)?.toLowerCase(), rightSubject = advisorySubject(right)?.toLowerCase();
  if (leftSubject && rightSubject && leftSubject !== rightSubject) return true;
  const advisoryId = h => String(h.link || '').match(/\bCERTFR-\d{4}-[A-Z]+-\d+\b/i)?.[0].toUpperCase();
  const leftAdvisory = advisoryId(left), rightAdvisory = advisoryId(right);
  if (leftAdvisory && rightAdvisory && leftAdvisory !== rightAdvisory) return true;
  const leftIds = headlineCves({ ...left, sourceMembers: undefined });
  const rightIds = headlineCves({ ...right, sourceMembers: undefined });
  if (!leftIds.some(id => rightIds.includes(id))) return false;
  const followOn = /\b(?:bypass|re-?exploit|new campaign|ransomware campaign|mitigation (?:fails|revised)|patch (?:fails|bypass|retracted|withdrawn)|new exploit chain|proof[ -]of[ -]concept|PoC|public exploit|exploit (?:released|published)|exploitation (?:begins|starts)|now (?:actively )?exploited)\b/i;
  const titleKey = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Exact copies of the same follow-on can still group. A shared CVE alone is
  // insufficient to equate different follow-on headlines with the first report.
  if ((followOn.test(left.title || '') || followOn.test(right.title || ''))
    && titleKey(left.title) !== titleKey(right.title)) return true;
  const a = normalizeFeedTimestamp(left.date), b = normalizeFeedTimestamp(right.date);
  return Boolean(a && b && Math.abs(Date.parse(a) - Date.parse(b)) > 3 * 86400_000);
}

export function sameVulnerabilityDevelopment(left, right) {
  const leftIds = headlineCves({ ...left, sourceMembers: undefined });
  const rightIds = headlineCves({ ...right, sourceMembers: undefined });
  if (leftIds.length !== 1 || rightIds.length !== 1 || leftIds[0] !== rightIds[0]) return false;
  if (mustKeepSeparateDevelopments(left, right)) return false;
  const a = normalizeFeedTimestamp(left.date), b = normalizeFeedTimestamp(right.date);
  return Boolean(a && b && Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * 86400_000);
}

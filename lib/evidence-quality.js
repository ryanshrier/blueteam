// Bounded source-input diagnostics. These classify the retained passage, not
// the truth of a publisher or the entailment of a generated claim.
import { createHash } from 'node:crypto';
import { expandCveShorthand } from './cve-identities.js';
export const EVIDENCE_QUALITY_POLICY_VERSION = 2;
export const SOURCE_EVIDENCE_LIMITS = Object.freeze({ maxCharacters: 2_000_000,
  maxTitleCharacters: 8192, maxAddressCharacters: 8192, maxWords: 100_000, maxHtmlRegions: 30_000 });
const exceeded = () => { throw Object.assign(new Error('Source evidence exceeds its computation limit'), { code: 'E_SOURCE_EVIDENCE_LIMIT' }); };

function plain(value) {
  if (typeof value !== 'string') return '';
  if (value.length > SOURCE_EVIDENCE_LIMITS.maxCharacters) exceeded();
  const parts = [];
  let cursor = 0, regions = 0;
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor);
    if (start < 0) break;
    const end = value.indexOf('>', start + 1);
    // An unmatched '<' preserves the complete remainder. Retrying the same
    // missing '>' at every following '<' made the former regexp quadratic.
    if (end < 0) break;
    if (++regions > SOURCE_EVIDENCE_LIMITS.maxHtmlRegions) exceeded();
    parts.push(value.slice(cursor, start), ' ');
    cursor = end + 1;
  }
  parts.push(value.slice(cursor));
  return parts.join('').replace(/&(?:nbsp|amp);/gi, ' ').replace(/\s+/g, ' ').trim();
}
function analysisText(value) {
  const result = value.normalize('NFKC');
  if (result.length > SOURCE_EVIDENCE_LIMITS.maxCharacters) exceeded();
  return result;
}
function* boundedWords(value, budget) {
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (--budget.remaining < 0) exceeded();
    yield match;
  }
}
// Duration units do not establish subject agreement: "zero-day" reporting
// must not make an unrelated "6-day course" advert look like article evidence.
const generic = new Set('a an the of for and or to in on from with by at as is are was were has have had it its this that these those new latest cyber cybersecurity security threat threats news report reports day days week weeks month months year years hour hours minute minutes second seconds'.split(' '));
function topicWords(value, budget) {
  const result = new Set();
  for (const match of boundedWords(value, budget)) {
    const word = match[0].toLowerCase();
    if (word.length > 2 && !generic.has(word)) result.add(word);
  }
  return result;
}
const quality = (status, reason) => Object.freeze({ policyVersion: EVIDENCE_QUALITY_POLICY_VERSION,
  status, substantive: status === 'substantive', reasons: Object.freeze([reason]) });

/** Small concrete statements remain usable; length alone never rejects one. */
export function classifySourceEvidence(input = {}) {
  try {
    return classifyBoundedSource(input);
  } catch (error) {
    if (error?.code !== 'E_SOURCE_EVIDENCE_LIMIT') throw error;
    return quality('limited', 'source-computation-limit');
  }
}

function classifyBoundedSource({ title = '', passage = '', url = '', link = '' }) {
  if ((typeof title === 'string' && title.length > SOURCE_EVIDENCE_LIMITS.maxTitleCharacters)
    || (typeof (url || link) === 'string' && (url || link).length > SOURCE_EVIDENCE_LIMITS.maxAddressCharacters)) exceeded();
  const body = analysisText(plain(passage));
  const headline = analysisText(plain(title));
  const budget = { remaining: SOURCE_EVIDENCE_LIMITS.maxWords };
  const heading = [...boundedWords(headline, budget)].map(match => match[0].toLowerCase());
  let residual = body;
  if (heading.length) {
    let position = 0, end = 0;
    // Consume each leading word once. Remember only complete heading copies,
    // so a partial heading followed by real reporting remains evidence.
    for (const match of boundedWords(body, budget)) {
      if (match[0].toLowerCase() !== heading[position]) break;
      if (++position === heading.length) { end = match.index + match[0].length; position = 0; }
    }
    if (end) residual = body.slice(end).replace(/^[\s:;,.!?—–-]+/, '').trim();
  }
  const words = new Set(heading.filter(word => word.length > 2 && !generic.has(word)));
  const residualWords = topicWords(residual, budget);
  const overlap = [...residualWords].filter(word => words.has(word)).length;
  const concrete = /\bCVE-\d{4}-\d{3,7}\b|\b\d+\.\d+(?:\.\d+)*\b/i.test(residual);
  const interstitial = /^(?:advertisement\b|sponsored content\b|promoted content\b|(?:sign|log) in(?:[.!?]|$|\s+to\s+(?:continue|read|view))|enable javascript\b|accept (?:all )?cookies\b|cookie preferences\b|access denied\b|please (?:enable|verify)\b|checking your browser\b|just a moment\b|(?:this|the|requested) (?:page|article|content|resource) (?:is |was |has been )?(?:not available|unavailable|not found|removed)\b|(?:(?:we have|we've) )?updated (?:our|your) cookie preferences\b|(?:error\s*)?404\b)/i.test(residual);
  const promotion = /\b(?:register (?:now|today)|sign up|subscribe (?:now|today|to)|reserve your (?:seat|spot)|limited[- ]time|early[- ]bird|enroll (?:now|today)|book (?:a )?demo|free trial)\b|\b\d+[- ]day\b.{0,40}\b(?:course|training|workshop)\b|\b(?:find|discover|explore)\s+(?:[\p{L}\d-]+\s+){0,3}(?:training|courses|workshops)\s+for\b/iu.test(residual);
  // A dated advisory card is not the requested article. Require the compact
  // card shape plus a conflicting identity/topic; old advisory references in
  // reporting and genuine short advisories are not rejected merely for age.
  const teaser = /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\s+)?(?:Cybersecurity|Security) Advisory\s*[|:—–-]?\s*(AA\d{2}-\d{3}[a-z])\s+(.+)$/i.exec(residual);
  const requestedAdvisory = /\bAA\d{2}-\d{3}[a-z]\b/i.exec(`${url || link} ${headline}`)?.[0]?.toLowerCase();
  const teaserTitle = teaser?.[2] || '';
  const teaserWords = topicWords(teaserTitle, budget);
  const teaserOverlap = [...teaserWords].filter(word => words.has(word)).length;
  const unrelatedTeaser = teaser && residual.length < 600 && !/[.!?](?:\s|$)/.test(teaserTitle.replace(/\b(?:[A-Z]\.){2,}/g, ''))
    && ((requestedAdvisory && requestedAdvisory !== teaser[1].toLowerCase())
      || (words.size >= 3 && teaserOverlap / Math.max(1, Math.min(words.size, teaserWords.size)) < 0.35));
  let status; let reason;
  if (!/[\p{L}\p{N}]/u.test(residual)) { status = 'title-only'; reason = 'no-body-beyond-title'; }
  else if (unrelatedTeaser) { status = 'contaminated'; reason = 'unrelated-advisory-card'; }
  else if (interstitial || (promotion && overlap === 0 && !concrete)) { status = 'contaminated'; reason = interstitial ? 'interstitial-or-promotional-body' : 'off-topic-promotional-body'; }
  else if (!overlap && !concrete && !/\b[\p{L}]{3,}ed\b|\b(?:is|are|was|were|has|have|had|will|can|could|may|might|must|should|does|do|did|confirms?|confirmed|reports|reported|says|states|released|published|patched|fixed|affects?|affecting|exploited|observed|disclosed|found|detected|stole|stolen|compromised|available)\b/iu.test(residual)) {
    status = 'limited'; reason = 'unrelated-fragment-without-concrete-detail';
  } else { status = 'substantive'; reason = 'retained-body-detail'; }
  return quality(status, reason);
}

const evidenceCves = value => [...new Set([...expandCveShorthand(value).matchAll(/CVE-\d{4}-\d{3,7}/gi)].map(match => match[0].toUpperCase()))];

/** Re-evaluate a receipt without rewriting its historical decisions or text. */
export function reclassifyRetainedSource(record = {}) {
  const title = typeof record.title === 'string' ? record.title : '';
  const originalPassage = typeof record.passage === 'string' && record.passage ? record.passage
    : typeof record.evidenceText === 'string' ? record.evidenceText : '';
  const existingParts = Array.isArray(record.sourceParts) && record.sourceParts.length ? record.sourceParts : null;
  const inputs = existingParts || [{ kind: record.passageKind || 'retained-passage', passage: originalPassage,
    quality: record.quality, sourceRevisions: record.sourceRevisions || [], retrievedAt: record.retrievedAt || '' }];
  const assessed = inputs.map(part => {
    const passage = typeof part.passage === 'string' ? part.passage : '';
    const quality = classifySourceEvidence({ title, url: record.url, passage });
    return { ...part, passage, quality,
      cves: evidenceCves([part.kind === 'article-excerpts' ? '' : title, passage].join(' ')) };
  });
  const accepted = assessed.filter(part => part.quality.substantive);
  const primary = accepted.find(part => part.passage === originalPassage && part.kind === record.passageKind)
    || accepted.find(part => part.passage === originalPassage) || accepted[0];
  const quality = primary?.quality || assessed.find(part => part.passage === originalPassage)?.quality
    || assessed[0]?.quality || classifySourceEvidence({ title, url: record.url, passage: '' });
  const passage = primary?.passage || '';
  const evidenceText = [title, ...accepted.map(part => part.passage)].filter(Boolean).join(' ');
  const qualityAssessment = { policyVersion: EVIDENCE_QUALITY_POLICY_VERSION,
    originalQuality: record.quality || null, currentQuality: primary ? quality : { ...quality, substantive: false },
    rejectedPartCount: assessed.length - accepted.length,
    parts: assessed.map((part, index) => ({ kind: part.kind, passageSha256: createHash('sha256').update(part.passage).digest('hex'),
      originalQuality: inputs[index].quality || null, currentQuality: part.quality, accepted: part.quality.substantive })) };
  return { ...record, passage, passageKind: primary?.kind || 'title-only', evidenceText,
    quality: qualityAssessment.currentQuality,
    sourceParts: existingParts ? accepted : [],
    sourceRevisions: primary?.sourceRevisions || [], retrievedAt: primary?.retrievedAt || '',
    cves: evidenceCves(evidenceText), qualityAssessment,
    ...(!primary ? { cvssMetrics: [], configurations: [], configurationCaptures: [], applicabilityPassage: '', applicabilityComplete: false } : {}) };
}

/** Retain complementary captures from one article without blending their provenance. */
export function selectSourcePassage(headline = {}) {
  const title = typeof headline.title === 'string' ? headline.title : '';
  let feed = typeof (headline.passage || headline.description) === 'string' ? (headline.passage || headline.description) : '';
  const article = headline.articleBody && !headline.articleStale ? selectOperationalExcerpt(String(headline.articleBody)) : '';
  const originals = Array.isArray(headline.sourceMembers) ? headline.sourceMembers : [];
  let feedRecord = originals.find(member => member.source === headline.source && member.link === headline.link
    && plain(member.passage || member.description || '') === plain(feed)) || headline;
  let feedQuality = classifySourceEvidence({ title, url: headline.link, passage: feed });
  if (!feedQuality.substantive && headline.source && headline.link && Array.isArray(headline.sourceMembers)) {
    // A grouped/enriched headline can lose its original feed description. Only
    // recover its first exact publisher + article member and carry that member's
    // revision reference with it. Never borrow another source's body.
    const original = headline.sourceMembers.find(member => member.source === headline.source && member.link === headline.link);
    const retained = original?.passage || original?.description || '';
    const retainedQuality = classifySourceEvidence({ title, url: headline.link, passage: retained });
    if (retainedQuality.substantive) {
      feed = retained; feedQuality = retainedQuality;
      feedRecord = original;
    }
  }
  // Feed captures already have a separate bounded retention contract. Do not
  // re-excerpt a complete short advisory and discard its metric table.
  if (feed.length > 8192) feed = selectOperationalExcerpt(feed, 8192);
  const feedSourceRevisions = feedRecord !== headline || !originals.length ? feedRecord.evidence || [] : [];
  const articleQuality = classifySourceEvidence({ title, url: headline.link, passage: article });
  const part = (kind, passage, quality, metadata) => ({ kind, passage, quality,
    passageSha256: createHash('sha256').update(passage).digest('hex'), ...metadata });
  const feedPart = part('feed-excerpt', feed, feedQuality, {
    publishedAt: feedRecord.dateUnknown ? '' : feedRecord.date || '',
    retrievedAt: feedRecord.retrievedAt || (feedSourceRevisions.length === 1 ? feedSourceRevisions[0].retrievedAt || '' : ''),
    retrievalStatus: feedRecord.collectionStale ? 'retained-cache' : 'feed-capture',
    feedPassageField: feedRecord.feedPassageField || '', sourceRevisions: feedSourceRevisions,
  });
  const articlePart = part('article-excerpts', article, articleQuality, {
    publishedAt: headline.articlePublishedAt || '', retrievedAt: headline.articleRetrievedAt || '',
    retrievalStatus: headline.articleRetrievalStatus || 'not-recorded', sourceRevisions: [],
  });
  const finish = selected => {
    const primary = selected.kind === 'article-excerpts' ? articlePart : feedPart;
    // Identical text can still have a different identity context or capture
    // history. In particular, a feed title can bind a metric that the article
    // body repeats without naming the CVE; substring dedup would lose that fact.
    const sourceParts = selected.passage ? [feedPart, articlePart].filter(candidate => candidate.quality.substantive) : [];
    return { ...selected, sourceParts, sourceRevisions: selected.passage ? primary.sourceRevisions : [],
      retrievedAt: selected.passage ? primary.retrievedAt : '' };
  };
  const selectedFeed = () => ({ passage: feed, kind: 'feed-excerpt', quality: feedQuality });
  if (article) {
    const quality = articleQuality;
    if (quality.substantive) {
      // A longer original feed passage may preserve the mitigation section the
      // fetched opening omits. Never borrow another publisher's prose.
      const richerFeed = feedQuality.substantive && operationalScore(feed) > operationalScore(article);
      return finish(richerFeed ? selectedFeed() : { passage: article, kind: 'article-excerpts', quality });
    }
    if (feedQuality.substantive) return finish({ ...selectedFeed(), excludedArticle: { passage: article, quality } });
    return finish({ passage: '', kind: 'title-only', quality, excludedArticle: { passage: article, quality } });
  }
  return finish(feedQuality.substantive ? selectedFeed() : { passage: '', kind: 'title-only', quality: feedQuality,
    ...(feed ? { excludedPassage: { passage: feed, quality: feedQuality } } : {}) });
}

const operationalPattern = /\b(?:mitigat|remediat|recover|re-?imag|re-?deploy|fixed|patched|affected|vulnerable|password|TOTP|compromis|indicator|support|requires? authentication|not rely|no public)\w*/gi;
function operationalScore(text) { return (String(text).match(operationalPattern) || []).length; }

/** Bounded verbatim excerpts, in source order, with omissions made explicit. */
export function selectOperationalExcerpt(value, budget = 4000) {
  const text = plain(value);
  if (text.length <= budget) return text;
  // Consume through internal dots before looking for a sentence boundary.
  // Excluding all dots from a match silently dropped the start of sentences
  // containing versions, filenames, addresses and decimal scores.
  const parts = text.match(/[\s\S]+?(?:[.!?](?=\s|$)|$)/g) || [text];
  const ranked = parts.map((part, index) => ({ part: part.trim(), index,
    operational: operationalScore(part),
    hasIdentity: /\bCVE-\d{4}-\d{3,7}\b/i.test(part),
    score: operationalScore(part) + (index < 2 ? 4 : 0) }));
  let remaining = budget - 32;
  const chosen = new Set();
  for (const item of [...ranked].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (!(item.score > 0 || chosen.size < 2)) continue;
    // Versions and mitigations often follow a separate identity sentence. Keep
    // that nearby context (including intervening qualifications) with the fact,
    // rather than selecting an orphaned version and dropping its only CVE.
    // The nearest identity within three sentences is a bounded source span,
    // not a reason to collect unrelated CVEs from the rest of the article.
    const context = item.operational && !item.hasIdentity
      ? ranked.slice(Math.max(0, item.index - 3), item.index).findLast(candidate => candidate.hasIdentity)
      : null;
    const required = ranked.slice(context?.index ?? item.index, item.index + 1).filter(candidate => !chosen.has(candidate.index));
    const cost = required.reduce((sum, candidate) => sum + candidate.part.length + 7, 0);
    if (cost <= remaining) {
      for (const candidate of required) chosen.add(candidate.index);
      remaining -= cost;
    }
  }
  if (!chosen.size) return text.slice(0, budget - 2).replace(/\s+\S*$/, '') + '…';
  let last = -1;
  return ranked.filter(item => chosen.has(item.index)).map(item => {
    const gap = item.index > last + 1 ? '[…] ' : '';
    last = item.index;
    return gap + item.part;
  }).join(' ') + (last < parts.length - 1 ? ' […]' : '');
}

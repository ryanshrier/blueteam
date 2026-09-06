// Bounded source-input diagnostics. These classify the retained passage, not
// the truth of a publisher or the entailment of a generated claim.
const plain = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp);/gi, ' ').replace(/\s+/g, ' ').trim() : '';
const normalized = value => plain(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Duration units do not establish subject agreement: "zero-day" reporting
// must not make an unrelated "6-day course" advert look like article evidence.
const generic = new Set('a an the of for and or to in on from with by at as is are was were has have had it its this that these those new latest cyber cybersecurity security threat threats news report reports day days week weeks month months year years hour hours minute minutes second seconds'.split(' '));
const topicWords = value => new Set(normalized(value).split(' ').filter(word => word.length > 2 && !generic.has(word)));

/** Small concrete statements remain usable; length alone never rejects one. */
export function classifySourceEvidence({ title = '', passage = '' } = {}) {
  const body = plain(passage);
  const headline = plain(title);
  let residual = body;
  while (headline && (normalized(residual) === normalized(headline) || normalized(residual).startsWith(normalized(headline) + ' '))) {
    // Compare words rather than punctuation so repeated article headings do
    // not masquerade as an independent body passage.
    const count = normalized(headline).split(' ').length;
    const tokens = [...residual.matchAll(/[\p{L}\p{N}]+/gu)];
    const end = tokens[count - 1];
    if (!end) break;
    residual = residual.slice(end.index + end[0].length).replace(/^[\s:—–-]+/, '').trim();
  }
  const words = topicWords(headline);
  const overlap = [...topicWords(residual)].filter(word => words.has(word)).length;
  const concrete = /\bCVE-\d{4}-\d{3,7}\b|\b\d+\.\d+(?:\.\d+)*\b/i.test(residual);
  const interstitial = /^(?:advertisement\b|sponsored content\b|promoted content\b|(?:sign|log) in(?:[.!?]|$|\s+to\s+(?:continue|read|view))|enable javascript\b|accept (?:all )?cookies\b|cookie preferences\b|access denied\b|please (?:enable|verify)\b|checking your browser\b|just a moment\b|(?:this|the|requested) (?:page|article|content|resource) (?:is |was |has been )?(?:not available|unavailable|not found|removed)\b|(?:(?:we have|we've) )?updated (?:our|your) cookie preferences\b|(?:error\s*)?404\b)/i.test(residual);
  const promotion = /\b(?:register (?:now|today)|sign up|subscribe (?:now|today|to)|reserve your (?:seat|spot)|limited[- ]time|early[- ]bird|enroll (?:now|today)|book (?:a )?demo|free trial)\b|\b\d+[- ]day\b.{0,40}\b(?:course|training|workshop)\b/i.test(residual);
  let status; let reason;
  if (!normalized(residual)) { status = 'title-only'; reason = 'no-body-beyond-title'; }
  else if (interstitial || (promotion && overlap === 0 && !concrete)) { status = 'contaminated'; reason = interstitial ? 'interstitial-or-promotional-body' : 'off-topic-promotional-body'; }
  else if (!overlap && !concrete && !/\b[\p{L}]{3,}ed\b|\b(?:is|are|was|were|has|have|had|will|can|could|may|might|must|should|does|do|did|confirms?|confirmed|reports|reported|says|states|released|published|patched|fixed|affects?|affecting|exploited|observed|disclosed|found|detected|stole|stolen|compromised|available)\b/iu.test(residual)) {
    status = 'limited'; reason = 'unrelated-fragment-without-concrete-detail';
  } else { status = 'substantive'; reason = 'retained-body-detail'; }
  return Object.freeze({ status, substantive: status === 'substantive', reasons: Object.freeze([reason]) });
}

/** Choose one original passage from this publisher; never blend group members. */
export function selectSourcePassage(headline = {}) {
  const title = typeof headline.title === 'string' ? headline.title : '';
  let feed = typeof (headline.passage || headline.description) === 'string' ? (headline.passage || headline.description) : '';
  const article = headline.articleBody && !headline.articleStale ? selectOperationalExcerpt(String(headline.articleBody)) : '';
  let feedQuality = classifySourceEvidence({ title, passage: feed });
  let feedSourceRevisions;
  if (!feedQuality.substantive && headline.source && headline.link && Array.isArray(headline.sourceMembers)) {
    // A grouped/enriched headline can lose its original feed description. Only
    // recover its first exact publisher + article member and carry that member's
    // revision reference with it. Never borrow another source's body.
    const original = headline.sourceMembers.find(member => member.source === headline.source && member.link === headline.link);
    const retained = original?.passage || original?.description || '';
    const retainedQuality = classifySourceEvidence({ title, passage: retained });
    if (retainedQuality.substantive) {
      feed = retained; feedQuality = retainedQuality;
      feedSourceRevisions = Array.isArray(original.evidence) ? original.evidence : [];
    }
  }
  const selectedFeed = (passage = feed) => ({ passage, kind: 'feed-excerpt', quality: feedQuality,
    ...(feedSourceRevisions ? { sourceRevisions: feedSourceRevisions } : {}) });
  if (article) {
    const quality = classifySourceEvidence({ title, passage: article });
    if (quality.substantive) {
      // A longer original feed passage may preserve the mitigation section the
      // fetched opening omits. Never borrow another publisher's prose.
      const richerFeed = feedQuality.substantive && operationalScore(feed) > operationalScore(article);
      return richerFeed
        ? selectedFeed(selectOperationalExcerpt(feed))
        : { passage: article, kind: 'article-excerpts', quality };
    }
    if (feedQuality.substantive) return { ...selectedFeed(), excludedArticle: { passage: article, quality } };
    return { passage: '', kind: 'title-only', quality, excludedArticle: { passage: article, quality } };
  }
  return feedQuality.substantive ? selectedFeed() : { passage: '', kind: 'title-only', quality: feedQuality,
    ...(feed ? { excludedPassage: { passage: feed, quality: feedQuality } } : {}) };
}

const operationalPattern = /\b(?:mitigat|remediat|recover|re-?imag|re-?deploy|fixed|patched|affected|vulnerable|password|TOTP|compromis|indicator|support|requires? authentication|not rely|no public)\w*/gi;
function operationalScore(text) { return (String(text).match(operationalPattern) || []).length; }

/** Bounded verbatim excerpts, in source order, with omissions made explicit. */
export function selectOperationalExcerpt(value, budget = 4000) {
  const text = plain(value);
  if (text.length <= budget) return text;
  const parts = text.match(/[^.!?]+[.!?](?:\s|$)|[^.!?]+$/g) || [text];
  const ranked = parts.map((part, index) => ({ part: part.trim(), index, score: operationalScore(part) + (index < 2 ? 4 : 0) }));
  let remaining = budget - 32;
  const chosen = new Set();
  for (const item of [...ranked].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (item.part.length <= remaining && (item.score > 0 || chosen.size < 2)) { chosen.add(item.index); remaining -= item.part.length + 7; }
  }
  if (!chosen.size) return text.slice(0, budget - 2).replace(/\s+\S*$/, '') + '…';
  let last = -1;
  return ranked.filter(item => chosen.has(item.index)).map(item => {
    const gap = item.index > last + 1 ? '[…] ' : '';
    last = item.index;
    return gap + item.part;
  }).join(' ') + (last < parts.length - 1 ? ' […]' : '');
}

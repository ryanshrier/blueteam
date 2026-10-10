// Capacity is spent on reported developments before additional publisher copies.
// This grouping never merges source passages or establishes corroboration.
import { createHash } from 'node:crypto';
import { sourceUrlKey } from './grounding.js';
import { normalizeFeedTimestamp, mustKeepSeparateDevelopments } from './intelligence-context.js';
import { expandCveShorthand } from './cve-identities.js';
import { withinInvestigationBudget } from './investigation-budget.js';

const text = value => typeof value === 'string' ? value.slice(0, 8192) : '';
const normalized = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cves = value => [...new Set(expandCveShorthand(text(value)).match(/\bCVE-\d{4}-\d{3,7}\b/gi) || [])].map(id => id.toUpperCase()).sort();
const stop = new Set('the a an and of in to for on with by as from critical high flaw flaws vulnerability vulnerabilities unpatched exploited exploits exploitation active actively wild attacks attackers threat actors new security now'.split(' '));
const words = value => new Set(normalized(value).split(' ').filter(word => word.length > 3 && !stop.has(word)));

function identity(headline) {
  const title = text(headline?.title);
  const feed = text(headline?.description || headline?.passage?.text || headline?.passage);
  const ids = cves(title);
  return { title, description: feed, date: headline?.date || headline?.publishedAt || '',
    link: headline?.link || headline?.url || '', ids: ids.length ? ids : cves(feed.slice(0, 1200)),
    event: text(headline?.eventIdentity?.eventId), terms: words(title) };
}

function sameDevelopment(left, right) {
  const url = sourceUrlKey(left.link);
  if (url && url === sourceUrlKey(right.link)) return 'same-article';
  if (left.event && left.event === right.event) return 'captured-event';
  const a = normalizeFeedTimestamp(left.date), b = normalizeFeedTimestamp(right.date);
  if (!a || !b || Math.abs(Date.parse(a) - Date.parse(b)) > 3 * 86400_000) return '';
  if (mustKeepSeparateDevelopments(left, right)) return '';
  const followOn = /\b(?:bypass|new campaign|ransomware campaign|mitigation (?:fails|revised)|patch (?:fails|retracted|withdrawn)|new exploit chain|proof[ -]of[ -]concept|PoC|exploit (?:released|published))\b/i;
  if ((followOn.test(left.title) || followOn.test(right.title)) && normalized(left.title) !== normalized(right.title)) return '';
  if (left.ids.length && right.ids.length) {
    if (left.ids.length !== right.ids.length || left.ids.some((id, index) => id !== right.ids[index])) return '';
    return 'same-vulnerabilities-and-publication-window';
  }
  // A sparse feed may omit its IDs. Only a narrow product-specific report of
  // unpatched exploitation can match here; shared actor/vendor names cannot.
  const unpatchedExploitation = value => /\bunpatched\b/i.test(value) && /\bexploit(?:ed|s|ation)\b/i.test(value);
  if (unpatchedExploitation(left.title) && unpatchedExploitation(right.title)
    && [...left.terms].some(term => term.length >= 7 && right.terms.has(term))) return 'same-product-unpatched-exploitation';
  const shared = [...left.terms].filter(term => right.terms.has(term));
  if ((/\bunpatched\b/i.test(left.title) || /\bunpatched\b/i.test(right.title))
    && [left.title, right.title].every(title => /\bexploit(?:ed|s|ation)?\b/i.test(title))
    && shared.length >= 2 && shared.some(term => term.length >= 7)) return 'same-product-exploitation-and-consequence';
  return '';
}

/** Stable, conservative primary matching; no transitive bridge clustering. */
export function groupEvidenceEvents(headlines = []) {
  const groups = [];
  for (const [index, headline] of headlines.slice(0, 250).entries()) {
    const current = identity(headline);
    let basis = '';
    const group = groups.find(candidate => (basis = sameDevelopment(candidate.identity, current)));
    if (group) { group.members.push({ headline, index }); group.bases.add(basis); }
    else groups.push({ identity: current, members: [{ headline, index }], bases: new Set(['primary-report']),
      eventId: current.event || createHash('sha256').update(sourceUrlKey(current.link) || `${current.title}:${current.date}:${index}`).digest('hex') });
  }
  return groups.map(({ identity: _identity, bases, ...group }) => ({ ...group, bases: [...bases] }));
}

/** Round-robin distinct events, retaining input priority within each event. */
export function diversifyEvidenceRequests(headlines = []) {
  const groups = groupEvidenceEvents(headlines);
  const ordered = [];
  for (let round = 0; ordered.length < headlines.length; round++) {
    const batch = groups.flatMap(group => group.members[round] ? [group.members[round].headline] : []);
    if (!batch.length) break;
    ordered.push(...batch);
  }
  return ordered;
}

/** Preserve exploration reservations without reserving a second copy of an event. */
export function budgetEvidenceRequests(headlines = [], budget = 10) {
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  if (!limit) return [];
  const groups = groupEvidenceEvents(headlines);
  const representatives = groups.map(group => (group.members.find(member => !member.headline.selectionInvestigation) || group.members[0]).headline);
  const first = withinInvestigationBudget(representatives, limit);
  if (first.length >= limit) return first;
  const chosen = new Set(first);
  return [...first, ...withinInvestigationBudget(diversifyEvidenceRequests(headlines).filter(headline => !chosen.has(headline)), limit - first.length)];
}

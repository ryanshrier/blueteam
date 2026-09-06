// Declared operator interests, never an inventory or proof of exposure.
// Pure helpers are shared by settings, scoring, evidence inspection and manifests.
export const WATCH_PROFILE_VERSION = 1;
export const WATCH_PROFILE_LIMITS = Object.freeze({
  technologies: { count: 25, length: 64 },
  sectors: { count: 20, length: 128 },
  regions: { count: 100, length: 128 },
  intelligenceQuestions: { count: 100, length: 300 },
  exclusions: { count: 25, length: 64 },
});
const clean = value => [...value].filter(ch => ch.codePointAt(0) > 31 && ch.codePointAt(0) !== 127).join('').trim();
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function normalizeList(value, { count, length }) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(v => typeof v === 'string').map(v => clean(v).slice(0, length))
    .filter(v => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase())).slice(0, count);
}

// Preserve absent fields as absent: explicit empty arrays clear a watch, while
// an omitted field keeps its previous value or legacy/config fallback.
export function sanitizeWatchProfile(input) {
  const out = {};
  if (!isObject(input)) return out;
  for (const [key, limits] of Object.entries(WATCH_PROFILE_LIMITS)) {
    if (Object.hasOwn(input, key)) out[key] = normalizeList(input[key], limits);
  }
  if (Object.hasOwn(input, 'teamProfile')) out.teamProfile = typeof input.teamProfile === 'string' ? clean(input.teamProfile).slice(0, 512) : '';
  if (Object.hasOwn(input, 'preferredHorizons')) {
    out.preferredHorizons = Array.isArray(input.preferredHorizons)
      ? [...new Set(input.preferredHorizons.filter(v => [1, 2, 3].includes(v)))] : [];
  }
  return out;
}

export function validateWatchProfile(input) {
  if (!isObject(input)) return { error: 'watchProfile must be an object.' };
  const allowed = new Set([...Object.keys(WATCH_PROFILE_LIMITS), 'schemaVersion', 'teamProfile', 'preferredHorizons']);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) return { error: `Unknown watchProfile field: ${unknown}.` };
  if (input.schemaVersion !== undefined && input.schemaVersion !== WATCH_PROFILE_VERSION) return { error: 'Unsupported watchProfile schemaVersion.' };
  for (const [key, { count, length }] of Object.entries(WATCH_PROFILE_LIMITS)) {
    if (!Object.hasOwn(input, key)) continue;
    if (!Array.isArray(input[key]) || input[key].some(v => typeof v !== 'string')) return { error: `watchProfile.${key} must be an array of strings.` };
    if (input[key].length > count) return { error: `watchProfile.${key} allows at most ${count} entries.` };
    if (input[key].some(v => clean(v).length > length)) return { error: `Each watchProfile.${key} entry must be ${length} characters or fewer.` };
  }
  if (Object.hasOwn(input, 'teamProfile') && (typeof input.teamProfile !== 'string' || input.teamProfile.length > 512)) return { error: 'watchProfile.teamProfile must be a string of 512 characters or fewer.' };
  if (Object.hasOwn(input, 'preferredHorizons') && (!Array.isArray(input.preferredHorizons) || input.preferredHorizons.length > 3 || input.preferredHorizons.some(v => ![1, 2, 3].includes(v)))) return { error: 'watchProfile.preferredHorizons must contain only horizon numbers 1, 2, or 3.' };
  return { watchProfile: sanitizeWatchProfile(input) };
}

export function getEffectiveWatchProfile(config = {}, settings = {}) {
  const org = config?.organization || {};
  const fallback = {
    technologies: [],
    sectors: org.sector ? [org.sector] : [],
    regions: org.regions || [],
    intelligenceQuestions: org.watchTopics || [],
    exclusions: [],
    preferredHorizons: [],
    teamProfile: org.profile || '',
  };
  const legacy = {};
  if (Object.hasOwn(settings || {}, 'watchTerms')) legacy.technologies = settings.watchTerms;
  const savedOrg = settings?.organization || {};
  if (savedOrg.sector) legacy.sectors = [savedOrg.sector];
  if (savedOrg.regions?.length) legacy.regions = savedOrg.regions;
  if (savedOrg.profile) legacy.teamProfile = savedOrg.profile;
  const declared = sanitizeWatchProfile(settings?.watchProfile);
  const configured = sanitizeWatchProfile(config?.watchProfile);
  const inherited = sanitizeWatchProfile(legacy);
  const provenance = Object.fromEntries(Object.keys(fallback).map(field => [field,
    Object.hasOwn(declared, field) ? 'operator-declared'
      : Object.hasOwn(inherited, field) ? 'legacy-operator-setting'
        : Object.hasOwn(configured, field) ? 'server-profile' : 'server-default',
  ]));
  return {
    schemaVersion: WATCH_PROFILE_VERSION,
    ...sanitizeWatchProfile(fallback),
    ...configured, ...inherited, ...declared,
    provenance,
  };
}

export function evaluateApplicability(headline, profile) {
  const normalized = getEffectiveWatchProfile({ watchProfile: profile });
  // Match only the original retained feed observations the inspector can show.
  // Enriched article openings have no retained revision yet, and joined display
  // descriptions must not manufacture a term across two distinct sources.
  const members = Array.isArray(headline?.sourceMembers) && headline.sourceMembers.length
    ? headline.sourceMembers : [headline];
  const fieldsInEvidence = ['title', 'description', 'passage'];
  const content = members.map(member => Object.fromEntries(fieldsInEvidence.map(field => [
    field, typeof member?.[field] === 'string' ? member[field].slice(0, 8192).toLowerCase() : '',
  ])));
  const findMatches = fields => fields.flatMap(field => normalized[field].map(term => ({
    field, term, in: fieldsInEvidence.filter(key => content.some(member => member[key].includes(term.toLowerCase()))),
  })).filter(match => match.in.length));
  const matches = findMatches(['technologies', 'sectors', 'regions']);
  const exclusionMatches = findMatches(['exclusions']);
  const questionStopWords = new Set('what which where when who how why does do did is are was were be been have has had the a an and or for of to in on at with our us we this that these those affect affects affecting threat threats risk risks organization environment security relevant monitor track about could should would can any new'.split(' '));
  const questionMatches = normalized.intelligenceQuestions.flatMap(question => {
    const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+.\-]{2,}/gu) || [])]
      .filter(term => !questionStopWords.has(term)).slice(0, 20);
    const matchedTerms = terms.filter(term => content.some(member => fieldsInEvidence.some(field => member[field].includes(term))));
    const exact = content.some(member => fieldsInEvidence.some(field => member[field].includes(question.toLowerCase())));
    return exact || (terms.length > 1 && matchedTerms.length >= Math.max(2, Math.ceil(terms.length / 2)))
      ? [{ field: 'intelligenceQuestions', term: question, matchedTerms, method: exact ? 'literal-match' : 'question-term-overlap' }] : [];
  });
  return {
    state: matches.length ? 'declared-match' : 'unknown',
    exposure: 'unknown',
    method: 'literal-match',
    matches,
    questionMatches,
    questionRelevance: questionMatches.length ? 'matched' : 'unknown',
    questionExplanation: 'Question relevance uses retained-text overlap, not a semantic assessment or proof of deployment.',
    exclusionMatches,
    preferredHorizon: normalized.preferredHorizons.includes(headline?.horizon),
    explanation: matches.length
      ? 'Reporting mentions a declared watch term. A literal match does not establish an affected version, local deployment, exposure, or mitigation.'
      : 'No declared technology, sector, or region term was found in the retained text. Local applicability remains unknown.',
  };
}

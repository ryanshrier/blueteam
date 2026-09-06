// Display composition preserves authored actions and uses only explicitly
// reviewed summaries. Viewport measurement decides whether a response must split.
import { executiveSummaryModel, actionDisplayModel, usableKevRecords, cleanSummary } from './wall-format.js';

export const DISPLAY_DEFAULTS = Object.freeze({ size: 'standard', margin: 'normal', speed: 'normal', playlist: 'balanced', feedSeconds: 90, holdSeconds: 0, dim: false, dimStart: 1, dimEnd: 5, maintenance: false, maintenanceHour: 4, fullscreen: true, awake: true });
export const DISPLAY_STORAGE_KEY = 'bt-wall-display';
let sessionDisplaySettings = null;
const allowed = (value, choices, fallback) => choices.includes(value) ? value : fallback;
export function normalizeDisplaySettings(value = {}) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    size: allowed(value.size, ['standard', 'large', 'largest'], 'standard'),
    margin: allowed(value.margin, ['normal', 'safe', 'wide'], 'normal'),
    speed: allowed(value.speed, ['slow', 'normal', 'fast'], 'normal'),
    playlist: allowed(value.playlist, ['balanced', 'assessment', 'updates'], 'balanced'),
    feedSeconds: allowed(Number(value.feedSeconds), [60, 90, 120], 90),
    holdSeconds: allowed(Number(value.holdSeconds), [0, 60, 120, 300], 0),
    dim: value.dim === true, dimStart: hour(value.dimStart, 1), dimEnd: hour(value.dimEnd, 5),
    maintenance: value.maintenance === true, maintenanceHour: hour(value.maintenanceHour, 4), fullscreen: value.fullscreen !== false, awake: value.awake !== false,
  };
}
const hour = (value, fallback) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 23 ? Number(value) : fallback;
export function inDimWindow(hour, start, end) { return start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end); }
export function loadDisplaySettings(storage = null) {
  if (sessionDisplaySettings) return { ...sessionDisplaySettings };
  try { return normalizeDisplaySettings(JSON.parse((storage ?? globalThis.localStorage).getItem(DISPLAY_STORAGE_KEY) || '{}')); }
  catch { return { ...DISPLAY_DEFAULTS }; }
}
export function persistDisplaySettings(value, storage = null) {
  const settings = normalizeDisplaySettings(value);
  try {
    (storage ?? globalThis.localStorage).setItem(DISPLAY_STORAGE_KEY, JSON.stringify(settings));
    sessionDisplaySettings = null;
    return { settings, persisted: true };
  } catch {
    sessionDisplaySettings = { ...settings };
    return { settings, persisted: false };
  }
}
export function saveDisplaySettings(value) { return persistDisplaySettings(value).settings; }

export function splitDisplayText(text, limit = 58) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source)].map(item => item.segment.trim())
    : source.split(/(?<=[.!?])\s+(?=[A-Z“"'])/);
  const parts = [];
  for (const sentence of sentences) {
    const last = parts.at(-1);
    if (last && wordCount(last) + wordCount(sentence) <= limit) parts[parts.length - 1] += ` ${sentence}`;
    else parts.push(sentence);
  }
  // A short terminal sentence belongs with its preceding thought, even if that
  // exceeds the preferred word target. Overflow uses the readable continuation
  // viewport; typography and authored meaning are never sacrificed to a cap.
  if (parts.length > 1 && wordCount(parts.at(-1)) < 12) parts[parts.length - 2] += ` ${parts.pop()}`;
  return parts;
}
const wordCount = value => String(value || '').trim().split(/\s+/).filter(Boolean).length;

/** A source excerpt may be clipped; do not promote its dangling tail to a screen. */
export function completeSourceExcerpt(value, fallback = '') {
  const text = cleanSummary(value).trim();
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(item => item.segment.trim())
    : text.split(/(?<=[.!?])\s+(?=[A-Z“"'])/);
  return sentences.find(sentence => /[.!?][”"')\]]*$/.test(sentence) && !/(?:…|\.\.\.)[”"')\]]*$/.test(sentence)) || fallback;
}

export function storyActions(story) {
  if (Array.isArray(story?.actions) && story.actions.length) return story.actions;
  const legacy = actionDisplayModel(story?.actionShift);
  return legacy.imperative ? [{ ...legacy, targetType: 'recommended', id: 'legacy-action', text: [legacy.owner, legacy.imperative, legacy.target].filter(Boolean).join(' — ') }] : [];
}
export function displayDwellMs(text, speed = 'normal') {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const wpm = { slow: 145, normal: 185, fast: 230 }[speed] || 185;
  return Math.max(12_000, Math.ceil(5000 + words / wpm * 60_000));
}

// Identity is independent of which visible sentence happens to contain a CVE.
export function topicCves(story = {}) {
  const text = [story.title, story.kevCVE, story.whatHappened, story.assessment,
    ...(story.actions || []).map(action => action.text || action.imperative)].filter(Boolean).join(' ');
  return [...new Set(text.match(/CVE-\d{4}-\d{4,}/gi) || [])].map(value => value.toUpperCase());
}
const articleIdentity = value => {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
  }
  catch { return ''; }
};

export function presentationReadingText(page) {
  return [page.topic, page.coverTitle, ...(page.priorities || []), page.block?.text, page.condition, page.timing, page.federalDue,
    ...(page.actions || []).flatMap(action => [action.owner, action.imperative || action.text, action.target,
      action.condition, action.dependencies, action.initiationTrigger, action.evidence, action.completionCriterion, action.recoverySteps])]
    .filter(Boolean).join(' ');
}

// Called only after the complete topic has failed its actual viewport fit.
// Semantic action records remain intact, including recovery and completion.
export function splitResponsePage(page) {
  if (!page.actions || page.actions.length < 2) return [page];
  return page.actions.map((action, part) => ({ ...page, actions: [action], part, parts: page.actions.length,
    block: { ...page.block, label: action.owner || 'Owned response' } }));
}
export const pageKey = page => page.key || `${page.kind}:${page.idx ?? ''}:${page.part ?? ''}`;
export const topicKey = page => page?.bundle || `${page?.kind}:${page?.idx ?? ''}`;
export const isEligibleWallEdition = value => value?.disposition?.eligibleForLatest !== false
  && !['review-required', 'superseded'].includes(value?.disposition?.status);
export const kindLabel = kind => ({ bluf: 'BLUF', execsummary: 'Executive summary', judgment: 'Judgment', developing: 'Developing', convergence: 'Convergence', watchlist: 'Watchlist', kev: 'KEV', wire: 'Wire', brieferror: 'Briefing status', empty: 'Status' }[kind] || 'Wall');
export function topicLabel(page, doc, landscape) {
  const topic = page.topic || ({ judgment: doc?.stories?.[page.idx]?.title, convergence: doc?.convergence?.[page.idx]?.title, developing: 'Situations and tripwires', execsummary: 'Threat, exposure and decisions', bluf: 'Bottom line', kev: 'Confirmed exploited · catalog additions', wire: 'Current retained signals', watchlist: 'What to watch' }[page.kind]) || '';
  const short = topic.length > 95 ? `${topic.slice(0, 92).replace(/\s+\S*$/, '')}…` : topic;
  return `${kindLabel(page.kind)}${short ? ` · ${short}` : ''}${page.parts > 1 ? ` · ${page.part + 1}/${page.parts}` : ''}`;
}
// Accept the shared schema's exact heading identities and retain object-form
// anchors for a held view created before a schema transition.
export function readerFragment(page, anchors = {}) {
  if (page.kind === 'judgment') return `#judgment-${page.idx + 1}`;
  const prefix = { execsummary: /^EXECUTIVE SUMMARY/i, developing: /^DEVELOPING/i, convergence: /^CONVERGENCE/i, watchlist: /^WATCHLIST/i }[page.kind];
  const id = Array.isArray(anchors) ? (prefix && anchors.find(item => prefix.test(item.label))?.id) : anchors[page.kind];
  return id ? `#${id}` : '';
}

export function buildPresentationPages(doc, landscape, settings = DISPLAY_DEFAULTS, { briefLoadError = false } = {}) {
  const pages = [];
  if (doc && !isEligibleWallEdition(doc)) { pages.push({ kind: 'briefexcluded' }); doc = null; }
  const add = (kind, idx, topic, fields, extra = {}) => {
    const blocks = fields.filter(item => item?.text);
    if (blocks.length) pages.push({ kind, idx, topic, part: 0, parts: 1, bundle: `${kind}:${idx}`,
      block: { label: blocks[0].label, text: blocks.map(item => item.text).join(' ') }, ...extra });
  };
  const presentation = doc?.review?.presentation?.status === 'reviewed' ? doc.review.presentation : null;
  if (briefLoadError) pages.push({ kind: 'brieferror' });
  if (doc && settings.playlist !== 'updates') {
    add('bluf', 0, 'Shift assessment', [{ text: presentation?.bluf || doc.bluf }], {
      coverTitle: presentation?.judgments?.find(item => item.index === 0 && item.originalTitle === doc.stories?.[0]?.title)?.title || doc.stories?.[0]?.title || 'Shift assessment',
      priorities: (doc.stories || []).slice(1, 4).map(story => story.title),
    });
    // The primary cycle features the complete judgment response. Executive
    // restatements remain in operator mode instead of repeating those actions.
    if (!(doc.stories || []).length) {
      const model = executiveSummaryModel(doc.execSummary);
      [model.threat, model.exposure, ...model.context].filter(Boolean).forEach((item, i) => add('execsummary', i, item.label, [{ text: item.text }]));
      model.decisions.forEach((item, i) => add('execsummary', i + 100, `Decision · ${item.owner}`, [{ text: item.action }], { timing: item.deadline }));
    }
    (doc.stories || []).forEach((story, idx) => {
      if (!story?.title) return;
      const actions = storyActions(story);
      const edited = presentation?.judgments?.find(item => item.index === idx && item.originalTitle === story.title);
      const context = edited?.summary || story.line || story.assessment || '';
      pages.push({ kind: 'judgment', idx, topic: edited?.title || story.title, bundle: story.id || `judgment:${idx}`, part: 0, parts: 1,
        block: { label: 'Assessment', text: context }, actions, actionCount: actions.length,
        decision: story.decision, editionDate: doc.date, certainty: story.confidence, citations: story.citations,
        isKEV: story.isKEV, cve: story.kevCVE, cves: topicCves(story),
        coveredReports: edited?.coveredReports || [],
      });
    });
    (doc.convergence || []).forEach((item, idx) => {
      pages.push({ kind: 'convergence', idx, topic: item.title, bundle: `convergence:${idx}`, part: 0, parts: 1,
        block: { label: 'Hypothesis', text: item.cascade || item.intersection || '' }, condition: item.confirmation,
        actions: item.move ? [{ owner: item.moveVerb || 'Recommended move', imperative: item.move, text: item.move }] : [], citations: item.citations,
      });
    });
  }
  if (doc && settings.playlist !== 'assessment') {
    (doc.developing || []).forEach((item, idx) => {
      const edited = presentation?.developing?.find(entry => entry.index === idx && entry.originalTitle === item.name);
      add('developing', idx, edited?.title || item.name, [
        { label: item.trajectory || 'Tracking', text: edited?.summary || item.trajectoryDetail || item.watch },
      ], { condition: edited?.condition || item.watch, citations: item.citations });
    });
    // Watchlist conditions remain completely available inside Wall. They join
    // the unattended loop only in the explicitly selected updates playlist.
    if (settings.playlist === 'updates') (doc.watchlist || []).forEach((text, idx) => add('watchlist', idx, 'Watch condition', [{ label: 'Escalation condition', text }], { validity: doc.watchlistMetadata?.validityText }));
  }
  // KEV and Wire remain in all playlists. Cadence below also interjects them
  // while a long assessment is being read; freshness is still a separate label.
  const featuredStories = settings.playlist !== 'updates' ? doc?.stories || [] : [];
  const featuredCves = new Set(featuredStories.flatMap(topicCves));
  const catalog = usableKevRecords(landscape?.kev);
  for (const page of pages.filter(item => item.kind === 'judgment')) {
    page.catalogEntries = catalog.filter(item => page.cves?.includes(item.cve));
  }
  const featuredArticles = new Set(pages.flatMap(page => (page.citations || []).map(item => articleIdentity(item.url))).filter(Boolean));
  // Explicit editorial matches cover reports without identifiers. Bind the
  // exact publication timestamp so later versions can re-enter the loop.
  const coveredReports = pages.flatMap(page => page.coveredReports || []);
  const briefTime = Date.parse(doc?.generatedAt || doc?.date || '');
  const selectedKev = catalog.filter(item => !featuredCves.has(item.cve)
    || (Number.isFinite(briefTime) && Date.parse(item.dateAdded) > briefTime)).slice(0, 3);
  selectedKev.forEach((item, idx) => add('kev', idx, `${item.product || item.vendor || 'Product'}: known exploitation`, [
    { label: 'Exploitation confirmed by CISA', text: item.name || `${item.vendor || ''} ${item.product || ''}` },
  ], { vendor: item.vendor, cve: item.cve, added: item.dateAdded, federalDue: item.dueDate,
    condition: item.requiredAction || 'Check affected versions and deployment. Apply the vendor mitigation or fix where applicable.' }));
  const catalogCves = new Set(selectedKev.map(item => item.cve));
  const seenArticles = new Set(), seenCves = new Set();
  const signals = (landscape?.signals || []).filter(item => {
    if (!item?.title || featuredArticles.has(articleIdentity(item.link))) return false;
    if (coveredReports.some(report => articleIdentity(report.url) === articleIdentity(item.link)
      && Date.parse(report.publishedAt) === Date.parse(item.date))) return false;
    const identities = topicCves({ title: item.title, kevCVE: item.kevCVE, whatHappened: item.description });
    const later = Number.isFinite(briefTime) && Date.parse(item.date) > briefTime;
    if (identities.length && !identities.some(cve => !catalogCves.has(cve) && (!featuredCves.has(cve) || later))) return false;
    const article = articleIdentity(item.link);
    if ((article && seenArticles.has(article)) || (identities.length && identities.every(cve => seenCves.has(cve)))) return false;
    if (article) seenArticles.add(article);
    identities.forEach(cve => seenCves.add(cve));
    return true;
  }).slice(0, 2);
  signals.forEach((item, idx) => {
    const excerpt = completeSourceExcerpt(item.displayExcerpt || item.description);
    add('wire', idx, item.editorialContext?.title || item.title, [
      { label: excerpt ? 'Retained reporting · excerpt' : 'Reporting headline · complete excerpt unavailable', text: excerpt || item.title },
    ], { source: item.source, sourceUrl: item.link, sourceDate: item.date, cve: item.kevCVE, signalKey: item.link || item.title, isKEV: item.isKEV, selectionIndex: idx + 1, selectionCount: signals.length });
  });
  return pages.length ? pages : [{ kind: 'empty' }];
}

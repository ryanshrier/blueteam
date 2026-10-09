// Display composition preserves authored records and uses saved short copy.
// The glance projection never turns a qualified procedure into an isolated task.
import { executiveSummaryModel, executiveTargetModel, actionDisplayModel, usableKevRecords, cleanSummary } from './wall-format.js';
import { formatDecisionWindow, judgmentCertainty } from '/vendor/brief-schema.js';

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
  let candidate = '';
  for (const sentence of sentences) {
    // Sentence segmenters can stop after "The U.S." or a person's initial.
    // Retain those words with their continuation instead of publishing a stub.
    if (/(?:…|\.\.\.)[”"')\]]*$/.test(sentence)) { candidate = ''; continue; }
    candidate = [candidate, sentence].filter(Boolean).join(' ');
    const end = candidate.replace(/[”"')\]]+$/, '');
    const abbreviation = /(?:\b(?:[A-Za-z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Fig|Inc|Ltd|Co|Corp)\.|(?:^|\s)[A-Z]\.)$/i.test(end);
    if (/[.!?][”"')\]]*$/.test(candidate) && !abbreviation) return candidate;
  }
  // An abbreviation can also legitimately end the final retained sentence.
  // Reject only an obvious standalone abbreviation/initial stub here; do not
  // discard "The campaign targeted organizations in the U.S." for its ending.
  const unwrapped = candidate.replace(/^[“"'(\[]+|[”"')\]]+$/g, '');
  const abbreviationStub = /^(?:(?:the|a|an)\s+)?(?:(?:[a-z]\.){2,}|(?:(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Fig|Inc|Ltd|Co|Corp|[a-z])\.\s*)+)$/i.test(unwrapped);
  if (/[.!?][”"')\]]*$/.test(candidate) && !abbreviationStub) return candidate;
  return fallback;
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

export function buildGlanceModel(page = {}) {
  const text = value => typeof value === 'string' ? value : '';
  const model = { label: text(page.block?.label) || 'Saved assessment', headline: text(page.topic),
    summary: text(page.block?.text), summaryLabel: 'The takeaway', railLabel: 'At a glance', facts: [], related: [] };
  const fact = (label, value) => { if (text(value).trim()) model.facts.push({ label, value: text(value).trim() }); };
  const cve = value => /^CVE-\d{4}-\d{4,}$/i.test(text(value)) ? value.toUpperCase() : '';
  const catalogFact = (includeEntries = true) => {
    const ids = [...new Set([...(page.isKEV === true ? [cve(page.cve)] : []),
      ...(includeEntries ? page.catalogEntries || [] : []).map(item => cve(item.cve))].filter(Boolean))];
    if (ids.length) fact('CISA KEV', ids.join(' · '));
    return ids;
  };
  switch (page.kind) {
    case 'bluf':
      model.label = 'Lead story';
      model.headline = text(page.coverTitle) || model.headline;
      model.summary = text(page.coverSummary) || model.summary;
      model.railLabel = 'Also in this briefing';
      model.related = (page.priorities || []).filter(value => text(value).trim());
      break;
    case 'judgment': {
      model.label = 'Key judgment';
      model.railLabel = 'Response brief';
      const owners = [...new Set((page.actions || []).map(action => text(action.owner).trim()).filter(Boolean))];
      fact('Response owners', owners.join(' · '));
      if (text(page.decision).trim()) {
        const window = formatDecisionWindow(page.decision);
        fact('Decision window', `${window.display}${window.relative && text(page.editionDate) ? ` · from ${page.editionDate} briefing` : ''}`);
      }
      const certainty = judgmentCertainty(page.certainty);
      fact(certainty.label, certainty.value);
      const catalogIds = new Set(catalogFact());
      const references = [...new Set((Array.isArray(page.cves) ? page.cves : []).map(cve)
        .filter(id => id && !catalogIds.has(id)))];
      fact(references.length === 1 ? 'Referenced CVE' : 'Referenced CVEs', references.join(' · '));
      break;
    }
    case 'developing':
      model.label = 'Developing situation';
      model.summaryLabel = 'What we know';
      model.railLabel = 'Tracking';
      if (text(page.trajectory).trim().toLowerCase() !== 'uncertain') fact('Trajectory', page.trajectory);
      break;
    case 'convergence':
      model.label = 'Analyst hypothesis';
      model.summaryLabel = 'Possible connection';
      model.summary = text(page.glimpseSummary) || model.summary;
      break;
    case 'kev':
      model.label = 'Known exploitation';
      model.headline = model.summary.trim() ? model.summary : text(page.productIdentity) || model.headline.replace(/: known exploitation$/, '');
      model.summary = '';
      model.summaryLabel = '';
      model.railLabel = 'Catalog record';
      fact('CVE', cve(page.cve));
      fact('Catalog added', page.added);
      fact('Federal civilian deadline', text(page.federalDue) ? `${page.federalDue} · FCEB scope` : '');
      break;
    case 'wire':
      model.summary = page.sourceExcerpt !== undefined ? text(page.sourceExcerpt)
        : /unavailable/i.test(text(page.block?.label)) || model.summary === 'A complete retained excerpt is unavailable.' ? '' : model.summary;
      model.label = model.summary ? 'Source reporting' : 'Headline only';
      model.summaryLabel = model.summary ? 'From the report' : '';
      model.railLabel = 'Report context';
      catalogFact(false);
      break;
    case 'watchlist': {
      model.label = 'Watch for';
      model.summaryLabel = 'Watch condition';
      model.railLabel = 'Watch window';
      fact('Watch validity', page.validity);
      const normalized = model.summary.replace(/\s+/g, ' ').trim();
      const trigger = completeSourceExcerpt(normalized);
      // Promote only an intact opening sentence. Later qualifications remain
      // visible, and excerpts that skip or rewrite the beginning cannot move.
      if (trigger && wordCount(trigger) <= 40 && normalized.startsWith(trigger)) {
        model.headline = trigger;
        model.summary = normalized.slice(trigger.length).trim();
        model.summaryLabel = model.summary ? 'Context' : '';
      }
      break;
    }
    case 'execsummary': {
      model.label = 'Executive summary';
      const target = executiveTargetModel(page.timing);
      fact(target.label, target.value);
      if (model.summary.trim() && wordCount(model.summary) <= 20) {
        model.label = ['Executive summary', model.headline].filter(Boolean).join(' · ');
        model.headline = model.summary;
        model.summary = '';
        model.summaryLabel = '';
      }
      break;
    }
  }
  return model;
}

export function presentationReadingText(page) {
  const model = buildGlanceModel(page);
  return [model.label, model.headline, ...(model.summary ? [model.summaryLabel, model.summary] : []),
    ...(model.facts.length > 1 || model.related.length ? [model.railLabel] : []),
    ...model.facts.flatMap(item => [item.label, item.value]), ...model.related].filter(Boolean).join(' ');
}

// Called only after the complete topic has failed its actual viewport fit.
// Semantic action records remain intact, including recovery and completion.
export function splitResponsePage(page) {
  if (!page.actions || page.actions.length < 2) return [page];
  return page.actions.map((action, part) => ({ ...page, actions: [action], part, parts: page.actions.length,
    block: { ...page.block, label: 'Recommended response' } }));
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

// Plain dated references have no saved URL. Move a complete terminal citation
// run only; a mixed or ambiguous tail stays in the authored explanation.
export function splitDevelopingSourceTail(value, citations = []) {
  const text = String(value || '');
  const saved = Array.isArray(citations) ? citations : [];
  const reference = token => {
    const plain = /^\[([^\[\],\r\n]{1,120}), (\d{4}-\d{2}-\d{2})\]$/.exec(token);
    if (plain) {
      const date = new Date(`${plain[2]}T00:00:00Z`);
      if (/^[\p{L}\p{N}][\p{L}\p{N} &'’()./+:-]*$/u.test(plain[1])
        && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === plain[2]) {
        return { label: `${plain[1]}, ${plain[2]}`, url: '' };
      }
      return null;
    }
    return saved.find(item => item.label === token) || null;
  };
  for (const boundary of text.matchAll(/[.!?]["'”’)]{0,2}\s+/g)) {
    const start = boundary.index + boundary[0].length;
    const sources = text.slice(start).trim().split(/\s+·\s+/).map(reference);
    if (!sources.length || sources.some(item => !item)) continue;
    const combined = [...sources, ...saved];
    return { text: text.slice(0, start).trimEnd(), citations: combined.filter((item, index) =>
      combined.findIndex(other => other.label === item.label && other.url === item.url) === index) };
  }
  return { text, citations: saved };
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
    const lead = doc.stories?.[0];
    const editedLead = presentation?.judgments?.find(item => item.index === 0 && item.originalTitle === lead?.title);
    add('bluf', 0, 'Shift assessment', [{ text: presentation?.bluf || doc.bluf }], {
      coverTitle: editedLead?.title || lead?.title || 'Shift assessment',
      coverSummary: editedLead?.summary || lead?.line || presentation?.bluf || doc.bluf,
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
        block: { label: 'Recommended response', text: context }, actions, actionCount: actions.length,
        decision: story.decision, editionDate: doc.date, certainty: story.confidence, citations: story.citations,
        isKEV: story.isKEV, cve: story.kevCVE, cves: topicCves(story),
        coveredReports: edited?.coveredReports || [],
      });
    });
    (doc.convergence || []).forEach((item, idx) => {
      pages.push({ kind: 'convergence', idx, topic: item.title, bundle: `convergence:${idx}`, part: 0, parts: 1,
        block: { label: 'Hypothesis', text: item.cascade || item.intersection || '' }, condition: item.confirmation,
        glimpseSummary: item.intersection || item.cascade || '',
        actions: item.move ? [{ owner: item.moveVerb || 'Recommended move', imperative: item.move, text: item.move }] : [], citations: item.citations,
      });
    });
  }
  if (doc && settings.playlist !== 'assessment') {
    (doc.developing || []).forEach((item, idx) => {
      const edited = presentation?.developing?.find(entry => entry.index === idx && entry.originalTitle === item.name);
      const detail = String(item.trajectoryDetail || '');
      const prefix = /^\s*([A-Za-z]+)\s*[—–]\s*/.exec(detail);
      // Move only the repeated state into its labeled field. Keep the entire
      // explanation, unrecognized prose, and any approved display summary.
      const explanation = item.trajectory && prefix?.[1].toLowerCase() === item.trajectory.toLowerCase()
        ? detail.slice(prefix[0].length).replace(/^(a|an|the)(?=\s)/, article => article[0].toUpperCase() + article.slice(1)) : detail;
      const display = splitDevelopingSourceTail(explanation, item.citations);
      add('developing', idx, edited?.title || item.name, [
        { label: 'Developing situation', text: edited?.summary || display.text || item.watch },
      ], { trajectory: item.trajectory || '', condition: edited?.condition || item.watch, citations: display.citations });
    });
    // Watchlist conditions remain completely available inside Wall. They join
    // the unattended loop only in the explicitly selected updates playlist.
    if (settings.playlist === 'updates') {
      const entries = doc.watchlistEntries?.length ? doc.watchlistEntries : (doc.watchlist || []).map(text => ({ text }));
      entries.forEach((item, idx) => add('watchlist', idx, 'Watch condition', [{ label: 'Escalation condition', text: item.text }], {
        validity: doc.watchlistMetadata?.validityText, citations: item.citations || [],
      }));
    }
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
  selectedKev.forEach((item, idx) => {
    const vendor = String(item.vendor || '').trim(), product = String(item.product || '').trim();
    const vendorPattern = vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const includesVendor = vendor && new RegExp(`(?:^|[^a-z0-9])${vendorPattern}(?:$|[^a-z0-9])`, 'i').test(product);
    const identity = (includesVendor ? product : [vendor, product].filter(Boolean).join(' ')) || 'Product';
    add('kev', idx, `${identity}: known exploitation`, [
      { label: 'Exploitation confirmed by CISA', text: item.name || identity },
    ], { productIdentity: identity, vendor: item.vendor, cve: item.cve, added: item.dateAdded, federalDue: item.dueDate,
      condition: item.requiredAction || 'Check affected versions and deployment. Apply the vendor mitigation or fix where applicable.' });
  });
  const catalogCves = new Set(selectedKev.map(item => item.cve));
  const seenArticles = new Set(), seenCves = new Set();
  const signals = (landscape?.signals || []).filter(item => {
    if (!item?.title) return false;
    const updatedCapture = Number.isFinite(briefTime) && item.evidence?.some(source => source.changed
      && Date.parse(source.retrievedAt) > briefTime);
    const later = Number.isFinite(briefTime) && (Date.parse(item.date) > briefTime || updatedCapture);
    if (featuredArticles.has(articleIdentity(item.link)) && !later) return false;
    if (coveredReports.some(report => articleIdentity(report.url) === articleIdentity(item.link)
      && Date.parse(report.publishedAt) === Date.parse(item.date)) && !updatedCapture) return false;
    const identities = topicCves({ title: item.title, kevCVE: item.kevCVE, whatHappened: item.description });
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
      { label: excerpt ? 'Retained reporting · excerpt' : 'Reporting headline · complete excerpt unavailable', text: excerpt || 'A complete retained excerpt is unavailable.' },
    ], { sourceExcerpt: excerpt, source: item.source, sourceUrl: item.link, sourceDate: item.date, cve: item.kevCVE, signalKey: item.link || item.title, isKEV: item.isKEV, selectionIndex: idx + 1, selectionCount: signals.length });
  });
  return pages.length ? pages : [{ kind: 'empty' }];
}

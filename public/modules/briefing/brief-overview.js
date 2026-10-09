// Editorial overview of a saved edition. Current reporting has its own clock
// and request lifecycle; it never mutates the edition or its assessment times.
import { parseBrief, judgmentCertainty, stripMd, sourceCitations, section } from '/vendor/brief-schema.js';
import { escapeHtml } from '../core/sanitize.js';
import { renderAssessmentMeta, assessmentSources } from '../core/assessment-meta.js';
import { formatBriefPublication, formatBriefPublishedAt, formatBriefLabel } from '../core/brief-date.js';
import { signalUrl, isFeedStale } from '../wire/wire-format.js';

export function overviewModel(brief = {}) {
  const content = String(brief.content || '');
  const parsed = parseBrief(content);
  const preface = stripMd(content.split(/^##\s+/m)[0].split('\n')
    .filter(line => !/^\s*#/.test(line)).join(' '));
  // The server verifies this presentation against the complete corrected copy.
  // An entry must also match this parsed heading; never reuse a stale summary.
  const presentation = brief.review?.presentation?.status === 'reviewed' ? brief.review.presentation : null;
  return { ...parsed, preface, publication: formatBriefPublication(brief),
    editionLead: presentation?.bluf || parsed.bluf,
    judgments: parsed.stories.map((story, index) => {
      const edited = presentation?.judgments?.find(item => item.index === index && item.originalTitle === story.title);
      return { ...story, anchor: `judgment-${index + 1}`,
        displayTitle: edited?.title || story.title,
        reviewedSummary: edited?.summary || '', reviewedCondition: edited?.condition || '',
        claim: story.assessment || story.line || story.whatHappened,
        summary: story.line || story.assessment || story.whatHappened,
        action: story.actions[0]?.text || story.actionShift?.imperative || '',
        certainty: judgmentCertainty(story.confidence),
      };
    }),
    developing: parsed.developing.map((item, index) => {
      const edited = presentation?.developing?.find(entry => entry.index === index && entry.originalTitle === item.name);
      return { ...item, displayTitle: edited?.title || item.name,
        summary: edited?.summary || item.trajectoryDetail,
        condition: edited?.condition || item.watch };
    }),
    blufSources: sourceCitations(section(content, 'BLUF')),
  };
}

function confidenceLevels(story) {
  return new Set((story.certainty?.text?.match(/\b(?:high|moderate|medium|low)\b/gi) || [])
    .map(value => value.toLowerCase().replace('medium', 'moderate')));
}

function metadata(story, savedMetadata = null) {
  const sources = assessmentSources(savedMetadata?.sources || (story.citations || []).map(source => ({ label: source.label, href: source.url })));
  const certainty = story.certainty;
  const levels = confidenceLevels(story);
  const shortValue = levels.size <= 1 && certainty?.value && certainty.value.length <= 48 ? certainty.value : '';
  const label = shortValue ? `${certainty.label} · ${shortValue}` : certainty?.text ? 'Confidence and qualifications' : 'Confidence not assessed';
  const authored = story.reviewedSummary && story.claim ? `<div class="brief-overview-authored"><h3>Full assessment and qualifications</h3><p>${escapeHtml(story.claim)}</p></div>` : '';
  return `<details class="brief-overview-evidence"><summary>${escapeHtml(label)} <span>${sources.length ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}` : 'Source details'}</span></summary>${authored}${renderAssessmentMeta({
    ...savedMetadata,
    sources: savedMetadata?.sources || (story.citations || []).map(source => ({ label: source.label, href: source.url })),
    time: { label: 'Assessment updated', value: 'Not recorded' },
    severity: { label: 'Severity', value: 'Not assessed' },
    certainty: { label: story.certainty?.label === 'Likelihood' ? 'Likelihood' : 'Assessment confidence',
      value: story.certainty?.text || 'Not assessed' }, omitUnavailable: true,
  })}</details>`;
}

const words = value => String(value || '').trim().split(/\s+/).filter(Boolean).length;

/** Whole authored passages remain available; an unreviewed excerpt is never a summary. */
export function overviewPassage(story) {
  const authored = story.claim;
  const passage = story.reviewedSummary || authored;
  const condition = story.reviewedCondition || '';
  // Mixed confidence applies to different parts of a judgment. Keep its full
  // authored scope visible rather than inventing a single overall rating.
  const qualification = confidenceLevels(story).size > 1 ? story.certainty.text : '';
  return `<p class="brief-overview-claim${!story.reviewedSummary && words(authored) > 55 ? ' brief-overview-claim--long' : ''}">${escapeHtml(passage)}</p>`
    + (condition ? `<p class="brief-overview-condition">${escapeHtml(condition)}</p>` : '')
    + (qualification && qualification !== condition ? `<p class="brief-overview-qualification"><span>Confidence by claim</span> ${escapeHtml(qualification)}</p>` : '');
}

function assessmentDate(brief, now) {
  const timestamp = brief.generatedAt || brief.timestamp;
  const published = formatBriefPublishedAt(timestamp);
  const edition = formatBriefLabel(brief.filename || brief.date);
  const label = published || edition;
  const day = published ? new Date(timestamp).toISOString().slice(0, 10)
    : edition ? String(brief.filename || brief.date).match(/\d{4}-\d{2}-\d{2}/)?.[0] : '';
  const current = new Date(now);
  const days = day && Number.isFinite(current.getTime())
    ? Math.round((Date.parse(current.toISOString().slice(0, 10)) - Date.parse(day)) / 86_400_000) : NaN;
  const age = days >= 0 ? `<span class="brief-overview-age">${days === 0 ? 'Dated today (UTC)' : `${days} ${days === 1 ? 'day' : 'days'} old`}</span>` : '';
  return `<p class="brief-overview-assessment-date">${label ? `Assessment from ${escapeHtml(label)}` : 'Assessment date unavailable'}${age}</p>`;
}

function reportHref(filename, anchor) {
  const edition = filename ? `/briefing/${encodeURIComponent(filename)}` : '/briefing';
  return anchor ? `${edition}#${encodeURIComponent(anchor)}` : `${edition}?view=report`;
}

function reportLink(filename, anchor, text, className = '') {
  return `<a class="brief-overview-open ${className}" data-overview-open href="${escapeHtml(reportHref(filename, anchor))}">${escapeHtml(text)} <span aria-hidden="true">→</span></a>`;
}

function judgment(story, featured = false, savedMetadata = null, filename = '') {
  return `<article class="brief-overview-story${featured ? ' brief-overview-feature' : ''}" aria-labelledby="overview-${escapeHtml(story.anchor)}">
    ${featured ? '<p class="brief-overview-label">Featured story</p>' : ''}
    <h2 id="overview-${escapeHtml(story.anchor)}" tabindex="-1"><a data-overview-open href="${escapeHtml(reportHref(filename, story.anchor))}">${escapeHtml(story.displayTitle || story.title)}</a></h2>
    ${overviewPassage(story)}
    <div class="brief-overview-footer">${metadata(story, savedMetadata)}${reportLink(filename, story.anchor, 'Read assessment')}</div>
  </article>`;
}

export function renderOverview(brief = {}, { judgmentMetadata = [], developingAnchor = '', now = Date.now() } = {}) {
  const model = overviewModel(brief);
  const [featured, ...stories] = model.judgments;
  const warnings = Array.isArray(brief.warnings) ? brief.warnings : [];
  return `<div class="brief-overview-edition">${assessmentDate(brief, now)}
    ${brief.review?.status === 'editorially-corrected' ? `<p class="brief-overview-review">Corrected edition · ${brief.review.notes?.length || 0} corrections · ${reportLink(brief.filename, 'editorial-review', 'Review record')}</p>` : ''}</div>
    ${model.preface ? `<p class="brief-overview-preface">${escapeHtml(model.preface)}</p>` : ''}
    ${warnings.length ? `<details class="brief-overview-warnings"><summary>${warnings.length} edition review ${warnings.length === 1 ? 'note' : 'notes'}</summary><ul>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : ''}
    <section class="brief-overview-edition-note" aria-label="Edition summary"><h2 class="brief-overview-label">${featured ? 'This edition' : 'Edition summary'}</h2><p>${escapeHtml(model.editionLead || 'No edition summary recorded.')}</p>
      ${!featured ? metadata({ citations: model.blufSources }) : ''}${reportLink(brief.filename, '', 'Read full report')}</section>
    ${featured ? `<div class="brief-overview-front">${judgment(featured, true, judgmentMetadata[0], brief.filename)}</div>` : ''}
    ${stories.length ? `<section class="brief-overview-more" aria-label="More stories from this edition"><h2 class="brief-overview-label">More in this edition</h2><div class="brief-overview-grid">${stories.map((story, index) => judgment(story, false, judgmentMetadata[index + 1], brief.filename)).join('')}</div></section>` : ''}
    ${model.developing.length ? `<section class="brief-overview-watch" aria-label="Also watching from this edition"><h2>Also watching <span>From the saved edition</span></h2><ul>${model.developing.map(item => `<li><h3>${escapeHtml(item.displayTitle)}</h3>${item.summary ? `<p class="brief-overview-watch-summary">${escapeHtml(item.summary)}</p>` : ''}${item.condition ? `<p class="brief-overview-watch-condition"><span>Watch for</span> ${escapeHtml(item.condition)}</p>` : ''}</li>`).join('')}</ul>${reportLink(brief.filename, developingAnchor, 'Read watch criteria')}</section>` : ''}
      <aside class="brief-overview-recent" aria-label="Recent developments"><h2 class="brief-overview-label">Recent developments</h2><p class="brief-overview-recent-note">Current reporting · separate from the saved assessment</p>
        <div data-overview-recent><p role="status">Loading current reporting…</p></div>
        <a class="brief-overview-wire" href="/wire?sort=newest">Open Wire <span aria-hidden="true">→</span></a>
      </aside>`;
}

export function recentDevelopmentsModel(payload, now = Date.now()) {
  if (!payload || !Array.isArray(payload.headlines)) throw new Error('Current reporting unavailable');
  const items = payload.headlines.filter(item => item && typeof item.title === 'string' && item.title.trim())
    .map((item, index) => ({ ...item, order: index, published: !item.dateUnknown && Number.isFinite(Date.parse(item.date)) ? Date.parse(item.date) : null }))
    .sort((a, b) => (b.published ?? -Infinity) - (a.published ?? -Infinity) || a.order - b.order).slice(0, 5);
  const collectionTime = Date.parse(payload.generatedAt);
  const suppliedAge = payload.ageSeconds != null && payload.ageSeconds !== '' ? Number(payload.ageSeconds) : NaN;
  const ageSeconds = Number.isFinite(collectionTime) ? Math.max(0, (now - collectionTime) / 1000) : suppliedAge;
  return { items, stale: isFeedStale(ageSeconds, payload.refreshMinutes), generatedAt: Number.isFinite(collectionTime) ? new Date(collectionTime).toISOString() : '' };
}

function timestamp(date) {
  if (!date || !Number.isFinite(Date.parse(date))) return 'Time not available';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(date)) + ' UTC';
}

export function renderRecentDevelopments(model, { failed = false } = {}) {
  const state = failed ? 'Refresh unavailable · showing previous reporting' : model.stale ? 'Collection is stale' : 'Latest collected reporting';
  return `<p class="brief-overview-freshness"${failed || model.stale ? ' data-level="warning"' : ''}>${state}${model.generatedAt ? `<span>Collected ${escapeHtml(timestamp(model.generatedAt))}</span>` : ''}</p>
    ${model.items.length ? `<ol class="brief-overview-timeline">${model.items.map(item => `<li>
      <time${item.published ? ` datetime="${new Date(item.published).toISOString()}"` : ''}>${item.published ? escapeHtml(timestamp(new Date(item.published).toISOString())) : 'Publication time unknown'}</time>
      <h3><a href="${escapeHtml(signalUrl(item))}">${escapeHtml(item.editorialContext?.title || item.title)}</a></h3>
      <p>${escapeHtml(item.source || 'Source not named')}</p>
      ${item.evidence?.some(source => source.changed) ? '<span class="brief-overview-change">Retained source changed</span>' : ''}
    </li>`).join('')}</ol>` : '<p class="brief-overview-empty">No current reporting is available.</p>'}
    ${failed ? '<button class="btn-ghost-sm" type="button" data-recent-retry>Retry reporting</button>' : ''}`;
}

// Refreshes are held while this region owns keyboard focus so an update cannot
// replace the link/button somebody is using. The next poll applies fresh data.
export function mountRecentDevelopments(host, fetchRecent) {
  if (!host || typeof fetchRecent !== 'function') return () => {};
  let disposed = false, busy = false, retained = null;
  async function refresh() {
    if (disposed || busy || host.contains(host.ownerDocument.activeElement)) return;
    busy = true;
    try {
      const model = recentDevelopmentsModel(await fetchRecent());
      if (disposed) return;
      retained = model;
      if (!host.contains(host.ownerDocument.activeElement)) host.innerHTML = renderRecentDevelopments(model);
    } catch {
      if (disposed || host.contains(host.ownerDocument.activeElement)) return;
      host.innerHTML = retained ? renderRecentDevelopments(retained, { failed: true })
        : '<p class="brief-overview-freshness" data-level="warning">Current reporting could not load.</p><button class="btn-ghost-sm" type="button" data-recent-retry>Retry reporting</button>';
    } finally { busy = false; }
  }
  const retry = event => { if (event.target.closest('[data-recent-retry]')) { event.target.blur(); refresh(); } };
  host.addEventListener('click', retry);
  refresh();
  const timer = setInterval(refresh, 60_000);
  return () => { disposed = true; clearInterval(timer); host.removeEventListener('click', retry); };
}

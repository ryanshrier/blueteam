// Editorial overview of a saved edition. Current reporting has its own clock
// and request lifecycle; it never mutates the edition or its assessment times.
import { parseBrief, judgmentCertainty, stripMd, sourceCitations, section } from '/vendor/brief-schema.js';
import { escapeHtml } from '../core/sanitize.js';
import { renderAssessmentMeta, assessmentSources } from '../core/assessment-meta.js';
import { formatBriefPublication } from '../core/brief-date.js';
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
    blufSources: sourceCitations(section(content, 'BLUF')),
  };
}

function metadata(story, compact = false, savedMetadata = null) {
  const sources = assessmentSources(savedMetadata?.sources || (story.citations || []).map(source => ({ label: source.label, href: source.url })));
  const certainty = story.certainty;
  const levels = new Set((certainty?.text?.match(/\b(?:high|moderate|medium|low)\b/gi) || []).map(value => value.toLowerCase()));
  const shortValue = levels.size <= 1 && certainty?.value && certainty.value.length <= 48 ? certainty.value : '';
  const label = shortValue ? `${certainty.label} · ${shortValue}` : certainty?.text ? 'Confidence and qualifications' : 'Confidence not assessed';
  return `<details class="brief-overview-evidence"><summary>${escapeHtml(label)} <span>${sources.length ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}` : 'Source details'}</span></summary>${renderAssessmentMeta({
    ...savedMetadata,
    sources: savedMetadata?.sources || (story.citations || []).map(source => ({ label: source.label, href: source.url })),
    time: { label: 'Assessment updated', value: 'Not recorded' },
    severity: { label: 'Severity', value: 'Not assessed' },
    certainty: { label: story.certainty?.label === 'Likelihood' ? 'Likelihood' : 'Assessment confidence',
      value: story.certainty?.text || 'Not assessed' }, compact,
  })}</details>`;
}

const words = value => String(value || '').trim().split(/\s+/).filter(Boolean).length;

/** Whole authored passages remain available; an unreviewed excerpt is never a summary. */
export function overviewPassage(story, lead = false) {
  const authored = lead ? story.claim : story.summary;
  if (story.reviewedSummary) return `<p class="brief-overview-claim">${escapeHtml(story.reviewedSummary)}</p>${story.reviewedCondition ? `<p class="brief-overview-condition">${escapeHtml(story.reviewedCondition)}</p>` : ''}<details class="brief-overview-authored"><summary>Full assessment and qualifications</summary><p>${escapeHtml(story.claim || authored)}</p></details>`;
  if (words(authored) <= (lead ? 55 : 35)) return `<p class="brief-overview-claim">${escapeHtml(authored)}</p>`;
  return `<p class="brief-overview-claim brief-overview-claim--long">${escapeHtml(authored)}</p>`;
}

function reportLink(filename, anchor, text, className = '') {
  const edition = filename ? `/briefing/${encodeURIComponent(filename)}` : '/briefing';
  const href = anchor ? `${edition}#${encodeURIComponent(anchor)}` : `${edition}?view=report`;
  return `<a class="brief-overview-open ${className}" data-overview-open href="${escapeHtml(href)}">${escapeHtml(text)} <span aria-hidden="true">→</span></a>`;
}

function judgment(story, lead = false, savedMetadata = null, filename = '') {
  return `<article class="brief-overview-story${lead ? ' brief-overview-lead' : ''}">
    ${lead ? '<p class="brief-overview-label">Lead assessment</p>' : ''}
    <h2>${escapeHtml(story.displayTitle || story.title)}</h2>
    ${overviewPassage(story, lead)}
    ${reportLink(filename, story.anchor, lead ? 'Read assessment and evidence' : 'Read assessment')}
    ${lead && story.action ? `<div class="brief-overview-action"><span>First response · complete actions in the assessment</span><p>${escapeHtml(story.action)}</p></div>` : ''}
    ${story.decision ? `<p class="brief-overview-window">Decision window <strong>${escapeHtml(story.decision)}</strong></p>` : ''}
    ${metadata(story, !lead, savedMetadata)}
  </article>`;
}

export function renderOverview(brief = {}, { judgmentMetadata = [] } = {}) {
  const model = overviewModel(brief);
  const [lead, ...support] = model.judgments;
  const warnings = Array.isArray(brief.warnings) ? brief.warnings : [];
  return `<div class="brief-overview-edition"><p>Saved assessment <span class="sr-only">· ${escapeHtml(model.publication)}</span></p></div>
    ${brief.review?.status === 'editorially-corrected' ? `<p class="brief-overview-review">Corrected edition · ${brief.review.notes?.length || 0} corrections · ${reportLink(brief.filename, 'editorial-review', 'Review record')}</p>` : ''}
    ${model.preface ? `<p class="brief-overview-preface">${escapeHtml(model.preface)}</p>` : ''}
    ${warnings.length ? `<details class="brief-overview-warnings"><summary>${warnings.length} edition review ${warnings.length === 1 ? 'note' : 'notes'}</summary><ul>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : ''}
    <div class="brief-overview-grid">
      <div class="brief-overview-primary">${lead ? judgment(lead, true, judgmentMetadata[0], brief.filename) : `<article class="brief-overview-story brief-overview-lead"><p class="brief-overview-label">Edition summary</p><h2>${escapeHtml(model.bluf || 'No lead assessment in this edition')}</h2>${metadata({ citations: model.blufSources })}${reportLink(brief.filename, '', 'Read full report')}</article>`}
      ${lead && model.bluf ? `<details class="brief-overview-summary" open><summary>Edition summary</summary><p>${escapeHtml(model.bluf)}</p></details>` : ''}</div>
      <section class="brief-overview-support" aria-label="Supporting assessments"><h2 class="brief-overview-label">Supporting briefs</h2>
        ${support.length ? support.map((story, index) => judgment(story, false, judgmentMetadata[index + 1], brief.filename)).join('') : '<p class="brief-overview-empty">No additional assessments in this edition.</p>'}
      </section>
      <aside class="brief-overview-recent" aria-label="Recent developments"><h2 class="brief-overview-label">Recent developments</h2><p class="brief-overview-recent-note">Current reporting · separate from the saved assessment</p>
        <div data-overview-recent><p role="status">Loading current reporting…</p></div>
        <a class="brief-overview-wire" href="/wire?sort=newest">Open Wire <span aria-hidden="true">→</span></a>
      </aside>
    </div>
    ${model.developing.length ? `<section class="brief-overview-watch" aria-label="Watch criteria from this edition"><h2>Watch criteria <span>From the saved edition</span></h2><dl>${model.developing.map(item => `<div><dt>${escapeHtml(item.name)}</dt><dd>${escapeHtml(item.watch || 'No watch criterion recorded.')}</dd></div>`).join('')}</dl></section>` : ''}`;
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

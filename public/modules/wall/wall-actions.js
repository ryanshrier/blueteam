import { escapeHtml } from '../core/sanitize.js';
import { formatBriefPublication, formatBriefPublishedAt } from '../core/brief-date.js';
import { storyActions } from './wall-presentation.js';

export function actionTargetLabel(action) {
  return action.targetType === 'due' ? 'Authored due date' : action.targetType === 'target' ? 'Target' : 'Recommended target';
}

export function wallActionHtml(action, { compact = false } = {}) {
  const context = [
    ['Condition', action.condition], ['Dependencies', action.dependencies], ['Initiation', action.initiationTrigger],
    ['Evidence / artifact', action.evidence], ['Completion criterion', action.completionCriterion], ['Conditional recovery', action.recoverySteps],
  ].filter(([label, value]) => value && !(label === 'Condition' && String(action.imperative).includes(value)));
  return `<li class="nb-response-action"${action.id ? ` data-action-id="${escapeHtml(action.id)}"` : ''}>
    <strong class="nb-response-owner">${escapeHtml(action.owner || 'Owner not specified')}</strong>
    <p class="nb-response-imperative">${escapeHtml(action.imperative || action.text || '')}</p>
    ${action.target ? `<p class="nb-response-target">${escapeHtml(actionTargetLabel(action))} · ${escapeHtml(action.target)}</p>` : ''}
    ${context.length ? `<dl class="nb-response-context${compact ? ' is-compact' : ''}">${context.map(([label, text]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>`).join('')}</dl>` : ''}
  </li>`;
}

function sources(citations = []) {
  return citations.filter(item => {
    try { const url = new URL(item.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }).map(item => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label || new URL(item.url).hostname)}</a>`).join(' · ');
}

export function wallDocumentHtml(doc = {}) {
  const stories = doc.stories || [];
  const reviewIdentity = doc.review ? [doc.review.reviewer || 'Editorial review', formatBriefPublishedAt(doc.review.reviewedAt)].filter(Boolean).join(' · ') : '';
  return `<p class="nb-actions-edition">${escapeHtml(formatBriefPublication(doc))} · Complete authored actions and supporting context</p>
    ${doc.review?.status === 'editorially-corrected' ? `<p>Editorially corrected reading copy · ${escapeHtml(reviewIdentity)}${doc.filename ? ` · <a href="/briefing/${encodeURIComponent(doc.filename)}#editorial-review">Review corrections and original</a>` : ''}</p>` : ''}
    ${doc.review?.status === 'editorially-corrected' ? `<details><summary>Editorial scope and original generation findings</summary>${doc.review.scope ? `<p>${escapeHtml(doc.review.scope)}</p>` : ''}${doc.review.originalSha256 ? `<p>Original output SHA-256: <code>${escapeHtml(doc.review.originalSha256)}</code></p>` : ''}${doc.warnings?.length ? `<p>These source-check notes belong to the unchanged original output:</p><ul>${doc.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}</details>` : ''}
    <nav aria-label="Action topics">${stories.map((story, idx) => { const count = storyActions(story).length; return `<a href="#wall-action-topic-${idx}">${escapeHtml(story.title)} · ${count} ${count === 1 ? 'action' : 'actions'}</a>`; }).join('')}</nav>
    ${stories.map((story, idx) => `<section id="wall-action-topic-${idx}" tabindex="-1"><h3>${escapeHtml(story.title)}</h3>
      ${story.decision ? `<p>Decision window · ${escapeHtml(story.decision)} · as of ${escapeHtml(doc.date || 'the saved edition')}</p>` : ''}
      ${storyActions(story).length ? `<ol class="nb-response-actions">${storyActions(story).map(action => wallActionHtml(action)).join('')}</ol>` : '<p>No action was authored for this judgment.</p>'}
      <details><summary>Assessment and source context</summary>${[['Assessment', story.assessment], ['What happened', story.whatHappened], ['Defender impact', story.defenderImpact], ['Relevance', story.relevance], ['Confidence / basis', story.confidence], ['Forecast', story.forecast], ['The line', story.line]].filter(([, text]) => text).map(([label, text]) => `<p><strong>${label}:</strong> ${escapeHtml(text)}</p>`).join('')}
      ${story.citations?.length ? `<p>${sources(story.citations)}</p>` : ''}</details></section>`).join('')}
    ${(doc.convergence || []).map(item => `<section><h3>${escapeHtml(item.title)}</h3>${[['Intersection', item.intersection], ['Hypothesis', item.cascade], [item.moveVerb || 'Recommended move', item.move], ['Confirmation', item.confirmation], ['Action rationale', item.actionRationale]].filter(([, text]) => text).map(([label, text]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(text)}</p>`).join('')}<p>${sources(item.citations)}</p></section>`).join('')}
    ${(doc.developing || []).length ? `<section><h3>Developing</h3>${doc.developing.map(item => `<h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.trajectoryDetail || item.trajectory || '')}</p><p><strong>Escalation condition:</strong> ${escapeHtml(item.watch || '')}</p><p>${sources(item.citations)}</p>`).join('')}</section>` : ''}
    ${(doc.watchlist || []).length ? `<section><h3>Watchlist</h3><p>${escapeHtml(doc.watchlistMetadata?.validityText || 'Validity boundary not specified')}</p><ul>${(doc.watchlistEntries || doc.watchlist.map(text => ({ text }))).map(item => `<li>${escapeHtml(item.text)}${item.citations?.length ? `<p>${sources(item.citations)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}`;
}

export function mountWallActions({ getDocument, onOpen }) {
  let dialog = null;
  return {
    open(trigger) {
      if (dialog) return;
      const doc = getDocument();
      if (!doc) return;
      onOpen();
      dialog = document.createElement('dialog');
      dialog.className = 'wall-action-dialog';
      dialog.setAttribute('aria-labelledby', 'wallActionsTitle');
      dialog.innerHTML = `<header><h2 id="wallActionsTitle">All actions and context</h2><button type="button" data-close aria-label="Close all actions">Close</button></header><div class="wall-action-dialog-body">${wallDocumentHtml(doc)}</div>`;
      dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => {
        const link = event.target.closest?.('a[href^="#wall-action-topic-"]');
        if (!link) return;
        const section = dialog.querySelector(link.getAttribute('href'));
        if (section) { event.preventDefault(); section.scrollIntoView({ block: 'start' }); section.focus({ preventScroll: true }); }
      });
      dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; trigger?.focus?.({ preventScroll: true }); }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
    },
    destroy() { dialog?.remove(); dialog = null; },
  };
}

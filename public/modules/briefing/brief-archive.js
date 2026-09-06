// Archive URLs are ordinary navigation state: reload, Back, and new tabs all
// restore the same query/page. The legacy /api/briefs array stays compatible.
import { escapeHtml } from '../core/sanitize.js';
import { formatBriefLabel, formatBriefPublishedAt } from '../core/brief-date.js';

export function archiveLocation(query = '', page = 1, sort = 'relevance') {
  const params = new URLSearchParams({ archive: '1' });
  const q = String(query).trim().slice(0, 200);
  if (q) params.set('q', q);
  if (q && sort === 'newest') params.set('sort', 'newest');
  if (Number.isInteger(page) && page > 1) params.set('page', String(page));
  return `/briefing?${params}`;
}

export function archiveRoute(search = '') {
  const params = new URLSearchParams(search);
  const rawPage = Number(params.get('page') || 1);
  return {
    active: params.get('archive') === '1',
    query: (params.get('q') || '').trim().slice(0, 200),
    sort: params.get('sort') === 'newest' ? 'newest' : 'relevance',
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

export async function fetchArchiveSearch(query, sort = 'relevance') {
  const response = await fetch(`/api/search?${new URLSearchParams({ q: query, sort })}`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!response.ok) throw new Error('Archive search unavailable');
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid search response');
  return data;
}

export async function fetchArchivePage(page = 1) {
  const response = await fetch(`/api/briefs?page=${page}&pageSize=12`, {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Archive unavailable');
  const data = await response.json();
  // Old servers and read-only fixtures still return the original array.
  if (Array.isArray(data)) return { items: data, total: data.length, page: 1, pageSize: Math.max(1, data.length), legacy: true };
  if (!data || !Array.isArray(data.items) || !Number.isInteger(data.total)) throw new Error('Invalid archive response');
  return data;
}

export function archiveExcerpt(text, limit = 32) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length > limit ? { text: `${words.slice(0, limit).join(' ')}…`, shortened: true } : { text: words.join(' '), shortened: false };
}

export function archiveListHtml({ items, total, page, pageSize, legacy = false }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `<p class="archive-count">${legacy ? 'Recent editions' : `${total} saved ${total === 1 ? 'edition' : 'editions'}`}</p>
    <div class="archive-editions">${items.map(item => {
      const published = formatBriefPublishedAt(item.generatedAt);
      const bluf = String(item.bluf || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#`]/g, '').trim();
      const excerpt = archiveExcerpt(bluf);
      return `<article class="archive-edition"><a class="archive-edition-link" data-brief-route href="/briefing/${encodeURIComponent(item.filename)}">
        <strong>${escapeHtml(formatBriefLabel(item.filename))}</strong>
        ${['review-required', 'superseded'].includes(item.disposition?.status) ? `<span class="archive-edition-review">${item.disposition.status === 'superseded' ? 'Superseded edition' : 'Editorial review required'} · excluded from Latest and automatic Wall rotation</span>` : ''}
        ${bluf ? `<span class="archive-edition-bluf">${escapeHtml(excerpt.text)}</span>` : '<span>Open the saved assessment</span>'}
        ${item.reviewStatus === 'editorially-corrected' ? '<span class="archive-edition-review">Editorially corrected reading copy</span>' : item.reviewStatus === 'unavailable' ? '<span class="archive-edition-review">Review could not be verified · original shown</span>' : ''}
        <span class="archive-edition-meta">${escapeHtml([published && `Published ${published}`, Number.isFinite(item.wordCount) && `${Math.max(1, Math.round(item.wordCount / 220))} min read`].filter(Boolean).join(' · '))}</span>
        <span class="archive-edition-open">Read edition →</span>
      </a>${excerpt.shortened ? `<details class="archive-edition-summary"><summary>Full edition summary</summary><p>${escapeHtml(bluf)}</p></details>` : ''}</article>`;
    }).join('')}</div>
    ${!items.length ? '<div class="empty-state"><h2>No saved editions yet</h2><p>Your published briefings will appear here.</p></div>' : ''}
    ${pages > 1 ? `<nav class="archive-pagination" aria-label="Archive pages">
      ${page > 1 ? `<a data-brief-route class="btn-ghost" href="${escapeHtml(archiveLocation('', page - 1))}">← Newer editions</a>` : '<span></span>'}
      <span>Page ${page} of ${pages}</span>
      ${page < pages ? `<a data-brief-route class="btn-ghost" href="${escapeHtml(archiveLocation('', page + 1))}">Older editions →</a>` : '<span></span>'}
    </nav>` : ''}`;
}

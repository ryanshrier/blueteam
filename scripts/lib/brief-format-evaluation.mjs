// Experimental analysis only. Nothing here changes production publication policy.
import { marked } from 'marked';
import { validateBrief, publicationDecision } from '../../lib/validation.js';
import { buildGroundingManifest } from '../../lib/grounding.js';
import { renderBriefCitations } from '../../lib/brief-citations.js';
import { parseJudgments } from '../../lib/brief-schema.js';
import { briefReplayDiagnostics } from '../../lib/brief-replay.js';
import { FORMAT_EVAL_CASES, FORMAT_EVAL_DATE, formatEvalHeadlines } from '../../test/fixtures/brief-format-evaluation.js';

export const grounding = buildGroundingManifest({ headlines: formatEvalHeadlines() });
export const evidence = { publication: true, editorialStandard: 2, groundingManifest: grounding,
  kevSet: new Set(), kevCatalogLoaded: false };
const normalize = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
function tokenText(tokens) {
  return tokens.map(token => {
    if (['html', 'code', 'space', 'hr'].includes(token.type)) return '';
    if (token.type === 'list') return tokenText(token.items);
    if (token.type === 'table') return tokenText([...token.header, ...token.rows.flat()]);
    return token.tokens ? tokenText(token.tokens) : String(token.text || '');
  }).join(' ');
}
export const visibleText = text => tokenText(marked.lexer(text, { gfm: true }));
const words = text => text.trim().match(/\S+/g)?.length || 0;
export function stories(text) {
  const tokens = marked.lexer(text, { gfm: true });
  const entries = []; let current; let inStories = false;
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth <= 2) {
      current = null;
      inStories = token.depth === 2 && /^(?:KEY JUDGMENTS|PRIORITY STORIES)\b/i.test(token.text);
    }
    if (inStories && token.type === 'heading' && token.depth === 3) {
      current = { title: token.text, text: '' }; entries.push(current);
    } else if (current) current.text += token.raw;
  }
  return entries;
}

// Expose every narrative paragraph to the existing fact checker. This is an
// audit view, not a publication adapter: no actions, owners, dates or confidence
// are invented, and projection checks never establish production eligibility.
export function factAuditView(text) {
  if (/^##\s+KEY JUDGMENTS\s*$/mi.test(text)) return text;
  const entries = stories(text);
  const lead = /^##\s+TODAY['’]S PICTURE[^\n]*\n([\s\S]*?)(?=\n##\s|$)/mi.exec(text)?.[1]?.trim() || '';
  return `# Threat Landscape Briefing — ${FORMAT_EVAL_DATE}\n## BLUF\n${lead}\n## KEY JUDGMENTS\n`
    + entries.map((entry, index) => `### Signal ${index + 1} — ${entry.title}\n**What happened:** ${entry.text.trim()}\n`).join('\n');
}

const summarize = checks => {
  const decision = publicationDecision(checks);
  return { canPublish: decision.canPublish, blockers: decision.blockers, review: decision.reviewIssues,
    notes: decision.notes, policy: checks.validationPolicyVersion };
};
export function evaluateFormat(text) {
  const rendered = renderBriefCitations(text, grounding).content;
  const raw = summarize(validateBrief(rendered, FORMAT_EVAL_DATE, evidence));
  const projected = summarize(validateBrief(factAuditView(rendered), FORMAT_EVAL_DATE, evidence));
  const entries = stories(rendered);
  const authoredChecks = FORMAT_EVAL_CASES.map((item, index) => {
    const url = `https://example.test/brief-format/${item.id}`;
    const entry = entries.find(entry => entry.text.includes(url));
    const value = normalize(visibleText(entry?.text || ''));
    return { id: item.id, sourceCitedInStory: Boolean(entry), storyTitle: entry?.title || null,
      missingAnchors: item.anchors.filter(alternatives => !alternatives.some(term => value.includes(normalize(term)))),
      forbiddenClaims: item.forbidden.filter(term => value.includes(normalize(term))),
      // These are hand-authored lexical probes, deliberately not labeled
      // entailment, accuracy, analyst approval, or a quality score.
      sourceId: `S${index + 1}.1` };
  });
  const visible = visibleText(rendered);
  const frequencies = new Map();
  for (const [id] of visible.matchAll(/\bCVE-\d{4}-\d{3,7}\b/gi)) frequencies.set(id, (frequencies.get(id) || 0) + 1);
  return {
    authoredChecks, authoredChecksPassed: authoredChecks.every(row => row.sourceCitedInStory && !row.missingAnchors.length && !row.forbiddenClaims.length),
    productionCompatibility: { ...raw, readerJudgments: parseJudgments(rendered).length },
    factAudit: { view: 'paragraphs in What happened; evaluation only',
      trustBlockers: projected.blockers.filter(issue => issue.severity === 'trust'),
      otherBlockers: projected.blockers.filter(issue => issue.severity !== 'trust'), review: projected.review },
    diagnostics: { ...briefReplayDiagnostics(rendered).wordCounts,
      stories: entries.length, repeatedCveMentions: [...frequencies.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
      ownerTargetLines: (rendered.match(/^[-*].+\s[—–]\s.+recommended target\b/gmi) || []).length,
      prescribedTargetMentions: (visible.match(/\brecommended target\b/gi) || []).length,
      directiveMarkers: (visible.match(/\b(?:must|should|need to|required to)\b/gi) || []).length,
      visibleWords: words(visible) },
    limits: ['Authored lexical probes do not establish semantic equivalence or general factual accuracy.',
      'The projected fact audit is not production publication eligibility.',
      'Action-only safety checks do not cover free narrative; a prose-aware replacement requires evaluation.',
      'Counts of words, directives and repeated identifiers are descriptive, not quality scores.'],
  };
}

export function evaluateMutations(candidate) {
  return FORMAT_EVAL_CASES.flatMap(item => item.mutations.map(mutation => {
    if (!candidate.includes(item.candidate) || !item.candidate.includes(mutation.from)) throw new Error(`Mutation target missing: ${mutation.id}`);
    const modified = candidate.replace(item.candidate, item.candidate.replace(mutation.from, mutation.to));
    const result = evaluateFormat(modified);
    const authored = result.authoredChecks.find(row => row.id === item.id);
    const authoredCaught = !authored.sourceCitedInStory || authored.missingAnchors.length > 0 || authored.forbiddenClaims.length > 0;
    const factualCaught = result.factAudit.trustBlockers.length > 0;
    return { id: mutation.id, case: item.id, expectedDetection: mutation.detection, authoredCaught, factualCaught,
      detected: mutation.detection === 'factual' ? factualCaught : authoredCaught,
      factualCodes: [...new Set(result.factAudit.trustBlockers.map(issue => issue.code))] };
  }));
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function reviewHtml(title, variants, summary) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{max-width:1500px;margin:32px auto;padding:0 24px;background:#f4f2ed;color:#18222b;font:16px/1.6 system-ui}h1{font-size:28px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:24px}article{background:white;padding:24px;border:1px solid #d1d4d7;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.7 Georgia,serif}.summary{font:14px/1.5 ui-monospace,monospace}small{color:#45535f}</style>
<h1>${escapeHtml(title)}</h1><p><small>Evaluation artifact. No publication or approval is implied. Source facts are synthetic unless explicitly identified as retained evidence.</small></p>
<pre class="summary">${escapeHtml(JSON.stringify(summary, null, 2))}</pre><section>${variants.map(row => `<article><h2>${escapeHtml(row.label)}</h2><pre>${escapeHtml(row.text)}</pre></article>`).join('')}</section></html>`;
}

// Worker-only HTML handling. No application state, credentials or networking.
import { DomHandler, Parser } from 'htmlparser2';
import { classifySourceEvidence, selectOperationalExcerpt } from './evidence-quality.js';

export const ARTICLE_STRUCTURE_LIMITS = Object.freeze({ maxNodes: 30_000, maxDepth: 128,
  maxParagraphs: 2_000, maxAttributes: 30_000, maxAttributesPerNode: 128 });
const SKIP_TAGS = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe', 'svg', 'form']);
const CONTENT_CLASS_PATTERNS = /article[_-]?body|entry[_-]?content|post[_-]?content|story[_-]?body|field--body|post-body|article-content|story-content/i;
const BOILERPLATE_PATTERN = /^(subscribe|sign up|cookie|copyright|share this|related|advertisement|follow us|terms of|read more|click here|learn more|see also|you may also|about the author|published|tags:|filed under)/i;
const SKIP_REGION = /(?:^|[\s_-])(?:ads?|advert(?:isement|ising)?|adslot|adcontainer|sponsor(?:ed)?|related|recommended|recommendations|newsletter|breadcrumb|social-share|cookie(?:s|-banner)?)(?:$|[\s_-])/i;
const exceeded = () => { throw new Error('Article structure exceeds extraction limits'); };

class BoundedDomHandler extends DomHandler {
  nodes = 0;
  paragraphs = 0;
  attributes = 0;
  addNode(node) {
    if (++this.nodes > ARTICLE_STRUCTURE_LIMITS.maxNodes) exceeded();
    super.addNode(node);
  }
  onopentag(name, attrs) {
    const attributes = Object.keys(attrs).length;
    this.attributes += attributes;
    if (this.tagStack.length > ARTICLE_STRUCTURE_LIMITS.maxDepth
      || attributes > ARTICLE_STRUCTURE_LIMITS.maxAttributesPerNode
      || this.attributes > ARTICLE_STRUCTURE_LIMITS.maxAttributes
      || (name === 'p' && ++this.paragraphs > ARTICLE_STRUCTURE_LIMITS.maxParagraphs)) exceeded();
    super.onopentag(name, attrs);
  }
}

export function extractArticleHtml(html, context = {}) {
  const handler = new BoundedDomHandler();
  new Parser(handler).end(html);
  const dom = handler.root;
  const identityWords = value => new Set((String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length > 3 && !/^(?:with|from|that|this|have|been|into|cyber|security|cybersecurity|threat|report|reports|advisory|vulnerability|vulnerabilities)$/.test(word)));
  const titleWords = identityWords(context.title);
  const skipped = node => SKIP_TAGS.has(node.name)
    || node.attribs?.hidden != null || node.attribs?.['aria-hidden'] === 'true'
    || SKIP_REGION.test(`${node.attribs?.class || ''} ${node.attribs?.id || ''}`)
    || /^(?:banner|navigation|complementary)$/i.test(node.attribs?.role || '');

  function textDetails(root) {
    const chunks = [];
    let linkLength = 0, paragraphs = 0;
    const stack = [{ node: root, link: false }];
    while (stack.length) {
      const { node, link } = stack.pop();
      if (skipped(node)) continue;
      if (node.type === 'text') { chunks.push(node.data || ''); if (link) linkLength += (node.data || '').length; }
      if (node.name === 'p') paragraphs++;
      for (let index = (node.children?.length || 0) - 1; index >= 0; index--) {
        stack.push({ node: node.children[index], link: link || node.name === 'a' });
      }
    }
    return { text: chunks.join(' ').replace(/\s+/g, ' ').trim(), linkLength, paragraphs };
  }

  function findAll(root, predicate, stopAtMatch = false) {
    const results = [], stack = [...(root.children || [])].reverse();
    while (stack.length) {
      const node = stack.pop();
      if (skipped(node)) continue;
      if (node.type === 'tag' && predicate(node)) {
        results.push(node);
        if (stopAtMatch) continue;
      }
      for (let index = (node.children?.length || 0) - 1; index >= 0; index--) stack.push(node.children[index]);
    }
    return results;
  }

  // The candidate bound caps repeated region scoring. All parsing, candidate
  // classification and excerpt selection also share the worker's hard deadline.
  const candidates = findAll(dom, node => node.name === 'article' || node.name === 'main'
    || CONTENT_CLASS_PATTERNS.test(`${node.attribs?.class || ''} ${node.attribs?.id || ''}`)).slice(0, 40);
  const ranked = candidates.map(node => {
    const details = textDetails(node);
    const explicitBody = CONTENT_CLASS_PATTERNS.test(`${node.attribs?.class || ''} ${node.attribs?.id || ''}`);
    const quality = classifySourceEvidence({ ...context, passage: details.text });
    const bodyWords = identityWords(details.text);
    const agreement = [...titleWords].filter(word => bodyWords.has(word)).length / Math.max(1, titleWords.size);
    const score = (explicitBody ? 80 : node.name === 'main' ? 60 : 30)
      + 40 * agreement + Math.min(details.paragraphs, 20) + Math.log2(Math.max(1, details.text.length))
      - 100 * details.linkLength / Math.max(1, details.text.length);
    return { ...details, score, quality };
  }).filter(candidate => candidate.text && candidate.quality.substantive)
    .sort((a, b) => b.score - a.score);

  // Only disjoint outer paragraphs enter the fallback. Walking every nested
  // paragraph repeated both work and the same prose once for each ancestor.
  const paragraphs = ranked.length ? [] : findAll(dom, node => node.name === 'p', true)
    .map(node => textDetails(node).text)
    .filter(text => text && !BOILERPLATE_PATTERN.test(text)
      && classifySourceEvidence({ ...context, passage: text }).substantive);
  const body = ranked[0]?.text || paragraphs.join(' ');
  if (!classifySourceEvidence({ ...context, passage: body }).substantive) return '';
  const excerpt = selectOperationalExcerpt(body);
  return classifySourceEvidence({ ...context, passage: excerpt }).substantive ? excerpt : '';
}

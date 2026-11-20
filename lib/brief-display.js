import { createHash } from 'node:crypto';
import { marked } from 'marked';
import { parseBrief, stripMd, STORY_OPENING_CONTRACT } from './brief-schema.js';
import { capturedCitationTokens, protectedSpans } from './brief-citations.js';
import { escapeRegExp } from './regex-util.js';

const digest = content => createHash('sha256').update(content).digest('hex');
const openingQualifications = [
  /^(?:this|that) (?:finding |assessment |risk |conclusion |effect )?(?:applies only|holds only|depends on|is limited to)\b/i,
  /^(?:the (?:key |decisive )?(?:condition|distinction|limitation|prerequisite) (?:is|was)|[\w-]+ is the (?:key|decisive) (?:distinction|condition|prerequisite))\b/i,
  /^(?:[\p{L}-]+ ){1,3}alone (?:does not|cannot) (?:establish|show|confirm|rule out)\b/iu,
];
const continuingQualifications = [
  ...openingQualifications,
  /^(?:but|however|unless|only|except|provided|if|when|without|otherwise|in that case|this|that|it|they)\b/i,
  /\b(?:also requires?|must also|depends on|only (?:if|when|to)|limited to|remains? (?:unknown|uncertain|unconfirmed)|(?:cannot|does not|did not) (?:establish|show|confirm|rule out))\b/i,
  /\b(?:sample|observations?|testing|study) (?:covered|included|excluded)\b/i,
];
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function qualifyingContinuation(paragraph) {
  if (!openingQualifications.some(pattern => pattern.test(paragraph))) return '';
  let previous = '';
  for (const { segment, index } of sentences.segment(paragraph)) {
    // Keep the explanation after a bare label ("Execution is the key
    // distinction."), another condition, or an uncertain sentence boundary.
    const unfinished = /(?:\b(?:[A-Z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|No|Fig|Inc|Ltd|etc|e\.g|i\.e)\.|(?:^|\s)[A-Z]\.|…|\.\.\.)[”"’)\]]*$/i.test(previous);
    const bareLabel = /\bis the (?:key|decisive) (?:distinction|condition|prerequisite)[.!?]$/i.test(previous);
    if (index && !unfinished && !bareLabel && !continuingQualifications.some(pattern => pattern.test(segment))) {
      return paragraph.slice(0, index).trimEnd();
    }
    previous = segment.trimEnd();
  }
  return paragraph;
}

/** Remove only captured bibliography groups following a complete sentence.
 * Never delete linked subjects, conditions, attribution, or arbitrary brackets. */
export function displayProse(markdown, tokens = []) {
  if (!tokens.length) return stripMd(markdown);
  const token = `(?:${tokens.map(escapeRegExp).join('|')})`;
  const cluster = `${token}(?:[ \\t]+${token})*`;
  // Existing Markdown links are intentionally eligible; code and HTML aren't.
  const codeSpans = protectedSpans(markdown).filter(([start]) => markdown[start] !== '[');
  const bibliography = `(?:\\((?:[Ss]ources?:[ \\t]*)?${cluster}\\)|\\[${cluster}\\]|${cluster})`;
  const clean = markdown.replace(new RegExp(`([.!?])[ \\t]+${bibliography}\\.?(?=\\s|$)`, 'g'), (raw, punctuation, offset) => {
    // A dated linked subject such as "[Vendor, date] says ..." still carries
    // grammatical meaning, even after the preceding sentence's punctuation.
    if (/^\p{Ll}/u.test(markdown.slice(offset + raw.length).trimStart())) return raw;
    return codeSpans.some(([start, end]) => offset < end && offset + raw.length > start) ? raw : punctuation;
  });
  return stripMd(clean);
}

/** Run on the final selected generation, after repair preservation. No model
 * call, new claims, editorial certification, or publication consequence. */
export function captureBriefDisplay(content, grounding, contract) {
  if (contract !== STORY_OPENING_CONTRACT) return null;
  const doc = parseBrief(content);
  if (doc.stories.some(story => story.formatVersion !== 2)) return null;
  const tokens = capturedCitationTokens(grounding);
  return { contract, contentSha256: digest(content),
    stories: doc.stories.map((story, index) => {
      const [first, next] = marked.lexer(story.narrative).filter(token => token.type !== 'space');
      let opening = first?.type === 'paragraph' ? displayProse(first.raw.trim(), tokens) : '';
      // Some writers put the condition that limits their lead in its own
      // paragraph. Keep the qualifying language apart from later support.
      if (opening && next?.type === 'paragraph') {
        const qualification = qualifyingContinuation(displayProse(next.raw.trim(), tokens));
        if (qualification) opening += '\n\n' + qualification;
      }
      return { index, originalTitle: story.title, narrative: story.narrative,
        opening,
        paragraphs: story.narrative.split(/\n\s*\n/).map(paragraph => displayProse(paragraph, tokens)).filter(Boolean) };
    }) };
}

/** An absent, edited or malformed display record falls back to complete prose.
 * Its availability never changes validation, approval or Wall eligibility. */
export function verifiedBriefDisplay(content, record) {
  if (record?.contract !== STORY_OPENING_CONTRACT || record.contentSha256 !== digest(content)
    || !Array.isArray(record.stories) || record.stories.length > 30) return null;
  const stories = parseBrief(content).stories;
  if (record.stories.length !== stories.length || !record.stories.every((entry, index) =>
    entry && entry.index === index && entry.originalTitle === stories[index].title && entry.narrative === stories[index].narrative
    && typeof entry.opening === 'string' && Array.isArray(entry.paragraphs)
    && entry.paragraphs.every(paragraph => typeof paragraph === 'string'))) return null;
  return record;
}

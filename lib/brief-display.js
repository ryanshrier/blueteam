import { createHash } from 'node:crypto';
import { marked } from 'marked';
import { parseBrief, stripMd, STORY_OPENING_CONTRACT } from './brief-schema.js';
import { capturedCitationTokens, protectedSpans } from './brief-citations.js';
import { escapeRegExp } from './regex-util.js';

const digest = content => createHash('sha256').update(content).digest('hex');

/** Remove only captured bibliography groups following a complete sentence.
 * Never delete linked subjects, conditions, attribution, or arbitrary brackets. */
export function displayProse(markdown, tokens = []) {
  if (!tokens.length) return stripMd(markdown);
  const token = `(?:${tokens.map(escapeRegExp).join('|')})`;
  // Existing Markdown links are intentionally eligible; code and HTML aren't.
  const codeSpans = protectedSpans(markdown).filter(([start]) => markdown[start] !== '[');
  const clean = markdown.replace(new RegExp(`([.!?])[ \\t]+${token}(?:[ \\t]+${token})*(?=\\s|$)`, 'g'), (raw, punctuation, offset) => {
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
      const first = marked.lexer(story.narrative).find(token => token.type !== 'space');
      return { index, originalTitle: story.title, narrative: story.narrative,
        opening: first?.type === 'paragraph' ? displayProse(first.raw.trim(), tokens) : '',
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

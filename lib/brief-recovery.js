// Bounded regression checks for a corrective attempt. Passing these checks is
// not proof of equivalent meaning or editorial quality; publication still uses
// the complete validator. A smaller repair may remove only located defective
// judgments while retaining unaffected judgments and repairing other located defects.
import { publicationDecision } from './validation.js';
import { marked } from 'marked';
import { briefSections, briefFormatVersion, section, splitEntries, stripMd } from './brief-schema.js';

const material = validation => {
  const decision = publicationDecision(validation);
  return [...decision.blockers, ...decision.reviewIssues];
};
// Locations and judgment ordinals may change during a legitimate repair.
// Preserve all remaining message details, including identities and values.
function findingKeys(issue) {
  const message = String(issue.message || '').replace(/\b(Signal|Convergence) \d+\b/g, '$1');
  // These checkers aggregate identities in one finding. Resolving one identity
  // must not look like a new finding merely because the list became shorter.
  // Truncated lists and unknown formats remain opaque: don't infer their scope.
  const list = issue.code === 'GROUNDING' && /^(Ungrounded CVE\(s\) in no source headline|CVE\(s\) labeled KEV but not in the verified catalog|CVE\(s\) described as pending\/not in KEV but already in the verified catalog|KEV catalog unavailable — cannot verify claim\(s\)|KEV catalog freshness unavailable — cannot establish current membership claim\(s\)): (CVE-\d{4}-\d{3,7}(?:, CVE-\d{4}-\d{3,7})*)$/.exec(message);
  return list ? list[2].split(', ').map(id => `${issue.code}:${list[1]}:${id}`) : [`${issue.code}:${message}`];
}

const plain = text => stripMd(String(text || '')).replace(/\s+/g, ' ').trim();

// Use the same entry grammar as publication, retaining actual document lines.
// Ambiguous section boundaries and code/comment headings cannot authorize a
// deletion. This is a narrow recovery exception, not a second prose parser.
function locatedJudgments(text) {
  const document = String(text || '').replace(/\r\n/g, '\n');
  const narrative = briefFormatVersion(document) === 2;
  const headings = [...document.matchAll(narrative ? /^##[ \t]+PRIORITY STORIES[^\n]*\n/gim : /^##[ \t]+KEY JUDGMENTS[^\n]*\n/gim)];
  if (headings.length !== 1) return null;
  const prefix = document.slice(0, headings[0].index);
  // A protected region may begin before this section, so examining the section
  // body alone would mistake a quoted/commented report for visible judgments.
  if (prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->')) return null;
  let fence = null;
  const visiblePrefix = prefix.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
  for (const line of visiblePrefix.split('\n')) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
      && !line.slice(marker[0].length).trim()) fence = null;
  }
  if (fence) return null;
  const block = section(document, briefSections(document).keyJudgments);
  if (/(?:^|\n)[ \t]*(?:```|~~~)|<!--/.test(block)) return null;
  const offset = document.indexOf(block, headings[0].index + headings[0][0].length);
  if (!block || offset < 0) return null;
  const entries = [...block.matchAll(/(?:^|\n)###\s+([\s\S]*?)(?=\n###\s|$)/g)];
  return entries.map((match, index) => {
    const start = offset + match.index + (match[0].startsWith('\n') ? 1 : 0);
    const end = offset + match.index + match[0].length;
    const entry = match[1].trim();
    return {
      index,
      startLine: document.slice(0, start).split('\n').length,
      endLine: document.slice(0, end).split('\n').length,
      signal: narrative ? index + 1 : Number(/^Signal\s+(\d+)(?=\s|$)/i.exec(entry)?.[1]),
      title: entry.split('\n')[0].replace(/^Signal\s+\d+\s*(?:[—–-]\s*)?(?:\[Horizon [123]\]\s*)?/i, '').trim(),
      identities: [...new Set(entry.match(/\bCVE-\d{4}-\d{3,7}\b/gi) || [])].map(id => id.toUpperCase()).sort().join(','),
      // A section separator may move onto the last surviving entry. All
      // actual prose, values, citations and action text remain byte-sensitive.
      key: entry.replace(/^Signal\s+\d+(?=\s|$)/i, 'Signal #')
        .replace(/\n(?:[ \t]*\n)*[ \t]*---[ \t]*(?:\n[ \t]*)*$/, '').trim(),
    };
  });
}

function blockerJudgment(issue, entries, lines) {
  const signals = [...new Set([...String(issue.message || '').matchAll(/\bSignal\s+(\d+)\b/gi)]
    .map(match => Number(match[1])))];
  if (signals.length > 1) return null;
  let explicit = null;
  if (signals.length) {
    explicit = entries[signals[0] - 1];
    // Validator messages use ordinal positions. Noncanonical or repeated
    // authored numbers cannot silently redirect that identity to another entry.
    if (!explicit || explicit.signal !== signals[0]
      || entries.filter(entry => entry.signal === signals[0]).length !== 1) return null;
  }
  const location = issue.location;
  if (!location) return explicit;
  if (!['judgment', 'paragraph'].includes(location.scope)
    || !Number.isInteger(location.line) || location.line < 1) return null;
  const located = entries.find(entry => location.line >= entry.startLine && location.line <= entry.endLine);
  if (!located || (explicit && located !== explicit)) return null;
  const excerpt = plain(location.excerpt);
  // A paragraph finding can span wrapped Markdown lines. Verify its excerpt
  // within this same story, never against a different story or the document.
  const actual = plain(lines.slice(location.line - 1, located.endLine).join('\n'));
  if (excerpt && (!actual || !actual.includes(excerpt))) return null;
  // A bare global line number is not enough evidence to remove content.
  return explicit || (excerpt && actual ? located : null);
}

function onlyDefectiveJudgmentsRemoved(original, candidate) {
  const before = locatedJudgments(original.text);
  const after = locatedJudgments(candidate.text);
  if (!before || !after || !after.length) return false;
  const lines = String(original.text || '').replace(/\r\n/g, '\n').split('\n');
  const defective = new Set(publicationDecision(original.validation).blockers
    .map(issue => blockerJudgment(issue, before, lines)?.index).filter(index => index !== undefined));
  const surviving = new Set();
  for (const entry of after) {
    let matches = before.filter(previous => previous.key === entry.key);
    // A separately located defective survivor can be repaired while another
    // defective entry is omitted. Bind it to a unique original title or CVE set;
    // unchanged entries still require exact text, and new/ambiguous identities
    // cannot displace unaffected coverage.
    if (!matches.length) matches = before.filter(previous => defective.has(previous.index)
      && ((entry.title && entry.title === previous.title)
        || (entry.identities && entry.identities === previous.identities)));
    // Identical repeated entries have no reliable identity for deletion.
    if (matches.length !== 1 || surviving.has(matches[0].index)) return false;
    surviving.add(matches[0].index);
  }
  return before.every(entry => surviving.has(entry.index) || defective.has(entry.index));
}

// Top-level Markdown tokens exclude quoted, fenced and HTML heading lookalikes.
// Keep complete story prose rather than extracting a new summary during repair.
export function narrativeParts(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n');
  const tokens = []; let offset = 0, line = 1;
  for (const token of marked.lexer(text, { gfm: true })) {
    // Reference definitions are absent from Marked's output tokens. Count
    // through the source before each token to keep findings on the right line.
    if (!text.startsWith(token.raw, offset)) {
      const start = text.indexOf(token.raw, offset);
      if (start >= 0) {
        line += text.slice(offset, start).split('\n').length - 1;
        offset = start;
      } else if (text.slice(offset).trimEnd() !== token.raw.trimEnd()) return null;
    }
    tokens.push({ ...token, start: offset, line });
    offset += token.raw.length;
    line += token.raw.split('\n').length - 1;
  }
  const sections = tokens.filter(token => token.type === 'heading' && token.depth === 2);
  const priority = sections.filter(token => token.text.toUpperCase() === 'PRIORITY STORIES');
  if (priority.length !== 1) return null;
  const end = sections.find(token => token.start > priority[0].start)?.start ?? text.length;
  const headings = tokens.filter(token => token.type === 'heading' && token.depth === 3
    && token.start > priority[0].start && token.start < end);
  if (!headings.length) return null;
  const part = (start, finish, title) => {
    const raw = text.slice(start, finish);
    const paragraphs = tokens.filter(token => token.type === 'paragraph' && token.start >= start && token.start < finish)
      .map(token => ({ raw: token.raw.trimEnd(), offset: token.start - start, line: token.line }));
    return { raw, start, paragraphs, title: stripMd(title).trim().replace(/^Signal\s+\d+\s*(?:[—–-]\s*)?(?:\[Horizon [123]\]\s*)?/i, ''), startLine: text.slice(0, start).split('\n').length,
      endLine: text.slice(0, finish).split('\n').length - (raw.endsWith('\n') ? 1 : 0),
      identities: [...new Set(raw.match(/\bCVE-\d{4}-\d{3,7}\b/gi) || [])].map(id => id.toUpperCase()).sort().join(',') };
  };
  const picture = sections.filter(token => token.text.toUpperCase() === "TODAY'S PICTURE");
  const lead = picture.length === 1 && sections.indexOf(picture[0]) + 1 === sections.indexOf(priority[0])
    ? part(picture[0].start + picture[0].raw.length, priority[0].start, picture[0].text) : null;
  return { text, lead, prefix: text.slice(0, headings[0].start),
    stories: headings.map((heading, index) => ({ ...part(heading.start, headings[index + 1]?.start ?? end, heading.text), index, signal: index + 1 })),
    tail: sections.filter(heading => heading.start >= end).map(heading =>
      part(heading.start, sections.find(next => next.start > heading.start)?.start ?? text.length, heading.text)) };
}

const localFactFinding = issue => issue.location?.scope === 'paragraph'
  && /^(?:CVE_CVSS_|CVSS_|FACT_CVSS_|CITATION_REFERENCE_INVALID$|CITATION_IDENTITY_INVALID$|CVE_CITATION_MISMATCH$)/.test(issue.code);

function repeatsLocatedFact(text, issues) {
  return issues.some(issue => {
    if (issue.code === 'CITATION_REFERENCE_INVALID') return Boolean(issue.location.excerpt && text.includes(issue.location.excerpt));
    if (!issue.claimKey?.startsWith('cvss:')) return false;
    try {
      const [, , score] = JSON.parse(issue.claimKey.slice(5));
      return typeof score === 'number' && /\b(?:CVSS|score|rating|assessment)\b/i.test(text)
        && (text.match(/\b\d+(?:\.\d+)?\b/g) || []).includes(String(score));
    } catch { return false; }
  });
}

// Splice located paragraphs into the original story, retaining the headline,
// other paragraphs and their Markdown verbatim. A simple candidate paragraph
// may be removed when every surviving paragraph already matches the original.
// Ambiguous boundaries stay on the story-level recovery path.
function repairLocatedParagraphs(story, replacement, issues) {
  if (!issues?.length || !issues.every(localFactFinding)) return replacement.raw;
  const paragraphs = story.paragraphs;
  const changed = new Set();
  for (const issue of issues) {
    const i = paragraphs.findIndex(p => issue.location.line >= p.line && issue.location.line < p.line + p.raw.split('\n').length);
    if (i < 0) return replacement.raw;
    changed.add(i);
  }
  paragraphs.forEach((p, i) => { if (repeatsLocatedFact(p.raw, issues)) changed.add(i); });
  const candidates = replacement.paragraphs;
  const stable = paragraphs.filter((_, i) => !changed.has(i));
  const onlyRemoved = stable.length === candidates.length && stable.every((p, i) => p.raw === candidates[i].raw);
  const edits = [];
  for (const i of changed) {
    const p = paragraphs[i];
    let corrected = candidates[i];
    if (onlyRemoved) corrected = null;
    else {
      // A provider may move or delete a paragraph. A shared, unique citation
      // can identify the corrected passage even when its position changes.
      const links = (p.raw.match(/\]\([^\s)]+\)/g) || []).filter(link =>
        paragraphs.filter(other => other.raw.includes(link)).length === 1);
      const matches = candidates.filter(candidate => links.some(link => candidate.raw.includes(link)));
      if (matches.length === 1) [corrected] = matches;
      else if (paragraphs.length !== candidates.length || stable.some(other => other.raw === corrected.raw)) return replacement.raw;
      if (edits.some(edit => edit.corrected === corrected)) return replacement.raw;
    }
    edits.push({ p, corrected });
  }
  let merged = story.raw;
  for (const { p, corrected } of edits.sort((a, b) => b.p.offset - a.p.offset)) {
    merged = merged.slice(0, p.offset) + (corrected?.raw || '') + merged.slice(p.offset + p.raw.length);
  }
  return merged;
}

/** Merge a complete corrective response into its captured draft. This neither
 * approves claims nor changes validation policy. The merged copy must be checked.
 * Partial-output regeneration and malformed original structures keep their
 * existing recovery path; they are not complete drafts to splice into. */
export function preserveUnaffectedStories(original, candidate) {
  const unchanged = { content: candidate.text, preservation: null };
  if (original.partial || candidate.partial || briefFormatVersion(original.text) !== 2
    || briefFormatVersion(candidate.text) !== 2) return unchanged;
  const before = narrativeParts(original.text), after = narrativeParts(candidate.text);
  if (!before || !after) return unchanged;
  const issues = material(original.validation);
  const lines = before.text.split('\n');
  const editable = new Set(), removable = new Set(), storyIssues = new Map();
  const blockers = new Set(publicationDecision(original.validation).blockers);
  for (const issue of issues) {
    const located = blockerJudgment(issue, before.stories, lines);
    if (located) {
      editable.add(located.index);
      if (!storyIssues.has(located.index)) storyIssues.set(located.index, []);
      storyIssues.get(located.index).push(issue);
      if (blockers.has(issue)) removable.add(located.index);
    } else if ((!issue.location || issue.location.scope === 'document') && !/\bSignal\s+\d+/i.test(issue.message || '')) {
      // Whole-document identity checks can name a CVE without a story ordinal.
      // That permits its correction, never deletion on an inferred association.
      const ids = (issue.message || '').match(/\bCVE-\d{4}-\d{3,7}\b/gi) || [];
      for (const story of before.stories) if (ids.some(id => story.identities.split(',').includes(id.toUpperCase()))) {
        editable.add(story.index);
        if (!storyIssues.has(story.index)) storyIssues.set(story.index, []);
        storyIssues.get(story.index).push(issue);
      }
    }
  }
  const matches = new Map(), used = new Set();
  for (const story of before.stories) {
    for (const key of ['title', 'identities']) {
      if (!story[key] || before.stories.filter(other => other[key] === story[key]).length !== 1) continue;
      const candidates = after.stories.filter(other => other[key] === story[key]);
      if (candidates.length === 1 && !used.has(candidates[0].index)) {
        matches.set(story.index, candidates[0]); used.add(candidates[0].index); break;
      }
    }
  }
  const unmatchedTargets = before.stories.filter(story => editable.has(story.index) && !matches.has(story.index));
  const unmatchedCandidates = after.stories.filter(story => !used.has(story.index));
  // A single remaining repair target is unambiguous even if its erroneous CVE
  // and title both changed. Multiple unknown identities cannot be guessed.
  if (unmatchedTargets.length === 1 && unmatchedCandidates.length === 1
    && before.stories.every(story => editable.has(story.index) || matches.has(story.index))) {
    matches.set(unmatchedTargets[0].index, unmatchedCandidates[0]); used.add(unmatchedCandidates[0].index);
  }
  const preservation = { restoredStories: [], editedStories: [], omittedStories: [], restoredSections: [], restoredStoryPassages: [] };
  const stories = before.stories.flatMap(story => {
    const replacement = matches.get(story.index);
    if (editable.has(story.index) && replacement) {
      const merged = repairLocatedParagraphs(story, replacement, storyIssues.get(story.index));
      if (merged.trim() !== replacement.raw.trim()) preservation.restoredStoryPassages.push(story.signal);
      if (merged.trim() !== story.raw.trim()) preservation.editedStories.push(story.signal);
      return [merged.trimEnd()];
    }
    if (!replacement && removable.has(story.index) && used.size === after.stories.length
      && after.stories.length < before.stories.length) {
      preservation.omittedStories.push(story.signal); return [];
    }
    if (!replacement || replacement.raw.trim() !== story.raw.trim()) preservation.restoredStories.push(story.signal);
    return [story.raw.trimEnd()];
  });
  const tail = before.tail.map(section => {
    const located = issues.some(issue => issue.location && issue.location.scope !== 'document'
      && issue.location.line >= section.startLine && issue.location.line <= section.endLine);
    const replacements = after.tail.filter(other => other.title === section.title);
    if ((located || repeatsLocatedFact(section.raw, issues)) && replacements.length === 1) return replacements[0].raw.trimEnd();
    if (replacements.length !== 1 || replacements[0].raw.trim() !== section.raw.trim()) preservation.restoredSections.push(section.title);
    return section.raw.trimEnd();
  });
  const order = before.stories.flatMap(story => matches.has(story.index) ? [matches.get(story.index).index] : []);
  const sameOrder = order.every((index, position) => index === position);
  const sameSections = before.tail.length === after.tail.length && before.tail.every((section,index) => section.title === after.tail[index].title);
  const preserveOpening = issues.length && issues.every(localFactFinding) && !preservation.omittedStories.length
    && issues.every(issue => issue.location.line >= before.stories[0].startLine) && !repeatsLocatedFact(before.prefix, issues);
  const prefix = preserveOpening ? before.prefix : after.prefix;
  if (prefix !== after.prefix) preservation.restoredSections.push("TODAY'S PICTURE");
  if (!preservation.restoredStories.length && !preservation.restoredSections.length && !preservation.restoredStoryPassages.length
    && used.size === after.stories.length && sameOrder && sameSections) return { content: candidate.text, preservation };
  // The opening can change with the repaired assessment. Optional, unaffected
  // sections stay original; a repair cannot add unrelated reporting at the end.
  let content = prefix + [...stories, ...tail].join('\n\n') + '\n';
  if (String(original.text).includes('\r\n')) content = content.replace(/\n/g, '\r\n');
  return { content, preservation };
}

export function correctiveRecoveryDecision(original, candidate) {
  if (briefFormatVersion(original.text) !== briefFormatVersion(candidate.text)) return { accepted: false, reason: 'format-changed' };
  if (!original.partial && candidate.partial) return { accepted: false, reason: 'incomplete-replacement' };
  const originalJudgments = splitEntries(section(original.text, briefSections(original.text).keyJudgments)).length;
  const candidateJudgments = splitEntries(section(candidate.text, briefSections(candidate.text).keyJudgments)).length;
  // Output-limit recovery explicitly requests a shorter complete edition. A
  // completed response may omit a specifically defective judgment, but cannot
  // improve its checks by removing or rewriting unaffected coverage.
  if (!original.partial && candidateJudgments < originalJudgments
    && !onlyDefectiveJudgmentsRemoved(original, candidate)) return { accepted: false, reason: 'judgments-removed' };
  const preserved = preserveUnaffectedStories(original, candidate).preservation;
  if (preserved?.restoredStories.length || preserved?.restoredSections.length || preserved?.restoredStoryPassages.length) return { accepted: false, reason: 'unaffected-reporting-changed' };
  const before = material({ ...original.validation, partial: original.partial }).flatMap(findingKeys);
  const after = material({ ...candidate.validation, partial: candidate.partial }).flatMap(findingKeys);
  const remaining = new Map();
  for (const key of before) remaining.set(key, (remaining.get(key) || 0) + 1);
  for (const key of after) {
    const available = remaining.get(key) || 0;
    if (!available) return { accepted: false, reason: 'new-material-findings' };
    remaining.set(key, available - 1);
  }
  if (after.length >= before.length) return { accepted: false, reason: 'no-material-improvement' };
  return { accepted: true, reason: 'resolved-findings' };
}

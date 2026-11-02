// Descriptive diagnostics for provider runs and frozen replays. These are not
// semantic accuracy scores, publication rules, or reasons to call a model again.
import { parseBrief, storyDisplay } from '../../lib/brief-schema.js';
import { verifiedBriefDisplay } from '../../lib/brief-display.js';
const words = value => String(value || '').trim().split(/\s+/).filter(Boolean).length;
const cves = value => String(value || '').match(/\bCVE-\d{4}-\d{3,7}\b/gi) || [];
export function evaluateBriefDisplay(content, receipt = {}, requests = []) {
  const displayCopy = verifiedBriefDisplay(content, receipt.displayCopy);
  const stories = parseBrief(content).stories.map((story, index) => {
    const display = storyDisplay(story, index, { presentation: { displayCopy } });
    const passage = display.paragraphs.join('\n\n');
    return { title: story.title, provenance: display.provenance, headlineWords: words(story.title),
      displayWords: words(passage), fullStoryWords: words(story.assessment), displayCveMentions: cves(passage).length,
      fullStoryCveMentions: cves(story.assessment).length, paragraphs: story.paragraphs?.length || 1,
      // Useful to locate examples for review, never sufficient to judge quality.
      displayText: passage, advisoryLengthTarget: display.summary ? words(display.summary) >= 40 && words(display.summary) <= 60 : null };
  });
  return { displayAvailable: Boolean(displayCopy), stories,
    requests: requests.map(request => {
      const input = JSON.stringify(request.messages || request.input || '');
      const ids = [...input.matchAll(/Evidence ID: (NVD-CVE-[0-9-]+)/g)].map(match => match[1]);
      return { inputCharacters: input.length, nvdOccurrences: ids.length, distinctNvdIds: new Set(ids).size };
    }),
    editorialRubric: ['Opening explains the consequential change rather than listing identifiers.',
      'Opening retains its material attribution, affected scope, uncertainty and conditions when read alone.',
      'Supporting paragraphs add evidence or reasoning without repeating the opening.',
      'Conditional implications preserve relevant investigation, credential and recovery distinctions.',
      'No invented owners, deadlines, approvals or compulsory closing action.',
      'Compare Overview, complete report and actual Wall screens; counts alone cannot establish quality.'] };
}

// A generated report can turn a source's explicit local unknown into a direct
// statement about the reader. These two narrow edits need no model response.
// Apply only to a complete eligible first draft. The caller checks the result.
import { narrativeParts } from './brief-recovery.js';
import { capturedCitationTokens, protectedSpans } from './brief-citations.js';
import { sourceEvidencePassages } from './source-passages.js';

const localClaim = /(?:^|(?<=[.!?])\s+)Our (?:[\p{L}\d-]+ ){1,5}(?:is|are|was|were|has been|have been) (?:confirmed )?compromised\.(?=\s|$)/gu;
const populationClaim = /^(?:All|Every) (?:affected )?(?:customers?|clients?|deployments?|organizations?|sites?) (?:have |has )?(?:confirmed|reported) (?:the )?(?:compromise|breach|exposure) of (?:their |its |the )?([\p{L}\d-]+(?: [\p{L}\d-]+){0,5})\.$/u;
const genericAsset = new Set('system systems network networks account accounts service services data environment environments application applications'.split(' '));

function substantivePublisher(source) {
  return /^S\d+\.\d+$/i.test(source.id) && source.quality?.substantive === true && sourceEvidencePassages(source).length > 0;
}

function sourceExplicitlyLeavesCompromiseUnknown(passages) {
  const relevant = passages.flatMap(passage => passage.split(/[.!?;\n]/))
    .filter(sentence => /\b(?:local|our|we)\b/i.test(sentence) && /\bcompromis(?:e|ed)\b/i.test(sentence));
  // Preserve conflicting evidence. Require a direct declaration, including
  // simple lists such as "Local deployment, exposure and compromise are unknown".
  return relevant.length > 0 && relevant.every(sentence => {
    const unknowns = /^\s*Local ([\w ,–-]{1,160}) (?:is|are|remains?) (?:unknown|unconfirmed|undetermined)\s*$/i.exec(sentence);
    return unknowns?.[1].toLowerCase().split(/,|\band\b/).some(subject => subject.trim() === 'compromise');
  });
}

function citedOpening(story, sources) {
  const opening = story.paragraphs[0];
  if (!opening || /\bOur\b|[<>]/.test(opening.raw)
      || !/^\s*### [^\n]+\n\s*$/u.test(story.raw.slice(0, opening.offset))) return null;
  const citations = sources.filter(substantivePublisher).flatMap(source =>
    capturedCitationTokens({ members: [source] }).map(token => ({ token, id: source.id })));
  let prose = opening.raw;
  const sourceIds = [];
  for (;;) {
    const matches = citations.filter(({ token }) => prose.endsWith(' ' + token));
    if (matches.length > 1) return null;
    if (!matches.length) break;
    const { token, id } = matches[0];
    sourceIds.unshift(id);
    prose = prose.slice(0, -token.length).trimEnd();
  }
  // An in-sentence linked subject must stay with its claim. Move the complete
  // opening only when its terminal source group is clearly a bibliography;
  // the citations remain at the original story and in the receipt.
  return sourceIds.length && /[.!?]$/.test(prose) ? { prose, sourceIds: [...new Set(sourceIds)] } : null;
}

export function repairFirstDraftIncidentScope(content, grounding, judgmentEvidence = []) {
  const untouched = { content, repairs: [] };
  if (!/\b(?:Our [^.!?\n]{1,110} compromised\.|(?:All|Every) [^.!?\n]{1,75} (?:compromise|breach|exposure) of )/.test(content)) return untouched;
  const doc = narrativeParts(content);
  const records = grounding?.members || grounding?.sources || [];
  if (!doc || !records.length) return untouched;
  const byId = new Map(records.map(record => [record.id, record]));
  const edits = [];
  let conflictingLocalEvidence;
  let firstOpening;
  for (const story of doc.stories) {
    const ids = judgmentEvidence.find(item => item.signal === story.signal)?.sourceIds || [];
    const sources = ids.map(id => byId.get(id)).filter(Boolean);
    if (story.index === 0) firstOpening = citedOpening(story, sources);
    if (sources.length !== 1 || !story.raw.includes('Our ') || !substantivePublisher(sources[0])
        || !sourceExplicitlyLeavesCompromiseUnknown(sourceEvidencePassages(sources[0]))) continue;
    // A separate captured report can establish or dispute local status. A
    // statement about one affected customer is not a local observation.
    conflictingLocalEvidence ??= records.some(record => sourceEvidencePassages(record).some(passage =>
      /\b(?:confirmed|verified) local compromise\b|\blocal compromise (?:was |is |has been )?(?:confirmed|verified)\b|\bour [\w -]{1,60} (?:is|are|was|were|have been|has been) compromised\b/i.test(passage)));
    if (conflictingLocalEvidence) continue;
    for (const paragraph of story.paragraphs) {
      if (!paragraph.raw.includes('Our ') || /["“”‘«<>]|(?:^|\s)'/.test(paragraph.raw)) continue;
      const protectedRanges = protectedSpans(paragraph.raw);
      for (const match of paragraph.raw.matchAll(localClaim)) {
        const start = match.index + match[0].indexOf('Our ');
        if (protectedRanges.some(([a, b]) => start < b && match.index + match[0].length > a)) continue;
        edits.push({ at: story.start + paragraph.offset + start, length: match[0].trimStart().length,
          replacement: 'Local compromise remains unconfirmed.', record: { kind: 'restore-local-uncertainty', story: story.signal, sourceIds: ids } });
      }
    }
  }
  // An edition summary can synthesize several stories. Replace only a direct
  // population-wide incident assertion about an asset absent from both the
  // other reporting and the substantive source packet. Preserve paraphrases
  // whenever either contains the subject or evidence of a population-wide event.
  const lead = doc.lead?.raw.trim() || '';
  const claim = populationClaim.exec(lead);
  if (claim && firstOpening) {
    const subjects = claim[1].toLowerCase().split(' ').filter(term => term.length > 2 && !genericAsset.has(term));
    const evidence = [doc.text.slice(doc.lead.start + doc.lead.raw.length),
      ...records.flatMap(record => sourceEvidencePassages(record).length ? [String(record.title || ''), ...sourceEvidencePassages(record)] : [])];
    if (subjects.length && evidence.every(passage => !subjects.some(term => passage.toLowerCase().includes(term))
        && !/\b(?:all|every|each) (?:affected )?(?:customers?|clients?|deployments?|organizations?|sites?)\b/i.test(passage)
        && !/\b(?:all|every|each)\b[^.!?\n]{0,100}\b(?:compromis\w*|breach\w*|expos\w*)\b/i.test(passage))) {
      edits.push({ at: doc.lead.start + doc.lead.raw.indexOf(lead), length: lead.length, replacement: firstOpening.prose,
        record: { kind: 'use-cited-story-opening', story: 1, sourceIds: firstOpening.sourceIds } });
    }
  }
  if (!edits.length) return untouched;
  let text = doc.text;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    text = text.slice(0, edit.at) + edit.replacement + text.slice(edit.at + edit.length);
  }
  return { content: content.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text, repairs: edits.map(edit => edit.record) };
}

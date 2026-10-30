// A source-location index shared by the server and reader. Pass the top-level
// Markdown tokens from the same lexer as the rendered document. Nested tokens
// are deliberately not traversed: examples cannot create assessment identities.
export function briefSourceIndex(value, tokens) {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  const lineCount = source.split('\n').length;
  const headings = [];
  let cursor = 0;
  for (const token of tokens || []) {
    if (!token.raw) continue;
    const start = source.indexOf(token.raw, cursor);
    if (start < 0) return { headings: [], judgments: [], lineCount };
    cursor = start + token.raw.length;
    if (token.type !== 'heading' || ![1, 2, 3].includes(token.depth)) continue;
    const label = String(token.text || '').replace(/[*_`]/g, '').trim();
    headings.push({ depth: token.depth, label, sourceLabel: String(token.text || ''), line: source.slice(0, start).split('\n').length });
  }
  headings.forEach((heading, index) => {
    heading.endLine = headings.slice(index + 1).find(next => next.depth <= heading.depth)?.line - 1 || lineCount;
  });
  const narrative = /^\uFEFF?\s*<!--\s*briefing-format:\s*2\s*-->/.test(source);
  const sections = headings.filter(heading => heading.depth === 2 && (narrative ? /^PRIORITY STORIES$/i : /^KEY JUDGMENTS\b/i).test(heading.label));
  const section = sections.length === 1 ? sections[0] : null;
  const judgments = section ? headings.filter(heading => heading.depth === 3 && heading.line > section.line && heading.line <= section.endLine)
    .map((heading, index) => ({ ...heading, signal: index + 1, signalId: `S${index + 1}` })) : [];
  return { headings, judgments, lineCount };
}

export function sourceFindingLocation(index, issue) {
  if (issue?.location?.scope === 'document') return { kind: 'document' };
  const line = issue?.location?.line;
  if (!Number.isSafeInteger(line) || line < 1 || line > index.lineCount) return null;
  const judgment = index.judgments.find(heading => line >= heading.line && line <= heading.endLine);
  if (judgment) return { kind: 'judgment', ...judgment };
  const heading = index.headings.findLast(candidate => candidate.line <= line && candidate.endLine >= line);
  return heading ? { kind: 'section', ...heading } : null;
}

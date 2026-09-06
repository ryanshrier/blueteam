// Independent acceptance readers: do not import the production CSV serializer
// or Print Edition renderer to calculate their own expected results.
import assert from 'node:assert/strict';
import { parseDocument } from 'htmlparser2';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, endedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; endedQuote = true; }
      else cell += char;
    } else if (char === ',' || char === '\r' || char === '\n') {
      row.push(cell); cell = ''; endedQuote = false;
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (char === '"' && !cell && !endedQuote) quoted = true;
    else { assert(!endedQuote && char !== '"', 'Malformed CSV quoting'); cell += char; }
  }
  assert(!quoted, 'Unterminated CSV quote');
  if (cell || row.length || endedQuote) rows.push([...row, cell]);
  assert(rows.length > 1, 'CSV has a header and data');
  const [columns, ...values] = rows;
  assert.equal(new Set(columns).size, columns.length, 'Unique CSV columns');
  return values.map(value => {
    assert.equal(value.length, columns.length, 'CSV row width matches header');
    return Object.fromEntries(columns.map((key, index) => [key, value[index]]));
  });
}

export function normalizedPdfText(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Poppler's ordinary text ordering may insert a right-hand deadline between
// lines of a left-hand action, or read both column tops before a page break.
// Reconstruct contiguous lines sharing a physical left edge. This preserves
// every word within each region; it does not search an arbitrary subsequence
// or pool missing words from unrelated columns.
export function pdfTextRegions(bboxHtml) {
  const lines = [];
  let page = 0;
  let wordId = 0;
  const textOf = node => node.type === 'text' ? node.data : (node.children || []).map(textOf).join('');
  function visit(node) {
    if (node.name === 'page') page++;
    if (node.name === 'line') {
      const words = (node.children || []).filter(child => child.name === 'word').map(child => ({ id: wordId++, text: textOf(child),
        page, left: Number(child.attribs.xmin), top: Number(child.attribs.ymin) }));
      const text = words.map(word => word.text).join(' ');
      const left = Number(node.attribs.xmin), top = Number(node.attribs.ymin);
      if (text && Number.isFinite(left) && Number.isFinite(top)
        && !/^BlueTeam\.News\s*[·•]?\s*Print edition\b/i.test(text)
        && !/^Page\s+\d+\s+of\s+\d+$/i.test(text)) lines.push({ page, left, top, text, words });
    }
    for (const child of node.children || []) visit(child);
  }
  visit(parseDocument(bboxHtml));
  const readingOrder = { left: null, lines: lines.slice() };
  const regions = [];
  for (const line of lines.sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left)) {
    let region = regions.find(value => Math.abs(value.left - line.left) <= 1);
    if (!region) { region = { left: line.left, lines: [] }; regions.push(region); }
    region.lines.push(line);
  }
  return [readingOrder, ...regions].map(region => {
    let normalized = '';
    const words = region.lines.flatMap(line => line.words).map(word => {
      const start = normalized.length;
      normalized += normalizedPdfText(word.text);
      return { ...word, start, end: normalized.length };
    }).filter(word => word.end > word.start);
    return { left: region.left, text: region.lines.map(line => line.text).join('\n'), normalized, words };
  });
}

export function matchPdfPassages(regions, passages) {
  const used = new Set();
  const matches = [];
  // Reserve complete long paragraphs before their repeated shorter phrases.
  // Every occurrence must own separate PDF words, even across candidate views
  // of the same text. One repeated paragraph cannot stand in for two DOM blocks.
  const ordered = passages.map((text, index) => ({ text, index, wanted: normalizedPdfText(text) }))
    .sort((a, b) => b.wanted.length - a.wanted.length);
  for (const passage of ordered) {
    let match;
    for (const region of regions) {
      let offset = 0;
      while (offset < region.normalized.length) {
        const start = region.normalized.indexOf(passage.wanted, offset);
        if (start < 0) break;
        const end = start + passage.wanted.length;
        const words = region.words.filter(word => word.end > start && word.start < end);
        if (words.length && words[0].start === start && words.at(-1).end === end && words.every(word => !used.has(word.id))) {
          const candidate = { index: passage.index, region: region.left, first: words[0], words };
          // Repeated text can appear earlier in a split column than in the
          // default extraction. Allocate its earliest physical occurrence,
          // rather than letting candidate ordering misidentify its page.
          if (!match || candidate.first.page < match.first.page
            || (candidate.first.page === match.first.page && candidate.first.top < match.first.top)
            || (candidate.first.page === match.first.page && candidate.first.top === match.first.top && candidate.first.left < match.first.left)) match = candidate;
          break;
        }
        offset = start + 1;
      }
    }
    assert(match, `PDF lost text or a repeated occurrence: ${passage.text.slice(0, 150)}`);
    for (const word of match.words) used.add(word.id);
    matches.push(match);
  }
  const columns = [];
  for (const match of matches.sort((a, b) => a.index - b.index)) {
    const { first } = match;
    const previous = columns.find(column => Math.abs(column.left - first.left) <= 1);
    if (previous) {
      assert(first.page > previous.page || (first.page === previous.page && first.top >= previous.top - 1), 'PDF paragraphs changed order within a text column');
      Object.assign(previous, first);
    } else columns.push({ ...first });
  }
  return { checkedPassages: matches.length, matchedByRegion: matches.filter(match => match.region !== null).length, distinctWordsChecked: used.size,
    passagePositions: matches.map(match => ({ index: match.index, pages: [...new Set(match.words.map(word => word.page))], left: match.first.left, top: match.first.top })) };
}

export function inspectPdfText(text, expectedPassages, bboxHtml = '') {
  const pages = text.split('\f');
  if (!pages.at(-1)?.trim()) pages.pop();
  assert(pages.length >= 2, 'The long edition exercises actual pagination');
  const bodyPages = pages.map(page => page.split('\n').filter(line =>
    !/^\s*BlueTeam\.News\s*[·•]?\s*Print edition\b/i.test(line)
      && !/^\s*Page\s+\d+\s+of\s+\d+\s*$/i.test(line)).join('\n'));
  for (let index = 0; index < bodyPages.length; index++) {
    assert(normalizedPdfText(bodyPages[index]).length >= 30, `PDF page ${index + 1} contains body content, not just a running folio`);
  }
  let matches;
  if (bboxHtml) matches = matchPdfPassages(pdfTextRegions(bboxHtml), expectedPassages);
  else {
    const normalized = normalizedPdfText(bodyPages.join('\n'));
    for (const passage of expectedPassages) assert(normalized.includes(normalizedPdfText(passage)), `PDF lost text: ${passage.slice(0, 150)}`);
    matches = { checkedPassages: expectedPassages.length, matchedByRegion: 0 };
  }
  assert(normalizedPdfText(bodyPages.at(-1)).includes(normalizedPdfText('Verify every CVE ID, vendor name, date, and link before acting.')), 'Final PDF page retains the verification colophon');
  return { pageCount: pages.length, charactersPerPage: bodyPages.map(page => normalizedPdfText(page).length), ...matches };
}

export function inspectPdfBounds(bboxHtml) {
  const pages = [];
  function visit(node, page = null) {
    if (node.name === 'page') {
      page = { width: Number(node.attribs.width), height: Number(node.attribs.height), words: 0 };
      assert(page.width > 0 && page.height > 0, 'PDF page has physical dimensions');
      pages.push(page);
    }
    if (node.name === 'word') {
      const box = ['xmin', 'ymin', 'xmax', 'ymax'].map(key => Number(node.attribs[key]));
      assert(page && box.every(Number.isFinite), 'PDF text has valid coordinates');
      assert(box[0] >= 0 && box[1] >= 0 && box[2] <= page.width + 0.5 && box[3] <= page.height + 0.5,
        `PDF text exceeds page ${pages.length}: ${box.join(', ')}`);
      page.words++;
    }
    for (const child of node.children || []) visit(child, page);
  }
  visit(parseDocument(bboxHtml));
  assert(pages.length && pages.every(page => page.words > 0), 'Every PDF page has positioned text');
  return pages;
}

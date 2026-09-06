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

export function inspectPdfText(text, expectedPassages) {
  const pages = text.split('\f');
  if (!pages.at(-1)?.trim()) pages.pop();
  assert(pages.length >= 2, 'The long edition exercises actual pagination');
  const bodyPages = pages.map(page => page.split('\n').filter(line =>
    !/^\s*BlueTeam\.News\s*[·•]?\s*Print edition\b/i.test(line)
      && !/^\s*Page\s+\d+\s+of\s+\d+\s*$/i.test(line)).join('\n'));
  for (let index = 0; index < bodyPages.length; index++) {
    assert(normalizedPdfText(bodyPages[index]).length >= 30, `PDF page ${index + 1} contains body content, not just a running folio`);
  }
  const normalized = normalizedPdfText(bodyPages.join('\n'));
  for (const passage of expectedPassages) {
    assert(normalized.includes(normalizedPdfText(passage)), `PDF lost text: ${passage.slice(0, 150)}`);
  }
  assert(normalizedPdfText(bodyPages.at(-1)).includes(normalizedPdfText('Verify every CVE ID, vendor name, date, and link before acting.')), 'Final PDF page retains the verification colophon');
  return { pageCount: pages.length, charactersPerPage: bodyPages.map(page => normalizedPdfText(page).length), checkedPassages: expectedPassages.length };
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

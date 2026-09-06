import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPdfBounds, inspectPdfText, matchPdfPassages, pdfTextRegions } from '../scripts/handoff-acceptance.mjs';

// The fallback is optional. Run explicitly with the same HANDOFF_PYTHON used
// by check-handoff-render; the normal Poppler-only CI path gains no dependency.
const python = process.env.HANDOFF_PYTHON;
const fixture = String.raw`
import sys
from reportlab.pdfgen.canvas import Canvas
c = Canvas(sys.argv[1], pagesize=(612, 792))
c.setFont('Helvetica', 12)
c.drawString(40, 720, 'A complete left-column paragraph starts')
c.drawString(360, 720, 'Unrelated right-column evidence')
c.drawString(40, 704, 'and continues with the retained action.')
c.drawString(40, 670, 'Repeated physical passage')
c.showPage()
c.setFont('Helvetica', 12)
c.drawString(40, 720, 'Repeated physical passage')
c.drawString(40, 680, 'Verify every CVE ID, vendor name, date, and link before acting.')
if len(sys.argv) > 2:
    c.drawString(600, 630, 'This word exceeds the actual page boundary')
c.save()
`;

(python ? describe : describe.skip)('optional actual PDF extraction fallback', () => {
  let directory;
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'handoff-extractor-test-')); });
  afterAll(() => {
    if (!directory) return;
    const target = realpathSync(directory);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('handoff-extractor-test-')) {
      throw new Error('Refusing cleanup outside the owned temporary fixture directory');
    }
    rmSync(target, { recursive: true, force: true });
  });
  function extract(name, outOfBounds = false) {
    const pdf = join(directory, `${name}.pdf`);
    const output = join(directory, name);
    execFileSync(python, ['-c', fixture, pdf, ...(outOfBounds ? ['overflow'] : [])], { windowsHide: true });
    const result = JSON.parse(execFileSync(python, [fileURLToPath(new URL('../scripts/extract-handoff-pdf.py', import.meta.url)), pdf, output], { encoding: 'utf8', windowsHide: true }));
    return { result, text: readFileSync(join(output, 'print-edition.txt'), 'utf8'), bounds: readFileSync(join(output, 'print-edition-bounds.html'), 'utf8') };
  }
  test('extracts actual words, columns, repeated occurrences, page dimensions and footer', () => {
    const { result, text, bounds } = extract('complete');
    expect(result).toMatchObject({ engine: 'pdfplumber/PDFMiner', pages: 2 });
    expect(inspectPdfBounds(bounds)).toEqual([
      { width: 612, height: 792, words: expect.any(Number) },
      { width: 612, height: 792, words: expect.any(Number) },
    ]);
    const checked = inspectPdfText(text, [
      'A complete left-column paragraph starts and continues with the retained action.',
      'Repeated physical passage', 'Repeated physical passage',
      'Verify every CVE ID, vendor name, date, and link before acting.',
    ], bounds);
    expect(checked).toMatchObject({ pageCount: 2, checkedPassages: 4 });
    expect(checked.passagePositions.slice(1, 3).map(item => item.pages)).toEqual([[1], [2]]);
    expect(() => matchPdfPassages(pdfTextRegions(bounds), ['A fabricated retained action'])).toThrow(/lost text/);
  });
  test('does not clamp genuine coordinates that exceed the physical page', () => {
    const { bounds } = extract('overflow', true);
    expect(() => inspectPdfBounds(bounds)).toThrow(/exceeds page/);
  });
});

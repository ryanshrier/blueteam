import { describe, expect, test } from '@jest/globals';
import { marked } from 'marked';
import { briefSourceIndex, sourceFindingLocation } from '../public/modules/briefing/brief-source-index.js';
import { readerFindingLocation } from '../public/modules/briefing/brief-finding-locations.js';
import { readerEvidenceLimits } from '../public/modules/briefing/brief-review.js';
import { decisionCopyText, readerPresentationIssues } from '../public/modules/briefing/brief-renderer.js';
import { briefPresentation } from '../lib/brief-reading-checks.js';
import { sha256 } from '../lib/generation-manifest.js';

const content = `# Current edition
## KEY JUDGMENTS
> ### Signal 77 — Quoted example
> Quoted claim before any assessment.

- ### Signal 88 — Listed example

\`\`\`md
### Signal 66 — Code example
\`\`\`

<h3>Signal 55 — Raw HTML example</h3>

### Gateway exposure
Gateway finding.
#### A supporting subsection
Gateway qualification.

### Signal 9 — Credential recovery
Recovery finding.

### **Package execution**
Execution finding.

## DEVELOPING SITUATIONS
### Signal 1 — Outside the judgments
Developing finding.
`;
const line = text => content.split('\n').findIndex(value => value === text) + 1;
const issue = (text, extra = {}) => ({ code: 'CVE_CVSS_AMBIGUOUS', audience: 'reader', consequence: 'note', severity: 'review',
  message: text, location: { scope: 'paragraph', line: line(text) }, ...extra });
const issues = [issue('Gateway finding.', { signal: 77 }), issue('Gateway qualification.'), issue('Recovery finding.', { signal: 9 }),
  issue('Execution finding.'), issue('Developing finding.'), issue('Quoted claim before any assessment.', { signal: 77, location: { line: line('> Quoted claim before any assessment.') } }),
  issue('Routine bookkeeping.', { code: 'PRIORITY_COVERAGE_MISSING', audience: 'operator', location: { line: line('Gateway finding.') } })];
const presentation = { currentChecks: { issues } };
const index = value => briefSourceIndex(value, marked.lexer(value.replace(/\r\n?/g, '\n'), { gfm: true, breaks: true }));

describe('visible, ordinal finding association', () => {
  test('only real top-level headings inside KEY JUDGMENTS create identities', () => {
    expect(index(content).judgments.map(heading => [heading.signalId, heading.label])).toEqual([
      ['S1', 'Gateway exposure'], ['S2', 'Signal 9 — Credential recovery'], ['S3', 'Package execution'],
    ]);
    expect(sourceFindingLocation(index(content), issues[0])).toMatchObject({ kind: 'judgment', signal: 1 });
    expect(sourceFindingLocation(index(content), issues[1])).toMatchObject({ kind: 'judgment', signal: 1 });
    expect(sourceFindingLocation(index(content), issues[4])).toMatchObject({ kind: 'section' });
    expect(sourceFindingLocation(index(content), issues[5])).toMatchObject({ kind: 'section' });
  });

  test.each([[1, ['Gateway finding.', 'Gateway qualification.']], [2, ['Recovery finding.']], [3, ['Execution finding.']]])(
    'Overview and copied decision %i retain the same material findings', (signal, messages) => {
      expect(readerEvidenceLimits({ content, presentation: { schemaVersion: 1, ...presentation } }, signal).map(value => value.message)).toEqual(messages);
      expect(readerPresentationIssues(presentation, { signal, sourceContent: content }).map(value => value.message)).toEqual(messages);
      const copy = decisionCopyText({ signal, sourceContent: content, presentation, action: 'Verify exposure before acting.', editionUrl: 'https://desk.test/briefing/example.md' });
      for (const message of messages) expect(copy).toContain(message);
      expect(copy).not.toMatch(/Developing finding|Quoted claim before|Routine bookkeeping/);
    });

  test('a document qualification follows every decision without a guessed judgment number', () => {
    const documentIssue = issue('The retained evidence record is unavailable.', { code: 'VALIDATION_UNAVAILABLE', consequence: 'block', location: { scope: 'document', line: 1 } });
    const state = { currentChecks: { issues: [documentIssue] } };
    for (const signal of [1, 2, 3]) expect(readerPresentationIssues(state, { signal, sourceContent: content })).toEqual([expect.objectContaining({ message: documentIssue.message })]);
    expect(readerPresentationIssues({ currentChecks: { ...state.currentChecks, status: 'unavailable' } }, { signal: 1, sourceContent: content })).toHaveLength(1);
  });

  test('missing, invalid and outside-section locations are not guessed from messages or signal fields', () => {
    for (const location of [undefined, { line: -1 }, { line: 500 }, { line: '15' }, { line: line('Developing finding.') }]) {
      const value = issue('Signal 1 is unverified.', { signal: 1, location });
      expect(readerPresentationIssues({ currentChecks: { issues: [value] } }, { signal: 1, sourceContent: content })).toEqual([]);
    }
    expect(readerPresentationIssues({ currentChecks: { issues: [issue('Signal 1 is unverified.', { location: undefined })] } }, { signal: 1 })).toEqual([]);
  });

  test('duplicate judgment sections abstain, and CRLF keeps correct source locations', () => {
    expect(index(`${content}\n## KEY JUDGMENTS\n### Another\nClaim`).judgments).toEqual([]);
    expect(readerFindingLocation(issues[3], presentation, content.replace(/\n/g, '\r\n'))).toMatchObject({ kind: 'judgment', signal: 3 });
  });
});

describe('exact reading-copy findings', () => {
  const projection = (overrides = {}) => briefPresentation({ original: content, content, manifest: {
    outputSha256: sha256(content), publicationValidation: { issues: issues.slice(0, 4) },
  }, ...overrides });

  test('server projection binds ordinals to current check hash and exact source line', () => {
    const result = projection();
    expect(result.currentChecks.contentSha256).toBe(sha256(content));
    expect(result.currentChecks.issues[0].association).toMatchObject({ kind: 'judgment', signal: 1, signalId: 'S1',
      contentSha256: sha256(content), sourceLine: 'Gateway finding.' });
    expect(readerFindingLocation(result.currentChecks.issues[0], result, content)).toMatchObject({ signal: 1 });
    expect(readerFindingLocation(result.currentChecks.issues[0], result, content.replace('Gateway finding.', 'A changed claim.'))).toBeNull();
  });

  test('stale check snapshots and old publication lines never attach to a corrected copy', () => {
    const changed = content.replace('Gateway finding.', 'A corrected claim.');
    for (const result of [projection({ content: changed }), projection({ content: changed,
      readingChecks: { status: 'checked', contentSha256: sha256(content), issues: issues.slice(0, 4) } })]) {
      expect(result.currentChecks.issues[0].association.status).toBe('unavailable');
      expect(readerPresentationIssues(result, { signal: 1, sourceContent: changed })).toEqual([]);
      expect(result.currentChecks.issues[0].message).toBe('Gateway finding.');
    }
  });

  test('a current corrected snapshot gets current locations while original checks remain historical', () => {
    const changed = content.replace('Gateway finding.', 'A corrected claim.');
    const current = { ...issues[0], message: 'The corrected claim still needs a qualification.' };
    const result = projection({ content: changed, reviewed: { review: { status: 'editorially-corrected' } },
      readingChecks: { status: 'checked', contentSha256: sha256(changed), issues: [current] } });
    expect(readerPresentationIssues(result, { signal: 1, sourceContent: changed }).map(value => value.message)).toEqual([current.message]);
    expect(result.history[0].issues[0]).not.toHaveProperty('association');
  });
});

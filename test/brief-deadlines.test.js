import { describe, expect, test } from '@jest/globals';
import { capturedFederalDeadlines, renderBriefDeadlines } from '../lib/brief-deadlines.js';
import { buildGroundingManifest, CISA_KEV_CATALOG_URL } from '../lib/grounding.js';
import { parseBrief, parseJudgments, rawField, FIELDS } from '../lib/brief-schema.js';
import { validateBrief } from '../lib/validation.js';
import { wallDocumentHtml } from '../public/modules/wall/wall-actions.js';
import { decisionCardContent, decisionCopyText, splitPackedBriefFieldHtml } from '../public/modules/briefing/brief-renderer.js';

const first = 'CVE-2026-83548', second = 'CVE-2026-83549';
const kevSet = new Set([first, second]);
const headlines = [{ title: `${first} and ${second} affect the gateway`, source: 'Vendor', date: '2026-10-22',
  link: 'https://vendor.example/advisory', description: `${first} and ${second} affect the gateway. Verify installed versions before choosing the update.` }];
const grounding = buildGroundingManifest({ headlines, kevSet });
const kevTiming = { [first]: { dueDate: '2026-11-04' }, [second]: { dueDate: '2026-11-12' } };
const context = { grounding, kevTiming };
const judgment = (body = `${first} affects the gateway.`, number = 1) => `### Signal ${number} — [Horizon 1] Verify gateway ${number}

**What happened:** ${body} [Vendor, October 22, 2026](https://vendor.example/advisory)

**Recommended actions:**
- **Act now:** Infrastructure — verify installed versions — recommended target 2026-10-23.

**Decision window:** Current shift

**The line:** Establish exposure before choosing the update.`;
const brief = (body, suffix = '') => `## KEY JUDGMENTS\n\n${judgment(body)}\n\n${suffix}`;
const deadlineIssues = content => validateBrief(content, '2026-10-22', { publication: true, groundingManifest: grounding, kevSet, kevTiming }).issues
  .filter(issue => /^KEV_DEADLINE_/.test(issue.code));

describe('app-owned federal deadline composition', () => {
  test('renders separate exact per-CVE dates, FCEB scope and the captured catalog citation', () => {
    const { content, deadlines } = renderBriefDeadlines(brief(`${first} and ${second} affect the gateway.`), context);
    expect(deadlines).toEqual([
      { judgmentIndex: 1, cve: first, dueDate: '2026-11-04', scope: 'FCEB', precision: 'day', sourceId: 'CISA-KEV', sourceUrl: CISA_KEV_CATALOG_URL },
      { judgmentIndex: 1, cve: second, dueDate: '2026-11-12', scope: 'FCEB', precision: 'day', sourceId: 'CISA-KEV', sourceUrl: CISA_KEV_CATALOG_URL },
    ]);
    expect(content).toContain(`${first}: FCEB remediation due 2026-11-04.`);
    expect(content).toContain(`${second}: FCEB remediation due 2026-11-12.`);
    expect(content).toContain('apply only to Federal Civilian Executive Branch (FCEB) agencies');
    expect(content).toContain('Internal recommended targets are separate.');
    expect(content).toContain(`[CISA KEV catalog](${CISA_KEV_CATALOG_URL})`);
    expect(content).not.toMatch(/\d{1,2}:\d{2}|\bUTC\b|\bGMT\b/);
    expect(content.indexOf('**Federal remediation:**')).toBeLessThan(content.indexOf('**Recommended actions:**'));
    expect(deadlineIssues(content)).toEqual([]);
  });

  test('repeated composition is byte-identical and leaves internal action targets unchanged', () => {
    const initial = brief();
    const once = renderBriefDeadlines(initial, context);
    const twice = renderBriefDeadlines(once.content, context);
    expect(twice).toEqual(once);
    expect(rawField(once.content, FIELDS.recommendedActions)).toBe(rawField(initial, FIELDS.recommendedActions));
    expect(parseJudgments(once.content)[0].actions).toHaveLength(1);
    expect(parseJudgments(once.content)[0].actions[0].target).toBe('2026-10-23');
    expect(once.content.match(/\*\*Federal remediation:\*\*/g)).toHaveLength(1);
  });

  test('newly mentioned identities append their own date without replacing an existing field', () => {
    const once = renderBriefDeadlines(brief(), context).content;
    const edited = once.replace(`${first} affects the gateway.`, `${first} and ${second} affect the gateway.`);
    const twice = renderBriefDeadlines(edited, context).content;
    expect(twice).toContain(`${second}: FCEB remediation due 2026-11-12.`);
    expect(twice.match(/\*\*Federal remediation:\*\*/g)).toHaveLength(1);
    expect(twice.match(/FCEB remediation due 2026-11-04/g)).toHaveLength(1);
    expect(renderBriefDeadlines(twice, context).content).toBe(twice);
  });

  test.each([
    `${first} is in KEV, FCEB remediation due 2026-11-30.`,
    `${first} is in KEV, FCEB remediation due 2026-11-04 at 5 PM UTC.`,
  ])('preserves conflicting authored claims for validation: %s', claim => {
    const result = renderBriefDeadlines(brief(claim), context);
    expect(result.content).toContain(claim);
    expect(deadlineIssues(result.content).some(issue => ['KEV_DEADLINE_MISMATCH', 'KEV_DEADLINE_PRECISION'].includes(issue.code))).toBe(true);
  });

  test('a forged Federal remediation field cannot overwrite or suppress captured facts', () => {
    const authored = `**Federal remediation:** ${first}: FCEB remediation due 2026-11-30.\n\n`;
    const initial = brief().replace('**Recommended actions:**', `${authored}**Recommended actions:**`);
    const result = renderBriefDeadlines(initial, context);
    expect(result.content).toContain(authored.trim());
    expect(result.content).toContain(`${first}: FCEB remediation due 2026-11-04.`);
    expect(deadlineIssues(result.content).map(issue => issue.code)).toContain('KEV_DEADLINE_MISMATCH');
    expect(renderBriefDeadlines(result.content, context).content).toBe(result.content);
  });

  test.each([undefined, null, '', '2026-02-30', '2026-11-04T17:00:00Z', 'November 4, 2026'])('does not infer an exact day from %s', dueDate => {
    expect(capturedFederalDeadlines(grounding, { [first]: { dueDate } })).toEqual([]);
    expect(renderBriefDeadlines(brief(), { grounding, kevTiming: { [first]: { dueDate } } }).content).toBe(brief());
  });

  test('requires captured catalog membership, tolerates serialized arrays and raw catalog field names', () => {
    expect(capturedFederalDeadlines({ members: [{ id: 'S1.1', cves: [first] }] }, kevTiming)).toEqual([]);
    expect(capturedFederalDeadlines({ members: [{ id: 'CISA-KEV', cves: [first] }] }, { [first]: { due_date: '2026-11-04' } }))
      .toEqual([expect.objectContaining({ cve: first, dueDate: '2026-11-04' })]);
  });

  test('does not transfer dates between adjacent judgments or from other sections', () => {
    const input = `## BLUF\n\n${second} affects another product.\n\n## KEY JUDGMENTS\n\n${judgment()}\n\n${judgment('Another issue requires research.', 2)}\n\n## WATCHLIST\n\n- Watch ${second}.`;
    const result = renderBriefDeadlines(input, context);
    expect(result.deadlines).toHaveLength(1);
    expect(result.content).not.toContain('due 2026-11-12');
    expect(parseJudgments(result.content)[1].federalRemediation).toBe('');
  });

  test.each([
    `A report links [advisory](https://example.test/${first}).`,
    `The identifier is in a code example: \`lookup --cve ${first}\`.`,
    `No identity in prose.\n\n<!-- ${first} -->`,
    `No identity in prose.\n\n\`\`\`text\n${first}\n\`\`\``,
    `No identity in prose.\n\n> ${first} is a quoted report.`,
  ])('ignores non-prose identity references: %s', text => {
    const input = brief(text);
    expect(renderBriefDeadlines(input, context)).toEqual({ content: input, deadlines: [] });
  });

  test.each([
    `<span hidden>${first}</span>`,
    `<span style="display:none"><strong>${first}</strong></span>`,
    `<span hidden>${first}`,
    `<span hidden>Unclosed container.\n\n${first} in a later paragraph.`,
  ])('does not surface identities inside inline HTML containers: %s', text => {
    const input = brief(text);
    expect(renderBriefDeadlines(input, context)).toEqual({ content: input, deadlines: [] });
  });

  test('a closed HTML container does not hide a distinct visible identity outside it', () => {
    const result = renderBriefDeadlines(brief(`<span hidden>${first}</span> ${second} affects the gateway.`), context);
    expect(result.deadlines.map(fact => fact.cve)).toEqual([second]);
    expect(result.content).not.toContain(`${first}: FCEB remediation due`);
    expect(result.content).toContain(`${second}: FCEB remediation due 2026-11-12.`);
  });

  test('an unmatched inline HTML opener remains opaque across judgment boundaries', () => {
    const input = brief('<span hidden>Hidden context.', judgment(`${second} appears in a later judgment.`, 2));
    expect(renderBriefDeadlines(input, context)).toEqual({ content: input, deadlines: [] });
  });

  test.each([`\`${first}\``, `\`${first}, ${second}\``, `\`${first} and ${second}\``])('accepts inline formatting around exact CVE identities: %s', text => {
    const result = renderBriefDeadlines(brief(`${text} affects the gateway.`), context);
    expect(result.content).toContain(`${first}: FCEB remediation due 2026-11-04.`);
    if (text.includes(second)) expect(result.content).toContain(`${second}: FCEB remediation due 2026-11-12.`);
  });

  test.each([input => `\`\`\`markdown\n${input}\n\`\`\``, input => `<!--\n${input}\n-->`])('does not compose protected section headings', wrap => {
    const input = wrap(brief());
    expect(renderBriefDeadlines(input, context)).toEqual({ content: input, deadlines: [] });
  });

  test('keeps CRLF inputs idempotent and puts a missing-action field before the section boundary', () => {
    const input = `## KEY JUDGMENTS\r\n\r\n### Signal 1 — [Horizon 1] Gateway\r\n\r\n${first} affects the gateway.\r\n\r\n---\r\n\r\n## WATCHLIST\r\n\r\n- Observe.`;
    const result = renderBriefDeadlines(input, context).content;
    expect(result.indexOf('**Federal remediation:**')).toBeLessThan(result.indexOf('\r\n---'));
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
    expect(renderBriefDeadlines(result, context).content).toBe(result);
  });
});

describe('federal deadline reader parity', () => {
  test('Wall parser and action context retain separate federal scope and its catalog citation', () => {
    const document = parseBrief(renderBriefDeadlines(brief(), context).content);
    const story = document.stories[0];
    expect(story.federalRemediation).toContain(`${first}: FCEB remediation due 2026-11-04.`);
    expect(story.citations).toContainEqual({ label: 'CISA KEV catalog', url: CISA_KEV_CATALOG_URL });
    const html = wallDocumentHtml({ ...document, date: '2026-10-22' });
    expect(html).toContain('Federal remediation:');
    expect(html).toContain('Federal Civilian Executive Branch (FCEB) agencies');
    expect(html).toContain('Recommended target · 2026-10-23');
    expect(html).toContain(`href="${CISA_KEV_CATALOG_URL}"`);
  });

  test('decision copy keeps federal dates and internal targets separately labelled', () => {
    const federalRemediation = parseJudgments(renderBriefDeadlines(brief(), context).content)[0].federalRemediation;
    const copy = decisionCopyText({ recommendations: ['Infrastructure — verify installed versions — recommended target 2026-10-23.'],
      federalRemediation, decisionWindow: 'This shift', editionUrl: 'https://desk.example/briefing/edition.md' });
    expect(copy).toContain('recommended target 2026-10-23.');
    expect(copy).toContain(`Federal remediation: ${federalRemediation}`);
    expect(splitPackedBriefFieldHtml('<strong>What happened:</strong> Captured claim.<br><strong>Federal remediation:</strong> Federal scope.<br><strong>Recommended actions:</strong> Internal goal.')).toHaveLength(3);
  });

  test('decision card copy takes the complete federal list but never swallows the following action', () => {
    const node = (tagName, textContent, className = '') => ({ tagName, textContent, className,
      cloneNode() { return { textContent: this.textContent, querySelectorAll: () => [] }; } });
    const card = { children: [node('P', 'Federal remediation: FCEB only; internal targets are separate.'),
      node('UL', `${first}: FCEB remediation due 2026-11-04. ${second}: FCEB remediation due 2026-11-12.`),
      node('DIV', 'Infrastructure — perform the authored action', 'c-action')], querySelector: () => null, querySelectorAll: () => [] };
    const result = decisionCardContent(card);
    expect(result.federalRemediation).toContain(`${second}: FCEB remediation due 2026-11-12.`);
    expect(result.federalRemediation).not.toContain('perform the authored action');
  });
});

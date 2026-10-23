import { describe, expect, test } from '@jest/globals';
import { captureBriefActionRecords } from '../lib/brief-composition.js';
import { documentExecutiveModel, sharedExecutiveGroups, structureExecutiveSummary, visibleJudgmentHeadings } from '../public/modules/briefing/brief-executive.js';
import { actionRecordMatchesText } from '../public/modules/briefing/brief-renderer.js';

const source = `## EXECUTIVE SUMMARY
- **Threat:** Exploitation is reported; local applicability remains unknown.
- **Required decisions:** Old summary which should never determine the record-backed view.

## KEY JUDGMENTS
${Array.from({ length: 4 }, (_, index) => `### Signal ${index + 1} — [Horizon 1] Service ${index + 1} response
**Recommended actions:**
- **Act now:** Infrastructure — verify deployment; Condition: if affected, schedule mitigation; Dependencies: approved change window — recommended target October 23, 2026.
- Incident response — inspect for compromise; Recovery: reset credentials only after confirmed exposure — recommended target October 23, 2026.
- Operations — record the result; Completion criterion: inventory reflects installed versions — recommended target October 23, 2026.
`).join('\n')}`;
const records = captureBriefActionRecords(source);
const presentation = { copy: { contentSha256: records.contentSha256 }, actionRecords: { ...records, source: 'derived' } };
const rows = [
  { lead: 'Threat:', tail: 'Exploitation is reported; local applicability remains unknown.' },
  { lead: 'Required decisions:', tail: 'Wrong owner — unqualified instruction — tomorrow; Dependencies: invented separate action.' },
];

function dom(items = rows) {
  const made = [];
  const make = tag => ({ tagName: tag.toUpperCase(), children: [], dataset: {}, className: '', textContent: '',
    appendChild(el) { this.children.push(el); }, append(...els) { this.children.push(...els); } });
  const list = { tagName: 'UL', querySelector: () => null, replaceWith: panel => made.push(panel), children: items.map(item => ({
    tagName: 'LI', querySelector: () => ({ textContent: item.lead }),
    cloneNode: () => ({ textContent: item.tail, querySelector: () => ({ remove() {} }) }),
  })) };
  const heading = { tagName: 'H2', textContent: 'EXECUTIVE SUMMARY', nextElementSibling: list };
  const keyJudgments = { tagName: 'H2', textContent: 'KEY JUDGMENTS' };
  const judgments = Array.from({ length: 4 }, (_, index) => ({ tagName: 'H3', textContent: `Signal ${index + 1} — Service ${index + 1} response`, dataset: {} }));
  const root = { querySelector: () => null,
    querySelectorAll: selector => selector === 'h3' ? judgments : selector === 'h2, h3' ? [heading, keyJudgments, ...judgments] : [heading], ownerDocument: { createElement: make } };
  [heading, keyJudgments, ...judgments].forEach(node => { node.parentElement = root; });
  return { made, judgments, root };
}
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');

describe('shared executive action projection', () => {
  test('judgment ordinals include mixed heading prefixes but exclude nested and other-section headings', () => {
    const root = {};
    const heading = (tagName, textContent, parentElement = root) => ({ tagName, textContent, parentElement });
    const card = { parentElement: root, classList: { contains: name => name === 'brief-judgment-card' } };
    const direct = [heading('H3', 'Service 1'), heading('H3', 'Signal 2 — Service 2'), heading('H3', 'Service 3', card), heading('H3', 'Signal 4 — Service 4')];
    const outside = heading('H3', 'Signal 99 — outside judgments');
    root.querySelectorAll = () => [heading('H2', 'KEY JUDGMENTS'),
      heading('H3', 'Signal 1 — quoted example', { tagName: 'BLOCKQUOTE' }),
      heading('H2', 'Other quoted section', { tagName: 'BLOCKQUOTE' }),
      direct[0], heading('H3', 'Nested list example', { tagName: 'LI' }), direct[1],
      heading('H3', 'HTML container example', { tagName: 'DIV' }), ...direct.slice(2), heading('H2', 'WATCHLIST'), outside];
    expect(visibleJudgmentHeadings(root)).toEqual(direct);
    expect(visibleJudgmentHeadings(root, { legacyFallback: true })).toEqual(direct);
    root.querySelectorAll = () => [heading('H2', 'Older archive'), direct[0], direct[1], heading('H3', 'Signal in quoted text', { tagName: 'BLOCKQUOTE' })];
    expect(visibleJudgmentHeadings(root)).toEqual([]);
    expect(visibleJudgmentHeadings(root, { legacyFallback: true })).toEqual([direct[1]]);
  });

  test('reconciles complete action text without guessing past a missing qualification or changed owner or target', () => {
    const action = records.actions[0];
    const text = `Act now: ${action.owner} — ${action.response} — recommended target ${action.target}.`;
    expect(actionRecordMatchesText(text, action)).toBe(true);
    expect(actionRecordMatchesText(text.replaceAll(' — ', ' - ').replaceAll('; ', '\n'), action)).toBe(true);
    expect(actionRecordMatchesText(text.replace('recommended target', 'target:'), action)).toBe(true);
    expect(actionRecordMatchesText(text.replace('if affected, ', ''), action)).toBe(false);
    expect(actionRecordMatchesText(text.replace('Infrastructure', 'Operations'), action)).toBe(false);
    expect(actionRecordMatchesText(text.replace('October 23', 'October 24'), action)).toBe(false);
    expect(actionRecordMatchesText(text.replace('verify deployment', 'disable the gateway'), action)).toBe(false);
    expect(actionRecordMatchesText(`${text} An unrelated instruction.`, action)).toBe(false);
  });

  test('uses the captured action identity for three short assessment groups without parsing summary prose', () => {
    const model = documentExecutiveModel(rows, { presentation });
    expect(model.groups).toHaveLength(3);
    expect(model.actionCount).toBe(9);
    expect(model.decisions).toEqual([]);
    expect(model.groups.map(group => group.title)).toEqual(['Service 1 response', 'Service 2 response', 'Service 3 response']);
    expect(model.groups[0].actions[0].response).toContain('Condition: if affected, schedule mitigation; Dependencies: approved change window');
    expect(model.groups[0].actions[1].response).toContain('Recovery: reset credentials only after confirmed exposure');
    expect(model.facts[0].text).toContain('local applicability remains unknown');
    expect(model.commonTarget).toBe('October 23, 2026');
  });

  test.each(['brief', 'np'])('renders the same compact groups and action identities in %s', prefix => {
    const { root, made, judgments } = dom();
    structureExecutiveSummary(root, { prefix, presentation });
    const panel = made[0];
    expect(panel.dataset.actionSource).toBe('shared-records');
    expect(panel.dataset.contentSha256).toBe(records.contentSha256);
    const queue = panel.children[1];
    expect(allText(queue.children[0])).toContain('3 priority assessments · 9 actions');
    expect(allText(queue.children[0])).toContain('Recommended target · October 23, 2026');
    const groups = queue.children[1];
    expect(groups.className).toContain(`${prefix}-exec-groups`);
    expect(groups.children).toHaveLength(3);
    expect(groups.children[0].dataset.actionIds).toBe('S1.A1 S1.A2 S1.A3');
    const firstTask = groups.children[0].children[1];
    expect(firstTask.children[0].href).toBe('#judgment-1');
    expect(firstTask.children[0].textContent).toBe('Service 1 response');
    expect(firstTask.children[1].textContent).toBe('Infrastructure / Incident response / Operations');
    expect(firstTask.children[2].textContent).toBe('Full assessment and 3 actions');
    expect(judgments.map(judgment => judgment.id || '')).toEqual(['judgment-1', 'judgment-2', 'judgment-3', '']);
    expect(allText(panel)).toContain('local applicability remains unknown');
    expect(allText(panel)).not.toMatch(/Wrong owner|unqualified instruction|invented separate action|schedule mitigation|reset credentials/);
    expect(allText(panel)).toContain('exposure checks, conditions and dependencies before acting');
  });

  test('keeps differing recommended targets associated with the correct owners', () => {
    const actions = records.actions.map(action => action.id === 'S1.A2' ? { ...action, target: 'October 24, 2026' } : action);
    const value = { ...presentation, actionRecords: { ...presentation.actionRecords, actions } };
    const { root, made } = dom();
    structureExecutiveSummary(root, { presentation: value });
    const queue = made[0].children[1];
    expect(allText(queue.children[0])).not.toContain('Recommended target');
    const metadata = queue.children[1].children[0].children[1].children.map(node => node.textContent);
    expect(metadata).toContain('Infrastructure / Operations · Recommended target October 23, 2026');
    expect(metadata).toContain('Incident response · Recommended target October 24, 2026');
    expect(allText(queue)).not.toMatch(/Due|deadline/);
  });

  test('links by judgment section order when a provider omits Signal prefixes, preserving existing anchors', () => {
    const { root, made, judgments } = dom();
    judgments.forEach((judgment, index) => { judgment.tagName = 'H3'; judgment.textContent = `Service ${index + 1} response`; });
    judgments[0].id = 'retained-service-anchor';
    const originalQuery = root.querySelectorAll;
    root.querySelectorAll = selector => selector === 'h2, h3'
      ? [{ tagName: 'H2', textContent: 'KEY JUDGMENTS', parentElement: root }, ...judgments, { tagName: 'H2', textContent: 'WATCHLIST', parentElement: root }]
      : originalQuery(selector);
    structureExecutiveSummary(root, { presentation });
    const groups = made[0].children[1].children[1].children;
    expect(groups[0].children[1].children[0].href).toBe('#retained-service-anchor');
    expect(groups[1].children[1].children[0].href).toBe('#judgment-2');
    expect(judgments[0].id).toBe('retained-service-anchor');
  });

  test('a stale, incomplete or ambiguous record cannot hide the authored fallback actions', () => {
    const malformed = [
      { ...presentation, copy: { contentSha256: 'changed' } },
      { ...presentation, actionRecords: { ...records, executiveGroups: records.executiveGroups.slice(0, 2) } },
      { ...presentation, actionRecords: { ...records, actions: [...records.actions, records.actions[0]] } },
      { ...presentation, actionRecords: { ...records, executiveGroups: [{ ...records.executiveGroups[0], actionIds: ['S1.A1'] }, ...records.executiveGroups.slice(1)] } },
    ];
    for (const value of malformed) {
      expect(sharedExecutiveGroups(value)).toBeNull();
      const model = documentExecutiveModel(rows, { presentation: value });
      expect(model.groups).toBeNull();
      expect(model.decisions[0].owner).toBe('Wrong owner');
    }
  });
});

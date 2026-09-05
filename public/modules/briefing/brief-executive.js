// Shared reader/print presentation. The saved Markdown remains authoritative.
import { executiveSummaryModel } from '../wall/wall-format.js';

export function documentExecutiveModel(items) {
  const model = executiveSummaryModel(items);
  return { ...model, facts: [model.threat, model.exposure, ...model.context].filter(Boolean) };
}

export function structureExecutiveSummary(root, { prefix = 'np' } = {}) {
  const existing = root.querySelector('.brief-exec-panel');
  if (existing && prefix === 'np') {
    [existing, ...existing.querySelectorAll('[class]')].forEach(el => {
      el.className = el.className.replace(/\bbrief-exec-/g, 'np-exec-');
    });
    return;
  }
  const heading = [...root.querySelectorAll('h2')]
    .find(el => /^\s*EXECUTIVE SUMMARY\b/i.test(el.textContent || ''));
  const list = heading?.nextElementSibling;
  if (!heading || !list || !/^(?:UL|OL)$/.test(list.tagName)) return;

  // Inline code contains common CVE/version identifiers; its exact text survives
  // the card transform. Keep authored citations and richer structures intact.
  if (list.querySelector('a, em, ul, ol, br, sup, img, table')) return;
  const items = [...list.children].filter(el => el.tagName === 'LI').map(li => {
    const lead = li.querySelector('strong')?.textContent || '';
    const copy = li.cloneNode(true);
    copy.querySelector('strong')?.remove();
    return { lead, tail: (copy.textContent || '').replace(/^\s*:\s*/, '').trim() };
  });
  const model = documentExecutiveModel(items);
  if (!model.facts.length && !model.decisions.length) return;
  const doc = root.ownerDocument;
  const make = (tag, name, text) => {
    const el = doc.createElement(tag);
    if (name) el.className = `${prefix}-exec-${name}`;
    if (text != null) el.textContent = text;
    return el;
  };
  heading.textContent = 'EXECUTIVE SUMMARY — SHIFT DECISIONS';
  const panel = make('section', 'panel');
  if (model.facts.length) {
    const facts = make('div', 'facts');
    model.facts.forEach(fact => {
      const row = make('div', 'fact');
      if (fact.label) row.appendChild(make('span', 'fact-label', fact.label));
      row.appendChild(make('p', '', fact.text));
      facts.appendChild(row);
    });
    panel.appendChild(facts);
  }
  if (model.decisions.length) {
    const queue = make('div', 'queue');
    const head = make('div', 'queue-head');
    head.appendChild(make('span', '', `${model.decisions.length} ${model.decisions.length === 1 ? 'decision' : 'decisions'}`));
    if (model.commonDeadline) head.appendChild(make('span', 'common-due', `Due ${model.commonDeadline}`));
    queue.appendChild(head);
    const actions = make('ol', 'actions');
    model.decisions.forEach((decision, index) => {
      const item = make('li');
      item.appendChild(make('span', 'action-index', String(index + 1).padStart(2, '0')));
      const task = make('div', 'action-task');
      // "Unassigned" is the parser's fallback, not an authored owner.
      if (decision.owner !== 'Unassigned') task.appendChild(make('strong', '', decision.owner));
      task.appendChild(make('p', '', decision.action));
      item.appendChild(task);
      if (decision.deadline && !model.commonDeadline) {
        const due = make('span', 'action-due');
        due.append(make('span', 'due-label', 'Due'), make('span', '', decision.deadline));
        item.appendChild(due);
      }
      actions.appendChild(item);
    });
    queue.appendChild(actions);
    panel.appendChild(queue);
  }
  list.replaceWith(panel);
}

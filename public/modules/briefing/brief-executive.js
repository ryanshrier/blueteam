// Shared reader/print presentation. The saved Markdown remains authoritative.
import { executiveSummaryModel, executiveTargetModel } from '../wall/wall-format.js';

const decisionLabel = /^(?:required decisions?|decisions? required|actions? required)\s*:?$/i;

export function visibleJudgmentHeadings(root, { legacyFallback = false } = {}) {
  if (root.dataset?.sourceJudgmentsIndexed === 'true') return [...root.querySelectorAll('h3')]
    .filter(heading => Number.isSafeInteger(Number(heading.dataset.sourceSignal)) && Number(heading.dataset.sourceSignal) > 0);
  const headings = [];
  let inJudgments = false;
  let foundJudgments = false;
  // The server assigns action ordinals to visible top-level Markdown H3s.
  // Quoted/list/HTML headings are not new judgments. A reader card is the only
  // app-created wrapper admitted here so raw and styled export share ordering.
  const documentHeadings = [...root.querySelectorAll('h2, h3')].filter(heading =>
    heading.parentElement === root || (heading.tagName === 'H3'
      && heading.parentElement?.classList?.contains('brief-judgment-card')
      && heading.parentElement.parentElement === root));
  for (const heading of documentHeadings) {
    if (heading.tagName === 'H2') {
      if (inJudgments) break;
      inJudgments = /^\s*KEY JUDGMENTS\b/i.test(heading.textContent || '');
      if (inJudgments) foundJudgments = true;
    } else if (inJudgments && heading.tagName === 'H3') headings.push(heading);
  }
  if (!foundJudgments && legacyFallback) return documentHeadings.filter(heading => heading.tagName === 'H3' && /^\s*Signal\b/i.test(heading.textContent || ''));
  return headings;
}

/** Use only the server's projection for this exact reading copy. The browser
 * neither infers associations nor turns a partial record into a complete queue. */
export function sharedExecutiveGroups(presentation) {
  const records = presentation?.actionRecords;
  if (records?.schemaVersion !== 1 || !records.contentSha256
      || records.contentSha256 !== presentation?.copy?.contentSha256
      || !Array.isArray(records.actions) || !Array.isArray(records.executiveGroups)
      || !records.actions.length || !records.executiveGroups.length || records.executiveGroups.length > 3) return null;
  const byId = new Map();
  for (const action of records.actions) {
    if (!action || !Number.isSafeInteger(action.signal) || action.signal < 1
        || !Number.isSafeInteger(action.actionIndex) || action.actionIndex < 1
        || action.signalId !== `S${action.signal}` || action.id !== `${action.signalId}.A${action.actionIndex}`
        || byId.has(action.id) || !['owner', 'response', 'target'].every(key => typeof action[key] === 'string' && action[key].trim())) return null;
    byId.set(action.id, action);
  }
  const seen = new Set();
  const groups = [];
  for (const group of records.executiveGroups) {
    if (!group || !Number.isSafeInteger(group.signal) || group.signal < 1 || group.signal > 3
        || group.signalId !== `S${group.signal}` || seen.has(group.signal)
        || typeof group.title !== 'string' || !group.title.trim()
        || !Array.isArray(group.actionIds) || !group.actionIds.length
        || new Set(group.actionIds).size !== group.actionIds.length) return null;
    const actions = group.actionIds.map(id => byId.get(id));
    if (actions.some(action => !action || action.signal !== group.signal)
        || actions.length !== records.actions.filter(action => action.signal === group.signal).length) return null;
    seen.add(group.signal);
    groups.push({ ...group, actions });
  }
  if (records.actions.some(action => action.signal <= 3 && !seen.has(action.signal))) return null;
  return groups;
}

export function documentExecutiveModel(items = [], { presentation = null } = {}) {
  const groups = sharedExecutiveGroups(presentation);
  // The shared path never reparses the long, generated action summary. Its
  // owner/target pairs come from the same records as the visible assessments.
  const rows = Array.isArray(items) ? items : [];
  const model = executiveSummaryModel(groups ? rows.filter(item => !decisionLabel.test(String(item?.lead || '').trim())) : rows);
  const actions = groups?.flatMap(group => group.actions) || [];
  return { ...model, facts: [model.threat, model.exposure, ...model.context].filter(Boolean), groups,
    actionCount: actions.length,
    commonTarget: actions.length && actions.every(action => action.target === actions[0].target) ? actions[0].target : '' };
}

export function structureExecutiveSummary(root, { prefix = 'np', presentation = null } = {}) {
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
  const sharedGroups = sharedExecutiveGroups(presentation);
  if (list.querySelector(sharedGroups ? 'ul, ol, img, table' : 'a, em, ul, ol, br, sup, img, table')) return;
  const items = [...list.children].filter(el => el.tagName === 'LI').map(li => {
    const lead = li.querySelector('strong')?.textContent || '';
    const copy = li.cloneNode(true);
    copy.querySelector('strong')?.remove();
    return { lead, tail: (copy.textContent || '').replace(/^\s*:\s*/, '').trim(), copy };
  });
  const model = documentExecutiveModel(items, { presentation });
  if (!model.facts.length && !model.decisions.length && !model.groups?.length) return;
  const doc = root.ownerDocument;
  const judgmentHeadings = model.groups ? visibleJudgmentHeadings(root) : [];
  const groupHeading = group => root.dataset?.sourceJudgmentsIndexed === 'true'
    ? judgmentHeadings.find(heading => Number(heading.dataset.sourceSignal) === group.signal)
    : judgmentHeadings[group.signal - 1];
  if (model.groups?.some(group => !groupHeading(group))) return;
  const make = (tag, name, text) => {
    const el = doc.createElement(tag);
    if (name) el.className = `${prefix}-exec-${name}`;
    if (text != null) el.textContent = text;
    return el;
  };
  heading.textContent = 'EXECUTIVE SUMMARY';
  const panel = make('section', 'panel');
  if (model.groups) {
    panel.dataset.actionSource = 'shared-records';
    panel.dataset.contentSha256 = presentation.actionRecords.contentSha256;
  }
  if (model.facts.length) {
    const facts = make('div', 'facts');
    model.facts.forEach(fact => {
      const row = make('div', 'fact');
      if (fact.label) row.appendChild(make('span', 'fact-label', fact.label));
      const paragraph = make('p', '', fact.text);
      // Keep source links, code identifiers and qualifications from the authored
      // executive facts; only the duplicate decisions row is replaced.
      const source = model.groups && items.find(item => item.lead.replace(/\s*:\s*$/, '').trim() === fact.label && item.tail === fact.text);
      if (source?.copy?.childNodes) paragraph.replaceChildren(...[...source.copy.childNodes].map(node => node.cloneNode(true)));
      row.appendChild(paragraph);
      facts.appendChild(row);
    });
    panel.appendChild(facts);
  }
  if (model.groups?.length) {
    const queue = make('div', 'queue');
    const head = make('div', 'queue-head');
    head.appendChild(make('span', '', `${model.groups.length} priority ${model.groups.length === 1 ? 'assessment' : 'assessments'} · ${model.actionCount} ${model.actionCount === 1 ? 'action' : 'actions'}`));
    if (model.commonTarget) head.appendChild(make('span', 'common-due', `Recommended target · ${model.commonTarget}`));
    queue.appendChild(head);
    const groups = make('ol', 'actions');
    groups.className += ` ${prefix}-exec-groups`;
    model.groups.forEach(group => {
      const item = make('li');
      item.dataset.signal = String(group.signal);
      item.dataset.actionIds = group.actionIds.join(' ');
      item.appendChild(make('span', 'action-index', String(group.signal).padStart(2, '0')));
      const task = make('div', 'action-task');
      const title = make('a', 'group-title', group.title);
      // Raw print callers may not yet have reader IDs. Section order follows
      // the same ordinal identities as the server; a Signal label is optional.
      const rawJudgment = groupHeading(group);
      if (rawJudgment) {
        if (!rawJudgment.id) rawJudgment.id = `judgment-${group.signal}`;
        title.href = `#${encodeURIComponent(rawJudgment.id)}`;
      }
      task.appendChild(title);
      const byTarget = new Map();
      for (const action of group.actions) {
        const owners = byTarget.get(action.target) || [];
        if (!owners.includes(action.owner)) owners.push(action.owner);
        byTarget.set(action.target, owners);
      }
      for (const [target, owners] of byTarget) {
        const metadata = `${owners.join(' / ')}${model.commonTarget ? '' : ` · Recommended target ${target}`}`;
        task.appendChild(make('span', 'owner', metadata));
      }
      const detail = make(rawJudgment ? 'a' : 'span', 'group-detail', `Full assessment and ${group.actions.length === 1 ? 'action' : `${group.actions.length} actions`}`);
      if (rawJudgment) detail.href = title.href;
      task.appendChild(detail);
      item.appendChild(task);
      groups.appendChild(item);
    });
    queue.appendChild(groups);
    queue.appendChild(make('p', 'qualifications', 'Read the assessment for exposure checks, conditions and dependencies before acting.'));
    panel.appendChild(queue);
  } else if (model.decisions.length) {
    const queue = make('div', 'queue');
    const head = make('div', 'queue-head');
    head.appendChild(make('span', '', `${model.decisions.length} recommended ${model.decisions.length === 1 ? 'decision' : 'decisions'}`));
    if (model.commonDeadline) {
      const target = executiveTargetModel(model.commonDeadline);
      head.appendChild(make('span', 'common-due', `${target.label} · ${target.value}`));
    }
    queue.appendChild(head);
    const actions = make('ol', 'actions');
    model.decisions.forEach((decision, index) => {
      const item = make('li');
      item.appendChild(make('span', 'action-index', String(index + 1).padStart(2, '0')));
      const task = make('div', 'action-task');
      task.appendChild(make('p', '', decision.action));
      // "Unassigned" is the parser's fallback, not an authored owner.
      if (decision.owner !== 'Unassigned') task.appendChild(make('span', 'owner', `Owner · ${decision.owner}`));
      item.appendChild(task);
      if (decision.deadline && !model.commonDeadline) {
        const target = executiveTargetModel(decision.deadline);
        const due = make('span', 'action-due');
        due.append(make('span', 'due-label', `${target.label} ·`), make('span', '', target.value));
        item.appendChild(due);
      }
      actions.appendChild(item);
    });
    queue.appendChild(actions);
    const judgments = [...root.querySelectorAll('h2')]
      .find(el => el.id && /^\s*KEY JUDGMENTS\b/i.test(el.textContent || ''));
    if (judgments) {
      const link = make('a', 'assessments', 'Read complete assessments');
      link.href = `#${encodeURIComponent(judgments.id)}`;
      queue.appendChild(link);
    }
    panel.appendChild(queue);
  }
  list.replaceWith(panel);
}

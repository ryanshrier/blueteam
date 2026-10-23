import { parseRecommendedActions, stripMd } from './brief-schema.js';
import { marked } from 'marked';
export { BRIEF_COMPOSITION_VERSION } from './brief-schema.js';

// Composition owns repeated presentation, not the recommendation itself. Keep
// every authored action and qualification; an incomplete or ambiguous action
// leaves the original document available to the normal publication checks.
const actionBullet = /^(\s*)(?:[-*•]|\d+[.)])\s+(.+)$/;
const actionHeading = /^\s*\*\*Recommended actions(?::\*\*|\*\*:)\s*(.*)$/i;
const decisionHeading = /^\s*(?:[-*•]\s+)?\*\*(?:Required decisions|Decisions required)(?::\*\*|\*\*:)\s*/i;
const contextHeading = /^(?:\*\*)?(?:Condition|Dependencies|Initiation|Evidence\s*\/\s*artifact|Completion criterion|Recovery):(?:\*\*)?\s*/i;
const targetHeading = /^(?:\*\*)?(?:recommended\s+target|target(?:\s+date)?|due)\b\s*:?(?:\*\*)?\s*:?\s*/i;
const targetMarker = /(?:\s*[—–]\s*|\s+-\s+|;\s*)(?:\*\*)?(?:recommended\s+target|target(?:\s+date)?|due)\b\s*:?(?:\*\*)?\s*:?\s*/gi;
const federalScope = /\b(?:federal|FCEB|CISA|KEV|BOD\s*22[-–]01)\b/i;

function protectedLines(lines) {
  const protectedRows = new Set();
  const source = lines.join('\n');
  let cursor = 0;
  // Respect the reader's Markdown block interpretation. Indented examples and
  // raw HTML can contain convincing field labels that are not visible actions.
  // A container containing HTML/code stays intact instead of promoting its
  // children into a new, visible executive instruction.
  for (const token of marked.lexer(source, { gfm: true })) {
    if (!token.raw) continue;
    const start = source.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;
    let protectedToken = false;
    marked.walkTokens([token], child => {
      if (child.type === 'code' || child.type === 'html') protectedToken = true;
    });
    if (protectedToken) {
      const first = source.slice(0, start).split('\n').length - 1;
      const last = source.slice(0, Math.max(start, cursor - 1)).split('\n').length - 1;
      for (let index = first; index <= last; index++) protectedRows.add(index);
    }
  }
  let fence = null, comment = false;
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (comment || fence || line.includes('<!--') || marker) protectedRows.add(index);
    if (comment || line.includes('<!--')) {
      const open = line.lastIndexOf('<!--'), close = line.lastIndexOf('-->');
      comment = close < 0 || open > close;
      return;
    }
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length
        && !line.slice(marker[0].length).trim()) fence = null;
    }
  });
  return protectedRows;
}

function sectionRange(lines, protectedRows, name) {
  const pattern = new RegExp(`^##\\s+${name}(?:\\s|$)`, 'i');
  const starts = lines.flatMap((line, index) => !protectedRows.has(index) && pattern.test(line) ? [index] : []);
  if (starts.length !== 1) return null;
  const start = starts[0];
  const end = lines.findIndex((line, index) => index > start && !protectedRows.has(index) && /^##\s/.test(line));
  return { start, end: end < 0 ? lines.length : end };
}

function parseAction(markdown, signal, actionIndex) {
  const original = markdown.split('\n').map(line => line.trim()).filter(Boolean);
  const actNow = /^(?:\*\*)?Act now:(?:\*\*)?\s*/i.test(original[0] || '');
  let first = (original.shift() || '').replace(/^(?:\*\*)?Act now:(?:\*\*)?\s*/i, '');
  let target = '', targetLabel = '';
  const markers = [...first.matchAll(targetMarker)];
  if (markers.length === 1) {
    const marker = markers[0];
    target = first.slice(marker.index + marker[0].length).replace(/\.\s*$/, '').trim();
    targetLabel = stripMd(marker[0]).replace(/^[—–;-]\s*/, '').replace(/:$/, '').trim();
    first = first.slice(0, marker.index).trim();
    if (original.some(line => targetHeading.test(line))) return null;
  } else if (markers.length > 1) return null;
  else if (original.length) {
    const tail = /^(?:\*\*)?(recommended\s+target|target(?:\s+date)?|due)\s*:?(?:\*\*)?\s*:?\s+(.+?)\.?\s*$/i.exec(original.at(-1));
    if (tail) {
      targetLabel = tail[1];
      target = tail[2].replace(/\.$/, '').trim();
      original.pop();
    }
  }
  const ownerMatch = /^([^—–;\n]{2,100}?)(?:\s*[—–]\s*|\s+-\s+)(.+)$/.exec(first);
  if (!ownerMatch || !target || /[\r\n]/.test(target)) return null;
  const owner = stripMd(ownerMatch[1]), task = ownerMatch[2].trim();
  if (!owner || !stripMd(task) || !stripMd(target)) return null;
  // A provider's "due"/"target" spelling is harmless for an internal
  // recommendation, but never reinterpret an explicitly federal obligation.
  if (!/^recommended\s+target$/i.test(targetLabel) && federalScope.test(markdown)) return null;
  if (original.some(line => actionBullet.test(line) || /^#{1,6}\s|^>/.test(line))) return null;
  const response = original.reduce((value, line) => `${value}${contextHeading.test(line) ? '; ' : ' '}${line}`, task);
  if ([...response.matchAll(targetMarker)].length) return null;
  const rendered = `${owner} — ${response} — recommended target ${target}.`;
  const normalizedMarkdown = `${actNow ? '**Act now:** ' : ''}${rendered}`;
  const parsed = parseRecommendedActions(`**Recommended actions:**\n- ${normalizedMarkdown}`)[0];
  if (!parsed?.owner || !parsed.imperative || !parsed.target) return null;
  return {
    ...parsed, id: `S${signal}.A${actionIndex}`, signal, signalId: `S${signal}`,
    actionIndex, response: stripMd(response), summaryMarkdown: rendered,
    markdown: normalizedMarkdown,
  };
}

function actionField(lines, start, end, protectedRows, signal) {
  const headings = [];
  for (let index = start + 1; index < end; index++) {
    if (!protectedRows.has(index) && actionHeading.test(lines[index])) headings.push(index);
  }
  if (headings.length !== 1) return null;
  const fieldStart = headings[0];
  let fieldEnd = fieldStart + 1;
  while (fieldEnd < end) {
    const line = lines[fieldEnd];
    if (!protectedRows.has(fieldEnd) && (/^\s*\*\*[^*]+(?::\*\*|\*\*:)/.test(line)
      && !contextHeading.test(line.trim()) && !targetHeading.test(line.trim()) || /^\s*---\s*$/.test(line))) break;
    fieldEnd++;
  }
  const records = [];
  let current = [], indent = null;
  const inline = actionHeading.exec(lines[fieldStart])[1].trim();
  if (inline) current.push(inline.replace(/^(?:[-*•]|\d+[.)])\s+/, ''));
  for (let index = fieldStart + 1; index < fieldEnd; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (protectedRows.has(index)) return null;
    const bullet = actionBullet.exec(line);
    if (bullet && (indent === null || bullet[1].length === indent)) {
      indent = bullet[1].length;
      if (current.length) records.push(current.join('\n'));
      current = [bullet[2]];
    } else if (current.length) current.push(line.trim());
    else return null;
  }
  if (current.length) records.push(current.join('\n'));
  const actions = records.map((record, index) => parseAction(record, signal, index + 1));
  if (!actions.length || actions.some(action => !action)) return null;
  return { start: fieldStart, end: fieldEnd, actions };
}

/** Derive repeated executive decisions from the visible judgment actions.
 * New generation / explicit composition only: never silently apply to archives.
 * No provider-specific output mode, hidden record, or asserted ID is required. */
export function composeBriefActions(value) {
  const text = String(value || '');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/), protectedRows = protectedLines(lines);
  const judgments = sectionRange(lines, protectedRows, 'KEY JUDGMENTS');
  const executive = sectionRange(lines, protectedRows, 'EXECUTIVE SUMMARY');
  const unchanged = reason => ({ text, actions: [], executiveActions: [], composed: false, reason });
  if (!judgments || !executive) return unchanged('section-unavailable');
  const starts = [];
  for (let index = judgments.start + 1; index < judgments.end; index++) {
    if (!protectedRows.has(index) && /^###\s/.test(lines[index])) starts.push(index);
  }
  if (!starts.length) return unchanged('actions-unavailable');
  const fields = starts.map((start, index) => actionField(lines, start, starts[index + 1] ?? judgments.end, protectedRows, index + 1));
  if (fields.some(field => !field)) return unchanged('actions-ambiguous');
  const actions = fields.flatMap(field => field.actions);
  // Executive decisions cover the leading judgments; every action belonging
  // to those judgments stays complete, including distinct recovery targets.
  const executiveActions = actions.filter(action => action.signal <= 3);
  const summary = `- **Required decisions:** ${executiveActions.map(action => action.summaryMarkdown.replace(/\.$/, '')).join('; ')}.`;
  const edits = fields.map(field => ({ start: field.start, end: field.end,
    lines: ['**Recommended actions:**', ...field.actions.map(action => `- ${action.markdown}`), ''] }));
  const decisionRows = [];
  for (let index = executive.start + 1; index < executive.end; index++) {
    if (protectedRows.has(index) || !decisionHeading.test(lines[index])) continue;
    let end = index + 1;
    while (end < executive.end && !protectedRows.has(end)
      && !/^\s*(?:[-*•]\s+|\*\*[^*]+(?::\*\*|\*\*:)|---\s*$)/.test(lines[end])) end++;
    decisionRows.push({ start: index, end });
  }
  const summaryMatches = decisionRows.length === 1
    && lines.slice(decisionRows[0].start, decisionRows[0].end).join(' ').trim().replace(/\s+/g, ' ')
      === summary.replace(/\s+/g, ' ');
  if (decisionRows.length) decisionRows.forEach((row, index) => edits.push({ ...row, lines: index ? [] : [summary, ''] }));
  else {
    let at = executive.end;
    while (at > executive.start + 1 && (!lines[at - 1].trim() || /^---\s*$/.test(lines[at - 1]))) at--;
    edits.push({ start: at, end: at, lines: [summary, ''] });
  }
  edits.sort((a, b) => b.start - a.start).forEach(edit => lines.splice(edit.start, edit.end - edit.start, ...edit.lines));
  return {
    text: lines.join(newline), actions, composed: true, summaryMatches,
    executiveActions: executiveActions.map((action, index) => ({ decision: index + 1, actionIds: [action.id] })),
  };
}

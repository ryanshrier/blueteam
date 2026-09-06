// Deterministic editorial constraints. These detect bounded inconsistencies;
// they do not claim to establish arbitrary natural-language entailment.
import { createHash } from 'node:crypto';
import { section, splitEntries, rawField, stripMd, SECTIONS, FIELDS } from './brief-schema.js';

export function canonicalActions(text) {
  return splitEntries(section(text, SECTIONS.keyJudgments)).flatMap((entry, index) => {
    const value = rawField(entry, FIELDS.recommendedActions);
    return value.split('\n').filter(line => /^\s*[-*]\s/.test(line)).map(line => ({
      signal: index + 1,
      markdown: line.replace(/^\s*[-*]\s+/, '').trim(),
      text: stripMd(line.replace(/^\s*[-*]\s+/, '')).trim(),
    })).filter(action => /\s[—–]\s.*\s[—–]\srecommended target\s/i.test(action.text));
  });
}

/** Preview complete responses for the first three judgments, including paired work. */
export function canonicalizeExecutiveActions(text) {
  const seen = new Set();
  const identities = new Set();
  const actions = canonicalActions(text).filter(action => {
    if (identities.has(action.text) || (!seen.has(action.signal) && seen.size >= 3)) return false;
    seen.add(action.signal); identities.add(action.text); return true;
  });
  if (!actions.length) return text;
  return text.replace(/^([-*]\s+\*\*Required decisions:\*\*)[^\n]*$/mi, (_, prefix) => `${prefix} ${actions.map(action => action.markdown.replace(/^\*\*Act now:\*\*\s*/i, '').replace(/\.$/, '')).join('; ')}.`);
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function compareEditionInputs(current, previous = null) {
  const sourceList = value => (value?.sources || value?.members || []).filter(item => item.url).map(item => ({ key: `${item.label || item.source}|${item.url}`, text: item.passage || item.evidenceText || '' }));
  const now = sourceList(current);
  const before = sourceList(previous);
  const old = new Map(before.map(item => [item.key, item.text]));
  const keys = new Set(now.map(item => item.key));
  const added = now.filter(item => !old.has(item.key)).length;
  const changed = now.filter(item => old.has(item.key) && old.get(item.key) !== item.text).length;
  const removed = before.filter(item => !keys.has(item.key)).length;
  return {
    kind: !before.length ? 'first-recorded-inputs' : added || changed || removed ? 'source-input-change' : 'unchanged-inputs',
    added, changed, removed, unchanged: now.length - added - changed,
    fingerprint: digest(now.sort((a, b) => a.key.localeCompare(b.key))),
    explanation: !before.length ? 'No preceding receipt is available for comparison.' : 'Counts compare retained publisher passages. Retrieval or text changes do not by themselves establish a new threat development.',
  };
}

export function editorialIssues(text, judgments, { records = [], inputDelta = null } = {}) {
  const issues = [];
  const add = (code, message, severity = 'trust') => issues.push({ code, severity, message });
  const allEvidence = records.filter(record => record.quality?.substantive !== false).map(record => record.passage || record.evidenceText || '').join('\n').toLowerCase();
  const actions = canonicalActions(text);
  const exec = stripMd(rawField(section(text, SECTIONS.execSummary), 'Required decisions'));
  if (actions.length && exec) {
    const actionDates = new Set(actions.map(action => action.text.match(/recommended target\s+([^.;]+)/i)?.[1]?.trim().toLowerCase()).filter(Boolean));
    for (const match of exec.matchAll(/recommended target\s+([^.;]+)/gi)) if (!actionDates.has(match[1].trim().toLowerCase())) add('ACTION_SUMMARY_CONFLICT', 'Executive action target is absent from the canonical judgment actions; rebuild the summary from those actions.');
  }
  judgments.forEach((entry, index) => {
    const citations = rawField(entry, FIELDS.whatHappened);
    const citedRecords = records.filter(record => record.url && citations.includes(record.url) && record.quality?.substantive !== false);
    const citedEvidence = citedRecords.map(record => record.passage || record.evidenceText || '').join('\n').toLowerCase();
    const confidence = rawField(entry, FIELDS.confidence);
    if (!/^(?:High|Moderate|Low)\s+[—–]\s+\S/i.test(confidence.trim())) add('EVIDENCE_CONFIDENCE_REQUIRED', `Signal ${index + 1} needs qualitative evidence confidence (High, Moderate, or Low) with its basis; probability belongs to a separately specified forecast.`, 'structure');
    if (/\b(?:independent(?:ly)? (?:confirmed|corroborated|reporting|researcher reporting)|multiple independent outlets)\b/i.test(confidence)
      && !citedRecords.some(record => record.independence?.verified === true)) add('INDEPENDENCE_UNESTABLISHED', `Signal ${index + 1} claims source independence that is not established in retained provenance; identify the primary origin and distinct source contributions.`);
    const relevance = rawField(entry, 'Relevance');
    if (/\b(?:unknown|unverified|not (?:a )?named|if .{0,35}(?:deployed|run))\b/i.test(relevance)) {
      const first = actions.find(action => action.signal === index + 1)?.text || '';
      if (first && !/^[^—–]+[—–]\s*(?:if\b|verify\b|confirm\b|check\b|inventory\b|determine\b)/i.test(first)) add('APPLICABILITY_ACTION_UNCONDITIONAL', `Signal ${index + 1} has unverified local applicability: its first action must verify deployment/exposure or explicitly condition the response.`);
    }
    const line = rawField(entry, FIELDS.theLine);
    if (/\b(?:before|by)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|\bthis weekend\b/i.test(line)) add('ACTION_RELATIVE_DEADLINE', `Signal ${index + 1} repeats an ambiguous relative deadline in its leadership line; use the canonical action target or omit the date.`);
    const factFields = [FIELDS.assessment, FIELDS.whatHappened, FIELDS.theLine].map(field => stripMd(rawField(entry, field))).join(' ');
    for (const match of factFields.matchAll(/\bat scale\b|\b(?:faster than|outpaces?)\b.{0,65}\b(?:patch|cadence|sector)|\b(?:nearly every|all) enterprise vendor categor(?:y|ies)\b/gi)) {
      if (!citedEvidence.includes(match[0].toLowerCase())) add('FACT_SCALE_UNSUPPORTED', `Signal ${index + 1} broad scale or patch-rate claim is not stated in retained passages: "${match[0]}". Scope the assessment to observed reporting.`);
    }
    const forecast = rawField(entry, 'Forecast');
    if (forecast && !/^Event:\s*.+?\s*\|\s*Resolve by:\s*\d{4}-\d{2}-\d{2}\s*\|\s*Likelihood:\s*(?:[1-9]|[1-9]\d)%\s*\|\s*Confirm when:\s*.+?\s*\|\s*Basis:\s*.+/i.test(forecast)) add('FORECAST_UNRESOLVABLE', `Signal ${index + 1} forecast needs Event, Resolve by, Likelihood (1–99%), Confirm when, and Basis fields.`, 'structure');
  });
  for (const [index, entry] of splitEntries(section(text, SECTIONS.convergence)).entries()) {
    const cascade = rawField(entry, FIELDS.theCascade);
    if (!/\b(?:analytical )?hypothesis\b/i.test(cascade)) add('SCENARIO_NOT_LABELED', `Convergence ${index + 1} must label its cascade as an analytical hypothesis.`, 'structure');
    if (!rawField(entry, 'Confirmation').trim() || !rawField(entry, 'Action rationale').trim()) add('SCENARIO_DECISION_GAP', `Convergence ${index + 1} needs an observable Confirmation and an Action rationale connecting the recommended control to its failure mode.`, 'structure');
    for (const match of cascade.matchAll(/\bby Q[1-4]\b|\bwithin (?:\d+|one|two|three|four) (?:quarters?|months?|years?)\b/gi)) if (!allEvidence.includes(match[0].toLowerCase())) add('SCENARIO_TIMELINE_UNSUPPORTED', `Convergence ${index + 1} forecast timing is unsupported: "${match[0]}". Omit the interval or cite its basis.`);
    if (/human cadence|human[- ]paced|built for human/i.test(cascade) && /same (?:access )?review cadence/i.test(rawField(entry, FIELDS.theMove))) add('ACTION_MECHANISM_CONFLICT', `Convergence ${index + 1} says human review cadence fails but recommends the same cadence; connect the control to the stated mechanism.`);
  }
  if (inputDelta?.kind === 'unchanged-inputs' && /\*\*Trajectory:\*\*\s*(?:Accelerating|Inflecting)/i.test(text)) add('CONTINUITY_WITHOUT_NEW_INPUT', 'Retained source inputs are unchanged; do not infer acceleration or inflection from a new edition. Preserve the prior status or explain a supported reinterpretation.');
  return issues;
}

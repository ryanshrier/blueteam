// Deterministic editorial constraints. These detect bounded inconsistencies;
// they do not claim to establish arbitrary natural-language entailment.
import { createHash } from 'node:crypto';
import { section, splitEntries, rawField, stripMd, parseRecommendedActions, SECTIONS, FIELDS } from './brief-schema.js';
import { hasAffirmativeClaim } from './claim-checks.js';
import { sourceEvidencePassages } from './source-passages.js';
import { sourcePublicationDay } from './grounding.js';

export function canonicalActions(text) {
  return splitEntries(section(text, SECTIONS.keyJudgments)).flatMap((entry, index) => {
    const value = rawField(entry, FIELDS.recommendedActions);
    return value.split('\n').filter(line => /^\s*[-*]\s/.test(line)).map(line => ({
      signal: index + 1,
      markdown: line.replace(/^\s*[-*]\s+/, '').trim(),
      text: stripMd(line.replace(/^\s*[-*]\s+/, '')).trim(),
    })).filter(action => /\s[—–]\s.*\s[—–]\srecommended target\s/i.test(action.text))
      .map((action, actionIndex) => ({ ...action, id: `S${index + 1}.A${actionIndex + 1}`,
        signalId: `S${index + 1}`, actionIndex: actionIndex + 1,
        ...(decisionRecords(action.text).records[0] || {}),
      }));
  });
}

// Recognize the authored owner / response / target grammar without treating
// semicolons inside the response as separate decisions. This establishes shape
// and literal metadata only; it cannot prove that a summary entails an action.
function decisionRecords(value) {
  const text = stripMd(value || '').trim();
  const records = [];
  let cursor = 0, complete = true;
  const pattern = /(?:^|;\s*)([^;—–\n]{2,100}?)\s+[—–]\s+([\s\S]*?)\s+[—–]\s+recommended target\s+([^.;\n]+)(?=[.;]|$)/gi;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== cursor) complete = false;
    cursor = match.index + match[0].length;
    records.push({ owner: match[1].replace(/^Act now:\s*/i, '').trim(), response: match[2].trim(), target: match[3].trim() });
  }
  return { records, complete: records.length > 0 && complete && /^\.?\s*$/.test(text.slice(cursor)) };
}

const metadataKey = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const targetKey = value => sourcePublicationDay(value) || metadataKey(value);
const namedOwners = value => value.split(/\s*[/&+]\s*/).map(metadataKey).filter(Boolean);
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A bounded assignment check, not a runbook or a general language classifier.
// These patterns bind an operational verb to its object. Merely naming a
// recovery plan, preserving evidence before a patch, or listing dependencies
// does not establish a second deliverable. Unrecognized phrasing abstains.
const ACTION_PHASES = [
  ['containment/remediation', /\b(?:restrict|limit|block)\s+(?:(?:the|all|any|unnecessary|external|network|management|remote|public|internet)\s+){0,4}(?:access|exposure|reachability|connections|services)\b|\bisolate\s+(?:(?:the|all|any|affected|suspected|compromised|exposed)\s+){0,4}(?:hosts?|appliances?|servers?|systems?|devices?|instances?)\b|\b(?:patch|update|upgrade)\s+(?:(?:only|the|all|any|affected|vulnerable|exposed|internet-facing|deployed)\s+){0,4}(?:hosts?|appliances?|servers?|systems?|devices?|instances?|deployments?|applications?|software)\b|\b(?:update|upgrade)\s+to\s+(?:(?:the|a|current|vendor-specified|fixed|supported|vendor-validated)\s+){0,4}(?:build|release|version)\b/i],
  ['investigation', /\binvestigate\s+(?:(?:the|all|any|affected|exposed|deployed|compromised|suspected|previously)\s+){0,4}(?:(?:[A-Za-z][\w-]*)\s+){0,2}(?:hosts?|appliances?|servers?|systems?|devices?|instances?|deployments?|compromise|exposure|access|use)\b|\breview\s+(?:(?:the|all|any|available|access|application|web|host|security|retained|file-access|compromise|exposure|authentication)\s+){0,4}(?:logs?|evidence|findings|records|activity)\b|\b(?:begin|start|conduct|perform)\s+(?:(?:a|an|the|vendor-assisted|Citrix-assisted)\s+){0,3}(?:compromise review|investigation)\b/i],
  ['recovery', /\b(?:restore|rebuild|reimage|re-image|redeploy)\s+(?:(?:the|all|any|affected|confirmed|confirmed-compromised|suspected|compromised|isolated)\s+){0,4}(?:hosts?|appliances?|servers?|systems?|devices?|instances?)\b|\b(?:restore|rebuild|redeploy)\s+from\s+(?:(?:a|the|verified|safe|trusted|known-good)\s+){0,4}(?:backup|software|image)\b|\brotate\s+(?:(?:the|all|any|affected|exposed|compromised)\s+){0,3}(?:secrets|credentials|passwords|keys)\b/i],
];

function assignedPhase(instruction, pattern) {
  let scoped = instruction;
  for (const match of instruction.matchAll(new RegExp(pattern.source, 'gi'))) {
    const before = instruction.slice(Math.max(0, match.index - 100), match.index);
    // A plan, observed attempt, or quoted adversary behavior is not an
    // instruction to complete that phase. Keep this exception local so a
    // later, affirmative restoration clause is still found.
    if (/\b(?:plans?|planning|prepare|preparing|attempts?|ability|permission|instructions?|guidance|procedure)\s+(?:(?:a|the|recovery|plan|on|how|when)\s+){0,3}to\s+$/i.test(before)
      || /\b(?:attackers?|adversaries?|they)\s+(?:(?:can|may|might|could|will|would)\s+)?$/i.test(before)) {
      scoped = scoped.slice(0, match.index) + ' '.repeat(match[0].length) + scoped.slice(match.index + match[0].length);
    }
  }
  return hasAffirmativeClaim(scoped, pattern);
}

function actionPhaseBundleIssues(text, add) {
  for (const [signal, entry] of splitEntries(section(text, SECTIONS.keyJudgments)).entries()) {
    for (const [index, action] of parseRecommendedActions(entry).entries()) {
      // Context about another action's deliverable stays a dependency. The
      // same applies to completion evidence and artifact titles. Actual work
      // expressed in a condition or recovery field still belongs to this task.
      const instruction = [action.imperative, action.condition, action.initiationTrigger, action.recoverySteps].filter(Boolean).join('; ');
      const phases = ACTION_PHASES.filter(([, pattern]) => assignedPhase(instruction, pattern)).map(([phase]) => phase);
      if (phases.length > 1) add('ACTION_PHASE_BUNDLE_REVIEW',
        `Signal ${signal + 1} action ${index + 1} combines ${phases.join(' and ')} under one target. Split separately assignable phases into actions with one accountable owner, completion evidence, and a feasible target each. Link prerequisites and preserve conditional recovery; an uncertain restoration date needs a scoped planning milestone and an open recovery dependency.`, 'review');
    }
  }
}

// An exact function name can itself contain "and". Split only when the full
// name is not a canonical owner. Explicit paired owners in the response still
// carry responsibility and must not lose their own target in a summary.
function summaryOwners(summary, knownOwners) {
  const exact = metadataKey(summary.owner);
  const owners = knownOwners.has(exact) ? [exact, ...namedOwners(summary.owner)] : summary.owner.split(/\s*[/&+]\s*|\s+and\s+/i).map(metadataKey).filter(Boolean);
  for (const owner of knownOwners.keys()) {
    if (new RegExp(`\\b(?:paired with|alongside|coordinate with|coordinating with)\\s+${escaped(owner)}\\b`, 'i').test(summary.response)) owners.push(owner);
  }
  return [...new Set(owners)];
}

// This intentionally recognizes only literal, distinctive identifiers already
// present in both the heading and a canonical action, not general semantic
// similarity. Ambiguous legacy summaries remain review findings.
function summarySignalScope(text, actions, summary) {
  const candidates = new Map();
  const generic = /^(?:Signal|Horizon|Critical|High|Moderate|Low|Verify|Check|Review|Update|Patch|Containment|Infrastructure|Incident|Response|Security|Application|Detection|Engineering|CISA|KEV|CVE|RCE|SAML|FIPS)$/i;
  const entries = splitEntries(section(text, SECTIONS.keyJudgments));
  entries.forEach((entry, index) => {
    const heading = stripMd(entry.split('\n')[0]);
    for (const match of heading.matchAll(/\b(?:CVE-\d{4}-\d{4,}|[A-Z][a-z]+(?:[A-Z][A-Za-z\d]+)+|[A-Z]{3,}[A-Z\d]*|[A-Z][a-z]{3,})\b/g)) {
      const identifier = match[0];
      if (generic.test(identifier)) continue;
      const pattern = new RegExp(`\\b${escaped(identifier)}\\b`);
      const signals = new Set(actions.filter(action => pattern.test(action.response || '')).map(action => action.signal));
      if (signals.size === 1 && signals.has(index + 1)) candidates.set(identifier, index + 1);
    }
  });
  return [...new Set([...candidates].filter(([identifier]) => new RegExp(`\\b${escaped(identifier)}\\b`, 'i').test(summary.response)).map(([, signal]) => signal))];
}

// Within a signal, an asserted action ID is not proof of association. Literal
// task phrases can expose a borrowed date; otherwise competing targets need
// review. Conditions/initiation labels are retained on the action, but are not
// used as interchangeable task identifiers.
function literalActionAssociations(summary, candidates) {
  const words = value => metadataKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const main = action => (action.response || '').split(/;\s*(?:Initiation|Condition|Completion criterion|Dependencies|Recovery|Evidence\/artifact):/i)[0];
  const tasks = candidates.map(action => ({ action, tokens: words(main(action)) }));
  const summaryText = ` ${words(summary.response).join(' ')} `;
  return tasks.filter(({ tokens }, index) => {
    if (tokens.length >= 3 && summaryText.includes(` ${tokens.join(' ')} `)) return true;
    if (tokens.length < 3) return false;
    // Keep the task's opening verb with the anchor. A product/object phrase
    // later in the response alone cannot establish which work was summarized.
    const phrase = ` ${tokens.slice(0, 3).join(' ')} `;
    return summaryText.includes(phrase) && tasks.every((other, otherIndex) => otherIndex === index || !` ${other.tokens.join(' ')} `.includes(phrase));
  }).map(({ action }) => action);
}

function summaryActionIssues(text, actions, summaries, executiveActions, add) {
  const ownerTargets = new Map();
  for (const action of actions) {
    if (!action.owner || !action.target) continue;
    for (const owner of new Set([metadataKey(action.owner), ...namedOwners(action.owner)])) {
      if (!ownerTargets.has(owner)) ownerTargets.set(owner, new Set());
      ownerTargets.get(owner).add(targetKey(action.target));
    }
  }
  const explicit = executiveActions !== undefined;
  const mappings = new Map();
  if (explicit) {
    if (!Array.isArray(executiveActions)) {
      add('ACTION_SUMMARY_MAPPING_INVALID', 'Executive action mapping must be an array of decision numbers and canonical action IDs.', 'structure');
    } else {
      for (const item of executiveActions) {
        if (!item || !Number.isInteger(item.decision) || item.decision < 1 || item.decision > summaries.length
          || mappings.has(item.decision) || !Array.isArray(item.actionIds) || !item.actionIds.length
          || item.actionIds.some(id => typeof id !== 'string' || !actions.some(action => action.id === id))
          || new Set(item.actionIds).size !== item.actionIds.length) {
          add('ACTION_SUMMARY_MAPPING_INVALID', 'Each executive decision needs one mapping with unique, existing canonical action IDs and a valid decision number.', 'structure');
          continue;
        }
        mappings.set(item.decision, item.actionIds);
      }
    }
    if (mappings.size !== summaries.length) add('ACTION_SUMMARY_MAPPING_INVALID', 'Every executive decision must reference its specific canonical judgment actions.', 'structure');
  }
  for (const [index, summary] of summaries.entries()) {
    const owners = summaryOwners(summary, ownerTargets);
    const scope = summarySignalScope(text, actions, summary);
    const refs = mappings.get(index + 1);
    if (explicit && !refs) continue;
    if (refs) {
      const referenced = actions.filter(action => refs.includes(action.id));
      const referencedOwners = new Set(referenced.flatMap(action => [metadataKey(action.owner || ''), ...namedOwners(action.owner || '')]));
      if (owners.some(owner => !referencedOwners.has(owner)) || referenced.some(action => namedOwners(action.owner || '').some(owner => !owners.includes(owner)))) {
        add('ACTION_SUMMARY_MAPPING_INVALID', `Executive decision ${index + 1} must preserve the owners of its referenced actions; name paired functions explicitly.`, 'structure');
      }
      if (referenced.some(action => !action.target || targetKey(action.target) !== targetKey(summary.target))) {
        add('ACTION_SUMMARY_CONFLICT', `Executive decision ${index + 1} target disagrees with ${referenced.map(action => action.id).join(', ')}; decisions with different targets must remain separate.`);
      }
      if (scope.length === 1 && referenced.some(action => action.signal !== scope[0])) {
        add('ACTION_SUMMARY_MAPPING_INVALID', `Executive decision ${index + 1} names Signal ${scope[0]}'s identifier but references another signal's action.`, 'structure');
      }
      for (const signal of new Set(referenced.map(action => action.signal))) for (const owner of owners) {
        const candidates = actions.filter(action => action.signal === signal && namedOwners(action.owner || '').includes(owner));
        if (new Set(candidates.map(action => targetKey(action.target))).size < 2) continue;
        const associated = literalActionAssociations(summary, candidates);
        if (associated.some(action => targetKey(action.target) !== targetKey(summary.target))) {
          add('ACTION_SUMMARY_CONFLICT', `Executive decision ${index + 1} repeats an action with a different canonical target within Signal ${signal}; an asserted action ID cannot substitute another task's date.`);
        } else if (associated.some(action => !refs.includes(action.id))) {
          add('ACTION_SUMMARY_MAPPING_INVALID', `Executive decision ${index + 1} repeats an action absent from its references within Signal ${signal}.`, 'structure');
        } else if (!associated.length) {
          add('ACTION_SUMMARY_ASSOCIATION_REVIEW', `Executive decision ${index + 1} has competing targets for the same owner within Signal ${signal}; verify the prose association as well as the supplied action IDs.`);
        }
      }
      continue;
    }
    if (owners.some(owner => !ownerTargets.has(owner))) {
      add('ACTION_SUMMARY_OWNER_CONFLICT', `Executive action owner "${summary.owner}" is absent from the canonical judgment actions; use the assigned function names.`);
    } else if (owners.some(owner => !ownerTargets.get(owner).has(targetKey(summary.target)))) {
      add('ACTION_SUMMARY_CONFLICT', `Executive target for "${summary.owner}" does not match that owner's canonical action target; preserve each owner's target or state separate decisions.`);
    } else if (scope.length === 1) {
      const scoped = actions.filter(action => action.signal === scope[0]);
      for (const owner of owners) {
        const candidates = scoped.filter(action => [metadataKey(action.owner || ''), ...namedOwners(action.owner || '')].includes(owner));
        if (candidates.length && candidates.every(action => targetKey(action.target) !== targetKey(summary.target))) {
          add('ACTION_SUMMARY_CONFLICT', `Executive target for "${owner}" on Signal ${scope[0]} contradicts its canonical action target; a date assigned to another signal cannot justify this decision.`);
        } else if (new Set(candidates.map(action => targetKey(action.target))).size > 1) {
          add('ACTION_SUMMARY_ASSOCIATION_REVIEW', `Executive decision ${index + 1} has multiple possible action targets within Signal ${scope[0]}; confirm the specific action references.`);
        }
      }
    } else if (owners.some(owner => ownerTargets.get(owner).size > 1)) {
      add('ACTION_SUMMARY_ASSOCIATION_REVIEW', `Executive decision ${index + 1} cannot be associated unambiguously with an action; the same owner has different targets. Confirm the specific action references.`);
    }
  }
}

/** Preserve authored decision summaries; recover empty/malformed legacy rows
 * from canonical actions without shortening their conditions or recovery steps. */
export function canonicalizeExecutiveActions(text) {
  const summary = text.match(/^[-*]\s+\*\*Required decisions:\*\*\s*([^\n]*)/mi)?.[1]?.trim();
  // A well-formed summary is its own editorial judgment. Copying every action
  // over it turned a compact executive assessment into a second task list.
  // Conflicting owners/targets still go through publication checks. Every row
  // must be well formed; one valid clause cannot conceal a malformed tail.
  if (decisionRecords(summary).complete) return text;
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
  const retainedPassages = item => {
    const parts = (item.sourceParts || []).map(part => part?.passage).filter(value => typeof value === 'string' && value);
    const primary = item.passage || (!parts.length ? item.evidenceText : '') || '';
    // Input change is descriptive, not an evidence-support decision. Retain
    // changes to a weak legacy passage as well as substantive captures.
    return [...new Set([primary, ...parts].filter(value => typeof value === 'string' && value))].sort();
  };
  // Receipts materialize absent node fields. Use the same semantic defaults
  // for live trees so capture serialization alone cannot invent a change.
  const condition = node => ({ operator: ['AND', 'OR'].includes(node?.operator) ? node.operator : null,
    negate: node?.negate === true,
    cpeMatch: (node?.cpeMatch || []).map(match => ({ criteria: match.criteria || '',
      vulnerable: typeof match.vulnerable === 'boolean' ? match.vulnerable : null,
      ...Object.fromEntries(['versionStartIncluding', 'versionStartExcluding', 'versionEndIncluding', 'versionEndExcluding']
        .filter(key => typeof match[key] === 'string').map(key => [key, match[key]])) })),
    nodes: (node?.nodes || []).map(condition),
  });
  const applicability = item => ({ configurations: (item.configurations || []).map(condition),
    captures: [...new Set((item.configurationCaptures || []).map(capture => JSON.stringify({
      configurations: (capture.configurations || []).map(condition), complete: capture.complete !== false,
    })))].sort(),
    passage: item.applicabilityPassage || '', complete: item.applicabilityComplete !== false,
  });
  // Live sources are grouped display records; members is the complete flat
  // inventory. Saved receipts expose that inventory as grounding.sources.
  const sourceList = value => (value?.members || value?.sources || []).filter(item => item.url).map(item => ({
    key: `${item.label || item.source}|${item.url}`,
    // Capture ordering and retrieval timestamps do not change the reporting;
    // an added or changed complementary passage does.
    text: JSON.stringify({ passages: retainedPassages(item), applicability: applicability(item) }),
  }));
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

export function editorialIssues(text, judgments, { records = [], inputDelta = null, executiveActions } = {}) {
  const issues = [];
  const add = (code, message, severity = 'trust') => issues.push({ code, severity, message });
  const allEvidence = records.flatMap(sourceEvidencePassages).map(passage => passage.toLowerCase());
  const actions = canonicalActions(text);
  actionPhaseBundleIssues(text, add);
  // rawField parses standalone labels; executive labels are authored as bullets.
  // Remove only those field prefixes before reading the complete row, otherwise
  // the normal generated form silently skips every summary consistency check.
  const executiveFields = section(text, SECTIONS.execSummary).replace(/^[-*•]\s+(?=\*\*[^*\n]+:\*\*)/gm, '');
  const exec = stripMd(rawField(executiveFields, 'Required decisions'));
  if ((actions.length && exec) || executiveActions !== undefined) {
    const summaries = decisionRecords(exec);
    if (executiveActions !== undefined && !summaries.complete) add('ACTION_SUMMARY_MAPPING_INVALID', 'Executive decisions must have complete owner, response and target fields before their action references can be validated.', 'structure');
    summaryActionIssues(text, actions, summaries.records, executiveActions, add);
  }
  judgments.forEach((entry, index) => {
    const citations = rawField(entry, FIELDS.whatHappened);
    const citedRecords = records.filter(record => record.url && citations.includes(record.url) && record.quality?.substantive !== false);
    const citedEvidence = citedRecords.flatMap(sourceEvidencePassages).map(passage => passage.toLowerCase());
    const confidence = rawField(entry, FIELDS.confidence);
    if (!/^(?:High|Moderate|Low)\s+[—–]\s+\S/i.test(confidence.trim())) add('EVIDENCE_CONFIDENCE_REQUIRED', `Signal ${index + 1} needs qualitative evidence confidence (High, Moderate, or Low) with its basis; probability belongs to a separately specified forecast.`, 'structure');
    if (hasAffirmativeClaim(stripMd(confidence), /\b(?:independent(?:ly)?\s+(?:confirmed|corroborated|reporting|researcher reporting)|multiple independent outlets)\b/i)
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
      if (!citedEvidence.some(passage => passage.includes(match[0].toLowerCase()))) add('FACT_SCALE_UNSUPPORTED', `Signal ${index + 1} broad scale or patch-rate claim is not stated in retained passages: "${match[0]}". Scope the assessment to observed reporting.`);
    }
    const forecast = rawField(entry, 'Forecast');
    if (forecast && !/^Event:\s*.+?\s*\|\s*Resolve by:\s*\d{4}-\d{2}-\d{2}\s*\|\s*Likelihood:\s*(?:[1-9]|[1-9]\d)%\s*\|\s*Confirm when:\s*.+?\s*\|\s*Basis:\s*.+/i.test(forecast)) add('FORECAST_UNRESOLVABLE', `Signal ${index + 1} forecast needs Event, Resolve by, Likelihood (1–99%), Confirm when, and Basis fields.`, 'structure');
  });
  for (const [index, entry] of splitEntries(section(text, SECTIONS.convergence)).entries()) {
    const cascade = rawField(entry, FIELDS.theCascade);
    if (!/\b(?:analytical )?hypothesis\b/i.test(cascade)) add('SCENARIO_NOT_LABELED', `Convergence ${index + 1} must label its cascade as an analytical hypothesis.`, 'structure');
    if (!rawField(entry, 'Confirmation').trim() || !rawField(entry, 'Action rationale').trim()) add('SCENARIO_DECISION_GAP', `Convergence ${index + 1} needs an observable Confirmation and an Action rationale connecting the recommended control to its failure mode.`, 'structure');
    for (const match of cascade.matchAll(/\bby Q[1-4]\b|\bwithin (?:\d+|one|two|three|four) (?:quarters?|months?|years?)\b/gi)) if (!allEvidence.some(passage => passage.includes(match[0].toLowerCase()))) add('SCENARIO_TIMELINE_UNSUPPORTED', `Convergence ${index + 1} forecast timing is unsupported: "${match[0]}". Omit the interval or cite its basis.`);
    if (/human cadence|human[- ]paced|built for human/i.test(cascade) && /same (?:access )?review cadence/i.test(rawField(entry, FIELDS.theMove))) add('ACTION_MECHANISM_CONFLICT', `Convergence ${index + 1} says human review cadence fails but recommends the same cadence; connect the control to the stated mechanism.`);
  }
  if (inputDelta?.kind === 'unchanged-inputs' && /\*\*Trajectory:\*\*\s*(?:Accelerating|Inflecting)/i.test(text)) add('CONTINUITY_WITHOUT_NEW_INPUT', 'Retained source inputs are unchanged; do not infer acceleration or inflection from a new edition. Preserve the prior status or explain a supported reinterpretation.');
  return issues;
}

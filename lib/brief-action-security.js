// A bounded review tripwire, not a prompt-injection detector or a claim that
// unflagged advice is safe. Source reporting about attacker behavior is not an
// instruction for defenders. Legacy action fields and version 2 narrative
// directives retain explicit review; attributed proposals remain reporting.
import { SECTIONS, FIELDS, section, splitEntries, rawField, briefFormatVersion } from './brief-schema.js';
import { VALIDATION_POLICY_VERSION } from './brief-validation-policy.js';
import { escapeRegExp } from './regex-util.js';

const WEAKEN = /\b(?:disabl(?:e|ing)|deactivat(?:e|ing)|turn(?:ing)?\s+off|switch(?:ing)?\s+off|stop(?:ping)?|suspend(?:ing)?|bypass(?:ing)?|remov(?:e|ing)|uninstall(?:ing)?|suppress(?:ing)?)\b/gi;
// Bind each verb to its immediate object. Scanning arbitrary later words would
// confuse "disable the compromised account and investigate EDR alerts" with
// disabling EDR. Unknown phrasing remains outside this bounded check.
const MODIFIERS = String.raw`(?:(?:the|all|any|our|your|their|existing|installed|active|enabled|local|centralized|enterprise|corporate|production|old|obsolete|accumulated|fleet-wide)\s+){0,6}`;
const CONTROL = new RegExp(String.raw`^\s*${MODIFIERS}(?:endpoint\s+(?:protection|detection(?:\s+and\s+response)?)|EDR|XDR|MFA|2FA|multi[- ]factor\s+authentication|two[- ]factor\s+authentication|anti[- ]?virus|anti[- ]?malware|(?:(?:Microsoft|Windows)\s+)?Defender|firewalls?|audit\s+(?:logging|logs?|trails?)|(?:security|event)\s+logs?|tamper\s+protection|(?:(?:TLS|SSL)\s+)?certificate\s+(?:validation|verification)|(?:TLS|signature)\s+(?:validation|verification)|security\s+(?:monitoring|controls?))\b`, 'i');
const LOG_REMOVAL = /\b(?:delet(?:e|ing)|clear(?:ing)?|purg(?:e|ing)|eras(?:e|ing)|wip(?:e|ing))\b/gi;
const LOG_TARGET = new RegExp(String.raw`^\s*${MODIFIERS}(?:(?:audit|event|security|system)\s+logs?|audit\s+(?:evidence|trails?))\b`, 'i');
// Recognize explicit prohibitions/defensive investigation, not an arbitrary
// negation elsewhere in the sentence that could mask a later instruction.
const DEFENSIVE_PREFIX = /\b(?:do\s+not|don['’]t|never|avoid|prevent|detect|investigate|alert\s+on)(?:\s+(?:temporarily|permanently|any|attempts?\s+to|attackers?|run|execute))?\s+$/i;
const COMMANDS = [
  /\bSet-MpPreference\b[^\n;]{0,160}-Disable(?:RealtimeMonitoring|BehaviorMonitoring|IOAVProtection)\s+(?:\$true|1)\b/gi,
  /\bwevtutil\s+(?:cl|clear-log)\b/gi,
  /\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off\b/gi,
  /\bauditpol\s+\/set\b[^\n;]{0,160}\/(?:success|failure):disable\b/gi,
];

function requiresReview(value, allowReviewTask, narrative = false) {
  const text = value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
  const affirmative = match => !DEFENSIVE_PREFIX.test(text.slice(Math.max(0, match.index - 70), match.index));
  const reported = match => {
    if (!narrative) return false;
    const prefix = text.slice(0, match.index).split(/[.!?;\n]/).at(-1);
    // Clause-bound attribution is reporting, not local approval. A subsequent
    // imperative is checked independently, including in the same paragraph.
    return /\b(?:vendor|supplier|researcher|advisory|report)\b[^,;.!?\n]{0,100}\b(?:proposes?|recommends?|describes?|reports?)\s+(?:(?:temporarily|permanently)\s+)?$/i.test(prefix)
      || /\b(?:attackers?|intruders?|malware)\s+(?:(?:can|may|could|attempt\s+to)\s+)?$/i.test(prefix)
      || /\bnot\s+(?:(?:an?|the|authorized|customer|local)\s+){0,5}change\s+or\s+(?:(?:an?|the|general|generally applicable)\s+){0,3}(?:instruction|recommendation|guidance)\s+to\s+$/i.test(prefix)
      || /\b(?:not|neither)\s+(?:(?:an?|the|authorized|general|generally applicable|local|customer)\s+){0,5}(?:instruction|recommendation|guidance|approval)\s+to\s+$/i.test(prefix);
  };
  const reviewTask = (match, targetMatch) => {
    if (!allowReviewTask) return false;
    const prefix = text.slice(Math.max(0, match.index - 160), match.index);
    if (!/\b(?:review|assess|evaluate)\s+(?:(?:the|a)\s+)?(?:(?:vendor|supplier)(?:['’]s)?\s+)?(?:request|proposal)\s+to\s+(?:temporarily\s+)?$/i.test(prefix)) return false;
    const control = targetMatch[0].trim().replace(new RegExp(`^${MODIFIERS}`, 'i'), '');
    // The same action must explicitly keep this very control enabled. Another
    // action's caveat, a different control, or later execution cannot hide a
    // weakening instruction; every occurrence is checked independently below.
    const suffix = text.slice(match.index + match[0].length + targetMatch[0].length,
      match.index + 400).split(/\n\s*[-*+]\s|\n\s*\n/)[0];
    return new RegExp(`(?:^|[;.!?]\\s*|\\band\\s+)keep\\s+(?:the\\s+)?${escapeRegExp(control)}\\s+enabled\\s+(?:until|pending)\\s+(?:(?:explicit|operator)\\s+)?approval\\b`, 'i').test(suffix.trim());
  };
  for (const [verb, target] of [[WEAKEN, CONTROL], [LOG_REMOVAL, LOG_TARGET]]) {
    for (const match of text.matchAll(verb)) {
      const following = text.slice(match.index + match[0].length, match.index + match[0].length + 180);
      const targetMatch = target.exec(following);
      if (targetMatch && affirmative(match) && !reported(match) && !(verb === WEAKEN && reviewTask(match, targetMatch))) return true;
    }
  }
  for (const pattern of COMMANDS) {
    if ([...text.matchAll(pattern)].some(affirmative)) return true;
  }
  return false;
}

export function securityActionIssues(text, renderedText, { validationPolicyVersion = VALIDATION_POLICY_VERSION } = {}) {
  if (briefFormatVersion(text) === 2) {
    return String(text).split('\n').flatMap((line, index) => {
      const heading = /^\s*#{1,6}\s+/.test(line);
      const value = renderedText(line.replace(/^\s*#{1,6}\s+/, ''));
      const proposalHeading = heading && /\b(?:proposed|proposal|workaround|exception)\b/i.test(value) && /\bwould\b/i.test(value);
      if (/^\s*<!--/.test(line) || proposalHeading || !requiresReview(value, true, true)) return [];
      return [{ code: 'SECURITY_CONTROL_CHANGE', severity: 'review',
        message: 'This passage directs weakening a security control or removing audit evidence. Attribute a source proposal with its scope and tradeoff, or obtain review for the exact execution guidance.',
        location: { scope: 'paragraph', line: index + 1, excerpt: renderedText(line).slice(0, 300) } }];
    });
  }
  const fields = [];
  const executive = section(text, SECTIONS.execSummary).replace(/^\s*[-*•]\s+/gm, '');
  fields.push(['Executive summary', rawField(executive, 'Required decisions')]);
  for (const [index, part] of splitEntries(section(text, SECTIONS.keyJudgments)).entries()) {
    fields.push([`Signal ${index + 1}`, rawField(part, FIELDS.recommendedActions)]);
    for (const label of ['Act now', 'Analyst (this shift)', 'Detection Engineering (this shift)']) {
      fields.push([`Signal ${index + 1}`, rawField(part, label)]);
    }
  }
  // Developing entries can contain owned triage steps before evidence supports
  // promotion to Key Judgments. Apply the same rule to their action fields.
  for (const part of splitEntries(section(text, SECTIONS.developing))) {
    for (const label of [FIELDS.recommendedActions, 'Initial triage', 'Act now']) {
      fields.push(['Developing situation', rawField(part, label)]);
    }
  }
  for (const [index, part] of splitEntries(section(text, SECTIONS.convergence)).entries()) {
    fields.push([`Convergence ${index + 1}`, rawField(part, FIELDS.theMove)]);
  }
  const flagged = new Set();
  return fields.flatMap(([scope, value]) => {
    if (!value || flagged.has(scope) || !requiresReview(renderedText(value), validationPolicyVersion >= 3)) return [];
    flagged.add(scope);
    return [{ code: 'SECURITY_CONTROL_CHANGE', severity: 'review',
      message: `${scope} proposes weakening a security control or removing audit evidence. Operator review of the source, affected scope, authorization, and recovery plan is required before approval.` }];
  });
}

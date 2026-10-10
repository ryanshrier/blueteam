// Worker-only evaluation of operator/domain patterns. Never import application
// state, credentials, filesystem adapters, or provider clients here.
import { affirmativeMatch } from './claims.js';

export function evaluateRegexRequest(request) {
  const compile = (source, flags = 'i') => new RegExp(source, flags);
  if (request.operation === 'validate') {
    for (const pattern of request.patterns) compile(pattern.source, pattern.flags);
    return true;
  }
  if (request.operation === 'match') {
    const regex = compile(request.source, request.flags);
    return request.affirmative ? affirmativeMatch(request.text, regex) : request.text.match(regex);
  }
  if (request.operation !== 'batch') throw new Error('Unsupported regex operation');
  const p = request.patterns;
  const lexicon = values => values.length ? compile(values.join('|')) : null;
  const critical = lexicon(p.critical), elevated = lexicon(p.elevated), promote = lexicon(p.promote);
  const severity = p.severity ? compile(p.severity) : null;
  const alerts = p.alerts.map(rule => ({ regex: compile(rule.pattern, rule.literalWatch ? 'iu' : 'i'), boost: rule.boost ?? 5 }));
  return request.items.map(item => {
    const statements = item.statements;
    let alertBoost = 0, alertMatched = false;
    for (const rule of alerts) {
      if (rule.regex.test(item.title) || rule.regex.test(item.description)) { alertMatched = true; alertBoost += rule.boost; }
    }
    return {
      criticalIndex: statements.findIndex(statement => statement.activityEligible && affirmativeMatch(statement.text, critical)),
      elevatedIndex: statements.findIndex(statement => affirmativeMatch(statement.text, elevated)),
      promote: statements.some(statement => statement.activityEligible && affirmativeMatch(statement.text, promote)),
      severityMatch: severity ? item.severity.match(severity)?.slice(0, 2) || null : null,
      alertBoost: Math.min(alertBoost, 10), alertMatched,
    };
  });
}

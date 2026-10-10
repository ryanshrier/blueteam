// Applicability conditions are evidence of NVD's match logic, not a list of
// installed assets or fixed releases. Keep the tree intact when showing it.
export const MAX_NVD_APPLICABILITY_PASSAGE = 24_000;

export function nvdApplicabilityEvidence(cve, configurations = []) {
  const retained = Array.isArray(configurations) ? configurations : [];
  if (!retained.length) return { cve, configurations: retained, passage: '', complete: true };
  const qualification = `NVD applicability conditions for ${cve}. Apply each configuration's complete AND/OR and negate logic. A vulnerable:false match describes an environmental condition, not an affected product; whether it is required depends on the complete tree. Exact CPE versions and inclusive/exclusive version bounds are match conditions; an exclusive upper bound does not establish a fixed release. These conditions do not establish local deployment or exposure. An unspecified operator remains unspecified; do not infer one.\n`;
  const serialized = JSON.stringify(retained).replace(/</g, '\\u003c');
  if (qualification.length + serialized.length > MAX_NVD_APPLICABILITY_PASSAGE) {
    return { cve, configurations: retained, complete: false,
      passage: `NVD applicability conditions for ${cve} are retained structurally but exceed the prompt display budget. No partial condition or version range is shown; do not infer affected versions, prerequisites, or fixed releases from this summary.` };
  }
  return { cve, configurations: retained, passage: qualification + serialized, complete: true };
}

// CPE fields may contain escaped colons. Keep the literal version component
// distinct from range boundaries without guessing at CPE wildcard semantics.
function cpeVersion(criteria) {
  if (typeof criteria !== 'string' || !criteria.startsWith('cpe:2.3:')) return '';
  const fields = criteria.split(/(?<!\\):/);
  const version = fields[5] || '';
  return version && !['*', '-'].includes(version) ? version.replace(/\\([\\:])/g, '$1') : '';
}

/** Literal facts only. Consumers must preserve the complete condition tree;
 * neither a positive match nor a range boundary establishes a fixed release. */
export function nvdApplicabilityVersionFacts(recordOrConfigurations = []) {
  const configurations = Array.isArray(recordOrConfigurations)
    ? recordOrConfigurations : recordOrConfigurations?.configurations || [];
  const facts = [];
  const visit = (node, configurationIndex, path, parents = []) => {
    if (!node || typeof node !== 'object' || path.length > 32) return;
    const conditions = [...parents, { operator: ['AND', 'OR'].includes(node.operator) ? node.operator : null, negate: node.negate === true }];
    for (const [matchIndex, match] of (Array.isArray(node.cpeMatch) ? node.cpeMatch : []).entries()) {
      const context = { criteria: typeof match.criteria === 'string' ? match.criteria : '',
        vulnerable: typeof match.vulnerable === 'boolean' ? match.vulnerable : null,
        configurationIndex, path: [...path], matchIndex, conditions,
        // Conservative marker: no logical simplification of nested NOTs.
        negated: conditions.some(condition => condition.negate) };
      const exact = cpeVersion(match.criteria);
      if (exact) facts.push({ ...context, version: exact, role: 'exact' });
      for (const [key, role] of [['versionStartIncluding', 'start-inclusive'], ['versionStartExcluding', 'start-exclusive'],
        ['versionEndIncluding', 'end-inclusive'], ['versionEndExcluding', 'end-exclusive']]) {
        if (typeof match[key] === 'string' && match[key]) facts.push({ ...context, version: match[key], role });
      }
    }
    for (const [index, child] of (Array.isArray(node.nodes) ? node.nodes : []).entries()) visit(child, configurationIndex, [...path, index], conditions);
  };
  if (Array.isArray(configurations)) configurations.forEach((node, index) => visit(node, index, []));
  return facts;
}

const VERSION = '\\d+\\.\\d+(?:[.-]\\w+)*';

function versionStatement(text, index) {
  const boundaries = [...text.matchAll(/[.!?](?=\s|$)|\n/g)];
  const start = boundaries.filter(match => match.index < index).at(-1);
  const end = boundaries.find(match => match.index >= index);
  const begin = start ? start.index + start[0].length : 0;
  return { text: text.slice(begin, end?.index ?? text.length), index: index - begin };
}

function reportedBoundaryRole(prefix, suffix) {
  const role = /\b(?:(inclusive|exclusive)\s+(lower|upper)|(lower|upper)\s+(inclusive|exclusive))\s+(?:version\s+)?(?:bound|limit)(?:\s+(?:of|at|is))?\s*:?\s*(?:version\s+)?$/i.exec(prefix);
  if (role) return `${(role[2] || role[3]).toLowerCase() === 'lower' ? 'start' : 'end'}-${(role[1] || role[4]).toLowerCase()}`;
  const after = /^\s*(?:as\s+(?:an?\s+)?)?\(?(?:(inclusive|exclusive)\s+(lower|upper)|(lower|upper)\s+(inclusive|exclusive))\s+(?:version\s+)?(?:bound|limit)\b/i.exec(suffix);
  if (after) return `${(after[2] || after[3]).toLowerCase() === 'lower' ? 'start' : 'end'}-${(after[1] || after[4]).toLowerCase()}`;
  if (/\b(?:exact(?:\s+CPE)?(?:\s+match)?|CPE\s+match)\s+version\s*$/i.test(prefix)) return 'exact';
  return null;
}

/** Additive support for attributed reports of NVD match bounds, not a semantic
 * assertion that a prose claim evaluates the NVD tree correctly. Existing
 * publisher-prose validation remains separate. `index` locates this occurrence
 * of `version`, so another sentence or another use cannot lend it support. */
export function nvdApplicabilitySupportsVersion(record, { text = '', version = '', index } = {}) {
  if (record?.applicabilityComplete !== true || !record.applicabilityPassage || !Array.isArray(record.configurations)) return false;
  const cve = /^NVD-(CVE-\d{4}-\d{3,7})$/i.exec(record.id || '')?.[1]?.toUpperCase();
  if (!cve || !Number.isSafeInteger(index) || index < 0 || text.slice(index, index + version.length) !== version) return false;
  const statement = versionStatement(text, index);
  const identities = [...new Set((statement.text.match(/\bCVE-\d{4}-\d{3,7}\b/gi) || []).map(id => id.toUpperCase()))];
  if (identities.length !== 1 || identities[0] !== cve || !/\bNVD\b|\bNational Vulnerability Database\b/i.test(statement.text)) return false;
  // A disclaimer that a bound is not a fixed release is permissible. A
  // positive fix, installation, or upgrade claim still needs publisher prose.
  const claim = statement.text
    .replace(/\b(?:does not|cannot)\s+(?:establish|prove|confirm)\s+(?:a\s+)?(?:fixed|patched|safe)\s+(?:version|release)\b/gi, '')
    .replace(/\bnot\s+(?:a\s+)?(?:fixed|patched|safe)\s+(?:version|release)\b/gi, '');
  if (/\b(?:fix(?:ed|es)?|patch(?:ed|es)?|upgrade|upgrading|install|installing|remediat\w*|safe)\b|\bupdat(?:e|ed|ing)\s+to\b/i.test(claim)) return false;
  const facts = nvdApplicabilityVersionFacts(record).filter(fact => fact.vulnerable === true && !fact.negated);
  const targetFacts = facts.filter(fact => fact.version === version);
  if (!targetFacts.length) return false;
  const prefix = statement.text.slice(0, statement.index);
  const suffix = statement.text.slice(statement.index + version.length);
  const role = reportedBoundaryRole(prefix, suffix);
  if (role && targetFacts.some(fact => fact.role === role)) {
    // A reported excluded bound must not also be asserted to be affected.
    if (/\b(?:affects?|affected|vulnerable)\b/i.test(statement.text)) return false;
    return true;
  }
  // A conditional range describes one CPE match, not the union of unrelated
  // matches. Require explicit endpoint roles and preserve the other conditions
  // by qualification rather than attempting to evaluate arbitrary AND/OR prose.
  const conditionsNamed = /\b(?:configuration|applicability|NVD)\s+conditions\b/i.test(statement.text);
  const conditionsPreserved = /\b(?:subject to|conditional on|depending on|with|under|apply|applies|applying|required)\b/i.test(statement.text);
  const conditionsDismissed = /\b(?:no|without|ignore|ignoring|disregard|regardless of|independent of)\b[^.;]{0,80}\bconditions\b/i.test(statement.text);
  if (!conditionsNamed || !conditionsPreserved || conditionsDismissed) return false;
  const ranges = new RegExp(`\\bversions?\\s+(?:from\\s+)?(${VERSION})\\s*\\(?\\b(inclusive|exclusive)\\)?\\s+(?:to|through)\\s+(?:(before|below|less than)\\s+)?(?:version\\s+)?(${VERSION})(?:\\s*\\(?(inclusive|exclusive)\\)?)?`, 'gi');
  for (const range of statement.text.matchAll(ranges)) {
    if (statement.index < range.index || statement.index >= range.index + range[0].length) continue;
    if (version !== range[1] && version !== range[4]) continue;
    const lowerRole = `start-${range[2].toLowerCase()}`;
    if (!range[3] && !range[5]) continue;
    if (range[3] && range[5] && range[5].toLowerCase() !== 'exclusive') continue;
    const upperRole = `end-${range[3] ? 'exclusive' : range[5].toLowerCase()}`;
    for (const lower of facts.filter(fact => fact.version === range[1] && fact.role === lowerRole)) {
      if (facts.some(upper => upper.version === range[4] && upper.role === upperRole
          && upper.configurationIndex === lower.configurationIndex && upper.matchIndex === lower.matchIndex
          && upper.criteria === lower.criteria && JSON.stringify(upper.path) === JSON.stringify(lower.path))) return true;
    }
  }
  return false;
}

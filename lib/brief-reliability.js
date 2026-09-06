// Bounded whole-document checks. A matching identifier is not semantic proof;
// unsupported inference remains an explicit editorial-review responsibility.
import { SECTIONS, FIELDS, section, splitEntries, rawField, stripMd } from './brief-schema.js';

const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const num = value => numberWords[String(value).toLowerCase()] ?? Number(value);
const number = String.raw`(?:\d+|${Object.keys(numberWords).join('|')})`;
const plain = value => stripMd(String(value || '')).replace(/\s+/g, ' ').trim();
export function expandBriefCves(text) {
  return String(text || '').replace(/\bCVE-(\d{4})-(\d{3,7})((?:\s*\/\s*\d{3,7}\b)+)/gi,
    (_whole, year, first, rest) => [`CVE-${year}-${first}`, ...rest.split('/').slice(1).map(id => `CVE-${year}-${id.trim()}`)].join(' / '));
}
const cves = text => [...new Set([...expandBriefCves(text).matchAll(/\bCVE-\d{4}-\d{3,7}\b/gi)].map(match => match[0].toUpperCase()))];
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
const plusDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function locateBriefIssues(text, issues) {
  const lines = String(text).split('\n');
  return issues.map(issue => {
    if (issue.location) return issue;
    const signal = /Signal (\d+)/i.exec(issue.message)?.[1];
    const id = /CVE-\d{4}-\d{3,7}/i.exec(issue.message)?.[0];
    let index = signal ? lines.findIndex(line => new RegExp(`^###\\s+Signal ${signal}\\b`, 'i').test(line)) : -1;
    if (index < 0 && id) index = lines.findIndex(line => line.includes(id));
    const heading = /Executive|Convergence|Watchlist|BLUF/i.exec(issue.message)?.[0];
    if (index < 0 && heading) index = lines.findIndex(line => /^##\s/.test(line) && line.toLowerCase().includes(heading.toLowerCase()));
    return { ...issue, location: index < 0 ? { scope: 'document', line: 1, excerpt: '' } : { scope: signal ? 'judgment' : 'paragraph', line: index + 1, excerpt: plain(lines[index]).slice(0, 300) } };
  });
}

export function wholeDocumentReliability(text, { records = [], kevTiming = {}, expectedDate, scoreFacts = () => [], scoreClaims = () => [], pairedScoreFacts = () => [] } = {}) {
  const issues = [];
  const lines = String(text).split('\n');
  const add = (code, message, line, severity = 'trust', sourceIds = []) => issues.push({ code, severity, message,
    location: { scope: 'paragraph', line: line + 1, excerpt: plain(lines[line]).slice(0, 300) }, sourceIds });
  const sourcesFor = ids => records.filter(record => ids.some(id => (record.cves instanceof Set ? record.cves.has(id) : record.cves?.includes(id))));
  const body = record => record.passage || record.evidenceText || '';
  const joins = value => value.toLowerCase().replace(/\s+/g, ' ');
  const allCitations = text.match(/\[[^\]]+\]\([^)]+\)/g) || [];
  const dateNow = day(expectedDate);
  for (const [index, raw] of lines.entries()) {
    const value = plain(expandBriefCves(raw));
    if (!value) continue;
    // Check only an explicitly closed product enumeration, not phrases such as
    // "five products, including ..." where the following examples are partial.
    const productList = new RegExp(`\\b(${number})\\s+(?:distinct\\s+)?products?\\b[^:]*:\\s*([^—]+)`, 'i').exec(value);
    if (productList && !/\b(?:including|such as|for example)\b/i.test(productList[0])) {
      const items = productList[2].replace(/[.;]\s*$/, '').split(/,\s*(?![^()]*\))|\s+and\s+(?![^()]*\))/).map(item => item.trim()).filter(Boolean);
      const stated = num(productList[1]);
      if (items.length > 1 && stated !== items.length) add('FACT_PRODUCT_COUNT_MISMATCH', `The closed list states ${stated} products but enumerates ${items.length}. Correct the count or remove the unsupported aggregate.`, index, 'review');
    }
    const unitStart = lines.slice(0, index + 1).findLastIndex(line => /^#{2,3}\s/.test(line));
    const nextUnit = lines.slice(Math.max(0, unitStart) + 1).findIndex(line => /^#{2,3}\s/.test(line));
    const unit = lines.slice(Math.max(0, unitStart), nextUnit < 0 ? undefined : Math.max(0, unitStart) + 1 + nextUnit).join('\n');
    // What happened retains its stricter existing per-citation checker. Other
    // fields may reuse the same judgment's cited fact, while summary rows may
    // reuse an exactly bound fact cited elsewhere in the document.
    if (!/^What happened:/i.test(value)) for (const claim of scoreClaims(value)) {
      const before = cves(value.slice(0, claim.index));
      const local = cves(unit);
      const id = before.at(-1) || (local.length === 1 ? local[0] : null);
      if (!id) { add('FACT_CVSS_ASSOCIATION_UNVERIFIED', 'This score has no unambiguous CVE association in its field or judgment. Name the full identity or remove the metric.', index, 'review'); continue; }
      const summary = /^##\s+(?:BLUF|EXECUTIVE)/i.test(lines[Math.max(0, unitStart)] || '');
      const citationContext = summary ? text : unit;
      let available = sourcesFor([id]).filter(source => source.quality?.substantive !== false && source.url && citationContext.includes(source.url));
      const authority = /^\s+(?:per|according to|from)\s+(NVD|CISA)\b/i.exec(value.slice(claim.end))?.[1]
        || /\b(NVD|CISA)\s+(?:lists|reports|assigns)\s*$/i.exec(value.slice(0, claim.index))?.[1];
      if (authority) available = available.filter(source => source.label?.toLowerCase().includes(authority.toLowerCase()));
      const matches = fact => fact.score === claim.score && (!fact.version || !claim.version || fact.version === claim.version);
      const supported = available.some(source => {
        const ids = source.cves instanceof Set ? [...source.cves] : source.cves || [];
        return ids.length === 1 ? scoreFacts(body(source)).some(matches) : pairedScoreFacts(body(source)).some(fact => fact.cve === id && matches(fact));
      });
      if (!supported) add('FACT_CVSS_UNSUPPORTED', `${id} CVSS ${claim.score}${authority ? ` attributed to ${authority}` : ''} in this field is not supported by its cited entity-bound evidence. Summaries and assessments cannot introduce a new score or change its authority.`, index, 'trust', available.map(source => source.id));
    }
    // Closed lists may include product labels and shortened same-year IDs.
    const counted = new RegExp(String.raw`\b(${number})\s+(?:(?:separate|distinct|different|known|actively|exploited|KEV)\s+){0,4}CVEs?\b[^().!?\n]{0,250}\(([^()\n]{1,1600})\)`, 'gi');
    for (const match of value.matchAll(counted)) {
      // A product-labelled list can span several parentheses: SonicWall (A, B),
      // PaperCut (C, D), and Chrome (E). Bind the count to the entire contiguous
      // enumeration, not just the first product's identities. Stop at a new
      // sentence, another clause, or a group without CVEs; never borrow an
      // unrelated paragraph's identities to make the number agree.
      let list = match[2];
      let scope = match[0];
      let remaining = value.slice(match.index + match[0].length);
      const nextGroup = /^\s*(?:,\s*(?:and\s+)?|and\s+)[^()\n.!?;—–]{1,100}\(([^()\n]{1,1000})\)/i;
      for (let group = 0; group < 20; group++) {
        const next = nextGroup.exec(remaining);
        if (!next || !cves(next[1]).length) break;
        list += ` ${next[1]}`;
        scope += next[0];
        remaining = remaining.slice(next[0].length);
      }
      if (/\b(?:including|such as|among|for example|etc)\b|…/i.test(scope)) continue;
      const ids = cves(list);
      if (ids.length < 2) continue;
      const stated = num(match[1]);
      if (stated !== ids.length) add('FACT_CVE_COUNT_MISMATCH', `The closed list states ${stated} CVEs but names ${ids.length} distinct full CVE identities.`, index);
      const period = new RegExp(String.raw`\b(?:past|last)\s+(${number})\s+days?\b`, 'i').exec(match[0]);
      if (period && dateNow && num(period[1]) >= 1 && num(period[1]) <= 366 && /added|additions/i.test(match[0])) {
        const start = plusDays(dateNow, 1 - num(period[1]));
        const known = ids.filter(id => day(kevTiming[id]?.dateAdded));
        const outside = known.filter(id => kevTiming[id].dateAdded < start || kevTiming[id].dateAdded > dateNow);
        if (outside.length) add('FACT_CVE_WINDOW_MISMATCH', `${outside.join(', ')} fall outside the stated inclusive catalog window ${start}–${dateNow}; ${known.length - outside.length} of the ${ids.length} listed CVEs were added within it.`, index);
        if (known.length < ids.length) add('FACT_CVE_WINDOW_UNVERIFIED', 'Some listed CVEs have no captured addition date for the claimed catalog window.', index);
      }
    }
    if (new RegExp(String.raw`\b${number}\s+(?:(?:separate|distinct)\s+)?CVEs?\b.{0,110}\b(?:KEV|catalog)\b`, 'i').test(value)
      && !/[()]|\b(?:including|such as|for example)\b/i.test(value)) add('FACT_COUNT_SCOPE_UNVERIFIED', 'This catalog count has no closed entity list or explicit captured population/window. State the exact identities and inclusive dates, or leave the aggregate for editorial verification.', index, 'review');

    for (const absent of value.matchAll(/\b(?:no|without)\s+(?:supported\s+)?CVSS(?:\s+(?:score|rating))?\s+(?:(?:is|was)\s+)?(?:supported|available|recorded|provided|retained)\b/gi)) {
      const id = cves(value.slice(0, absent.index)).at(-1);
      if (!id) continue;
      const available = sourcesFor([id]).filter(source => source.quality?.substantive !== false && scoreFacts(body(source)).length);
      if (available.length) add('EVIDENCE_ABSENCE_CONTRADICTED', `${id} has an explicit CVSS value in captured evidence (${available.map(source => source.label).join(', ')}). Missing attribution in this paragraph does not establish unavailable evidence; cite the supplied record or omit the score without asserting absence.`, index, 'trust', available.map(source => source.id));
    }

    // Unambiguous numeric retrospective claims need a timing statement, not
    // merely an article publication timestamp. Actions/forecasts are separate.
    const retrospective = /\b(?:was|were|has been|had been)\s+(?:actively\s+)?(?:weaponized|exploited)\b.{0,90}\bwithin\s+(a|an|one|two|three|\d+)\s+(hours?|days?)\s+of\s+(?:public\s+)?disclosure\b/ig;
    for (const match of value.matchAll(retrospective)) {
      const signalStart = lines.slice(0, index + 1).findLastIndex(line => /^###\s+Signal\b/i.test(line));
      const endOffset = lines.slice(signalStart + 1).findIndex(line => /^###\s+Signal\b|^##\s/.test(line));
      const context = signalStart >= 0 ? lines.slice(signalStart, endOffset < 0 ? undefined : signalStart + 1 + endOffset).join('\n') : raw;
      const ids = cves(context);
      const cited = sourcesFor(ids).filter(source => source.url && context.includes(source.url));
      const interval = `${/^(?:a|an)$/i.test(match[1]) ? 'one' : match[1]} ${match[2]}`;
      const normalizedInterval = interval.replace(/s$/, '').replace(/^one /, '1 ');
      if (!cited.some(source => joins(body(source)).replace(/\ba day\b/g, '1 day').replace(/\bone day\b/g, '1 day').includes(normalizedInterval))) {
        add('FACT_EVENT_TIMELINE_UNSUPPORTED', `Retrospective disclosure-to-exploitation interval "${interval}" is not stated by this judgment's cited passages; keep disclosure, observation and catalog dates separate.`, index, 'trust', cited.map(source => source.id));
      }
    }

    if (/\b(?:independent publishers|independent outlets|independent sources)\b/i.test(value)
      && !records.some(record => record.independence?.verified === true)) add('SOURCE_INDEPENDENCE_UNESTABLISHED', 'Publisher count does not establish independent observations. Identify the original disclosure and each source contribution.', index, 'review');

    if (/Patch Tuesday/i.test(unit) && /\bonly a small fraction of disclosed CVEs\b|\b(?:confirmed active )?exploitation stays rare\b|\bvendors are shipping record patch volumes\b/i.test(value)) add('STATISTICAL_SCOPE_UNESTABLISHED', 'A monthly patch population from one publisher does not establish a trend across all vendors or all disclosed vulnerabilities. Preserve the measured population, period and denominator; review the broader inference.', index, 'review');

    if (/\b(?:audit|review|hunt|rotate|revoke|reset)\b.{0,100}\bsince\s+(?:\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i.test(value)
      && !/\b(?:lookback|assumption|basis|proposed|retention|earliest (?:known|possible))\b/i.test(value)) add('ACTION_LOOKBACK_BASIS_REQUIRED', 'This investigation start date needs an explicit lookback basis and retention/exposure assumptions; a disclosure or advisory date alone does not bound compromise.', index, 'review');

    if (/\b(?:deploy|hunt|monitor)\b.{0,100}\b(?:IOCs?|indicators)\b/i.test(value)
      && /—/.test(value) && !/\b(?:retrieve|obtain|verify|acquire|download|evidence\/artifact)\b/i.test(value)
      && !/\[[^\]]+\]\([^)]+\)/.test(raw)) add('ACTION_ARTIFACT_UNSPECIFIED', 'Detection work names indicators without a specific linked artifact or an initial retrieval/verification step.', index, 'review');
  }

  for (const entry of splitEntries(section(text, SECTIONS.keyJudgments))) {
    const at = Math.max(0, lines.findIndex(line => line === entry.split('\n')[0]));
    const ids = cves(entry);
    const cited = sourcesFor(ids).filter(source => source.url && entry.includes(source.url));
    const evidence = cited.map(body).join(' ');
    const actions = plain(rawField(entry, FIELDS.recommendedActions));
    if (/re-imag|re-deploy/i.test(evidence) && /TOTP/i.test(evidence) && /password/i.test(evidence)
      && (!/password/i.test(actions) || !/TOTP/i.test(actions))) add('ACTION_RECOVERY_INCOMPLETE', 'The cited recovery guidance includes password changes and TOTP reset after compromise; preserve the complete conditional recovery branch, including support-assisted review where the vendor recommends it.', at, 'review', cited.map(source => source.id));
    if (/review.{0,110}before.{0,30}(?:patch|hotfix)/i.test(plain(rawField(entry, 'Defender impact')))) {
      const actionLines = rawField(entry, FIELDS.recommendedActions).split('\n');
      const target = value => { const match = /recommended target\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})/i.exec(value); return match ? Date.parse(match[1]) : NaN; };
      const patch = actionLines.find(value => /apply.{0,45}(?:patch|hotfix)/i.test(value));
      const review = actionLines.find(value => /review.{0,55}logs/i.test(value));
      if (target(review) > target(patch)) add('ACTION_DEPENDENCY_CONFLICT', 'The stated prerequisite is log review before patching, but its target falls after the patch target. Resolve sequence, initiation and ownership explicitly.', at, 'trust');
    }
  }

  for (const name of [SECTIONS.developing, SECTIONS.watchlist]) {
    const content = section(text, name);
    for (const entry of name === SECTIONS.developing ? splitEntries(content) : content.split('\n').filter(line => /^[-*]\s/.test(line))) {
      if (!/\b(?:exploited|exploit|breach|PoC|zero-day|vulnerability|ransomware|CVE-\d)/i.test(entry)) continue;
      if (/\[[^\]]+\]\([^)]+\)/.test(entry)) continue;
      const first = entry.split('\n')[0].trim();
      const sectionStart = lines.findIndex(line => /^##\s/.test(line) && line.toUpperCase().includes(name));
      const index = lines.findIndex((line, at) => at > sectionStart && line.replace(/^###\s+/, '').trim() === first);
      add('SUPPORTING_SECTION_PROVENANCE_REQUIRED', `${name}: ${plain(first).slice(0, 120)} — link the captured source and date supporting this claim or watch condition.`, Math.max(0, index), 'review');
    }
  }
  return { issues, coverage: { schemaVersion: 1, scope: 'whole-document-supported-forms', checked: ['CVE identities and closed counts (including same-year slash shorthand)', 'listed KEV addition windows and remediation dates', 'explicit CVSS values and evidence-absence claims', 'explicit retrospective event intervals', 'citation identity and source access', 'bounded action dependencies and recovery omissions'],
    notEstablished: ['arbitrary natural-language entailment', 'source independence without provenance', 'statistical representativeness or population trends', 'local deployment and response sufficiency', 'forecast calibration and editorial prioritization'],
    editorialReviewStatus: 'not-reviewed', materialReviewRequired: issues.some(issue => issue.severity === 'review'), citationCount: allCitations.length } };
}

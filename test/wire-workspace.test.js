import { describe, expect, test } from '@jest/globals';
import { filterChips, scanIdentity, scanFacts, signalSeverity, signalAssessmentMeta, normalizeDecision, readDecisions, mergeDecisions, saveDecisionRecord, exportDecisionRecords, decisionForm, reflectDecisionDraft, exportContext, captureScrollAnchor } from '../public/modules/wire/wire-workspace.js';
import { parseWireQuery, serializeWireUrl, signalUrl, signalReadKey, isSignalRead, migrateLegacyReadKeys, filterSignals } from '../public/modules/wire/wire-format.js';

// Retained record identities from the live audit; values here exercise presentation,
// not any assertion about the underlying vulnerability's current threat status.
const chrome = { title: 'CISA Adds One Known Exploited Vulnerability to Catalog',
  link: 'https://www.cisa.gov/news-events/alerts/2026/09/04/cisa-adds-one-known-exploited-vulnerability-catalog',
  kevCVE: 'CVE-2026-85046', kevRecords: [{ cve: 'CVE-2026-85046', product: 'Chromium V8', vendor: 'Google' }],
  evidence: [{ sourceId: 'src_retained', revisionId: 'rev_selected', changed: true }],
  applicability: { matches: [{ term: 'Chrome', field: 'technologies' }] } };

describe('Wire workspace review state', () => {
  test('legacy read migration cannot silently re-read an update after its changed flag expires', () => {
    const legacy = new Set([chrome.link]);
    const migrated = migrateLegacyReadKeys([chrome], legacy);
    expect(migrated.has(chrome.link)).toBe(false);
    const sameRevision = { ...chrome, evidence: chrome.evidence.map(source => ({ ...source, changed: false })) };
    expect(isSignalRead(sameRevision, migrated)).toBe(false);
    expect(isSignalRead(sameRevision, migrateLegacyReadKeys([sameRevision], legacy))).toBe(true);
  });
  test('a new retained revision is unread, while the revision actually inspected stays read', () => {
    const old = { ...chrome, evidence: [{ sourceId: 'source-a', revisionId: 'rev-old' }] };
    const revised = { ...chrome, evidence: [{ sourceId: 'source-a', revisionId: 'rev-new', changed: true }] };
    const readKeys = new Set([signalReadKey(old), chrome.link]); // includes a legacy marker
    expect(isSignalRead(old, readKeys)).toBe(true);
    expect(filterSignals([revised], { changed: true, unread: true, readKeys })).toEqual([revised]);
    readKeys.add(signalReadKey(revised));
    expect(filterSignals([revised], { changed: true, unread: true, readKeys })).toEqual([]);
    expect(isSignalRead({ ...revised, evidence: [...revised.evidence].reverse() }, readKeys)).toBe(true);
  });
  test('saving from a stale tab preserves another tab’s unrelated and newer records', () => {
    let raw = '{}';
    const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
    const stale = new Map([['shared', normalizeDecision({ note: 'old', recordedAt: '2026-09-01T00:00:00Z' })]]);
    saveDecisionRecord(storage, new Map(), 'shared', { note: 'updated elsewhere', recordedAt: '2026-09-02T00:00:00Z' });
    saveDecisionRecord(storage, readDecisions(storage), 'off-feed', { note: 'retained older signal', recordedAt: '2026-09-02T01:00:00Z' });
    const result = saveDecisionRecord(storage, stale, 'new', { note: 'this tab', recordedAt: '2026-09-03T00:00:00Z' });
    expect(result.persisted).toBe(true);
    expect(readDecisions(storage).get('shared').note).toBe('updated elsewhere');
    expect(readDecisions(storage).get('off-feed').note).toBe('retained older signal');
    expect(mergeDecisions(stale, storage).get('new').note).toBe('this tab');
    expect(exportDecisionRecords(result.decisions).map(record => record.signal)).toEqual(expect.arrayContaining(['shared', 'off-feed', 'new']));
  });
  test('failed storage keeps the newer session decision recoverable in a complete export', () => {
    const storage = { getItem: () => '{}', setItem: () => { throw new Error('quota'); } };
    const result = saveDecisionRecord(storage, new Map(), 'https://example.test/expired', { note: 'cannot lose this', recordedAt: '2026-09-03T00:00:00Z' });
    expect(result.persisted).toBe(false);
    expect(exportDecisionRecords(mergeDecisions(result.decisions, storage))[0].decision.note).toBe('cannot lose this');
  });
  test('a stale form cannot replace the same decision after a cross-tab storage refresh', () => {
    let raw = '{}';
    const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
    const initial = saveDecisionRecord(storage, new Map(), chrome.link, { state: 'investigate', note: 'Old basis', recordedAt: '2026-09-03T00:00:00Z' });
    const base = initial.decisions.get(chrome.link);
    const latest = saveDecisionRecord(storage, readDecisions(storage), chrome.link, { state: 'affected', owner: 'Response team', note: 'Affected build confirmed', recordedAt: base.recordedAt });
    const mine = { state: 'unaffected', note: 'My unsaved investigation', recordedAt: '2026-09-03T00:01:00Z' };
    // The storage listener can refresh the map without updating the form's baseline.
    const refreshed = mergeDecisions(initial.decisions, storage);
    const conflict = saveDecisionRecord(storage, refreshed, chrome.link, mine, base);
    expect(conflict).toMatchObject({ persisted: false, conflict: true, existing: latest.decisions.get(chrome.link) });
    expect(readDecisions(storage).get(chrome.link).note).toBe('Affected build confirmed');
    const html = decisionForm(chrome, mine, { conflict: conflict.existing });
    expect(html).toContain('My unsaved investigation');
    expect(html).toContain('Affected build confirmed');
    expect(html).toContain('data-decision-draft-export');
    expect(html).toContain('class="btn-primary" disabled');
    const reviewed = saveDecisionRecord(storage, conflict.decisions, chrome.link, { ...mine, note: 'Reviewed and merged both investigations' }, conflict.existing);
    expect(reviewed.persisted).toBe(true);
    expect(readDecisions(storage).get(chrome.link).note).toBe('Reviewed and merged both investigations');
  });
  test('the 2001st decision cannot evict an unresolved assessment and existing records remain editable', () => {
    let raw = JSON.stringify(Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`signal-${index}`, normalizeDecision({ state: 'investigate', note: `Assessment ${index}`, recordedAt: '2026-09-03T00:00:00Z' })])));
    const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
    const before = raw;
    const full = saveDecisionRecord(storage, readDecisions(storage), 'signal-2000', { note: 'New draft' });
    expect(full).toMatchObject({ persisted: false, limitReached: true });
    expect(raw).toBe(before);
    expect(full.decisions.size).toBe(2000);
    expect(exportDecisionRecords(full.decisions)).toHaveLength(2000);
    expect(decisionForm(chrome, { note: 'New draft' }, full)).toContain('No saved assessment was removed');
    expect(decisionForm(chrome, { note: 'New draft' }, full)).toContain('data-decision-export-all');
    expect(saveDecisionRecord(storage, full.decisions, 'signal-0', { state: 'mitigated' }).persisted).toBe(true);
    expect(readDecisions(storage).get('signal-0').state).toBe('mitigated');
  });
  test('reading previously oversized local storage preserves all authored records for export', () => {
    const records = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`signal-${index}`, { note: `Record ${index}` }]));
    const decisions = readDecisions({ getItem: () => JSON.stringify(records) });
    expect(decisions.size).toBe(2001);
    expect(exportDecisionRecords(decisions)[0].decision.note).toBe('Record 0');
  });
  test('compact facts retain the scored CVE once, including enrichment-only and later identifiers', () => {
    const facts = scanFacts({ title: 'CVE-2026-1000 and CVE-2026-1001 advisory', cveDetails: ['CVE-2026-1002 · CVSS 9.8 (Critical)'] });
    expect(facts.cves).toEqual(['CVE-2026-1002', 'CVE-2026-1000']);
    expect(facts.remainingCves).toBe(1);
    expect(facts.severity.scope).toBe('CVE-2026-1002');
    expect(scanFacts({ title: 'Policy reporting' })).toMatchObject({ cves: [], remainingCves: 0, severity: { scope: '' } });
  });

  test('severity stays scoped to the scored CVE in multi-CVE reporting', () => {
    expect(signalSeverity({ cveData: 'CVE-2026-1000: no score · CVE-2026-1001: CVSS 9.8 (Critical) · CVE-2026-1002: CVSS 5.3 (Medium)' }))
      .toMatchObject({ label: 'Highest CVSS severity', value: '9.8 Critical · version not recorded · authority not recorded', scope: 'CVE-2026-1001', level: 'critical' });
    expect(signalSeverity({ cveData: 'CVE-2026-1000: CVSS 4.0 9.3 (Critical)' })).toMatchObject({ value: '9.3 Critical · v4.0 · authority not recorded', scope: 'CVE-2026-1000' });
    expect(signalSeverity({ cveDetails: ['CVE-2026-1000: CVSS 0.0 (None)'] })).toMatchObject({ value: '0.0 None · version not recorded · authority not recorded' });
  });
  test('ranking, source count and collection times cannot manufacture severity, confidence or publication dates', () => {
    const headline = { source: 'Publisher', link: 'https://example.test/report', score: 98, corroboration: 5, isKEV: true,
      dateUnknown: true, date: '2026-09-06T12:00:00Z', evidence: [{ retrievedAt: '2026-09-06T12:00:00Z' }] };
    expect(signalSeverity(headline)).toMatchObject({ value: 'Not available', scope: '' });
    const html = signalAssessmentMeta(headline);
    expect(html).toContain('Assessment confidence');
    expect(html).toContain('Not assessed');
    expect(html).not.toContain('<time');
    expect(html).not.toContain('data-level');
    expect(html).toContain('https://example.test/report');
  });
  test('filter count treats comma-containing queries as one condition and includes hidden/sort', () => {
    expect(filterChips({ horizon: 'all', q: 'Chrome, V8', hidden: true }, 'newest').map(chip => chip.key)).toEqual(['hidden', 'q', 'sort']);
  });
  test('catalog identity remains visible despite an administrative source title', () => {
    expect(scanIdentity(chrome)).toEqual({ product: 'Chromium V8', cves: ['CVE-2026-85046'] });
  });
  test('an explicitly unknown affected product does not fall back to a research publisher mention', () => {
    const report = { title: 'Financially Motivated Threat Actor BREEZE COMET Targets Brazil',
      source: 'Google Threat Intelligence', vendors: ['Google'], editorialContext: { product: null } };
    expect(scanIdentity(report)).toEqual({ cves: [], product: '' });
    // Legacy responses without the product-assessment contract retain their
    // existing presentation path while current responses honor explicit unknowns.
    expect(scanIdentity({ ...report, editorialContext: undefined }).product).toBe('Google');
  });
  test('multi-product catalog announcements keep a bounded scan identity while preserving every record', () => {
    const records = ['Chromium V8', 'Exchange Server', 'Windows'].map((product, index) => ({ product, cve: `CVE-2026-${85046 + index}` }));
    const item = { ...chrome, kevRecords: records, editorialContext: { product: 'Chromium V8, Exchange Server, Windows' } };
    expect(scanIdentity(item)).toEqual({ product: 'Chromium V8 · Exchange Server +1 products', cves: ['CVE-2026-85046', 'CVE-2026-85047', 'CVE-2026-85048'] });
    expect(item.kevRecords).toEqual(records);
  });
  test('exact source/revision links round trip without losing an encoded signal URL', () => {
    const url = signalUrl(chrome, 'https://desk.example', chrome.evidence[0]);
    const params = parseWireQuery(new URL(url).search);
    expect(params).toMatchObject({ signal: chrome.link, source: 'src_retained', revision: 'rev_selected' });
    expect(new URL(serializeWireUrl(params), 'https://desk.example').searchParams.get('revision')).toBe('rev_selected');
    expect(parseWireQuery('?source=%3Cscript%3E&revision=../../wrong')).not.toHaveProperty('source');
  });
  test('question matches enter Watch without becoming declared exposure matches', () => {
    const question = { ...chrome, applicability: { state: 'unknown', questionMatches: [{ question: 'Chrome mitigation changes' }] } };
    expect(filterSignals([question], { watch: true })).toEqual([question]);
    expect(question.applicability.state).toBe('unknown');
  });
  test('local outcome normalization bounds untrusted imported records and does not invent an assessment', () => {
    expect(normalizeDecision({ state: 'confirmed-compromise', owner: 'A'.repeat(150), nextReview: 'tomorrow' })).toMatchObject({ state: 'unreviewed', owner: 'A'.repeat(100), nextReview: '' });
    expect(readDecisions({ getItem: () => '{broken' }).size).toBe(0);
    expect(readDecisions({ getItem: () => JSON.stringify({ [chrome.link]: { state: 'unaffected', note: 'Version checked' } }) }).get(chrome.link).state).toBe('unaffected');
    expect(decisionForm(chrome, { note: '<script>alert(1)</script>' })).toContain('&lt;script&gt;');
  });
  test('unsaved inline/inspector values survive switching the visible responsive form without overwriting other signals', () => {
    const form = (key, values) => {
      const fields = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]));
      return { dataset: { decisionForm: key }, fields, elements: { namedItem: name => fields[name] } };
    };
    const initial = { state: 'unreviewed', owner: '', nextReview: '', note: '', evidence: '' };
    const inline = form(chrome.link, initial), inspector = form(chrome.link, initial), other = form('another-signal', initial);
    const edit = { state: 'investigate', owner: 'Endpoint team', nextReview: '2026-09-07', note: 'Versions still under review', evidence: 'local ticket 42' };
    reflectDecisionDraft([inline, inspector, other], chrome.link, edit, inspector);
    expect(Object.fromEntries(Object.entries(inline.fields).map(([name, field]) => [name, field.value]))).toEqual(edit);
    expect(other.fields.note.value).toBe('');
    const continued = { ...edit, note: 'Inventory checked; mitigation pending' };
    reflectDecisionDraft([inline, inspector, other], chrome.link, continued, inline);
    expect(inspector.fields.note.value).toBe(continued.note);
    expect(other.fields.state.value).toBe('unreviewed');
  });
  test('handoff export carries decision evidence and exact selection context without mutating the source', () => {
    const decision = { state: 'investigate', note: 'Browser versions pending check', owner: 'Endpoint team', evidence: 'local ticket 42', nextReview: '2026-09-07', recordedAt: '2026-09-06T04:00:00Z' };
    const exported = exportContext(chrome, { decision, filters: { changed: true }, sort: 'newest', origin: 'https://desk.example', capturedAt: '2026-09-06T04:00:00Z' });
    expect(exported.decision).toEqual(decision);
    expect(exported.retainedSourceChanged).toBe(true);
    expect(JSON.parse(exported.filterDefinition)).toEqual({ changed: true, sort: 'newest' });
    expect(new URL(exported.evidenceLinks[0]).searchParams.get('revision')).toBe('rev_selected');
    expect(chrome).not.toHaveProperty('decision');
  });
  test('scroll anchoring selects a visible story beneath the sticky controls', () => {
    const rows = [{ dataset: { key: 'above' }, getBoundingClientRect: () => ({ top: -40, bottom: 20 }) },
      { dataset: { key: 'reading' }, getBoundingClientRect: () => ({ top: 90, bottom: 160 }) }];
    expect(captureScrollAnchor({ querySelectorAll: () => rows }, 100)).toEqual({ key: 'reading', top: 90 });
  });
});

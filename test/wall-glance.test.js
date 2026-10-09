import { describe, expect, test } from '@jest/globals';
import { buildGlanceModel, buildPresentationPages, displayDwellMs, presentationReadingText } from '../public/modules/wall/wall-presentation.js';

describe('Wall glance projection', () => {
  test('projects authored judgment copy and response context without detaching a procedure from its conditions', () => {
    const actions = [
      { owner: 'Infrastructure', imperative: 'Apply the fix.', condition: 'Only if the vulnerable feature is deployed.', recoverySteps: 'Restore only after compromise checks.' },
      { owner: 'Infrastructure', imperative: 'Verify recovery.', completionCriterion: 'Retain an evidence record.' },
      { owner: 'Incident response', imperative: 'Investigate compromise.', dependencies: 'Obtain authorization.' },
    ];
    const original = JSON.stringify(actions);
    const page = { kind: 'judgment', topic: 'Gateway exposure needs verification', block: { text: 'Exploitation is reported; local applicability remains unresolved.' },
      actions, decision: 'Current shift', editionDate: '2026-10-09', certainty: 'High — official reporting supports the assessment.',
      cve: 'CVE-2026-12345', isKEV: true };
    const model = buildGlanceModel(page);
    expect(model).toEqual({
      label: 'Key judgment', headline: page.topic, summary: page.block.text, summaryLabel: 'The takeaway', railLabel: 'Response brief',
      facts: [
        { label: 'Response owners', value: 'Infrastructure · Incident response' },
        { label: 'Decision window', value: 'This shift · from 2026-10-09 briefing' },
        { label: 'Confidence', value: 'High' },
        { label: 'CISA KEV', value: 'CVE-2026-12345' },
      ], related: [],
    });
    for (const action of actions) expect(JSON.stringify(model)).not.toContain(action.imperative);
    expect(JSON.stringify(model)).not.toContain(actions[0].condition);
    expect(page.actions).toBe(actions);
    expect(JSON.stringify(actions)).toBe(original);
  });

  test('keeps likelihood distinct from confidence and ignores missing or non-string decision windows', () => {
    for (const decision of ['', '   ', null, 42, {}]) {
      const model = buildGlanceModel({ kind: 'judgment', decision, certainty: 'Likely (55–80%) — reporting indicates an increase.' });
      expect(model.facts).toEqual([{ label: 'Likelihood', value: 'Likely (55–80%)' }]);
    }
    expect(buildGlanceModel({ kind: 'judgment', cve: 'CVE-2026-12345', isKEV: false }).facts).toEqual([]);
  });

  test('judgment CVE references remain visible without implying known exploitation', () => {
    const page = { kind: 'judgment', cves: ['CVE-2026-12345', 'cve-2026-12345', 'CVE-2026-67890', 'CVE-2026-123', 'prefix CVE-2026-99999', 'CVE-2026-99999 suffix', null], isKEV: false };
    expect(buildGlanceModel(page).facts).toEqual([{ label: 'Referenced CVEs', value: 'CVE-2026-12345 · CVE-2026-67890' }]);
    expect(presentationReadingText(page)).not.toMatch(/CISA|KEV|exploitation/);
    expect(buildGlanceModel({ kind: 'judgment', cves: ['CVE-2026-12345'] }).facts).toEqual([{ label: 'Referenced CVE', value: 'CVE-2026-12345' }]);
    expect(buildGlanceModel({ kind: 'judgment', cves: ['CVE-2026-123', 'not an ID'] }).facts).toEqual([]);
    expect(buildGlanceModel({ kind: 'judgment', cves: 'CVE-2026-12345' }).facts).toEqual([]);
  });

  test('judgment catalog identities are not repeated as ordinary CVE references', () => {
    const page = { kind: 'judgment', isKEV: true, cve: 'CVE-2026-12345', catalogEntries: [{ cve: 'CVE-2026-67890' }],
      cves: ['cve-2026-12345', 'CVE-2026-67890', 'CVE-2026-99999', 'CVE-2026-99999'] };
    expect(buildGlanceModel(page).facts).toEqual([
      { label: 'CISA KEV', value: 'CVE-2026-12345 · CVE-2026-67890' },
      { label: 'Referenced CVE', value: 'CVE-2026-99999' },
    ]);
    expect(buildGlanceModel({ ...page, cves: ['CVE-2026-12345', 'CVE-2026-67890'] }).facts).toEqual([
      { label: 'CISA KEV', value: 'CVE-2026-12345 · CVE-2026-67890' },
    ]);
  });

  test('cover uses the lead short copy, then a matching reviewed summary, without replacing the saved BLUF', () => {
    const doc = { bluf: 'The complete authored BLUF remains available in the reading copy.', stories: [
      { title: 'Lead assessment', line: 'The lead has a short authored line.' },
      { title: 'Second assessment', line: 'Second short line.' },
    ] };
    const first = buildPresentationPages(doc, {})[0];
    expect(buildGlanceModel(first)).toMatchObject({ headline: 'Lead assessment', summary: doc.stories[0].line,
      railLabel: 'Also in this briefing', related: ['Second assessment'] });
    expect(first.block.text).toBe(doc.bluf);
    doc.review = { presentation: { status: 'reviewed', bluf: 'Reviewed BLUF.', judgments: [
      { index: 0, originalTitle: 'Lead assessment', title: 'Reviewed lead', summary: 'Reviewed short line.' },
    ] } };
    expect(buildGlanceModel(buildPresentationPages(doc, {})[0])).toMatchObject({ headline: 'Reviewed lead', summary: 'Reviewed short line.' });
    doc.review.presentation.judgments[0].originalTitle = 'A different assessment';
    expect(buildGlanceModel(buildPresentationPages(doc, {})[0]).summary).toBe(doc.stories[0].line);
    delete doc.stories[0].line;
    expect(buildGlanceModel(buildPresentationPages(doc, {})[0]).summary).toBe('Reviewed BLUF.');
    doc.review.presentation.status = 'unavailable';
    expect(buildGlanceModel(buildPresentationPages(doc, {})[0]).summary).toBe(doc.bluf);
  });

  test('developing keeps every qualification while leaving its full watch task list in the reading record', () => {
    const summary = 'A title-only report alleges exploitation. It does not identify the flaw or establish that the separate cataloged CVE is involved.';
    const page = { kind: 'developing', topic: 'Separate report requires verification', trajectory: 'Uncertain', block: { text: summary },
      condition: 'Retrieve the authoritative advisory and complete the full local inventory checklist.' };
    expect(buildGlanceModel(page)).toMatchObject({ label: 'Developing situation', summary, railLabel: 'Tracking',
      facts: [] });
    expect(presentationReadingText(page)).not.toContain(page.condition);
    expect(page.condition).toContain('full local inventory checklist');
    expect(page.trajectory).toBe('Uncertain');
    expect(presentationReadingText(page)).toContain(summary);
    expect(presentationReadingText(page)).not.toContain('Tracking');
  });

  test.each(['Uncertain', ' uncertain ', 'UNCERTAIN'])('Developing omits only the redundant %s state from passive facts', trajectory => {
    const page = { kind: 'developing', trajectory, block: { text: 'Direction is uncertain because the retained report lacks technical scope.' } };
    expect(buildGlanceModel(page).facts).toEqual([]);
    expect(buildGlanceModel(page).summary).toBe(page.block.text);
    expect(page.trajectory).toBe(trajectory);
  });

  test.each(['Accelerating', 'Decelerating', 'Inflecting', 'Stalled', 'Unchanged'])('Developing retains the informative %s fact without a standalone rail title', trajectory => {
    const page = { kind: 'developing', trajectory, block: { text: 'The complete qualified assessment remains visible.' } };
    expect(buildGlanceModel(page).facts).toEqual([{ label: 'Trajectory', value: trajectory }]);
    expect(presentationReadingText(page)).toContain(`Trajectory ${trajectory}`);
    expect(presentationReadingText(page)).not.toContain('Tracking');
  });

  test('convergence uses the full authored intersection as an explicitly labeled hypothesis', () => {
    const item = { title: 'Potential interaction', intersection: 'These reports could interact only if both deployment conditions hold.',
      cascade: 'The longer cascade is preserved in the saved record.', move: 'Prepare a conditional response.', confirmation: 'Verify both conditions.' };
    const page = buildPresentationPages({ convergence: [item] }, {})[0];
    expect(buildGlanceModel(page)).toMatchObject({ label: 'Analyst hypothesis', headline: item.title, summary: item.intersection, facts: [] });
    expect(page.block.text).toBe(item.cascade);
    expect(page.actions[0].imperative).toBe(item.move);
    expect(presentationReadingText(page)).not.toContain(item.move);
  });

  test('KEV leads with the complete vulnerability name and keeps catalog facts and civilian deadline scope', () => {
    const page = buildPresentationPages(null, { kev: { recent: [{ cve: 'CVE-2026-12345', vendor: 'Vendor', product: 'Gateway',
      name: 'Gateway command injection', dateAdded: '2026-10-08', dueDate: '2026-10-29', requiredAction: 'Follow the full catalog action.' }] } })[0];
    expect(buildGlanceModel(page)).toMatchObject({ label: 'Known exploitation', headline: 'Gateway command injection', summary: '', summaryLabel: '',
      railLabel: 'Catalog record', facts: [
        { label: 'CVE', value: 'CVE-2026-12345' },
        { label: 'Catalog added', value: '2026-10-08' },
        { label: 'Federal civilian deadline', value: '2026-10-29 · FCEB scope' },
      ] });
    expect(page.condition).toBe('Follow the full catalog action.');
    expect(page.block.text).toBe('Gateway command injection');
    expect(page.productIdentity).toBe('Vendor Gateway');
    const longName = 'Vendor Gateway vulnerability affecting the administrator interface permits command injection only in a specified legacy deployment configuration';
    expect(buildGlanceModel({ ...page, block: { text: longName } }).headline).toBe(longName);
    expect(buildGlanceModel({ ...page, block: { text: '' } })).toMatchObject({ headline: 'Vendor Gateway', summary: '', summaryLabel: '' });
    expect(buildGlanceModel({ kind: 'kev', topic: 'Saved product: known exploitation' })).toMatchObject({ headline: 'Saved product', summary: '' });
  });

  test('Wire preserves complete excerpt text and needs an explicit verified CVE for the catalog marker', () => {
    const excerpt = 'The report describes a published exploit. It does not establish exploitation in the wild.';
    const page = { kind: 'wire', topic: 'Exploit disclosure', sourceExcerpt: excerpt, source: 'The Publisher',
      cve: 'CVE-2026-12345', isKEV: false, catalogEntries: [{ cve: 'CVE-2026-12345' }] };
    expect(buildGlanceModel(page)).toMatchObject({ label: 'Source reporting', summary: excerpt,
      facts: [] });
    expect(buildGlanceModel({ ...page, isKEV: true }).facts).toContainEqual({ label: 'CISA KEV', value: 'CVE-2026-12345' });
    expect(buildGlanceModel({ ...page, isKEV: true, cve: '' }).facts).toEqual([]);
    expect(page.source).toBe('The Publisher');
    expect(presentationReadingText({ ...page, isKEV: true })).not.toContain('Report context');
    const missing = buildPresentationPages(null, { signals: [{ title: 'Headline without a retained excerpt', source: 'The Publisher' }] })[0];
    expect(buildGlanceModel(missing)).toMatchObject({ label: 'Headline only', headline: missing.topic, summary: '', summaryLabel: '' });
    expect(buildGlanceModel({ kind: 'wire', block: { text: 'A complete retained excerpt is unavailable.' } }).summary).toBe('');
  });

  test('watchlist and executive fallback preserve complete authored text and dated context', () => {
    const watch = { kind: 'watchlist', topic: 'Watch condition', block: { text: 'Escalate only if the named condition is confirmed; otherwise keep monitoring.' }, validity: 'Through October 12, 2026' };
    expect(buildGlanceModel(watch)).toMatchObject({ label: 'Watch for', headline: watch.block.text, summary: '', summaryLabel: '', facts: [{ label: 'Watch validity', value: watch.validity }] });
    const executive = { kind: 'execsummary', topic: 'Exposure', block: { text: 'The authored fallback has no shorter approved substitute.' }, timing: 'recommended target October 12, 2026' };
    expect(buildGlanceModel(executive)).toMatchObject({ label: 'Executive summary · Exposure', headline: executive.block.text, summary: '', summaryLabel: '', facts: [{ label: 'Recommended target', value: 'October 12, 2026' }] });
  });

  test('executive fallback promotes only the entire short authored takeaway and preserves longer qualified copy', () => {
    const short = 'Reported attempts do not confirm compromise.';
    const page = { kind: 'execsummary', topic: 'Threat', block: { text: short } };
    expect(buildGlanceModel(page)).toMatchObject({ label: 'Executive summary · Threat', headline: short, summary: '', summaryLabel: '' });
    expect(page.block.text).toBe(short);
    const long = 'A reported exploit requires technical verification before it can support any conclusion about affected local systems, exposed configurations, or successful compromise in this environment.';
    expect(buildGlanceModel({ ...page, block: { text: long } })).toMatchObject({ label: 'Executive summary', headline: 'Threat', summary: long, summaryLabel: 'The takeaway' });
    expect(buildGlanceModel({ ...page, block: { text: '   ' } })).toMatchObject({ label: 'Executive summary', headline: 'Threat', summary: '   ' });
  });

  test('Watchlist promotes the conditional trigger while retaining every qualification in Context', () => {
    const trigger = 'The vendor changes its advisory after additional attempts are reported.';
    const qualification = 'Reported attempts do not confirm compromise. Verify the original report before escalating the response.';
    const text = `${trigger}\n\n${qualification}`;
    const page = { kind: 'watchlist', topic: 'Watch condition', block: { text } };
    const model = buildGlanceModel(page);
    expect(model).toMatchObject({ label: 'Watch for', headline: trigger, summary: qualification, summaryLabel: 'Context' });
    expect(`${model.headline} ${model.summary}`).toBe(text.replace(/\s+/g, ' '));
    expect(page.block.text).toBe(text);
    expect(presentationReadingText(page)).toContain('Reported attempts do not confirm compromise.');
  });

  test('Watchlist promotion keeps abbreviations with the complete opening sentence', () => {
    const trigger = 'The U.S. agency publishes an updated advisory.';
    const tail = 'An update alone would not establish affected local exposure.';
    expect(buildGlanceModel({ kind: 'watchlist', topic: 'Watch condition', block: { text: `${trigger} ${tail}` } })).toMatchObject({
      headline: trigger, summary: tail, summaryLabel: 'Context',
    });
  });

  test.each([
    `Only if ${'the full qualified deployment condition '.repeat(10)}is verified. Additional evidence is still required.`,
    'Vendor advisory changes remain unconfirmed',
    'Incomplete retained lead... A later complete sentence must not replace the opening.',
    'The post says an update appeared first on the vendor site.',
  ])('Watchlist keeps the full body when no safe bounded opening exists: %s', text => {
    expect(buildGlanceModel({ kind: 'watchlist', topic: 'Watch condition', block: { text } })).toMatchObject({
      label: 'Watch for', headline: 'Watch condition', summary: text, summaryLabel: 'Watch condition',
    });
  });

  test('dwell depends only on visible model copy and grows for long unshortened qualifications', () => {
    const page = { kind: 'judgment', topic: 'Gateway exposure', block: { text: 'Verify the deployment before deciding on a response.' }, actions: [{ owner: 'SOC', imperative: 'Do the full procedure.' }] };
    const before = presentationReadingText(page);
    page.actions[0].recoverySteps = 'Hidden procedure detail. '.repeat(500);
    expect(presentationReadingText(page)).toBe(before);
    expect(displayDwellMs(before)).toBeLessThan(20_000);
    const qualified = 'Every qualification remains part of this authored assessment. '.repeat(30);
    const longPage = { kind: 'developing', topic: 'Qualified report', block: { text: qualified }, trajectory: 'Uncertain' };
    expect(buildGlanceModel(longPage).summary).toBe(qualified);
    expect(presentationReadingText(longPage)).toContain(qualified);
    expect(displayDwellMs(presentationReadingText(longPage))).toBeGreaterThan(60_000);
  });

  test('dwell counts rail titles only for multiple facts or related stories', () => {
    const oneFact = { kind: 'judgment', topic: 'Topic', block: { text: 'Saved assessment.' }, certainty: 'High' };
    expect(presentationReadingText(oneFact)).toContain('Confidence High');
    expect(presentationReadingText(oneFact)).not.toContain('Response brief');
    expect(presentationReadingText({ ...oneFact, decision: 'Current shift' })).toContain('Response brief');
    expect(presentationReadingText({ kind: 'bluf', coverTitle: 'Lead', priorities: ['Related story'] })).toContain('Also in this briefing');
  });
});

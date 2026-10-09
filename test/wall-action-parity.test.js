import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { parseBrief, parseRecommendedActions } from '../lib/brief-schema.js';
import { buildPresentationPages, buildGlanceModel, normalizeDisplaySettings, splitDisplayText, completeSourceExcerpt, topicKey } from '../public/modules/wall/wall-presentation.js';
import { wallDocumentHtml, wallActionHtml } from '../public/modules/wall/wall-actions.js';
import { judgmentHtml, presentationHtml } from '../public/modules/wall/wall-view.js';
import { escapeHtml } from '../public/modules/core/sanitize.js';

// Immutable retained publication: renderer parity does not endorse its analysis.
const retained = JSON.parse(fs.readFileSync(new URL('./fixtures/retained-briefing-2026-09-06.json', import.meta.url), 'utf8'));
const original = retained.content;
const receipt = JSON.parse(fs.readFileSync(new URL('./fixtures/retained-feed-2026-09-05.json', import.meta.url), 'utf8'));
const doc = { ...parseBrief(original), date: '2026-09-06', filename: 'brief-2026-09-06-01.md' };

describe('retained September 6 action parity', () => {
  test('preserves all ten authored owner/imperative/target records, including unlabelled Act-now actions', () => {
    expect(doc.actions).toHaveLength(10);
    expect(new Set(doc.actions.map(action => action.id)).size).toBe(10);
    expect(doc.actions.map(action => action.owner)).toEqual(['Infrastructure', 'Detection engineering', 'Infrastructure', 'Incident response', 'Infrastructure', 'Detection engineering', 'Application security', 'Infrastructure', 'Detection engineering', 'Detection engineering']);
    expect(doc.actions.every(action => action.target && action.targetType === 'recommended')).toBe(true);
    expect(doc.actions[6]).toMatchObject({ owner: 'Application security', condition: 'if Artifactory deployed', target: 'September 9, 2026' });
    expect(doc.actions[6].imperative).toContain('audit all admin tokens issued since 2026-08-28');
    expect(doc.actions[3].imperative).toBe('review appliance logs for pre-patch admin/API access; re-image if compromise indicators found');
    expect(doc.stories.flatMap(story => story.actions)).toEqual(doc.actions);
  });
  test('all authored action data remains available behind one display topic at every text size', () => {
    for (const size of ['standard', 'large', 'largest']) {
      const pages = buildPresentationPages(doc, {}, normalizeDisplaySettings({ size }));
      const featured = pages.filter(page => page.kind === 'judgment');
      expect(featured.flatMap(page => page.actions).map(action => action.id)).toEqual(doc.actions.map(action => action.id));
      for (const page of featured) {
        expect(page.block.text).toBe(doc.stories[page.idx].line || doc.stories[page.idx].assessment);
        expect(page.actions.length).toBeGreaterThan(0);
      }
      const sonic = featured.filter(page => page.idx === 1);
      expect(new Set(sonic.map(topicKey)).size).toBe(1);
      expect(sonic.flatMap(page => page.actions).map(action => action.imperative).join(' ')).toContain('re-image if compromise indicators found');
      expect(pages.some(page => page.kind === 'execsummary')).toBe(false);
      expect(featured).toHaveLength(doc.stories.length);
      expect(featured.every(page => page.parts === 1)).toBe(true);
    }
  });
  test('All actions retains every imperative, target, convergence rationale and watch expiry', () => {
    const html = wallDocumentHtml(doc);
    for (const action of doc.actions) {
      expect(html).toContain(`data-action-id="${action.id}"`);
      expect(html).toContain(action.target);
      expect(html).toContain(action.imperative);
    }
    expect(html).toContain(doc.convergence[0].confirmation);
    expect(html).toContain(doc.convergence[0].actionRationale);
    expect(doc.convergence[0].citations).toHaveLength(2);
    expect(html).toContain('href="https://www.rapid7.com/blog/post/etr-critical-sonicwall-sma1000-vulnerabilities-cve-2026-83548-cve-2026-83549-exploited-in-the-wild"');
    expect(doc.watchlistMetadata.validThrough).toBe('2026-09-09');
    expect(html).toContain('Through 2026-09-09');
    expect(html).toContain(' · 1 action</a>');
    expect(html).not.toContain(' · 1 actions</a>');
    expect(wallDocumentHtml({ ...doc, review: { status: 'editorially-corrected', reviewer: 'Editorial review' } })).not.toMatch(/·\s*·/);
    const reviewed = wallDocumentHtml({ ...doc, originalWarnings: ['Original generation finding.'], review: { status: 'editorially-corrected', reviewer: 'AI-assisted editorial review', scope: 'Retained sources only; no local deployment knowledge.', originalSha256: 'original-digest' } });
    expect(reviewed).toContain('Edition record');
    expect(reviewed).toContain('Original publication notes');
    expect(reviewed).toContain('Retained sources only; no local deployment knowledge.');
    expect(reviewed).toContain('original-digest');
    expect(reviewed).toContain('Original generation finding.');
  });
  test('reading renders every action while display renders the headline, takeaway and selected facts', () => {
    const operator = doc.stories.map(story => judgmentHtml(story, doc.date)).join('');
    const pages = buildPresentationPages(doc, {});
    const originalPages = JSON.stringify(pages);
    const television = pages.map(page => presentationHtml(page, { interactive: false })).join('');
    for (const action of doc.actions) {
      expect(operator).toContain(`data-action-id="${action.id}"`);
      expect(operator).toContain(escapeHtml(action.imperative));
      expect(television).not.toContain(`data-action-id="${action.id}"`);
      expect(television).not.toContain(escapeHtml(action.imperative));
    }
    for (const page of pages.filter(page => page.kind === 'judgment')) {
      const glance = buildGlanceModel(page);
      const html = presentationHtml(page, { interactive: false });
      const visible = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      expect(glance.headline).toBe(doc.stories[page.idx].title);
      expect(html).toContain(escapeHtml(glance.headline));
      if (glance.summary) expect(html).toContain(escapeHtml(glance.summary));
      for (const fact of glance.facts) {
        expect(visible).toContain(escapeHtml(fact.label));
        expect(visible).toContain(escapeHtml(fact.value));
      }
    }
    expect(JSON.stringify(pages)).toBe(originalPages);
    expect(television).not.toContain('nb-response-context');
    expect(television).not.toContain('All actions and source context');
  });
  test('known-bad and superseded editions never enter the automatic composition', () => {
    for (const disposition of [{ status: 'review-required' }, { status: 'superseded' }, { eligibleForLatest: false }]) {
      const pages = buildPresentationPages({ ...doc, disposition }, {});
      expect(pages).toEqual([{ kind: 'briefexcluded' }]);
    }
    expect(buildPresentationPages({ ...doc, disposition: { status: 'eligible', editorialReviewStatus: 'not-reviewed' } }, {}).some(page => page.kind === 'judgment')).toBe(true);
  });
  test('reviewed procedures remain complete in reading while the TV omits detailed instructions', () => {
    const reviewed = parseBrief(fs.readFileSync(new URL('./fixtures/retained-reviewed-brief-2026-09-06.md', import.meta.url), 'utf8'));
    expect(reviewed.actions).toHaveLength(11);
    expect(reviewed.actions.every(action => action.owner && action.imperative && action.target)).toBe(true);
    expect(reviewed.actions.every(action => action.completionCriterion)).toBe(true);
    expect(reviewed.actions.map(action => action.target)).toEqual([
      'September 6, 2026', 'September 7, 2026', 'September 6, 2026',
      'September 6, 2026', 'September 7, 2026', 'September 6, 2026',
      'September 7, 2026', 'September 6, 2026', 'September 7, 2026',
      'September 6, 2026', 'September 6, 2026',
    ]);
    expect(reviewed.actions[2].dependencies).toContain('unmanaged/BYOD');
    expect(reviewed.actions[4].evidence).toContain('explicit indicator gap');
    expect(reviewed.actions[4].completionCriterion).toContain('exposure/retention-based lookback');
    const recovery = reviewed.actions.find(action => action.recoverySteps);
    expect(recovery.owner).toBe('Incident response');
    expect(recovery.condition).toBe('affected, potentially exposed appliances');
    expect(recovery.recoverySteps).toContain('reimage hardware or redeploy virtual appliances, change all user/admin passwords and reset TOTP tokens');
    expect(recovery.completionCriterion).toContain('keep unfinished investigation open');
    const reading = wallDocumentHtml(reviewed);
    const operator = reviewed.stories.map(story => judgmentHtml(story, reviewed.date)).join('');
    for (const action of reviewed.actions) {
      expect(reading).toContain(`data-action-id="${action.id}"`);
      expect(operator).toContain(`data-action-id="${action.id}"`);
      for (const field of ['imperative', 'condition', 'dependencies', 'initiationTrigger', 'evidence', 'completionCriterion', 'recoverySteps']) {
        if (!action[field]) continue;
        expect(reading).toContain(escapeHtml(action[field]));
        expect(operator).toContain(escapeHtml(action[field]));
      }
    }
    for (const size of ['standard', 'large', 'largest']) {
      const pages = buildPresentationPages(reviewed, {}, normalizeDisplaySettings({ size }));
      const featured = pages.filter(page => page.kind === 'judgment').flatMap(page => page.actions);
      expect(featured.map(action => action.id)).toEqual(reviewed.actions.map(action => action.id));
      const passive = pages.map(page => presentationHtml(page, { interactive: false })).join('');
      expect(passive).not.toMatch(/<(?:a|button|select|nav)\b/);
      expect(passive).not.toContain('All actions and source context');
      expect(passive).not.toContain('data-action-id=');
      expect(passive).not.toContain(escapeHtml(recovery.recoverySteps));
      expect(passive).not.toContain(escapeHtml(reviewed.actions[2].dependencies));
      for (const story of reviewed.stories) {
        expect(passive).toContain(escapeHtml(story.title));
        expect(passive).toContain(escapeHtml(story.line));
      }
    }
  });
  test('identities survive reordering while authored optional action context stays exact', () => {
    const first = doc.actions[0];
    const second = doc.actions[1];
    const block = `**Recommended actions:**\n- ${first.markdown}\n- ${second.markdown}`;
    const before = parseRecommendedActions(block, { judgmentId: first.judgmentId });
    const after = parseRecommendedActions(`**Recommended actions:**\n- ${second.markdown}\n- ${first.markdown}`, { judgmentId: first.judgmentId });
    expect(after.map(action => action.id)).toEqual(before.map(action => action.id).reverse());
    const extended = parseRecommendedActions(`**Recommended actions:**\n- ${first.markdown}\n  **Condition:** Managed Chrome is deployed.\n  **Dependencies:** Confirm the managed endpoint inventory.\n  **Initiation:** Begin version verification this shift.\n  **Evidence/artifact:** Retain the version inventory.\n  **Completion criterion:** No affected version remains in scope.\n  **Recovery:** Recheck failed managed updates.`, { judgmentId: first.judgmentId })[0];
    expect(extended).toMatchObject({ imperative: first.imperative, dependencies: 'Confirm the managed endpoint inventory.', initiationTrigger: 'Begin version verification this shift.', evidence: 'Retain the version inventory.', completionCriterion: 'No affected version remains in scope.', recoverySteps: 'Recheck failed managed updates.' });
    const html = wallActionHtml(extended, { compact: true });
    expect(html).toContain(extended.recoverySteps);
    expect(html).toContain(extended.condition);
    expect(html).toContain(extended.evidence);
    const wrapped = parseRecommendedActions(`**Recommended actions:**\n- ${first.markdown}\n  **Recovery:** Recheck failed managed updates\n  before closing the deployment verification task.`, { judgmentId: first.judgmentId })[0];
    expect(wrapped.recoverySteps).toBe('Recheck failed managed updates before closing the deployment verification task.');
    expect(wrapped.imperative).toBe(first.imperative);
    const inline = parseRecommendedActions(`**Recommended actions:**\n- **Act now:** ${first.owner} — ${first.imperative}; **Initiation:** Begin verification now; retain the inventory; **Condition:** Managed Chrome is deployed; **Completion criterion:** No affected version remains in scope; **Recovery:** Recheck failed managed updates — recommended target ${first.target}.`, { judgmentId: first.judgmentId })[0];
    expect(inline).toMatchObject({ owner: first.owner, imperative: first.imperative, target: first.target, targetType: 'recommended', initiationTrigger: 'Begin verification now; retain the inventory', condition: 'Managed Chrome is deployed', completionCriterion: 'No affected version remains in scope', recoverySteps: 'Recheck failed managed updates' });
    expect(inline.markdown).toContain('**Completion criterion:**');
    expect(wallActionHtml(inline)).toContain('Recheck failed managed updates');
  });
  test('keeps complete retained source sentences and never makes an excerpt tail its own screen', () => {
    const evidence = receipt.selectedEvidence.slice(0, 4);
    for (const item of evidence) {
      const passage = item.passage.text;
      const excerpt = completeSourceExcerpt(passage, item.title);
      expect(passage.includes(excerpt) || excerpt === item.title).toBe(true);
      expect(excerpt).not.toMatch(/(?:…|\.\.\.)$/);
    }
    const action = doc.actions[3].imperative;
    expect(splitDisplayText(action, 4)).toEqual([action]);
    expect(completeSourceExcerpt('One complete sentence. A fragment that was clipped…')).toBe('One complete sentence.');
    expect(completeSourceExcerpt('Clipped without punctuation…', 'Original title')).toBe('Original title');
    const headlineOnly = buildPresentationPages(null, { signals: [{ title: receipt.selectedEvidence[0].title, description: 'Clipped without punctuation…' }] })[0];
    expect(headlineOnly.block.label).toBe('Reporting headline · complete excerpt unavailable');
    expect(headlineOnly.topic).toBe(receipt.selectedEvidence[0].title);
    expect(headlineOnly.block.text).toBe('A complete retained excerpt is unavailable.');
    expect(headlineOnly.block.text).not.toContain(headlineOnly.topic);
  });
  test.each([
    ['The U.S. Cybersecurity and Infrastructure Security Agency added five vulnerabilities. Another report follows.', 'The U.S. Cybersecurity and Infrastructure Security Agency added five vulnerabilities.'],
    ['Dr. J. R. Smith confirmed the affected release. The advisory follows.', 'Dr. J. R. Smith confirmed the affected release.'],
    ['Version 3.2.1 fixes the flaw in v3.2.0. Administrators should verify deployment.', 'Version 3.2.1 fixes the flaw in v3.2.0.'],
    ['The U.S. agency warned of exposure without a retained ending…', ''],
    ['The U.S.', ''],
    ['Dr. J. R.', ''],
    ['“The U.S.”', ''],
    ['The campaign targeted organizations in the U.S.', 'The campaign targeted organizations in the U.S.'],
    ['A vulnerability affects Example Inc.', 'A vulnerability affects Example Inc.'],
    ['“The campaign targeted organizations in the U.S.”', '“The campaign targeted organizations in the U.S.”'],
  ])('keeps abbreviation and version context intact in %s', (passage, expected) => {
    expect(completeSourceExcerpt(passage)).toBe(expected);
  });
});

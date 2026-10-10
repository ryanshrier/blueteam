import { expect, test } from '@jest/globals';
import { buildGroundingManifest } from '../lib/grounding.js';
import { normalizeFeedTimestamp } from '../lib/intelligence-context.js';
import { buildUserPrompt } from '../lib/prompts.js';
import { validateBrief, publicationDecision } from '../lib/validation.js';
import { buildGenerationManifest } from '../lib/generation-manifest.js';
import { validationSourceFromManifest } from '../lib/brief-drafts.js';
import { BRIEF_EVALUATION_CASES, referenceBrief } from './fixtures/brief-evaluation.js';

const editionContext = { date: '2026-10-09', timezone: 'America/Chicago', scheduled: false };
function captured(originalDate, retrievedAt = '2026-10-10T01:05:00Z') {
  const fixture = structuredClone(BRIEF_EVALUATION_CASES[0]);
  fixture.headlines = fixture.headlines.map(h => ({ ...h, originalDate, date: normalizeFeedTimestamp(originalDate), retrievedAt }));
  return { fixture, grounding: buildGroundingManifest({ headlines: fixture.headlines }) };
}
const checked = (fixture, grounding, citationDate, extra = {}) => validateBrief(
  referenceBrief(fixture).replaceAll('September 4, 2026', citationDate).replaceAll('September 5, 2026', 'October 9, 2026'),
  editionContext.date, { publication: true, editorialStandard: 2, groundingManifest: grounding, editionTimezone: editionContext.timezone, ...extra });

test('evening feed collection preserves the publisher day instead of forcing its UTC day into citations', () => {
  const { fixture, grounding } = captured('Fri, 09 Oct 2026 20:00:00 -0500');
  expect(fixture.headlines[0].date).toBe('2026-10-10T01:00:00.000Z');
  expect(grounding.sources[0].date).toBe('Fri, 09 Oct 2026 20:00:00 -0500');
  const prompt = buildUserPrompt({ headlines: fixture.headlines, groundingManifest: grounding, config: {}, editionContext });
  expect(prompt).toContain('Published: <source>2026-10-09</source>');
  expect(publicationDecision(checked(fixture, grounding, 'October 9, 2026')).blockers).toEqual([]);
});

test('an observed overseas publisher date is checked in the captured edition timezone and survives receipt replay', () => {
  const { fixture, grounding } = captured('2026-10-10T08:00:00+09:00', '2026-10-09T23:05:00Z');
  expect(publicationDecision(checked(fixture, grounding, 'October 10, 2026')).blockers).toEqual([]);
  const manifest = buildGenerationManifest({ run: { headlines: fixture.headlines }, config: {}, editionContext, groundingManifest: grounding });
  const saved = JSON.parse(JSON.stringify(manifest));
  expect(saved.grounding.sources[0].publishedAt).toBe('2026-10-10T08:00:00+09:00');
  const source = validationSourceFromManifest(saved);
  expect(source.editionTimezone).toBe('America/Chicago');
  expect(publicationDecision(checked(fixture, grounding, 'October 10, 2026', source)).blockers).toEqual([]);
  expect(JSON.stringify(saved)).toBe(JSON.stringify(manifest));
});

test.each([
  ['future instant', '2026-10-10T08:00:00+09:00', '2026-10-09T22:05:00Z', {}],
  ['after edition day', '2026-10-11T08:00:00+09:00', '2026-10-10T23:05:00Z', {}],
  ['date only', '2026-10-10', '2026-10-10T01:05:00Z', {}],
  ['unknown observation', '2026-10-10T08:00:00+09:00', '', {}],
  ['legacy unknown timezone', '2026-10-10T08:00:00+09:00', '2026-10-09T23:05:00Z', { editionTimezone: 'local' }],
])('%s cannot excuse a future citation day', (_label, originalDate, retrievedAt, extra) => {
  const { fixture, grounding } = captured(originalDate, retrievedAt);
  const citationDate = originalDate.startsWith('2026-10-11') ? 'October 11, 2026' : 'October 10, 2026';
  expect(publicationDecision(checked(fixture, grounding, citationDate, extra)).blockers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'GROUNDING', message: expect.stringContaining('Future source citation') })]));
});

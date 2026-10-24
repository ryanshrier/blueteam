import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertBriefInput, stripFactHtml } from '../lib/brief-input-limits.js';
import { validateBrief } from '../lib/validation.js';
import { createBriefValidator } from '../lib/brief-validator.js';
import { stripRawHtmlAnchors, buildGroundingManifest } from '../lib/grounding.js';
import { buildGenerationManifest, sha256 } from '../lib/generation-manifest.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRejectedBrief, revalidateBriefDraft, readBriefDraft } from '../lib/brief-drafts.js';
import { publicErrorDetails, projectPublicError } from '../lib/public-errors.js';
import { referenceBrief, BRIEF_EVALUATION_CASES, EVAL_DATE } from './fixtures/brief-evaluation.js';

describe('bounded untrusted Briefing validation', () => {
  test('rejects the admitted-size unmatched-markup payload before parsing', () => {
    const payload = '<'.repeat(80_000);
    expect(Buffer.byteLength(payload)).toBeLessThan(100_000);
    expect(() => validateBrief(payload)).toThrow(expect.objectContaining({ code: 'E_BRIEF_INPUT_LIMIT' }));
    expect(() => assertBriefInput('ordinary '.repeat(70_000))).toThrow('retention limit');
  });

  test('HTML fact stripping preserves quoted attributes and malformed visible claims', () => {
    expect(stripFactHtml('Before <span title="a > b">CVE-2026-1234</span><!-- hidden --> after')).toBe('Before CVE-2026-1234 after');
    expect(stripFactHtml('Visible <unfinished claim')).toBe('Visible <unfinished claim');
    expect(stripFactHtml('x' + '<'.repeat(80_000))).toBe('x' + '<'.repeat(80_000));
  });

  test('the isolated validator returns the same substantive findings', async () => {
    const validator = createBriefValidator();
    try {
      const content = referenceBrief(BRIEF_EVALUATION_CASES[0]);
      const source = { headlines: BRIEF_EVALUATION_CASES[0].headlines, publication: true, editorialStandard: 2 };
      await expect(validator.validate(content, EVAL_DATE, source)).resolves.toEqual(validateBrief(content, EVAL_DATE, source));
    } finally { await validator.close(); }
  });

  test('a hard deadline keeps the parent event loop available and closes the worker', async () => {
    const validator = createBriefValidator({ timeoutMs: 10 });
    let ticked = false;
    const tick = setTimeout(() => { ticked = true; }, 1);
    try {
      await expect(validator.validate(referenceBrief(BRIEF_EVALUATION_CASES[0]), EVAL_DATE))
        .rejects.toMatchObject({ code: 'E_BRIEF_VALIDATION_TIMEOUT' });
      expect(ticked).toBe(true);
    } finally { clearTimeout(tick); await validator.close(); }
    await expect(validator.validate('closed')).rejects.toThrow('closed');
  });

  test('queue capacity rejects additional work without multiplying worker memory', async () => {
    const validator = createBriefValidator({ maxPending: 1 });
    const first = validator.validate('Synthetic draft');
    try {
      await expect(validator.validate('Second draft')).rejects.toThrow('queue is full');
      await first;
    } finally { await validator.close(); }
  });

  test('raw-anchor stripping is linear and preserves quoted attributes and code examples', () => {
    const code = '`<a href="https://example.test">inline</a>`\n```html\n<a href="https://example.test">fenced</a>\n```';
    expect(stripRawHtmlAnchors('Before <a title="a > b">visible</a> ' + code)).toBe('Before visible ' + code);
    const module = new URL('../lib/grounding.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
      import { stripRawHtmlAnchors } from ${JSON.stringify(module)};
      const text='<a '.repeat(7900)+'x'.repeat(460000);
      assert.equal(stripRawHtmlAnchors(text),text);
      const code=Array.from({length:1000},(_,i)=>'~'.repeat(3+(i%120))+' x ').join('');
      stripRawHtmlAnchors(code);`], { windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 16_384,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|path|temp|tmp)$/i.test(key))) });
    expect({ status: child.status, error: child.error?.code, stderr: child.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  });

  test('the total worker deadline includes signed receipt restoration, repair and metadata processing', async () => {
    const validator = createBriefValidator({ timeoutMs: 10 });
    const directory = mkdtempSync(join(tmpdir(), 'brief-preparation-deadline-'));
    const item = structuredClone(BRIEF_EVALUATION_CASES[0]);
    item.headlines[0].link += '?signature=synthetic-worker-identity&id=42';
    const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
    const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, groundingManifest, config: {}, editionContext: { date: EVAL_DATE } });
    const saved = saveRejectedBrief(directory, { content: referenceBrief(item), manifest, validation: { valid: false, issues: [], warnings: [] } });
    let ticked = false;
    const tick = setTimeout(() => { ticked = true; }, 1);
    try {
      await expect(revalidateBriefDraft(directory, saved.id, { content: '<a '.repeat(7900) + 'x'.repeat(55_000), baseRevision: 1 },
        { prepareDraft: payload => validator.prepareDraft(payload) })).rejects.toMatchObject({ code: 'E_BRIEF_VALIDATION_TIMEOUT' });
      expect(ticked).toBe(true);
      expect(readBriefDraft(directory, saved.id).revisions).toEqual(saved.revisions);
      expect(JSON.stringify(saved.manifest)).not.toContain('synthetic-worker-identity');
    } finally { clearTimeout(tick); await validator.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('provider assembly and retained receipt preparation are bounded worker operations', async () => {
    const validator = createBriefValidator();
    const item = BRIEF_EVALUATION_CASES[0];
    const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
    const text = referenceBrief(item);
    const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, groundingManifest, config: {}, editionContext: { date: EVAL_DATE } });
    try {
      const prepared = await validator.prepare(text, EVAL_DATE, { groundingManifest, publication: true }, { extractMetadata: true });
      expect(prepared.content).toContain('## KEY JUDGMENTS');
      expect(prepared.validation).toHaveProperty('issues');
      expect(prepared.actionRecords?.contentSha256).toBe(sha256(prepared.content));
      const retained = await validator.retained(text, manifest);
      expect(retained.validation).toHaveProperty('issues');
      expect(retained.actionRecords?.contentSha256).toBe(sha256(text));
    } finally { await validator.close(); }
  });

  test('queued signed repair snapshots preserve exact citations and cannot overwrite a later commit', async () => {
    const validator = createBriefValidator();
    const directory = mkdtempSync(join(tmpdir(), 'brief-preparation-snapshot-'));
    const item = structuredClone(BRIEF_EVALUATION_CASES[0]);
    const url = item.headlines[0].link + '?signature=synthetic-snapshot-identity&id=42#details';
    item.headlines[0].link = url;
    const groundingManifest = buildGroundingManifest({ headlines: item.headlines });
    const manifest = buildGenerationManifest({ run: { headlines: item.headlines }, groundingManifest, config: {}, editionContext: { date: EVAL_DATE } });
    const content = referenceBrief(item);
    const saved = saveRejectedBrief(directory, { content, manifest, validation: { valid: false, issues: [], warnings: [] } });
    let release, preparedReady;
    const ready = new Promise(resolve => { preparedReady = resolve; });
    try {
      const first = revalidateBriefDraft(directory, saved.id, { baseRevision: 1, content: content.replace('## WATCHLIST', '## WATCHLIST — first edit') }, {
        prepareDraft: async payload => {
          const processing = validator.prepareDraft(payload);
          // The queued worker owns a snapshot, not this mutable caller object.
          payload.artifact.manifest.grounding.sources.length = 0;
          const prepared = await processing;
          preparedReady();
          return new Promise(resolve => { release = () => resolve(prepared); });
        },
      });
      const stale = first.catch(error => error);
      await ready;
      const latest = await revalidateBriefDraft(directory, saved.id, { baseRevision: 1, content: content.replace('## WATCHLIST', '## WATCHLIST — latest edit') },
        { prepareDraft: payload => validator.prepareDraft(payload) });
      release();
      expect(await stale).toMatchObject({ code: 'E_DRAFT_CONFLICT' });
      const retained = readBriefDraft(directory, saved.id);
      expect(retained.revisions.at(-1).content).toBe(latest.revisions.at(-1).content);
      expect(retained.revisions.at(-1).content).toContain(url);
      expect(retained.lastCheck.validation.issues.map(issue => issue.code)).not.toContain('CITATION_IDENTITY_INVALID');
      expect(JSON.stringify(retained.manifest)).not.toContain('synthetic-snapshot-identity');
      expect(retained.manifest.grounding.sources).toHaveLength(saved.manifest.grounding.sources.length);
    } finally { release?.(); await validator.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('authenticated signed-draft repair and publication leave HTTP liveness responsive', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/brief-processing-http.mjs', import.meta.url))], {
      windowsHide: true, encoding: 'utf8', timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|path|pathext|comspec|temp|tmp)$/i.test(key))),
    });
    expect({ status: child.status, error: child.error?.code, stderr: child.stderr, stdout: child.stdout }).toEqual({ status: 0, error: undefined,
      stderr: '', stdout: expect.stringContaining('PASS brief-processing-http') });
  }, 40_000);
});

test('only bounded evidence-readiness details cross the public error boundary', () => {
  const env = { LOCAL_TOKEN: 'fixture-opaque-credential' };
  const details = { headlines: 5, reason: 'Unavailable: ' + env.LOCAL_TOKEN, collection: { configuredSources: 4, credentials: env.LOCAL_TOKEN },
    arbitrary: { password: env.LOCAL_TOKEN } };
  expect(publicErrorDetails({ code: 'E_EVIDENCE', details }, env)).toEqual({ headlines: 5,
    reason: 'Unavailable: [REDACTED]', collection: { configuredSources: 4 } });
  expect(publicErrorDetails({ code: 'E_PROVIDER_CUSTOM', details }, env)).toBeUndefined();
  expect(projectPublicError({ message: 'CLI result unknown', completionUncertain: true, timedOut: false,
    internal: { password: env.LOCAL_TOKEN } }, env)).toMatchObject({ completionUncertain: true, timedOut: false });
  expect(projectPublicError({ message: 'failure', completionUncertain: env.LOCAL_TOKEN }, env).completionUncertain).toBeUndefined();
});

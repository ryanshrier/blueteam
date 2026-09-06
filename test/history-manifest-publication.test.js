import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
const fs = await import('fs');
let failTarget = null;
const publications = [];
jest.unstable_mockModule('fs', () => ({ ...fs, renameSync: (source, target) => {
  if (failTarget && target.endsWith(failTarget)) throw Object.assign(new Error('Simulated disk failure'), { code: 'ENOSPC' });
  fs.renameSync(source, target);
  publications.push(target);
} }));
const { saveBrief } = await import('../lib/history.js');
const { readGenerationManifest } = await import('../lib/generation-manifest.js');

describe('manifest publication ordering and failure recovery', () => {
  let dir;
  const manifest = { schemaVersion: 1, generationId: 'fixture-generation' };
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'blueteam-publication-')); failTarget = null; publications.length = 0; });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('publishes the input receipt before the completed archive marker', () => {
    const filename = saveBrief(dir, 'assessment', { date: '2026-09-05', manifest });
    expect(publications.map(path => path.slice(dir.length + 1))).toEqual(['brief-2026-09-05-01.manifest.json', filename]);
    expect(readGenerationManifest(dir, filename).generationId).toBe('fixture-generation');
  });

  test.each(['.manifest.json', '.md'])('a failure publishing %s leaves no completed edition, orphan receipt, or temporary files', suffix => {
    failTarget = suffix;
    expect(() => saveBrief(dir, 'assessment', { date: '2026-09-05', manifest })).toThrow('Simulated disk failure');
    expect(fs.readdirSync(dir)).toEqual([]);
    failTarget = null;
    const filename = saveBrief(dir, 'recovered', { date: '2026-09-05', manifest });
    expect(filename).toBe('brief-2026-09-05-01.md');
    expect(readGenerationManifest(dir, filename)).toBeTruthy();
  });

  test('replaces an orphan receipt from a crash before the scheduled archive marker', () => {
    fs.writeFileSync(join(dir, 'brief-2026-09-05-00.manifest.json'), '{"interrupted":true}');
    const filename = saveBrief(dir, 'recovered scheduled assessment', { date: '2026-09-05', scheduled: true, manifest });
    expect(readGenerationManifest(dir, filename).generationId).toBe('fixture-generation');
  });
});

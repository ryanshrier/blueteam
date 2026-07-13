import { describe, test, expect } from '@jest/globals';
import { resolveLocation } from '../public/modules/core/router.js';

describe('client route resolution', () => {
  test('/wall is the canonical passive Wall route', () => {
    expect(resolveLocation('/wall')).toEqual({
      data: { mode: 'wall', action: null },
    });
  });

  test('analyst surfaces resolve from clean paths', () => {
    expect(resolveLocation('/wire').data.mode).toBe('wire');
    expect(resolveLocation('/briefing/new').data).toEqual({ mode: 'briefing', action: 'generate' });
    expect(resolveLocation('/settings').data.mode).toBe('settings');
  });

  test('briefing filenames are decoded and unknown paths normalize to /wire', () => {
    expect(resolveLocation('/briefing/brief%202026.md').data.filename).toBe('brief 2026.md');
    expect(resolveLocation('/').canonicalPath).toBe('/wire');
  });
});

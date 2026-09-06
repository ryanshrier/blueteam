import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { generateBrief } from '../public/modules/core/api.js';
import { generationErrorMessage } from '../public/modules/briefing/briefing-view.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function rejectedRequest(body, retryAfter = '15') {
  globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': retryAfter },
  }));
  try { await generateBrief(); }
  catch (error) { return error; }
  throw new Error('Expected the local request to be rejected');
}

describe('Briefing failure explanations', () => {
  test('a cooldown after an early failure never claims a Briefing completed', async () => {
    const error = await rejectedRequest({ code: 'E_GENERATION_COOLDOWN', retryAfterSeconds: 9 });
    expect(error.code).toBe('E_GENERATION_COOLDOWN');
    expect(generationErrorMessage(error)).toBe('A Briefing request was started recently. Try again in about 9 seconds.');
  });

  test('a local API limit survives the client and view without being blamed on the model', async () => {
    const message = 'API rate limit reached — try again in a minute';
    const error = await rejectedRequest({ code: 'E_API_RATE', error: message }, '60');
    expect(generationErrorMessage(error)).toBe(message);
  });

  test.each([
    'Briefing evidence is stale (90 minutes old). Refresh the landscape and try again.',
    'Current source evidence is unavailable.',
  ])('source failures retain their cause and explain the pre-provider stop: %s', message => {
    const displayed = generationErrorMessage({ code: 'E_EVIDENCE', message });
    expect(displayed).toContain(message);
    expect(displayed).toContain('No AI generation was started.');
    expect(displayed).toContain('System health in Settings');
  });

  test('an actual provider rate limit still gets provider guidance, never the no-generation claim', () => {
    expect(generationErrorMessage({ message: '429 rate limit error' })).toBe(
      'The model is rate-limited or overloaded right now. Wait a moment and retry.',
    );
  });

  test('a publication failure retains a CVE identifier that resembles an HTTP error', () => {
    const message = 'Draft not published: unsupported CVE-2026-529.';
    expect(generationErrorMessage({ code: 'E006', message })).toBe(message);
  });
});

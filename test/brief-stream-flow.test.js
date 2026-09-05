import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const generateBriefMock = jest.fn();

jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  generateBrief: generateBriefMock,
}));

const { getState, on, off, setState } = await import('../public/modules/core/store.js');
const { startGeneration } = await import('../public/modules/briefing/brief-stream.js');

const encode = value => new TextEncoder().encode(value);
const subscriptions = [];

function capture(event, sink) {
  const handler = payload => sink.push(payload);
  on(event, handler);
  subscriptions.push([event, handler]);
}

beforeEach(() => {
  generateBriefMock.mockReset();
  setState({ isGenerating: false, currentBrief: null });
});

afterEach(() => {
  for (const [event, handler] of subscriptions.splice(0)) off(event, handler);
});

describe('startGeneration completion boundary', () => {
  test('replacement attempts emit a reset and complete with only the authoritative saved edition', async () => {
    const text = 'Final validated replacement briefing. '.repeat(6);
    const reader = { read: jest.fn().mockResolvedValueOnce({ done: false, value: encode(
      'data: {"text":"Discarded full draft"}\n\n'
      + 'data: {"reset":true}\n\n'
      + 'data: {"text":"Replacement draft"}\n\n'
      + `data: ${JSON.stringify({ briefComplete: true, text, filename: 'brief-2026-09-05.md' })}\n\n`
    ) }), cancel: jest.fn().mockResolvedValue(undefined) };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });
    const resets = [];
    const streaming = [];
    capture('brief-stream-reset', resets);
    capture('brief-streaming', streaming);
    await startGeneration();
    expect(resets).toHaveLength(1);
    expect(streaming.at(-1)).toEqual({ accumulated: 'Replacement draft', chunk: 'Replacement draft' });
    expect(getState().lastGeneratedBrief.content).toBe(text);
    expect(getState().isGenerating).toBe(false);
  });

  test('background completion preserves the reader selection and carries the generated result separately', async () => {
    const selected = { filename: 'brief-2026-09-03.md', content: 'Selected historical edition' };
    setState({ currentBrief: selected });
    const text = 'Saved newer briefing content. '.repeat(8);
    const inputManifest = { status: 'available', verification: { selectedKevCves: ['CVE-2026-1234'] } };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => ({
      read: jest.fn().mockResolvedValueOnce({ done: false, value: encode(`data: ${JSON.stringify({
        briefComplete: true, text, filename: 'brief-2026-09-05.md', inputManifest,
        validation: { warnings: ['Review this saved claim.'] },
      })}\n\n`) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    }) } });
    await startGeneration();
    expect(getState().currentBrief).toBe(selected);
    expect(getState().lastGeneratedBrief).toMatchObject({
      filename: 'brief-2026-09-05.md', content: text, inputManifest, warnings: ['Review this saved claim.'],
    });
  });
  test('retains a pre-provider evidence rejection for the view instead of reporting a dropped stream', async () => {
    const reader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode('data: {"error":"Briefing evidence is stale.","code":"E_EVIDENCE"}\n\n'),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });
    const errors = [];
    capture('generation-error', errors);

    await startGeneration();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: 'Briefing evidence is stale.', code: 'E_EVIDENCE', streamLost: false,
    });
    expect(getState()).toMatchObject({ isGenerating: false, currentBrief: null });
  });

  test('clean EOF without briefComplete is incomplete, never a saved briefing', async () => {
    const draft = 'Unvalidated streamed draft '.repeat(8);
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: encode(`data: ${JSON.stringify({ text: draft })}\n\n`) })
        .mockResolvedValueOnce({ done: true }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });

    const errors = [];
    const generated = [];
    capture('generation-error', errors);
    capture('brief-generated', generated);

    await startGeneration();

    expect(generated).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      streamLost: true,
      accumulatedText: draft,
      message: expect.stringMatching(/before the server confirmed completion/),
    });
    expect(getState()).toMatchObject({ isGenerating: false, currentBrief: null });
  });

  test('a completed brief cannot be followed by a contradictory stream-lost error', async () => {
    const text = 'Validated completed briefing content. '.repeat(6);
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: encode(`data: ${JSON.stringify({
            briefComplete: true,
            text,
            filename: 'brief-2026-07-13-03.md',
          })}\n\ndata: [DONE]\n\n`),
        })
        .mockRejectedValueOnce(new TypeError('socket reset after completion')),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });

    const errors = [];
    const generated = [];
    capture('generation-error', errors);
    capture('brief-generated', generated);

    await startGeneration();

    expect(errors).toEqual([]);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ text, filename: 'brief-2026-07-13-03.md' });
    expect(getState()).toMatchObject({
      isGenerating: false,
      currentBrief: { content: text, filename: 'brief-2026-07-13-03.md' },
    });
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  test('emits the authoritative recoverable draft from a publication-gate error', async () => {
    const draft = '# Unpublished replacement\n\nReview only.';
    const reader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode(
          'data: {"text":"Discarded attempt"}\n\n'
          + `data: ${JSON.stringify({
            error: 'Draft was not published because the output-token limit was reached.',
            code: 'E_PARTIAL_GENERATION',
            draft,
            validation: { warnings: ['Output limit'], hardFail: false, trustFail: false },
          })}\n\n`
        ),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });

    const errors = [];
    capture('generation-error', errors);

    await startGeneration();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'E_PARTIAL_GENERATION',
      accumulatedText: 'Discarded attempt',
      recoverableDraft: draft,
      validation: { warnings: ['Output limit'], hardFail: false, trustFail: false },
    });
    expect(getState()).toMatchObject({ isGenerating: false, currentBrief: null });
  });
});
